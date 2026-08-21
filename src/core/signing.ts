/**
 * Ed25519 primitives for the x402-klyx client.
 *
 * Two roles:
 *   - `signAttestation` — sign the canonical bytes of a klever-exact
 *     payload with a wallet's ed25519 key. The Klyx facilitator will
 *     recompute the same bytes and verify against the pubkey the
 *     caller declared in `authorization.publicKey`.
 *   - `verifyFacilitatorSignature` — verify the sig the facilitator
 *     attaches to /verify + /settle responses (in the
 *     X-Klyx-Facilitator-Signature header) against the public key
 *     the caller learned from the on-chain rotation set.
 *
 * Uses @noble/ed25519 v2 — the same primitive the facilitator uses,
 * so bytes signed on one side verify byte-for-byte on the other.
 */

import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";

// @noble/ed25519 v2 defers the SHA-512 hash to the caller (keeps
// the bundle small). Wire ours in once at module load.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hexToBytes: odd-length hex string");
  }
  // Reject non-hex chars up front — `parseInt("gg", 16)` returns
  // NaN which coerces to 0 when assigned to a Uint8Array slot.
  // A typo in a hex key silently produced wrong bytes otherwise.
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("hexToBytes: non-hex characters");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Sign the canonical bytes of a payload with a wallet's ed25519
 * private key. Returns the 64-byte signature hex-encoded — the
 * caller inserts it into `authorization.attestation`.
 *
 * The Klyx facilitator hashes the same canonical body with SHA-256
 * before verifying, so we do the same here.
 */
export function signAttestation(params: {
  canonicalBody: string;
  privateKeyHex: string;
}): string {
  const { canonicalBody, privateKeyHex } = params;
  const priv = hexToBytes(privateKeyHex);
  if (priv.length !== 32) {
    throw new Error(
      `ed25519 private key must be 32 bytes, got ${priv.length}`,
    );
  }
  const digest = sha256(new TextEncoder().encode(canonicalBody));
  const sig = ed.sign(digest, priv);
  return bytesToHex(sig);
}

/**
 * Derive the ed25519 public key hex from a private key hex. Handy
 * when a caller has only the wallet's private key and wants to fill
 * in `authorization.publicKey` without a separate lookup.
 */
export function derivePublicKey(privateKeyHex: string): string {
  const priv = hexToBytes(privateKeyHex);
  if (priv.length !== 32) {
    throw new Error(
      `ed25519 private key must be 32 bytes, got ${priv.length}`,
    );
  }
  return bytesToHex(ed.getPublicKey(priv));
}

/**
 * Verify a facilitator's signature on a response body. Callers
 * hand us the canonical body bytes (the exact bytes the server
 * sent — do NOT re-serialize the parsed JSON, that will drift),
 * the hex-encoded signature from the X-Klyx-Facilitator-Signature
 * header, and the facilitator's advertised public key from the
 * on-chain rotation set.
 *
 * Returns true on valid signature, false otherwise. Throws only on
 * malformed key/sig bytes — a mismatched sig returns false so the
 * caller can react (retry, alert, treat as unverified) without an
 * exception in the hot path.
 */
export function verifyFacilitatorSignature(params: {
  canonicalBody: string;
  signatureHex: string;
  publicKeyHex: string;
}): boolean {
  const { canonicalBody, signatureHex, publicKeyHex } = params;
  const pub = hexToBytes(publicKeyHex);
  const sig = hexToBytes(signatureHex);
  if (pub.length !== 32) {
    throw new Error(
      `ed25519 public key must be 32 bytes, got ${pub.length}`,
    );
  }
  if (sig.length !== 64) {
    throw new Error(
      `ed25519 signature must be 64 bytes, got ${sig.length}`,
    );
  }
  const digest = sha256(new TextEncoder().encode(canonicalBody));
  try {
    return ed.verify(sig, digest, pub);
  } catch {
    return false;
  }
}
