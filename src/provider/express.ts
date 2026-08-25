/**
 * Express payment middleware — the "drop-in for accepting paid
 * invocations" side of x402-klyx.
 *
 * A route wrapped in this middleware:
 *   1. Emits HTTP 402 with a spec-compliant paymentOptions[] when
 *      no `X-PAYMENT` header is present.
 *   2. On a request WITH `X-PAYMENT`, base64-decodes + parses the
 *      payload, cross-checks it against the accepted (scheme,
 *      network) entries declared here, and calls `/verify` on the
 *      injected FacilitatorClient.
 *   3. On isValid=true, attaches the payment context to
 *      `req.x402` and passes control to the next handler.
 *   4. When the response finishes with a 2xx status, fires
 *      `/settle` on the facilitator in the background (unless
 *      `autoSettle: false`).
 *
 * Non-2xx responses do NOT settle — the client got an error, so
 * charging them would be wrong. Settle failures are logged
 * silently; retries + observability belong in a settlement worker.
 *
 * Receipt emission (POST /api/agents/receipts) is a separate
 * concern with its own signer + endpoint config, and is not part
 * of this middleware. A companion `receiptEmitter()` helper will
 * land in a follow-up PR.
 */

import { Buffer } from "node:buffer";
import type { Request, Response, RequestHandler } from "express";
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

// Augment express Request so downstream handlers can read
// `req.x402?.payer` etc. with typed autocomplete. Optional field —
// only populated after successful verification.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      x402?: {
        payer: string;
        payload: PaymentPayload;
        requirements: PaymentRequirements;
      };
    }
  }
}

export interface AcceptedPayment {
  /** Payment scheme (e.g. exact, klyx-escrow). */
  scheme: Scheme;
  /** Klever network (mainnet or testnet). */
  network: KleverNetwork;
  /** Minimum amount required, base-10 integer string in the
   *  asset's smallest unit (KLV is 6-decimals, so 500000 = 0.5 KLV). */
  price: string;
  /** Asset id — "KLV" or "KDA-XXXX". */
  asset: string;
  /** Optional human-readable description shown in the 402 body. */
  description?: string;
  /**
   * Optional cap on how long a klyx-escrow payment can lock the
   * funds. Klyx-escrow only — has no effect on klever-exact
   * (direct settlement, no window). Rejects payloads with
   * `disputeWindowDays > maxDisputeWindowDays` at the middleware
   * layer (before calling facilitator.verify) with a 402 body
   * carrying `error: "dispute_window_too_long"`.
   *
   * Use case: a provider who doesn't want to wait 60 days for
   * funds can set this to 7, and requesters offering longer
   * windows get bounced immediately with a clear signal to
   * shorten. Contract enforces its own max (60d default); this
   * is the PROVIDER'S preference on top.
   */
  maxDisputeWindowDays?: number;
}

export interface PaymentMiddlewareOptions {
  /**
   * FacilitatorClient instance the middleware calls for /verify +
   * /settle. Construct once at app setup and share across
   * middlewares; the client validates its own inputs at
   * construction so a misconfigured facilitator fails fast, not
   * per-request.
   */
  facilitator: FacilitatorClient;
  /**
   * URL of the facilitator, emitted in the 402 body's
   * `paymentOptions[].facilitator.url` field so clients know where
   * to send /verify. Usually the same URL you passed to the
   * FacilitatorClient constructor.
   */
  facilitatorUrl: string;
  /** klv1... bech32 address that receives payment. */
  payTo: string;
  /**
   * Payment options accepted for this route. At least one entry
   * required. Every entry becomes one item in the 402 body's
   * paymentOptions array.
   */
  accepts: AcceptedPayment[];
  /**
   * Override the `resource` field in emitted PaymentRequirements.
   * Defaults to `${req.baseUrl}${req.path}`. Provide a fully
   * qualified URL (or a callback) if you want it to include host
   * + protocol — useful when behind a proxy where `req.get('host')`
   * doesn't reflect the client-facing URL.
   */
  resource?: string | ((req: Request) => string);
  /**
   * Call /settle on the facilitator after a 2xx response. Default
   * `true`. Set `false` if your flow settles out-of-band (a
   * background worker polling receipts, or a manual reconcile job).
   */
  autoSettle?: boolean;
  /**
   * Optional ReceiptEmitter — if set, fires an ADR-013 receipt to
   * Klyx after each 2xx completion. Non-2xx responses skip both
   * settle and receipt (client got an error → don't record it as a
   * completed invocation). Emission is fire-and-forget; failures
   * surface via the emitter's `onError` hook, never as request
   * failures.
   *
   * Wire this in so receipts are the DEFAULT path for your agent
   * — that's the point of the reputation flywheel. Skipping is a
   * per-agent design decision, not a per-payment default.
   */
  receiptEmitter?: ReceiptEmitter;
  /**
   * Optional endpoint UUID for the receipt's providerEndpointId
   * field. Only meaningful when `receiptEmitter` is set. Leave
   * unset if this route doesn't map to a registered Klyx endpoint.
   */
  providerEndpointId?: string;
}

export function paymentMiddleware(
  opts: PaymentMiddlewareOptions,
): RequestHandler {
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

  return async (req, res, next) => {
    // Capture invocation start time BEFORE any I/O so the receipt's
    // invokedAt reflects when the request actually landed.
    const invokedAt = new Date().toISOString();
    const paymentHeader = req.header("x-payment");

    if (!paymentHeader) {
      respondWith402(res, opts, req);
      return;
    }

    // Base64 decode + JSON parse the payload. Shape-check the
    // outer envelope; scheme-specific validation happens at the
    // facilitator (client-side re-validation would just duplicate
    // it and drift over time).
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
        respondWith402(res, opts, req, "malformed_payment_header");
        return;
      }
      paymentPayload = raw;
    } catch {
      respondWith402(res, opts, req, "malformed_payment_header");
      return;
    }

    // Match the incoming (scheme, network) against our accepted
    // entries. If none match, re-emit the 402 so the client can
    // pick a supported option — the router doesn't gate on shape,
    // the middleware does.
    const acceptEntry = opts.accepts.find(
      (a) =>
        a.scheme === paymentPayload.scheme &&
        a.network === paymentPayload.network,
    );
    if (!acceptEntry) {
      respondWith402(res, opts, req, "unsupported_scheme_network");
      return;
    }

    // Provider-side dispute-window cap (klyx-escrow only). Rejects
    // before hitting the facilitator so we don't waste an RTT on a
    // payload we already know we don't want. klever-exact has no
    // dispute window (direct settlement) — check is a no-op there.
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
        respondWith402(res, opts, req, "dispute_window_too_long");
        return;
      }
    }

    const paymentRequirements: PaymentRequirements = {
      scheme: acceptEntry.scheme,
      network: acceptEntry.network,
      maxAmountRequired: acceptEntry.price,
      resource: resolveResource(opts, req),
      payTo: opts.payTo,
      asset: acceptEntry.asset,
      ...(acceptEntry.description
        ? { description: acceptEntry.description }
        : {}),
    };

    // Verify via facilitator. Signature verification of the
    // response is handled inside FacilitatorClient.
    let verifyResult;
    try {
      verifyResult = await opts.facilitator.verify({
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
      });
    } catch (err) {
      // Transport / signature-invalid / body_too_large / timeout —
      // surface as 502 with the structured error code. Callers can
      // switch on `code` to decide retry vs alert.
      const code =
        err instanceof FacilitatorError ? err.code : "transport_error";
      res.status(502).json({ error: "facilitator_error", code });
      return;
    }

    if (!verifyResult.body.isValid) {
      respondWith402(
        res,
        opts,
        req,
        verifyResult.body.invalidReason ?? "invalid_payment",
      );
      return;
    }

    // Verified — attach payment context for the downstream handler
    // and register the settle-on-finish hook.
    const payer = verifyResult.body.payer ?? "";
    req.x402 = {
      payer,
      payload: paymentPayload,
      requirements: paymentRequirements,
    };

    if (autoSettle || opts.receiptEmitter) {
      res.on("finish", () => {
        // Only settle + emit on 2xx. Non-2xx = client got an
        // error; charging them for a failed request or emitting
        // a "completed" receipt would both be wrong.
        if (res.statusCode < 200 || res.statusCode >= 300) return;

        // Fire settle in the background (if enabled). Capture
        // the settle response so the receipt can include the
        // tx hash. `.catch(() => null)` here means a settle
        // failure DOES NOT block receipt emission — the receipt
        // is still meaningful without the tx hash and can be
        // reconciled later.
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
          const nonce = (paymentPayload.payload as { nonce?: unknown })
            .nonce;
          if (typeof nonce === "string" && nonce.length > 0) {
            const requesterAgentUserId = req.header(
              "x-klyx-requester-agent",
            );
            settlePromise.then((settleRes) => {
              // Prefer the settle response's tx hash; fall back to
              // the payload's openEscrowTx for klyx-escrow (funds
              // already locked at openEscrow time — that's the
              // on-chain settlement anchor, and the facilitator's
              // settle for this scheme is a pass-through anyway).
              //
              // The fallback also covers the current facilitator
              // bug where settle re-verifies + trips nonce_reused
              // and returns success=false → no transaction field —
              // without this fallback, klyx-escrow receipts land
              // with paymentTxHash=null even though the openEscrow
              // tx is right there in the payload.
              const paymentTxHash =
                settleRes?.body.transaction ??
                extractEscrowTxHash(paymentPayload);
              void emitter.emit({
                outcome: "completed",
                requesterWallet: payer || undefined,
                requesterAgentUserId: requesterAgentUserId || undefined,
                paymentAsset: paymentRequirements.asset,
                paymentAmountSmallest:
                  paymentRequirements.maxAmountRequired,
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
          // If nonce is somehow missing (schema violation the
          // facilitator would have caught, but defensive), skip
          // the receipt silently. The middleware's contract to
          // the caller is unaffected.
        }
      });
    }

    next();
  };
}

/** Map an x402 scheme to the receipt schema's settlementType.
 *  Unrecognized schemes default to "external" — the receipt schema
 *  supports it; used when a facilitator routes payment through a
 *  non-Klever chain (base/solana/etc.) in a future scheme. */
function mapSettlementType(
  scheme: string,
): "direct" | "managed" | "external" {
  if (scheme === SCHEME_EXACT) return "direct";
  if (scheme === SCHEME_KLYX_ESCROW) return "managed";
  return "external";
}

/** For klyx-escrow, the on-chain settlement anchor is the
 *  openEscrow tx that the requester submitted before hitting the
 *  provider. That hash lives in the payload's `openEscrowTx` field
 *  so we can populate paymentTxHash from the payload directly
 *  when settle didn't return one. Returns undefined for other
 *  schemes or malformed payloads. */
function extractEscrowTxHash(
  paymentPayload: PaymentPayload,
): string | undefined {
  if (paymentPayload.scheme !== SCHEME_KLYX_ESCROW) return undefined;
  const escrowPayload = paymentPayload.payload as { openEscrowTx?: unknown };
  return typeof escrowPayload.openEscrowTx === "string"
    ? escrowPayload.openEscrowTx
    : undefined;
}

function respondWith402(
  res: Response,
  opts: PaymentMiddlewareOptions,
  req: Request,
  errorCode?: string,
): void {
  const resource = resolveResource(opts, req);
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
  res.status(402).json(body);
}

function resolveResource(
  opts: PaymentMiddlewareOptions,
  req: Request,
): string {
  if (typeof opts.resource === "string") return opts.resource;
  if (typeof opts.resource === "function") return opts.resource(req);
  return `${req.baseUrl}${req.path}`;
}
