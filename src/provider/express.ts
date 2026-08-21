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

    if (autoSettle) {
      res.on("finish", () => {
        // Only settle on 2xx. Non-2xx = client got an error;
        // charging them for a failed request would be wrong.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          opts.facilitator
            .settle({
              x402Version: X402_VERSION,
              paymentPayload,
              paymentRequirements,
            })
            .catch(() => {
              // Silent — settlement failure is out-of-band. A
              // production consumer should either handle this
              // (attach a logger via a wrapper) or run a
              // reconciliation worker.
            });
        }
      });
    }

    next();
  };
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
