/**
 * Receipt input shape — mirrors the Klyx AgentReceiptSchema at
 * server/src/schemas/AgentReceiptSchema.ts. Fields the emitter
 * derives (providerAgentUserId, providerAttestation,
 * providerAttestationScheme, canonicalReceiptHash) are NOT part of
 * ReceiptInput — they're set from ReceiptEmitterOptions and the
 * signing step, not from the caller.
 */
export interface ReceiptInput {
  /** UUID of the Klyx endpoint this receipt is for (optional; not
   *  every Klyx-registered agent maps 1:1 to on-Klyx endpoints). */
  providerEndpointId?: string;
  /** Short capability name for the endpoint (e.g. "summarize"). */
  capability?: string;
  /** Terminal outcome of the invocation. */
  outcome: "completed" | "failed" | "timed_out" | "disputed";
  /** Requester wallet address (klv1... bech32) — from the x402
   *  payload's authorization.signer field. */
  requesterWallet?: string;
  /** Requester agent UUID — if the caller identified themselves
   *  via the `X-Klyx-Requester-Agent` header per ADR-017 D13. */
  requesterAgentUserId?: string;
  /** Asset the payment was made in (KLV or KDA-XXXX). */
  paymentAsset: string;
  /** Payment amount in smallest units, base-10 integer string. */
  paymentAmountSmallest: string;
  /** On-chain tx hash — from the facilitator's /settle response. */
  paymentTxHash?: string;
  /** Which x402 settlement flow was used. */
  settlementType?: "direct" | "managed" | "external";
  /** Fee amount (2% for managed escrow settlement), if applicable. */
  feeAmountSmallest?: string;
  /** Hash of the request payload — SHA-256 hex or similar. */
  inputHash?: string;
  /** Hash of the response payload. */
  outputHash?: string;
  /** ISO-8601 timestamp when the invocation started. */
  invokedAt: string;
  /** ISO-8601 timestamp when the invocation completed. */
  completedAt?: string;
  /** Nonce from the x402 payment payload — Klyx's dedup key
   *  (UNIQUE constraint on the receipts table). */
  nonce: string;
  /** Arbitrary metadata for the caller's use (indexed for search). */
  metadata?: Record<string, unknown>;
  /** Chain-specific settlement details (block, tx, event index). */
  chainRef?: Record<string, unknown>;
}

/**
 * Klyx server DTO returned on a successful POST /api/agents/receipts.
 * Only the fields the emitter surfaces — the full DTO has more.
 */
export interface EmittedReceipt {
  receiptId: string;
  /** State from the server. 'signed' if both sides attested;
   *  'pending_sigs' if only provider attested (requester can
   *  later add via POST /api/agents/receipts/:id/sign). */
  state: "signed" | "pending_sigs" | string;
}

/** Attestation scheme identifier per ADR-017 D17. Only klv-ed25519
 *  produced by this client today; the union stays open to match
 *  the server schema. */
export type AttestationScheme =
  | "klv-ed25519"
  | "sol-ed25519"
  | "evm-personal"
  | "btc-message";
