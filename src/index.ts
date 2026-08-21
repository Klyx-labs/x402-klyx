/**
 * x402-klyx public API.
 *
 * v0 exports the core primitives — types, canonicalizer, scheme
 * builders, facilitator client. The provider middleware and
 * requester interceptor land in follow-up PRs and re-export from
 * here.
 */

export const VERSION = "0.1.0";

// Types + protocol constants
export type {
  PaymentPayload,
  PaymentRequirements,
  VerifyRequest,
  VerifyResponse,
  SettleRequest,
  SettleResponse,
  PaymentOption,
  Http402Body,
  SignedFacilitatorResponse,
} from "./core/types.js";
export { X402_VERSION } from "./core/types.js";

// Canonical serialization (must match the facilitator byte-for-byte)
export { canonicalize } from "./core/canonicalize.js";

// Ed25519 signing / verification primitives
export {
  signAttestation,
  derivePublicKey,
  verifyFacilitatorSignature,
  hexToBytes,
  bytesToHex,
} from "./core/signing.js";

// Scheme constants + builders
export {
  SCHEME_EXACT,
  SCHEME_KLYX_ESCROW,
  NETWORK_KLEVER_MAINNET,
  NETWORK_KLEVER_TESTNET,
} from "./core/schemes/index.js";
export type { Scheme, KleverNetwork } from "./core/schemes/index.js";

export type {
  KleverExactPayload,
  KleverExactBuildInput,
} from "./core/schemes/kleverExact.js";
export {
  buildAndSignKleverExactPayload,
  canonicalizeForAttestation,
  parseKleverExactPayload,
} from "./core/schemes/kleverExact.js";

export type {
  KlyxEscrowPayload,
  KlyxEscrowBuildInput,
} from "./core/schemes/klyxEscrow.js";
export {
  buildKlyxEscrowPayload,
  parseKlyxEscrowPayload,
} from "./core/schemes/klyxEscrow.js";

// Facilitator HTTP client
export {
  FacilitatorClient,
  FacilitatorError,
} from "./core/facilitatorClient.js";
export type {
  FacilitatorClientOptions,
  FacilitatorErrorCode,
} from "./core/facilitatorClient.js";

// Provider middleware (express)
export { paymentMiddleware } from "./provider/express.js";
export type {
  PaymentMiddlewareOptions,
  AcceptedPayment,
} from "./provider/express.js";

// Requester interceptor (fetch)
export {
  withPaymentInterceptor,
  PaymentError,
} from "./requester/fetch.js";
export type {
  KleverWallet,
  WithPaymentInterceptorOptions,
  PaymentAttemptInfo,
  PaymentErrorCode,
} from "./requester/fetch.js";
