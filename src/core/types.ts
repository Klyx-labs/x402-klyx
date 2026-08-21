/**
 * Public type surface for x402-klyx.
 *
 * These types mirror the x402 spec's PaymentPayload +
 * PaymentRequirements envelopes and the Klyx facilitator's
 * /verify + /settle request/response bodies verbatim. Any diff
 * between these shapes and the facilitator's `types.ts` is a bug —
 * the two must stay in lockstep so a client library user's payload
 * validates on the wire.
 *
 * The `payload` field on PaymentPayload is opaque to core; each
 * scheme (see ./schemes/) defines its own typed shape.
 */

/**
 * x402 standard PaymentPayload — envelope for a payment proof. The
 * facilitator that supports the (scheme, network) tuple decodes the
 * inner `payload` per its scheme spec.
 */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
}

/**
 * x402 standard PaymentRequirements — one entry from the
 * paymentOptions[] array in a 402 body. The facilitator cross-checks
 * an inbound PaymentPayload against the corresponding requirements
 * so a caller can't pay $0.01 on-chain and claim to have paid $10
 * for the endpoint.
 */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset: string;
  extra?: Record<string, unknown>;
}

/** x402 standard /verify request body. */
export interface VerifyRequest {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

/**
 * x402 standard /verify response body.
 *
 * `invalidReason` values are documented per-scheme in the Klyx
 * facilitator schemes/. Convention: lowercase snake_case, stable
 * across facilitator versions so clients can pattern-match without
 * a spec bump.
 */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

/** x402 standard /settle request body — same shape as /verify. */
export type SettleRequest = VerifyRequest;

/** x402 standard /settle response body. */
export interface SettleResponse {
  success: boolean;
  transaction?: string;
  network: string;
  payer: string;
  errorReason?: string;
}

/**
 * One entry inside an HTTP 402 body's `paymentOptions[]`. Providers
 * emit one of these per (scheme, network, asset) they accept for a
 * given resource. Callers pick one and build a matching payload.
 */
export interface PaymentOption extends PaymentRequirements {
  facilitator: { url: string };
}

/**
 * Full HTTP 402 body a provider emits when a request lacks a valid
 * X-PAYMENT header. Mirrors the x402 spec.
 */
export interface Http402Body {
  x402Version: number;
  error: string;
  paymentOptions: PaymentOption[];
}

/**
 * Signed-response envelope after client-side verification. Callers
 * who need to prove they saw a facilitator sig (e.g. when emitting
 * receipts) can round-trip this shape.
 */
export interface SignedFacilitatorResponse<T> {
  body: T;
  canonicalBody: string;
  signatureHex: string;
  publicKeyHex: string;
}

/** x402 protocol version this library implements. */
export const X402_VERSION = 1;
