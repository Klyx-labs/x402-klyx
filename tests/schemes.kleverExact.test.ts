import { describe, it, expect } from "vitest";
import {
  buildAndSignKleverExactPayload,
  canonicalizeForAttestation,
  parseKleverExactPayload,
} from "../src/core/schemes/kleverExact.js";
import { verifyFacilitatorSignature, derivePublicKey } from "../src/core/signing.js";
import {
  NETWORK_KLEVER_TESTNET,
  SCHEME_EXACT,
} from "../src/core/schemes/index.js";
import { X402_VERSION } from "../src/core/types.js";

const TEST_PRIVATE_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";

// bech32 fixtures — the payload zod schema only checks the klv1
// prefix + charset + length, so any well-formed-shaped strings pass.
// Real addresses aren't required for unit tests.
const SIGNER_ADDR = "klv1requester0000000000000000000000000000000";
const PROVIDER_ADDR = "klv1provider0000000000000000000000000000000";

function baseInput() {
  return {
    asset: "KLV",
    amount: "500000",
    destination: PROVIDER_ADDR,
    nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expiresAt: "2030-01-01T00:00:00Z",
    signer: SIGNER_ADDR,
    privateKeyHex: TEST_PRIVATE_KEY,
  };
}

describe("buildAndSignKleverExactPayload", () => {
  it("produces a wire-ready PaymentPayload envelope", () => {
    const p = buildAndSignKleverExactPayload(
      baseInput(),
      NETWORK_KLEVER_TESTNET,
    );
    expect(p.x402Version).toBe(X402_VERSION);
    expect(p.scheme).toBe(SCHEME_EXACT);
    expect(p.network).toBe(NETWORK_KLEVER_TESTNET);
    expect(p.payload.asset).toBe("KLV");
    const payload = p.payload as { authorization: { attestation: string; publicKey: string } };
    expect(payload.authorization.attestation).toMatch(/^[0-9a-f]{128}$/);
    expect(payload.authorization.publicKey).toBe(
      derivePublicKey(TEST_PRIVATE_KEY),
    );
  });

  it("attestation verifies against the canonicalized-minus-attestation body", () => {
    // This is the round-trip that the Klyx facilitator performs on
    // /verify: canonicalize the payload minus authorization.attestation,
    // verify the ed25519 sig against authorization.publicKey. Anything
    // that fails here would fail at the facilitator too.
    const p = buildAndSignKleverExactPayload(
      baseInput(),
      NETWORK_KLEVER_TESTNET,
    );
    const payload = p.payload as {
      asset: string;
      amount: string;
      destination: string;
      nonce: string;
      expiresAt: string;
      authorization: {
        signer: string;
        publicKey: string;
        attestation: string;
      };
    };
    const { attestation, ...authWithoutAttestation } = payload.authorization;
    const canonicalBody = canonicalizeForAttestation({
      asset: payload.asset,
      amount: payload.amount,
      destination: payload.destination,
      nonce: payload.nonce,
      expiresAt: payload.expiresAt,
      authorization: authWithoutAttestation,
    });
    const ok = verifyFacilitatorSignature({
      canonicalBody,
      signatureHex: attestation,
      publicKeyHex: payload.authorization.publicKey,
    });
    expect(ok).toBe(true);
  });

  it("rejects non-integer amount at build time", () => {
    expect(() =>
      buildAndSignKleverExactPayload(
        { ...baseInput(), amount: "0.5" },
        NETWORK_KLEVER_TESTNET,
      ),
    ).toThrow(/amount/);
  });

  it("rejects malformed bech32 destination", () => {
    expect(() =>
      buildAndSignKleverExactPayload(
        { ...baseInput(), destination: "0x0000000000000000000000000000000000000000" },
        NETWORK_KLEVER_TESTNET,
      ),
    ).toThrow(/destination/);
  });

  it("rejects nonce too short", () => {
    expect(() =>
      buildAndSignKleverExactPayload(
        { ...baseInput(), nonce: "aaaa" },
        NETWORK_KLEVER_TESTNET,
      ),
    ).toThrow();
  });
});

describe("parseKleverExactPayload", () => {
  it("accepts a payload built by the signer", () => {
    const p = buildAndSignKleverExactPayload(
      baseInput(),
      NETWORK_KLEVER_TESTNET,
    );
    expect(() => parseKleverExactPayload(p.payload)).not.toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => parseKleverExactPayload({ asset: "KLV" })).toThrow();
  });
});
