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
 *
 * Hardening (v0.1.x per issues #609 / #611 / #612):
 * - Constructor validates the URL scheme + rejects private hosts
 *   unless explicit opt-in (SSRF surface).
 * - Constructor requires an explicit `allowUnsigned` flag when
 *   `publicKeysHex` is empty (no more silent signature-verify
 *   bypass on a misconfigured caller).
 * - Constructor validates each key in `publicKeysHex` is 32-byte
 *   lowercase hex (no more all-verifies-fail from a malformed
 *   rotation set).
 * - Request timeout scope covers the response body read too (was
 *   previously only the fetch handshake — a stalled body hung the
 *   client forever). Response body size capped at 64 KiB.
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
  /** Base URL of the facilitator. Must be http(s). Rejected if the
   *  host resolves as private/loopback unless
   *  `allowPrivateTargets: true` is set. */
  url: string;
  /**
   * Ed25519 public keys (lowercase hex, 32 bytes / 64 chars) the
   * caller considers valid signers for this facilitator. In
   * production this comes from the on-chain rotation set — see the
   * `RotationSetCache` (added in a follow-up PR) for a Klever-
   * contract-backed source.
   *
   * A response with a signature that verifies against ANY key in
   * this list is accepted. Empty array = accept unsigned, but ONLY
   * when `allowUnsigned: true` is ALSO set (see below) — otherwise
   * the constructor throws to prevent silent bypasses.
   */
  publicKeysHex: string[];
  /**
   * Opt-in to unsigned mode (signature verification skipped). Only
   * safe for local dev/mock scenarios; a production caller with a
   * misconfigured rotation-set fetcher must NOT reach this branch
   * silently, so the constructor enforces the pairing:
   * `publicKeysHex: []` + `allowUnsigned: true`.
   */
  allowUnsigned?: boolean;
  /**
   * Opt-in to accepting a facilitator URL that resolves to a
   * private/loopback address (localhost, 127.0.0.0/8, RFC1918,
   * 169.254.0.0/16). Required for docker-compose dev + service-
   * mesh setups; rejected by default so a malicious 402 body
   * can't point the client at 169.254.169.254 (cloud metadata
   * endpoint) or an internal service.
   */
  allowPrivateTargets?: boolean;
  /** Request + response-body timeout in ms. Default 15s. */
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
    readonly code: FacilitatorErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FacilitatorError";
  }
}

export type FacilitatorErrorCode =
  | "http_error"
  | "signature_missing"
  | "signature_invalid"
  | "malformed_response"
  | "body_too_large"
  | "timeout"
  | "transport_error";

const HEADER_SIGNATURE = "x-klyx-facilitator-signature";

/** Cap facilitator response bodies. Well-behaved responses are
 *  <2 KiB (signed verify/settle envelopes); 64 KiB gives a very
 *  generous headroom. Guards against a malicious/broken server
 *  streaming a multi-GB body and exhausting caller heap. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export class FacilitatorClient {
  private readonly url: string;
  private readonly publicKeysHex: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FacilitatorClientOptions) {
    if (!opts.url) throw new Error("FacilitatorClient: url required");

    // URL scheme + private-host validation. Rejects non-http(s)
    // and (by default) private/loopback hosts to close the SSRF
    // surface — a 402 body that points at 169.254.169.254 or an
    // internal service should not be silently fetched.
    let parsed: URL;
    try {
      parsed = new URL(opts.url);
    } catch {
      throw new Error(`FacilitatorClient: invalid url: ${opts.url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `FacilitatorClient: unsupported protocol ${parsed.protocol}; only http(s) allowed`,
      );
    }
    if (!opts.allowPrivateTargets && isPrivateHost(parsed.hostname)) {
      throw new Error(
        `FacilitatorClient: hostname ${parsed.hostname} is private/loopback; ` +
          `pass allowPrivateTargets: true if intentional (dev docker, service mesh)`,
      );
    }

    // Public-key validation. Empty array is only allowed when
    // paired with allowUnsigned — otherwise a caller who forgot
    // to populate the rotation set silently accepts every response.
    if (opts.publicKeysHex.length === 0 && !opts.allowUnsigned) {
      throw new Error(
        "FacilitatorClient: publicKeysHex is empty; pass allowUnsigned: true " +
          "explicitly for dev/mock mode (dangerous in production)",
      );
    }
    // Every key must be 32-byte lowercase hex. Fail loud at
    // construction rather than silent-invalid-signature on every
    // request when the caller's rotation-set fetcher returned junk.
    opts.publicKeysHex.forEach((k, i) => {
      if (!/^[0-9a-f]{64}$/.test(k)) {
        throw new Error(
          `FacilitatorClient: publicKeysHex[${i}] must be 32-byte lowercase hex (64 chars)`,
        );
      }
    });

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
    let canonicalBody: string;
    try {
      resp = await this.fetchImpl(this.url + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Check declared content-length BEFORE reading. A malicious
      // facilitator with a huge Content-Length header is rejected
      // without allocating memory for the body.
      const declared = parseInt(
        resp.headers.get("content-length") ?? "0",
        10,
      );
      if (declared > MAX_RESPONSE_BYTES) {
        throw new FacilitatorError(
          `facilitator ${path} response declared ${declared} bytes (max ${MAX_RESPONSE_BYTES})`,
          "body_too_large",
          resp.status,
        );
      }
      // Body read is inside the AbortController scope now, so a
      // facilitator that sends headers then stalls the body is
      // aborted at timeoutMs rather than hanging forever.
      canonicalBody = await resp.text();
      // Post-read cap in case server omitted or lied about
      // Content-Length. Costs a length check on the allocated string.
      if (canonicalBody.length > MAX_RESPONSE_BYTES) {
        throw new FacilitatorError(
          `facilitator ${path} response body ${canonicalBody.length} bytes exceeds ${MAX_RESPONSE_BYTES}`,
          "body_too_large",
          resp.status,
        );
      }
    } catch (err) {
      if (err instanceof FacilitatorError) throw err;
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

    if (!resp.ok && !isRecoverableStatus(resp.status)) {
      throw new FacilitatorError(
        `facilitator ${path} returned HTTP ${resp.status}`,
        "http_error",
        resp.status,
      );
    }

    const signatureHex = resp.headers.get(HEADER_SIGNATURE);
    let acceptedKey = "";
    if (this.publicKeysHex.length > 0) {
      if (!signatureHex) {
        throw new FacilitatorError(
          `facilitator ${path} response missing ${HEADER_SIGNATURE} header`,
          "signature_missing",
        );
      }
      const key = firstMatchingKey(
        canonicalBody,
        signatureHex,
        this.publicKeysHex,
      );
      if (!key) {
        throw new FacilitatorError(
          `facilitator ${path} signature did not verify against any known key`,
          "signature_invalid",
        );
      }
      acceptedKey = key;
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
      signatureHex: signatureHex ?? "",
      publicKeyHex: acceptedKey,
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

/**
 * True if a hostname is a loopback / RFC1918 / link-local address
 * that a client library should refuse to hit unless the caller
 * explicitly opted in. Only IPv4 numeric checks + a small set of
 * IPv6 loopback literals — hostnames that resolve via DNS to
 * private addresses aren't caught here (would require a DNS
 * lookup, out of scope for a sync constructor).
 */
function isPrivateHost(host: string): boolean {
  if (host === "localhost") return true;
  if (host === "::1" || host === "[::1]") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const oct1 = Number(v4[1]);
  const oct2 = Number(v4[2]);
  // 127.0.0.0/8 — loopback
  if (oct1 === 127) return true;
  // 10.0.0.0/8
  if (oct1 === 10) return true;
  // 172.16.0.0/12
  if (oct1 === 172 && oct2 >= 16 && oct2 <= 31) return true;
  // 192.168.0.0/16
  if (oct1 === 192 && oct2 === 168) return true;
  // 169.254.0.0/16 — link-local (AWS metadata etc.)
  if (oct1 === 169 && oct2 === 254) return true;
  return false;
}
