/**
 * Receipt emitter — POSTs signed receipts to Klyx after a settled
 * x402 payment. Feeds the ADR-013 agent reputation stack
 * (AgentValue) by making each paid invocation a first-class,
 * queryable, attestation-signed record.
 *
 * Attestation scheme: klv-ed25519 per ADR-017 D17. The receipt is
 * canonicalized (alphabetical field sort, null/undefined omitted),
 * SHA-256'd, and signed with the provider wallet's ed25519 key —
 * same primitive as the klever-exact payment attestation.
 *
 * Design posture:
 * - Fire-and-forget by default; failures don't crash the caller
 *   (call `onError` if the caller wants observability).
 * - Standalone usable OR wired into paymentMiddleware via its
 *   `receiptEmitter` option (auto-emit on 2xx completion).
 * - No batching in v0 — the receipts endpoint is single-receipt
 *   POST, and typical agent scale doesn't need throughput
 *   optimizations yet.
 *
 * Adoption note: the whole point of the reputation flywheel is
 * that receipts get emitted for every payment. If cost becomes a
 * barrier, the recommended path is Klyx-side subsidy from the
 * facilitator fee — NOT skipping emission — so this helper
 * defaults to always-emit and callers opt out on a per-payment
 * basis if needed.
 */

import { sha256 } from "@noble/hashes/sha256";
import { canonicalize } from "../core/canonicalize.js";
import { bytesToHex } from "../core/signing.js";
import { assertValidSignatureHex, type KleverWallet } from "../core/wallet.js";
import type {
  AttestationScheme,
  EmittedReceipt,
  ReceiptInput,
} from "./types.js";

export interface ReceiptEmitterOptions {
  /** Klyx API base URL. No trailing slash. */
  klyxApiUrl: string;
  /**
   * JWT bearer token authorizing the provider agent to emit
   * receipts. Obtained via the Klyx auth flow (email/password
   * login or wallet login → access token).
   */
  authToken: string;
  /**
   * Provider agent's UUID in the Klyx system. Written into
   * every receipt's `providerAgentUserId` field.
   */
  providerAgentUserId: string;
  /**
   * Provider wallet — signs the klv-ed25519 attestation on each
   * receipt. Use `fromPrivateKey(hex, address)` for in-process
   * keys, or an adapter (e.g. wrapping Klever Web Extension) for
   * browser + hardware wallet flows.
   *
   * The wallet's `publicKeyHex` MUST match a key registered
   * against `providerAgentUserId` on Klyx — otherwise the
   * signature won't verify at a later phase, and the receipt is
   * silently downgraded in reputation scoring.
   */
  wallet: KleverWallet;
  /** Request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /**
   * Number of retry attempts on transport error. Default 2 (3
   * attempts total). Bad-request errors and nonce collisions do
   * NOT retry (they're deterministic failures).
   */
  retries?: number;
  /**
   * Base backoff between retries in ms. Default 500 (exponential:
   * 500, 1000, 2000, ...).
   */
  retryBaseMs?: number;
  /** Optional fetch impl for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Called for each failed emission. Default: silent (log via
   * caller's chosen mechanism). Receives the error and the
   * receipt that failed to emit.
   */
  onError?: (err: ReceiptError, receipt: ReceiptInput) => void;
  /**
   * Called on successful emission — for observability, dashboards,
   * or receipt-ID tracking. Fires after the POST returns 201.
   */
  onEmit?: (result: EmittedReceipt, receipt: ReceiptInput) => void;
}

export class ReceiptError extends Error {
  constructor(
    message: string,
    readonly code: ReceiptErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ReceiptError";
  }
}

export type ReceiptErrorCode =
  | "malformed_receipt"
  | "unauthorized"
  | "nonce_collision"
  | "http_error"
  | "malformed_response"
  | "transport_error"
  | "timeout";

export interface ReceiptEmitter {
  /**
   * Sign + POST a receipt. Returns `{ receiptId, state }` on
   * success, or `null` on failure (with `onError` fired). Never
   * throws — the caller's response path must not be blocked by
   * a downstream Klyx outage.
   */
  emit(receipt: ReceiptInput): Promise<EmittedReceipt | null>;
}

const ATTESTATION_SCHEME: AttestationScheme = "klv-ed25519";
const RECEIPTS_PATH = "/api/agents/receipts";

export function createReceiptEmitter(
  opts: ReceiptEmitterOptions,
): ReceiptEmitter {
  if (!opts.klyxApiUrl) {
    throw new Error("createReceiptEmitter: klyxApiUrl required");
  }
  if (!opts.authToken) {
    throw new Error("createReceiptEmitter: authToken required");
  }
  if (!opts.providerAgentUserId) {
    throw new Error("createReceiptEmitter: providerAgentUserId required");
  }
  if (!opts.wallet?.address) {
    throw new Error("createReceiptEmitter: wallet.address required");
  }
  if (!opts.wallet.publicKeyHex) {
    throw new Error("createReceiptEmitter: wallet.publicKeyHex required");
  }
  if (typeof opts.wallet.sign !== "function") {
    throw new Error("createReceiptEmitter: wallet.sign function required");
  }
  const url = opts.klyxApiUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 2;
  const retryBaseMs = opts.retryBaseMs ?? 500;
  const fetchImpl = opts.fetch ?? fetch;

  return {
    async emit(receipt) {
      // 1. Assemble the base receipt payload — caller's fields
      //    plus derived providerAgentUserId. Strip nulls per
      //    ADR-013 canonical rules (null fields OMITTED from
      //    signed bytes).
      const base = stripNulls({
        ...receipt,
        providerAgentUserId: opts.providerAgentUserId,
      });

      // 2. Canonicalize the base (no attestation fields yet, no
      //    canonicalReceiptHash — those are downstream).
      let canonicalBody: string;
      try {
        canonicalBody = canonicalize(base);
      } catch (err) {
        const rerr = new ReceiptError(
          `receipt not canonicalizable: ${(err as Error).message}`,
          "malformed_receipt",
        );
        opts.onError?.(rerr, receipt);
        return null;
      }

      // 3. Compute canonicalReceiptHash = SHA-256 hex of canonical
      //    bytes. The server recomputes to verify.
      const canonicalReceiptHash = bytesToHex(
        sha256(new TextEncoder().encode(canonicalBody)),
      );

      // 4. Sign the canonical bytes via the wallet callback. Same
      //    klv-ed25519 primitive as klever-exact attestation. The
      //    wallet's sign() handles the SHA-256 + ed25519 internally
      //    (for in-process wallets via `fromPrivateKey`) or
      //    delegates to an extension / hardware wallet / KMS.
      let providerAttestation: string;
      try {
        providerAttestation = await opts.wallet.sign(canonicalBody);
        assertValidSignatureHex(providerAttestation);
      } catch (err) {
        // Wallet declined, hardware timeout, adapter returned junk
        // — surface as malformed_receipt so onError sees it and we
        // don't retry (the caller's wallet state won't magically
        // change on retry).
        const rerr = new ReceiptError(
          `failed to sign attestation: ${(err as Error).message}`,
          "malformed_receipt",
        );
        opts.onError?.(rerr, receipt);
        return null;
      }

      // 5. POST body = base + attestation fields + canonical hash.
      //    Server writes these to first-class columns per Slice 3.
      const body = {
        ...base,
        providerAttestation,
        providerAttestationScheme: ATTESTATION_SCHEME,
        canonicalReceiptHash,
      };

      // 6. POST with retries. Bad-request + nonce-collision short-
      //    circuit (deterministic; retry would just fail again).
      const result = await postWithRetries({
        url: url + RECEIPTS_PATH,
        body,
        authToken: opts.authToken,
        timeoutMs,
        retries,
        retryBaseMs,
        fetchImpl,
        onError: (err) => opts.onError?.(err, receipt),
      });

      if (result) {
        opts.onEmit?.(result, receipt);
      }
      return result;
    },
  };
}

/** Recursively strip `null` values (converting to undefined so
 *  canonicalize skips them). ADR-013 canonical rule: null fields
 *  are OMITTED from the signed bytes. Arrays preserve their
 *  elements (including nulls, if any — arrays aren't sorted or
 *  filtered in canonicalization). */
function stripNulls<T>(value: T): T {
  if (value === null) return undefined as unknown as T;
  if (Array.isArray(value)) {
    return value.map(stripNulls) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const stripped = stripNulls(v);
      if (stripped !== undefined) out[k] = stripped;
    }
    return out as T;
  }
  return value;
}

interface PostArgs {
  url: string;
  body: unknown;
  authToken: string;
  timeoutMs: number;
  retries: number;
  retryBaseMs: number;
  fetchImpl: typeof fetch;
  onError: (err: ReceiptError) => void;
}

async function postWithRetries(
  args: PostArgs,
): Promise<EmittedReceipt | null> {
  let lastErr: ReceiptError | null = null;
  for (let attempt = 0; attempt <= args.retries; attempt++) {
    try {
      const result = await postOnce(args);
      return result;
    } catch (err) {
      const rerr = err as ReceiptError;
      lastErr = rerr;
      // Deterministic failures — no point retrying.
      if (
        rerr.code === "malformed_receipt" ||
        rerr.code === "nonce_collision" ||
        rerr.code === "unauthorized" ||
        rerr.code === "malformed_response"
      ) {
        break;
      }
      // Non-final attempt → back off + retry.
      if (attempt < args.retries) {
        await sleep(args.retryBaseMs * Math.pow(2, attempt));
      }
    }
  }
  if (lastErr) args.onError(lastErr);
  return null;
}

async function postOnce(args: PostArgs): Promise<EmittedReceipt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  let resp: Response;
  let bodyText: string;
  try {
    resp = await args.fetchImpl(args.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.authToken}`,
      },
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
    bodyText = await resp.text();
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new ReceiptError(
        `receipt POST timed out after ${args.timeoutMs}ms`,
        "timeout",
      );
    }
    throw new ReceiptError(
      `receipt POST transport error: ${(err as Error).message}`,
      "transport_error",
    );
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new ReceiptError(
      `Klyx receipts API rejected auth (HTTP ${resp.status})`,
      "unauthorized",
      resp.status,
    );
  }
  if (resp.status === 409) {
    throw new ReceiptError(
      "receipt nonce collision (409) — already recorded",
      "nonce_collision",
      resp.status,
    );
  }
  if (resp.status === 400) {
    throw new ReceiptError(
      `Klyx rejected receipt as malformed (HTTP 400): ${bodyText.slice(0, 200)}`,
      "malformed_receipt",
      resp.status,
    );
  }
  if (!resp.ok) {
    throw new ReceiptError(
      `Klyx receipts POST failed HTTP ${resp.status}`,
      "http_error",
      resp.status,
    );
  }

  let parsed: { receipt?: Partial<EmittedReceipt> };
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    throw new ReceiptError(
      `Klyx receipt response not valid JSON: ${(err as Error).message}`,
      "malformed_response",
    );
  }
  if (!parsed.receipt?.id) {
    throw new ReceiptError(
      "Klyx receipt response missing receipt.id",
      "malformed_response",
    );
  }
  return {
    id: parsed.receipt.id,
    state: parsed.receipt.state ?? "signed",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
