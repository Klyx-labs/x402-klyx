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
import { signAttestation, derivePublicKey } from "../signing.js";
import type { PaymentPayload } from "../types.js";
import { X402_VERSION } from "../types.js";
import { SCHEME_EXACT, type KleverNetwork } from "./index.js";

// ── Payload shape ──────────────────────────────────────────────
//
// Kept as a Zod schema for the SAME reason the facilitator does —
// dev errors surface with a clear message rather than a silent
// signature-verify failure downstream.

const kleverBech32 = /^klv1[0-9a-z]{38,}$/;
const hexOnly = /^[0-9a-fA-F]+$/;
const bigIntString = /^\d+$/;

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
 * fields, minus the derived ones (publicKey, attestation) which
 * this builder fills in.
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
  /** klv1… bech32 address of the requester wallet. */
  signer: string;
  /** Ed25519 private key hex (32 bytes / 64 chars). */
  privateKeyHex: string;
}

/**
 * Build + sign a klever-exact payload. Returns a wire-ready
 * PaymentPayload envelope with the attestation filled in.
 *
 * Throws (via zod) on malformed inputs — bad bech32, non-integer
 * amount, past `expiresAt`, wrong-length key. This is intentional:
 * dev errors should surface at build time, not as a `isValid=false`
 * from the facilitator two RTTs later.
 */
export function buildAndSignKleverExactPayload(
  input: KleverExactBuildInput,
  network: KleverNetwork,
): PaymentPayload {
  const publicKey = derivePublicKey(input.privateKeyHex);
  const unsigned = {
    asset: input.asset,
    amount: input.amount,
    destination: input.destination,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
    authorization: {
      signer: input.signer,
      publicKey,
    },
  };
  const canonicalBody = canonicalizeForAttestation(unsigned);
  const attestation = signAttestation({
    canonicalBody,
    privateKeyHex: input.privateKeyHex,
  });
  const payload: KleverExactPayload = {
    ...unsigned,
    authorization: { ...unsigned.authorization, attestation },
  };
  // Shape-check the fully assembled payload — belt + braces. Catches
  // a malformed input that slipped past the individual checks above.
  kleverExactPayloadSchema.parse(payload);
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
