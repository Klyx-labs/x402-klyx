/**
 * scheme: "exact" on network: "klever-mainnet" | "klever-testnet"
 *
 * Client-side builder + signer for the klever-exact payload. Mirrors
 * the payload shape the Klyx facilitator's
 * `src/schemes/kleverExact.ts` accepts, and canonicalizes for
 * attestation identically — any drift is a signature-verify failure.
 *
 * The wallet signs canonical bytes of the payload with the
 * `authorization.attestation` field stripped (it couldn't have
 * signed a value that contains its own signature). The facilitator
 * strips + recomputes the same way when it verifies.
 */

import { z } from "zod";
import { canonicalize } from "../canonicalize.js";
import type { PaymentPayload } from "../types.js";
import { X402_VERSION } from "../types.js";
import { SCHEME_EXACT, type KleverNetwork } from "./index.js";
import type { KleverWallet } from "../wallet.js";
import { assertValidSignatureHex } from "../wallet.js";

// ── Payload shape ──────────────────────────────────────────────
//
// Kept as a Zod schema for the SAME reason the facilitator does —
// dev errors surface with a clear message rather than a silent
// signature-verify failure downstream.

const kleverBech32 = /^klv1[0-9a-z]{38,}$/;
// Lowercase-only. Canonicalization preserves string case in JSON;
// a lowercasing middleware would silently break attestations
// otherwise. Matches facilitator per docs/x402-parity.md.
const hexOnly = /^[0-9a-f]+$/;
// Bounded to u128-max digit count (~40). Unbounded `\d+` let a
// caller submit a 10M-digit amount and DoS the facilitator on
// BigInt() parse — same schema is shared, so bound here too.
const bigIntString = /^\d{1,40}$/;

const kleverExactPayloadSchema = z.object({
  asset: z.string().min(1).max(64),
  amount: z.string().regex(bigIntString, "amount must be a base-10 integer string"),
  destination: z.string().regex(kleverBech32, "destination must be a lowercase klv1 bech32 address"),
  nonce: z.string().regex(hexOnly).min(32).max(128),
  expiresAt: z.string().datetime({ offset: true }),
  authorization: z.object({
    signer: z.string().regex(kleverBech32, "signer must be a lowercase klv1 bech32 address"),
    publicKey: z.string().regex(hexOnly).length(64, "publicKey must be 32 bytes hex (64 chars)"),
    attestation: z.string().regex(hexOnly).length(128, "attestation must be 64 bytes hex (128 chars)"),
  }),
});

export type KleverExactPayload = z.infer<typeof kleverExactPayloadSchema>;

// Input-only schema for the builder — validates caller-supplied
// fields BEFORE we invoke wallet.sign (which may pop up a browser
// extension or wake a hardware wallet). Fail fast on bad input
// instead of asking the user to approve a garbage payload.
const kleverExactBuildInputSchema = z.object({
  asset: z.string().min(1).max(64),
  amount: z
    .string()
    .regex(bigIntString, "amount must be a base-10 integer string"),
  destination: z
    .string()
    .regex(kleverBech32, "destination must be a lowercase klv1 bech32 address"),
  nonce: z.string().regex(hexOnly).min(32).max(128),
  expiresAt: z.string().datetime({ offset: true }),
});

/**
 * Canonicalize a payload for attestation. MUST drop
 * `authorization.attestation` — the wallet couldn't have signed a
 * value that contains its own signature. Byte-identical to the
 * facilitator's `canonicalizeForAttestation`.
 */
export function canonicalizeForAttestation(
  payload: Omit<KleverExactPayload, "authorization"> & {
    authorization: Omit<KleverExactPayload["authorization"], "attestation">;
  },
): string {
  return canonicalize(payload);
}

/**
 * Inputs to `buildAndSignKleverExactPayload` — the wallet-facing
 * fields, minus derived ones (publicKey, attestation) which this
 * builder fills in from `wallet`.
 */
export interface KleverExactBuildInput {
  /** Klever asset id (e.g. "KLV" or "KDA-XXXX"). */
  asset: string;
  /** Amount in the asset's smallest unit, base-10 integer string. */
  amount: string;
  /** klv1… bech32 address of the receiving provider. */
  destination: string;
  /** Hex string, 32+ chars, single-use per (signer, expiresAt). */
  nonce: string;
  /** ISO 8601 timestamp with offset, in the future. */
  expiresAt: string;
  /**
   * Wallet that signs the attestation. Its `.address` populates
   * `authorization.signer`, `.publicKeyHex` populates
   * `authorization.publicKey`, and `.sign(canonicalBody)` produces
   * the `authorization.attestation` hex. Sync or async — the
   * builder awaits either.
   */
  wallet: KleverWallet;
}

/**
 * Build + sign a klever-exact payload. Async so wallet extensions,
 * hardware wallets, and remote signers work — in-process wallets
 * (via `fromPrivateKey`) resolve synchronously and the caller just
 * awaits.
 *
 * Throws on malformed inputs — bad bech32, non-integer amount, past
 * `expiresAt`, wrong-length key. Dev errors should surface at build
 * time, not as an opaque `isValid=false` from the facilitator two
 * RTTs later.
 */
export async function buildAndSignKleverExactPayload(
  input: KleverExactBuildInput,
  network: KleverNetwork,
): Promise<PaymentPayload> {
  // Validate caller inputs upfront — before the wallet callback
  // is invoked. A hardware-wallet popup for a bad payload wastes
  // the user's time; catching malformed input synchronously with
  // a clear zod error is much friendlier.
  kleverExactBuildInputSchema.parse({
    asset: input.asset,
    amount: input.amount,
    destination: input.destination,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
  });
  const unsigned = {
    asset: input.asset,
    amount: input.amount,
    destination: input.destination,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
    authorization: {
      signer: input.wallet.address,
      publicKey: input.wallet.publicKeyHex,
    },
  };
  const canonicalBody = canonicalizeForAttestation(unsigned);
  const attestation = await input.wallet.sign(canonicalBody);
  // Fail loud on a wallet that returned garbage — otherwise the
  // facilitator returns invalid_signature and the caller has to
  // dig into the wallet adapter to find the bug.
  assertValidSignatureHex(attestation);
  const payload: KleverExactPayload = {
    ...unsigned,
    authorization: { ...unsigned.authorization, attestation },
  };
  return {
    x402Version: X402_VERSION,
    scheme: SCHEME_EXACT,
    network,
    payload,
  };
}

/**
 * Parse + validate an inbound klever-exact payload. Useful for the
 * provider-middleware path (once it lands) — the middleware receives
 * a PaymentPayload from a client and needs to type-narrow before
 * inspecting fields.
 */
export function parseKleverExactPayload(
  raw: Record<string, unknown>,
): KleverExactPayload {
  return kleverExactPayloadSchema.parse(raw);
}
