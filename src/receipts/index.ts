/**
 * Receipt-emission helpers for feeding Klyx agent reputation
 * after settled x402 payments. Standalone-usable + auto-wire-able
 * into paymentMiddleware via its `receiptEmitter` option.
 */
export * from "./emitter.js";
export * from "./types.js";
