/**
 * Hono payment middleware — mirror of the express `paymentMiddleware`,
 * hono-idiomatic. Same wire behavior, same options shape (except
 * for `KleverWallet` etc. that don't change between frameworks).
 *
 * Why a separate file rather than a shared adapter:
 *   Express and Hono differ enough at the request/response boundary
 *   (req/res vs Context, header access, response-finished hook) that
 *   trying to abstract over both makes the code harder to read for
 *   both. Coinbase's `x402-express` / `x402-hono` follow the same
 *   pattern. Duplication is small and stable; if we add a 3rd
 *   framework we'll extract a shared core.
 *
 * Type augmentation:
 *   Hono uses per-Context variable typing via a generic. Consumers
 *   can `Hono<{ Variables: X402Variables }>()` to get typed
 *   `c.get('x402')` in their handlers. Without the generic, `.get`
 *   returns unknown (safe default).
 */

import { Buffer } from "node:buffer";
import type { MiddlewareHandler } from "hono";
import {
  FacilitatorClient,
  FacilitatorError,
} from "../core/facilitatorClient.js";
import type {
  Http402Body,
  PaymentOption,
  PaymentPayload,
  PaymentRequirements,
} from "../core/types.js";
import { X402_VERSION } from "../core/types.js";
import type { KleverNetwork, Scheme } from "../core/schemes/index.js";
import {
  SCHEME_EXACT,
  SCHEME_KLYX_ESCROW,
} from "../core/schemes/index.js";
import type { ReceiptEmitter } from "../receipts/emitter.js";

// ── Public option types ────────────────────────────────────

export interface HonoAcceptedPayment {
  scheme: Scheme;
  network: KleverNetwork;
  /** Base-10 integer string in the asset's smallest unit. */
  price: string;
  asset: string;
  description?: string;
  /** Klyx-escrow-only cap on the requester's dispute window. */
  maxDisputeWindowDays?: number;
}

export interface HonoPaymentMiddlewareOptions {
  facilitator: FacilitatorClient;
  /** Emitted verbatim in the 402 body's `paymentOptions[].facilitator.url`. */
  facilitatorUrl: string;
  /** klv1... bech32 address that receives payment. */
  payTo: string;
  /** At least one accepted (scheme, network, asset, price) tuple. */
  accepts: HonoAcceptedPayment[];
  /**
   * Override the `resource` field in emitted PaymentRequirements.
   * Defaults to the request path. Consumer can pass a fully-
   * qualified URL or a callback if they need the host prefix.
   */
  resource?: string | ((path: string) => string);
  /** Fire /settle in the background on 2xx completion (default true). */
  autoSettle?: boolean;
  /** Optional ReceiptEmitter — auto-emits on 2xx completion. */
  receiptEmitter?: ReceiptEmitter;
  /** Optional Klyx-registered endpoint UUID for receipts. */
  providerEndpointId?: string;
}

/** Variables the middleware sets on the Hono `Context` after a
 *  successful verify. Consumers can genericize their Hono instance
 *  to get typed access:
 *
 *    new Hono<{ Variables: X402Variables }>()
 *      .get('/premium', paymentMiddleware(opts), (c) => {
 *        const ctx = c.get('x402'); // typed
 *      });
 */
export interface X402Variables {
  x402: {
    payer: string;
    payload: PaymentPayload;
    requirements: PaymentRequirements;
  };
}

// ── Middleware factory ─────────────────────────────────────

export function paymentMiddleware(
  opts: HonoPaymentMiddlewareOptions,
): MiddlewareHandler {
  if (!opts.facilitator) {
    throw new Error("paymentMiddleware: facilitator required");
  }
  if (!opts.facilitatorUrl) {
    throw new Error("paymentMiddleware: facilitatorUrl required");
  }
  if (!opts.payTo) {
    throw new Error("paymentMiddleware: payTo required");
  }
  if (!opts.accepts || opts.accepts.length === 0) {
    throw new Error("paymentMiddleware: accepts must have at least one entry");
  }
  const autoSettle = opts.autoSettle ?? true;

  return async (c, next) => {
    const invokedAt = new Date().toISOString();
    const paymentHeader = c.req.header("x-payment");

    if (!paymentHeader) {
      return respondWith402(c, opts);
    }

    // Decode + shape-check envelope. Scheme-specific validation
    // happens at the facilitator; we just make sure the outer
    // shape is sane so we don't ship garbage across the wire.
    let paymentPayload: PaymentPayload;
    try {
      const decoded = Buffer.from(paymentHeader, "base64").toString("utf-8");
      const raw = JSON.parse(decoded) as PaymentPayload;
      if (
        !raw ||
        typeof raw.scheme !== "string" ||
        typeof raw.network !== "string" ||
        typeof raw.payload !== "object" ||
        raw.payload === null ||
        Array.isArray(raw.payload)
      ) {
        return respondWith402(c, opts, "malformed_payment_header");
      }
      paymentPayload = raw;
    } catch {
      return respondWith402(c, opts, "malformed_payment_header");
    }

    const acceptEntry = opts.accepts.find(
      (a) =>
        a.scheme === paymentPayload.scheme &&
        a.network === paymentPayload.network,
    );
    if (!acceptEntry) {
      return respondWith402(c, opts, "unsupported_scheme_network");
    }

    // Provider-side dispute-window cap (klyx-escrow only). Same
    // semantics as the express middleware — reject before the
    // facilitator RTT.
    if (
      acceptEntry.maxDisputeWindowDays !== undefined &&
      paymentPayload.scheme === SCHEME_KLYX_ESCROW
    ) {
      const escrow = paymentPayload.payload as { disputeWindowDays?: unknown };
      const days =
        typeof escrow.disputeWindowDays === "number"
          ? escrow.disputeWindowDays
          : Number.MAX_SAFE_INTEGER;
      if (days > acceptEntry.maxDisputeWindowDays) {
        return respondWith402(c, opts, "dispute_window_too_long");
      }
    }

    const paymentRequirements: PaymentRequirements = {
      scheme: acceptEntry.scheme,
      network: acceptEntry.network,
      maxAmountRequired: acceptEntry.price,
      resource: resolveResource(opts, c.req.path),
      payTo: opts.payTo,
      asset: acceptEntry.asset,
      ...(acceptEntry.description ? { description: acceptEntry.description } : {}),
    };

    let verifyResult;
    try {
      verifyResult = await opts.facilitator.verify({
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
      });
    } catch (err) {
      const code =
        err instanceof FacilitatorError ? err.code : "transport_error";
      return c.json({ error: "facilitator_error", code }, 502);
    }

    if (!verifyResult.body.isValid) {
      return respondWith402(
        c,
        opts,
        verifyResult.body.invalidReason ?? "invalid_payment",
      );
    }

    const payer = verifyResult.body.payer ?? "";
    c.set("x402", {
      payer,
      payload: paymentPayload,
      requirements: paymentRequirements,
    });

    // Run the route handler.
    await next();

    // Post-handler: fire settle + emit on 2xx. Hono has no
    // res.on('finish') equivalent, but since we're already past
    // await next(), the response is written; c.res.status is set.
    if (!autoSettle && !opts.receiptEmitter) return;
    if (c.res.status < 200 || c.res.status >= 300) return;

    // Fire settle in the background. `.catch(() => null)` swallows
    // failures so the receipt path can still run with fallback tx
    // hash extraction (see extractEscrowTxHash below — same pattern
    // as express.ts).
    const settlePromise: Promise<{
      body: { transaction?: string };
    } | null> = autoSettle
      ? opts.facilitator
          .settle({
            x402Version: X402_VERSION,
            paymentPayload,
            paymentRequirements,
          })
          .catch(() => null)
      : Promise.resolve(null);

    if (opts.receiptEmitter) {
      const emitter = opts.receiptEmitter;
      const nonce = (paymentPayload.payload as { nonce?: unknown }).nonce;
      if (typeof nonce === "string" && nonce.length > 0) {
        const requesterAgentUserId = c.req.header("x-klyx-requester-agent");
        settlePromise.then((settleRes) => {
          const paymentTxHash =
            settleRes?.body.transaction ??
            extractEscrowTxHash(paymentPayload);
          void emitter.emit({
            outcome: "completed",
            requesterWallet: payer || undefined,
            requesterAgentUserId: requesterAgentUserId || undefined,
            paymentAsset: paymentRequirements.asset,
            paymentAmountSmallest: paymentRequirements.maxAmountRequired,
            paymentTxHash,
            settlementType: mapSettlementType(paymentPayload.scheme),
            invokedAt,
            completedAt: new Date().toISOString(),
            nonce,
            capability: paymentRequirements.description,
            providerEndpointId: opts.providerEndpointId,
          });
        });
      }
    }
    return;
  };
}

// ── Helpers (mirror the express.ts equivalents) ────────────

function respondWith402(
  c: Parameters<MiddlewareHandler>[0],
  opts: HonoPaymentMiddlewareOptions,
  errorCode?: string,
): Response {
  const resource = resolveResource(opts, c.req.path);
  const paymentOptions: PaymentOption[] = opts.accepts.map((a) => ({
    scheme: a.scheme,
    network: a.network,
    maxAmountRequired: a.price,
    resource,
    payTo: opts.payTo,
    asset: a.asset,
    ...(a.description ? { description: a.description } : {}),
    facilitator: { url: opts.facilitatorUrl },
  }));
  const body: Http402Body = {
    x402Version: X402_VERSION,
    error: errorCode ?? "x_payment_required",
    paymentOptions,
  };
  return c.json(body, 402);
}

function resolveResource(
  opts: HonoPaymentMiddlewareOptions,
  path: string,
): string {
  if (typeof opts.resource === "string") return opts.resource;
  if (typeof opts.resource === "function") return opts.resource(path);
  return path;
}

function mapSettlementType(
  scheme: string,
): "direct" | "managed" | "external" {
  if (scheme === SCHEME_EXACT) return "direct";
  if (scheme === SCHEME_KLYX_ESCROW) return "managed";
  return "external";
}

function extractEscrowTxHash(
  paymentPayload: PaymentPayload,
): string | undefined {
  if (paymentPayload.scheme !== SCHEME_KLYX_ESCROW) return undefined;
  const escrowPayload = paymentPayload.payload as { openEscrowTx?: unknown };
  return typeof escrowPayload.openEscrowTx === "string"
    ? escrowPayload.openEscrowTx
    : undefined;
}
