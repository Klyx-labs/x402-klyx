/**
 * Scheme + network constants for x402-klyx.
 *
 * String constants (not enums) so they match the wire tokens
 * verbatim and consumers can inline them without importing the
 * enum module.
 */

/** scheme: direct wallet-to-wallet KLV/KDA transfer with wallet-
 *  attested payload. 0% Klyx fee, no dispute recourse. */
export const SCHEME_EXACT = "exact";

/** scheme: funds locked in the Klyx contract's escrow slot at
 *  openEscrow time, released to provider after the dispute window
 *  (or on requester ack). 2% Klyx fee, dispute recourse via
 *  Klyx contract's dispute path (Phase 3). */
export const SCHEME_KLYX_ESCROW = "klyx-escrow";

export const NETWORK_KLEVER_MAINNET = "klever-mainnet";
export const NETWORK_KLEVER_TESTNET = "klever-testnet";

export type Scheme = typeof SCHEME_EXACT | typeof SCHEME_KLYX_ESCROW;
export type KleverNetwork =
  | typeof NETWORK_KLEVER_MAINNET
  | typeof NETWORK_KLEVER_TESTNET;

export * from "./kleverExact.js";
export * from "./klyxEscrow.js";
