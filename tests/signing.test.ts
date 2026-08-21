import { describe, it, expect } from "vitest";
import {
  signAttestation,
  derivePublicKey,
  verifyFacilitatorSignature,
  hexToBytes,
  bytesToHex,
} from "../src/core/signing.js";

// Fixed dev key — 32 bytes hex. Same shape the facilitator uses in
// its local docker-compose (`FACILITATOR_PRIVATE_KEY_HEX=1111...`).
const TEST_PRIVATE_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";

describe("hex helpers", () => {
  it("round-trips bytesToHex ↔ hexToBytes", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xab]);
    const hex = bytesToHex(bytes);
    expect(hex).toBe("0001ffab");
    expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes));
  });

  it("rejects odd-length hex", () => {
    expect(() => hexToBytes("abc")).toThrow(/odd-length/);
  });

  it("rejects non-hex characters (previously silent NaN → 0x00)", () => {
    // parseInt("gg", 16) returns NaN which coerces to 0 in a
    // Uint8Array; a typo silently produced wrong bytes before this
    // guard. See parity issue #607.
    expect(() => hexToBytes("gg")).toThrow(/non-hex/);
    expect(() => hexToBytes("00zz00zz")).toThrow(/non-hex/);
    // Even-length hex with a non-hex nibble in the middle — used
    // to silently zero that byte, now throws.
    expect(() => hexToBytes("00".repeat(15) + "gg" + "00".repeat(16))).toThrow(
      /non-hex/,
    );
  });
});

describe("derivePublicKey", () => {
  it("returns 32-byte hex (64 chars)", () => {
    const pub = derivePublicKey(TEST_PRIVATE_KEY);
    expect(pub).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic (same priv → same pub)", () => {
    expect(derivePublicKey(TEST_PRIVATE_KEY)).toBe(
      derivePublicKey(TEST_PRIVATE_KEY),
    );
  });

  it("throws on wrong-length private key", () => {
    expect(() => derivePublicKey("11")).toThrow(/32 bytes/);
  });
});

describe("signAttestation + verifyFacilitatorSignature", () => {
  it("round-trips a signature over canonical bytes", () => {
    const canonicalBody = '{"a":1,"b":2}';
    const publicKeyHex = derivePublicKey(TEST_PRIVATE_KEY);
    const sig = signAttestation({
      canonicalBody,
      privateKeyHex: TEST_PRIVATE_KEY,
    });
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    const ok = verifyFacilitatorSignature({
      canonicalBody,
      signatureHex: sig,
      publicKeyHex,
    });
    expect(ok).toBe(true);
  });

  it("returns false on tampered body", () => {
    const publicKeyHex = derivePublicKey(TEST_PRIVATE_KEY);
    const sig = signAttestation({
      canonicalBody: '{"a":1}',
      privateKeyHex: TEST_PRIVATE_KEY,
    });
    const ok = verifyFacilitatorSignature({
      canonicalBody: '{"a":2}',
      signatureHex: sig,
      publicKeyHex,
    });
    expect(ok).toBe(false);
  });

  it("returns false on wrong public key", () => {
    const otherPriv =
      "2222222222222222222222222222222222222222222222222222222222222222";
    const otherPub = derivePublicKey(otherPriv);
    const sig = signAttestation({
      canonicalBody: '{"a":1}',
      privateKeyHex: TEST_PRIVATE_KEY,
    });
    const ok = verifyFacilitatorSignature({
      canonicalBody: '{"a":1}',
      signatureHex: sig,
      publicKeyHex: otherPub,
    });
    expect(ok).toBe(false);
  });

  it("throws on wrong-length pubkey (dev error, not verify failure)", () => {
    expect(() =>
      verifyFacilitatorSignature({
        canonicalBody: "x",
        signatureHex: "0".repeat(128),
        publicKeyHex: "aa",
      }),
    ).toThrow(/32 bytes/);
  });

  it("throws on wrong-length signature (dev error)", () => {
    expect(() =>
      verifyFacilitatorSignature({
        canonicalBody: "x",
        signatureHex: "aa",
        publicKeyHex: "1".repeat(64),
      }),
    ).toThrow(/64 bytes/);
  });
});
