/**
 * Wallet abstraction for x402-klyx signing.
 *
 * Prior to v0.2, wallets were `{ address, privateKeyHex }` — the
 * library held raw key material. That works for server-side agents
 * (env vars / secret managers) but is wrong for browser + hardware-
 * wallet + enterprise-KMS flows where the caller shouldn't hand the
 * key to the library.
 *
 * The v0.2 shape is callback-based. Callers implement
 * `sign(canonicalBody)` however their environment allows:
 *   - In-process private key → `fromPrivateKey(hex, address)` helper
 *   - Klever Web Extension → wrap the extension's message-sign call
 *   - Ledger / hardware wallet → wrap the device's ed25519 signer
 *   - KMS / HSM → call the remote signing service
 *
 * Contract for `sign`:
 * - Input: the canonical body (JSON string) to sign
 * - Output: 128-char lowercase hex string = raw ed25519 signature
 *   over SHA-256 of the utf-8 bytes of the input (klv-ed25519 per
 *   ADR-017 D17)
 * - Return type is `Promise<string> | string` — sync for in-process,
 *   async for wallet extensions / hardware / remote signers
 *
 * The library validates the returned signature shape before using
 * it; a malformed return throws immediately with a clear error so
 * a broken wallet adapter fails loud rather than producing garbage
 * signatures the facilitator silently rejects.
 */

import { bech32 } from "bech32";
import { randomBytes } from "@noble/hashes/utils";
import {
  bytesToHex,
  derivePublicKey,
  hexToBytes,
  signAttestation,
} from "./signing.js";

export interface KleverWallet {
  /** klv1... bech32 address that will sign. */
  address: string;
  /** Ed25519 public key hex (32 bytes / 64 chars, lowercase).
   *  Required so the library doesn't need to round-trip through
   *  the callback to know the pubkey. */
  publicKeyHex: string;
  /**
   * Sign the canonical body with the wallet's ed25519 key.
   *
   * MUST return `bytesToHex(ed25519.sign(SHA256(utf8_bytes(canonicalBody)), private_key))`
   * — the klv-ed25519 primitive. Return 128-char lowercase hex.
   *
   * Sync for in-process (see `fromPrivateKey`); async for wallet
   * extensions, hardware wallets, and remote signers.
   *
   * Should throw / reject if the user declines (extension popup
   * cancel, hardware button no-press) — the caller surfaces that
   * as `wallet_error`.
   */
  sign(canonicalBody: string): Promise<string> | string;
}

/**
 * Build a KleverWallet from an in-process private key. Convenient
 * for server-side agents where the key is in an env var / secret
 * manager and the library is trusted to hold it.
 *
 * Do NOT use this in a browser or any environment where the
 * private key shouldn't touch application memory — use a wallet-
 * extension adapter instead.
 *
 * @param privateKeyHex 32-byte ed25519 private key hex (64 chars)
 * @param address klv1... bech32 address the wallet operates as
 */
export function fromPrivateKey(
  privateKeyHex: string,
  address: string,
): KleverWallet {
  if (!privateKeyHex) {
    throw new Error("fromPrivateKey: privateKeyHex required");
  }
  if (!address) {
    throw new Error("fromPrivateKey: address required");
  }
  // Deriving here validates the key length (32 bytes) up-front —
  // fail-fast rather than throwing later on the first sign() call.
  const publicKeyHex = derivePublicKey(privateKeyHex);
  return {
    address,
    publicKeyHex,
    sign(canonicalBody: string): string {
      return signAttestation({ canonicalBody, privateKeyHex });
    },
  };
}

/** Validate that a `wallet.sign()` return value is a well-formed
 *  ed25519 signature hex. Callers use this immediately after
 *  awaiting the sign callback so a broken adapter fails loud with
 *  a clear error, not silently downstream as invalid_signature. */
export function assertValidSignatureHex(sig: unknown): asserts sig is string {
  if (typeof sig !== "string") {
    throw new Error(
      `wallet.sign returned non-string (${typeof sig}); expected 128-char lowercase hex`,
    );
  }
  if (sig.length !== 128) {
    throw new Error(
      `wallet.sign returned ${sig.length}-char string; expected 128 chars (64-byte ed25519 sig)`,
    );
  }
  if (!/^[0-9a-f]+$/.test(sig)) {
    throw new Error(
      "wallet.sign returned non-hex or uppercase characters; expected lowercase hex only",
    );
  }
}

/**
 * Generate a fresh Klever wallet in memory — random ed25519 keypair
 * + derived `klv1…` bech32 address. Useful for tests, dev
 * scaffolding, or a one-time signup ceremony where the caller
 * persists the private key somewhere safe before using it.
 *
 * ⚠️ **The returned `privateKeyHex` is the only thing that can sign
 * as this address, ever.** If it's lost, funds sent to the address
 * are unrecoverable. If it leaks, an attacker owns the address.
 * Consumer responsibilities:
 *   - Persist `privateKeyHex` to an env var, secret manager, or
 *     encrypted keystore BEFORE using the wallet for anything real
 *   - Never log or commit it
 *   - Use `fromPrivateKey(privateKeyHex, address)` to construct a
 *     `KleverWallet` for x402-klyx's provider / requester APIs
 *
 * For browser flows where the user's wallet extension already
 * holds their key, this helper is the wrong tool — use a wallet-
 * extension adapter (see `KleverWallet` docs) instead.
 */
export function generateKleverWallet(): {
  address: string;
  publicKeyHex: string;
  privateKeyHex: string;
} {
  const privateKeyHex = bytesToHex(randomBytes(32));
  const publicKeyHex = derivePublicKey(privateKeyHex);
  const address = bech32.encode("klv", bech32.toWords(hexToBytes(publicKeyHex)));
  return { address, publicKeyHex, privateKeyHex };
}
