/**
 * Thin HTTP client for the Klyx x402 facilitator.
 *
 * Wraps POST /verify and POST /settle. Also handles the two things
 * a hand-roll trips over most often:
 *
 *   1. Reading the raw response body (not a re-serialized parse) so
 *      the X-Klyx-Facilitator-Signature verifies against what the
 *      wire actually carried — `JSON.parse` + `JSON.stringify` will
 *      drift and the sig will fail even on an honest server.
 *   2. Verifying the facilitator's response signature against a
 *      caller-provided public key (or set of keys — supports the
 *      on-chain rotation set).
 *
 * The Klyx contract's `facilitatorPublicKeys()` view is where a
 * production caller learns which keys are valid; keeping that
 * fetch out of this client (in a separate rotation-set module) lets
 * this stay a pure HTTP + signature primitive.
 */

import { verifyFacilitatorSignature } from "./signing.js";
import type {
  SettleRequest,
  SettleResponse,
  SignedFacilitatorResponse,
  VerifyRequest,
  VerifyResponse,
} from "./types.js";

export interface FacilitatorClientOptions {
  /** Base URL of the facilitator (no trailing slash). */
  url: string;
  /**
   * Ed25519 public keys (hex, 32 bytes / 64 chars) the caller
   * considers valid signers for this facilitator. In production
   * this comes from the on-chain rotation set — see the
   * `RotationSetCache` (added in a follow-up PR) for a Klever-
   * contract-backed source.
   *
   * A response with a signature that verifies against ANY key in
   * this list is accepted. Empty array = accept unsigned (only
   * safe for local dev/mock scenarios; the client throws on any
   * non-empty verification failure).
   */
  publicKeysHex: string[];
  /** Request timeout in ms. Default 15s. */
  timeoutMs?: number;
  /**
   * Optional fetch implementation for tests / non-node runtimes.
   * Defaults to the global `fetch`.
   */
  fetch?: typeof fetch;
}

export class FacilitatorError extends Error {
  constructor(
    message: string,
    readonly code:
      | "http_error"
      | "signature_missing"
      | "signature_invalid"
      | "malformed_response"
      | "timeout"
      | "transport_error",
    readonly status?: number,
  ) {
    super(message);
    this.name = "FacilitatorError";
  }
}

const HEADER_SIGNATURE = "x-klyx-facilitator-signature";

export class FacilitatorClient {
  private readonly url: string;
  private readonly publicKeysHex: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FacilitatorClientOptions) {
    if (!opts.url) throw new Error("FacilitatorClient: url required");
    this.url = opts.url.replace(/\/+$/, "");
    this.publicKeysHex = opts.publicKeysHex;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async verify(
    request: VerifyRequest,
  ): Promise<SignedFacilitatorResponse<VerifyResponse>> {
    return this.post<VerifyResponse>("/verify", request);
  }

  async settle(
    request: SettleRequest,
  ): Promise<SignedFacilitatorResponse<SettleResponse>> {
    return this.post<SettleResponse>("/settle", request);
  }

  private async post<T>(
    path: string,
    body: unknown,
  ): Promise<SignedFacilitatorResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.url + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        throw new FacilitatorError(
          `facilitator ${path} timed out after ${this.timeoutMs}ms`,
          "timeout",
        );
      }
      throw new FacilitatorError(
        `facilitator ${path} transport error: ${(err as Error).message}`,
        "transport_error",
      );
    } finally {
      clearTimeout(timer);
    }

    // Read the raw text so signature verification runs against the
    // exact wire bytes. Re-serializing the parsed JSON would drift
    // (key order, whitespace) and fail even honest signatures.
    const canonicalBody = await resp.text();

    if (!resp.ok && !isRecoverableStatus(resp.status)) {
      throw new FacilitatorError(
        `facilitator ${path} returned HTTP ${resp.status}: ${canonicalBody.slice(0, 200)}`,
        "http_error",
        resp.status,
      );
    }

    const signatureHex = resp.headers.get(HEADER_SIGNATURE);
    if (this.publicKeysHex.length > 0) {
      if (!signatureHex) {
        throw new FacilitatorError(
          `facilitator ${path} response missing ${HEADER_SIGNATURE} header`,
          "signature_missing",
        );
      }
      const acceptedKey = firstMatchingKey(
        canonicalBody,
        signatureHex,
        this.publicKeysHex,
      );
      if (!acceptedKey) {
        throw new FacilitatorError(
          `facilitator ${path} signature did not verify against any known key`,
          "signature_invalid",
        );
      }
      let parsed: T;
      try {
        parsed = JSON.parse(canonicalBody) as T;
      } catch (err) {
        throw new FacilitatorError(
          `facilitator ${path} response not valid JSON: ${(err as Error).message}`,
          "malformed_response",
        );
      }
      return {
        body: parsed,
        canonicalBody,
        signatureHex,
        publicKeyHex: acceptedKey,
      };
    }

    // Unsigned mode — dev/mock only. Just parse the body.
    let parsed: T;
    try {
      parsed = JSON.parse(canonicalBody) as T;
    } catch (err) {
      throw new FacilitatorError(
        `facilitator ${path} response not valid JSON: ${(err as Error).message}`,
        "malformed_response",
      );
    }
    return {
      body: parsed,
      canonicalBody,
      signatureHex: signatureHex ?? "",
      publicKeyHex: "",
    };
  }
}

function firstMatchingKey(
  canonicalBody: string,
  signatureHex: string,
  keys: string[],
): string | null {
  for (const publicKeyHex of keys) {
    try {
      const ok = verifyFacilitatorSignature({
        canonicalBody,
        signatureHex,
        publicKeyHex,
      });
      if (ok) return publicKeyHex;
    } catch {
      // Malformed key/sig — try the next key. Only surface the
      // aggregate "no key verified" error.
    }
  }
  return null;
}

/**
 * The facilitator returns 400 for a spec-compliant "malformed
 * request" response body — that body is still signed + should be
 * surfaced to the caller rather than thrown as a transport error.
 */
function isRecoverableStatus(status: number): boolean {
  return status === 400;
}
