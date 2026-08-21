/**
 * scheme: "klyx-escrow" on network: "klever-mainnet" | "klever-testnet"
 *
 * Client-side builder for the klyx-escrow payload. Unlike
 * klever-exact, this scheme has NO off-chain attestation — the
 * requester's on-chain openEscrow transaction IS the authorization.
 * Builder here is a pure shape assembler; the caller is expected to
 * have already submitted the openEscrow tx and to pass its hash in
 * `openEscrowTx`.
 *
 * Payload shape mirrors the facilitator's
 * `src/schemes/klyxEscrow.ts` schema — see there for validation
 * rules kept in sync between the two sides.
 */

import { z } from "zod";
import type { PaymentPayload } from "../types.js";
import { X402_VERSION } from "../types.js";
import { SCHEME_KLYX_ESCROW, type KleverNetwork } from "./index.js";

const kleverBech32 = /^klv1[0-9a-z]{38,}$/;
const hexOnly = /^[0-9a-fA-F]+$/;
const bigIntString = /^\d+$/;
const txHash = /^[0-9a-fA-F]{40,128}$/;

const klyxEscrowPayloadSchema = z.object({
  asset: z.string().min(1).max(64),
  amount: z.string().regex(bigIntString),
  provider: z.string().regex(kleverBech32),
  nonce: z.string().regex(hexOnly).min(32).max(128),
  expiresAt: z.string().datetime({ offset: true }),
  disputeWindowDays: z.number().int().positive().max(365),
  openEscrowTx: z.string().regex(txHash),
});

export type KlyxEscrowPayload = z.infer<typeof klyxEscrowPayloadSchema>;

/**
 * Inputs to `buildKlyxEscrowPayload`. All fields are wire-shape;
 * this builder does no signing (openEscrow tx is the auth).
 */
export interface KlyxEscrowBuildInput {
  asset: string;
  amount: string;
  /** klv1… bech32 address of the provider (receives release). */
  provider: string;
  nonce: string;
  expiresAt: string;
  /** Days the dispute window stays open; must match the value
   *  submitted to openEscrow on-chain. */
  disputeWindowDays: number;
  /** Hex tx hash of the openEscrow transaction the requester
   *  submitted. Must be `success` on-chain when the facilitator
   *  looks it up during /verify. */
  openEscrowTx: string;
}

/**
 * Assemble a klyx-escrow PaymentPayload envelope. Validates the
 * shape; throws (via zod) on malformed inputs so dev errors surface
 * at build time rather than as an opaque facilitator response.
 */
export function buildKlyxEscrowPayload(
  input: KlyxEscrowBuildInput,
  network: KleverNetwork,
): PaymentPayload {
  const payload = klyxEscrowPayloadSchema.parse({
    asset: input.asset,
    amount: input.amount,
    provider: input.provider,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
    disputeWindowDays: input.disputeWindowDays,
    openEscrowTx: input.openEscrowTx,
  });
  return {
    x402Version: X402_VERSION,
    scheme: SCHEME_KLYX_ESCROW,
    network,
    payload,
  };
}

/**
 * Parse + validate an inbound klyx-escrow payload. Useful for the
 * provider-middleware path (once it lands).
 */
export function parseKlyxEscrowPayload(
  raw: Record<string, unknown>,
): KlyxEscrowPayload {
  return klyxEscrowPayloadSchema.parse(raw);
}
