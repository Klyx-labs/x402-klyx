/**
 * Fetch-shaped interceptor for calling paid providers — the
 * "drop-in for paying agents" side of x402-klyx.
 *
 * Wraps any fetch impl. On an HTTP 402 response with a
 * spec-compliant Http402Body, this interceptor:
 *   1. Picks a compatible entry from paymentOptions[] (preference
 *      = klever-exact on the caller's preferred network)
 *   2. Enforces a caller-set maxAmount ceiling — hard cap against
 *      a malicious/buggy provider trying to overcharge
 *   3. Builds + signs a klever-exact PaymentPayload with the
 *      wallet's ed25519 key, using a fresh random nonce
 *   4. Base64-encodes the payload, sets X-PAYMENT header, retries
 *      the request once
 *   5. Returns the retry response as-is (no infinite loop — a
 *      second 402 surfaces to the caller)
 *
 * Non-402 responses pass through unchanged.
 *
 * Not in v0:
 *   - klyx-escrow scheme (requires on-chain openEscrow tx
 *     submission — outside a pure HTTP interceptor's scope).
 *     Callers who need escrow can use buildKlyxEscrowPayload from
 *     core after submitting the tx themselves.
 *   - Callback-style wallet signing (only in-process privateKeyHex
 *     supported today; wallet-extension bridges land in a follow-up).
 */

import { Buffer } from "node:buffer";
import { randomBytes } from "@noble/hashes/utils";
import { bytesToHex } from "../core/signing.js";
import { buildAndSignKleverExactPayload } from "../core/schemes/kleverExact.js";
import {
  SCHEME_EXACT,
  NETWORK_KLEVER_TESTNET,
  type Scheme,
  type KleverNetwork,
} from "../core/schemes/index.js";
import type {
  Http402Body,
  PaymentOption,
} from "../core/types.js";
import type { KleverWallet } from "../core/wallet.js";

/** Re-export for callers who want the wallet type without
 *  reaching into core/. Actual type lives at `../core/wallet.js`. */
export type { KleverWallet } from "../core/wallet.js";

/** Observability payload for the optional `onPayment` hook. Fires
 *  after building + signing but BEFORE the retry request goes
 *  out. Useful for logging, metrics, budget tracking. */
export interface PaymentAttemptInfo {
  scheme: string;
  network: string;
  /** Amount in smallest units, base-10 integer string. */
  amount: string;
  asset: string;
  /** Resource identifier as advertised in the 402 body. */
  resource: string;
  /** Provider bech32 address (payTo). */
  payTo: string;
  /** Random nonce used for this payment (32 hex chars). */
  nonce: string;
}

export interface WithPaymentInterceptorOptions {
  /**
   * Preferred scheme when the 402 body offers multiple entries.
   * Default `exact` (klever-exact). Only `exact` is supported in
   * v0 — if the provider only offers klyx-escrow, the interceptor
   * throws with a clear reason.
   */
  preferScheme?: Scheme;
  /**
   * Preferred network. Default `klever-testnet`. When the 402
   * body offers multiple networks, the one matching this
   * preference wins.
   */
  preferNetwork?: KleverNetwork;
  /**
   * Ceiling on payment amount, in smallest units (base-10 integer
   * string). If a 402 asks for more, the interceptor throws
   * rather than pay. Skip to disable (not recommended in prod).
   */
  maxAmount?: string;
  /**
   * Nonce expiry from now, in seconds. Default 300 (5 min). The
   * facilitator rejects payloads past their expiresAt, so shorter
   * windows reduce replay/holding surface.
   */
  expiresInSeconds?: number;
  /** Optional observability hook fired per payment attempt. */
  onPayment?: (info: PaymentAttemptInfo) => void;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly code: PaymentErrorCode,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export type PaymentErrorCode =
  | "malformed_402"
  | "no_compatible_option"
  | "amount_over_cap"
  | "unsupported_scheme_client"
  | "wallet_error";

/**
 * Wrap a fetch impl with automatic 402-handling. Returns a
 * fetch-shaped function; drop-in wherever the caller uses fetch.
 *
 * Example:
 *   const paidFetch = withPaymentInterceptor(fetch, wallet, { maxAmount: '5000000' });
 *   const res = await paidFetch('https://agent.example/summarize');
 */
export function withPaymentInterceptor(
  fetchImpl: typeof fetch,
  wallet: KleverWallet,
  opts: WithPaymentInterceptorOptions = {},
): typeof fetch {
  if (!wallet?.address) {
    throw new Error("withPaymentInterceptor: wallet.address required");
  }
  if (!wallet.publicKeyHex) {
    throw new Error("withPaymentInterceptor: wallet.publicKeyHex required");
  }
  if (typeof wallet.sign !== "function") {
    throw new Error("withPaymentInterceptor: wallet.sign function required");
  }
  const preferScheme = opts.preferScheme ?? SCHEME_EXACT;
  const preferNetwork = opts.preferNetwork ?? NETWORK_KLEVER_TESTNET;
  const expiresIn = opts.expiresInSeconds ?? 300;
  const maxAmount = opts.maxAmount ? BigInt(opts.maxAmount) : null;

  const paidFetch: typeof fetch = async (input, init) => {
    const first = await fetchImpl(input, init);
    if (first.status !== 402) return first;

    // Parse the 402 body. Clone first so the caller can still
    // access the original response if they catch our throw.
    const bodyText = await first.clone().text();
    let http402: Http402Body;
    try {
      http402 = JSON.parse(bodyText) as Http402Body;
    } catch {
      throw new PaymentError(
        "402 response body was not valid JSON",
        "malformed_402",
      );
    }
    if (
      !http402 ||
      !Array.isArray(http402.paymentOptions) ||
      http402.paymentOptions.length === 0
    ) {
      throw new PaymentError(
        "402 body missing or empty paymentOptions[]",
        "malformed_402",
      );
    }

    const option = pickOption(
      http402.paymentOptions,
      preferScheme,
      preferNetwork,
    );
    if (!option) {
      const offered = http402.paymentOptions
        .map((o) => `${o.scheme}/${o.network}`)
        .join(", ");
      throw new PaymentError(
        `no compatible payment option (wanted ${preferScheme}/${preferNetwork}, offered: ${offered})`,
        "no_compatible_option",
      );
    }

    // Amount cap — enforce BEFORE signing so we don't leak a
    // signed payload the caller doesn't intend to submit.
    let amount: bigint;
    try {
      amount = BigInt(option.maxAmountRequired);
    } catch {
      throw new PaymentError(
        `402 option has non-integer maxAmountRequired: ${option.maxAmountRequired}`,
        "malformed_402",
      );
    }
    if (maxAmount !== null && amount > maxAmount) {
      throw new PaymentError(
        `payment ${option.maxAmountRequired} exceeds maxAmount ${opts.maxAmount}`,
        "amount_over_cap",
      );
    }

    // Only klever-exact supported by the built-in signer today.
    // klyx-escrow requires an on-chain openEscrow tx — the caller
    // should build the payload manually via buildKlyxEscrowPayload
    // after submitting the tx, and hit the endpoint themselves.
    if (option.scheme !== SCHEME_EXACT) {
      throw new PaymentError(
        `scheme "${option.scheme}" not supported by withPaymentInterceptor v0; ` +
          `use buildKlyxEscrowPayload from core after submitting openEscrow on-chain`,
        "unsupported_scheme_client",
      );
    }

    const nonce = generateNonce();
    const expiresAt = new Date(nowMs() + expiresIn * 1000).toISOString();

    let payload;
    try {
      payload = await buildAndSignKleverExactPayload(
        {
          asset: option.asset,
          amount: option.maxAmountRequired,
          destination: option.payTo,
          nonce,
          expiresAt,
          wallet,
        },
        option.network as KleverNetwork,
      );
    } catch (err) {
      // Wallet callback threw (user declined popup, hardware
      // wallet timed out, KMS rejected) — surface as wallet_error
      // so callers can distinguish it from network / config
      // problems.
      throw new PaymentError(
        `failed to build payload: ${(err as Error).message}`,
        "wallet_error",
      );
    }

    opts.onPayment?.({
      scheme: option.scheme,
      network: option.network,
      amount: option.maxAmountRequired,
      asset: option.asset,
      resource: option.resource,
      payTo: option.payTo,
      nonce,
    });

    // Retry with X-PAYMENT set. If the retry also comes back as
    // 402 (e.g. facilitator returned invalid_signature), return
    // that response as-is — the caller decides whether to retry
    // manually. No infinite loop.
    const xPayment = Buffer.from(JSON.stringify(payload)).toString("base64");
    const retryInit: RequestInit = {
      ...init,
      headers: mergeHeaders(init?.headers, { "x-payment": xPayment }),
    };
    return fetchImpl(input, retryInit);
  };

  return paidFetch;
}

/** Pick the best-matching option from paymentOptions[]. Preference
 *  order:
 *    1. Exact scheme+network match on caller's preferences
 *    2. Same scheme, any network the caller advertised (currently
 *       just the preferred network)
 *    3. null → caller-decides via a thrown no_compatible_option
 *  Only returns options for schemes the interceptor supports client-
 *  side (currently just klever-exact). */
function pickOption(
  options: PaymentOption[],
  preferScheme: Scheme,
  preferNetwork: KleverNetwork,
): PaymentOption | null {
  const supported = options.filter((o) => o.scheme === preferScheme);
  const exact = supported.find((o) => o.network === preferNetwork);
  return exact ?? null;
}

/** 32 hex chars (16 bytes) — meets the min-32-char nonce regex on
 *  both client and facilitator schemas. Cryptographically random. */
function generateNonce(): string {
  return bytesToHex(randomBytes(16));
}

/** Merge existing init.headers with our additions. Preserves the
 *  original Headers instance if any, so caller-set headers (auth,
 *  user-agent, content-type) survive. */
function mergeHeaders(
  existing: RequestInit["headers"],
  additions: Record<string, string>,
): Headers {
  const merged = new Headers(existing);
  for (const [k, v] of Object.entries(additions)) {
    merged.set(k, v);
  }
  return merged;
}

/** Wallclock — separated so tests can stub via vi.setSystemTime. */
function nowMs(): number {
  return Date.now();
}
