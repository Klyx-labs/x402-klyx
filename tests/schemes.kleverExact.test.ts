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
import { fromPrivateKey } from "../src/core/wallet.js";

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
    wallet: fromPrivateKey(TEST_PRIVATE_KEY, SIGNER_ADDR),
  };
}

describe("buildAndSignKleverExactPayload", () => {
  it("produces a wire-ready PaymentPayload envelope", async () => {
    const p = await buildAndSignKleverExactPayload(
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

  it("attestation verifies against the canonicalized-minus-attestation body", async () => {
    // This is the round-trip the Klyx facilitator performs on
    // /verify: canonicalize the payload minus authorization.attestation,
    // verify the ed25519 sig against authorization.publicKey.
    const p = await buildAndSignKleverExactPayload(
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

  it("rejects non-integer amount at build time (BEFORE calling wallet.sign)", async () => {
    await expect(
      buildAndSignKleverExactPayload(
        { ...baseInput(), amount: "0.5" },
        NETWORK_KLEVER_TESTNET,
      ),
    ).rejects.toThrow(/amount/);
  });

  it("rejects malformed bech32 destination", async () => {
    await expect(
      buildAndSignKleverExactPayload(
        { ...baseInput(), destination: "0x0000000000000000000000000000000000000000" },
        NETWORK_KLEVER_TESTNET,
      ),
    ).rejects.toThrow(/destination/);
  });

  it("rejects nonce too short", async () => {
    await expect(
      buildAndSignKleverExactPayload(
        { ...baseInput(), nonce: "aaaa" },
        NETWORK_KLEVER_TESTNET,
      ),
    ).rejects.toThrow();
  });

  it("rejects uppercase hex in nonce (lowercase-only per parity #608)", async () => {
    await expect(
      buildAndSignKleverExactPayload(
        { ...baseInput(), nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
        NETWORK_KLEVER_TESTNET,
      ),
    ).rejects.toThrow();
  });

  it("rejects amounts longer than 40 digits (u128 bound per #610)", async () => {
    await expect(
      buildAndSignKleverExactPayload(
        { ...baseInput(), amount: "1".repeat(41) },
        NETWORK_KLEVER_TESTNET,
      ),
    ).rejects.toThrow(/amount/);
  });

  it("input validation runs BEFORE wallet.sign is invoked (no wasted popup)", async () => {
    // Custom wallet that records every sign call. Bad input should
    // never reach it.
    const signCalls: string[] = [];
    const wallet = {
      address: SIGNER_ADDR,
      publicKeyHex: derivePublicKey(TEST_PRIVATE_KEY),
      sign: (body: string) => {
        signCalls.push(body);
        return "0".repeat(128);
      },
    };
    await expect(
      buildAndSignKleverExactPayload(
        { ...baseInput(), wallet, amount: "not-a-number" },
        NETWORK_KLEVER_TESTNET,
      ),
    ).rejects.toThrow();
    expect(signCalls).toHaveLength(0);
  });

  it("surfaces wallet.sign errors as builder throws", async () => {
    const wallet = {
      address: SIGNER_ADDR,
      publicKeyHex: derivePublicKey(TEST_PRIVATE_KEY),
      sign: async () => {
        throw new Error("user declined popup");
      },
    };
    await expect(
      buildAndSignKleverExactPayload(
        { ...baseInput(), wallet },
        NETWORK_KLEVER_TESTNET,
      ),
    ).rejects.toThrow(/user declined popup/);
  });

  it("rejects wallet returning malformed signature (wrong length)", async () => {
    const wallet = {
      address: SIGNER_ADDR,
      publicKeyHex: derivePublicKey(TEST_PRIVATE_KEY),
      sign: () => "abc",  // way too short
    };
    await expect(
      buildAndSignKleverExactPayload(
        { ...baseInput(), wallet },
        NETWORK_KLEVER_TESTNET,
      ),
    ).rejects.toThrow(/128 chars/);
  });

  it("rejects wallet returning uppercase hex signature", async () => {
    const wallet = {
      address: SIGNER_ADDR,
      publicKeyHex: derivePublicKey(TEST_PRIVATE_KEY),
      sign: () => "A".repeat(128),
    };
    await expect(
      buildAndSignKleverExactPayload(
        { ...baseInput(), wallet },
        NETWORK_KLEVER_TESTNET,
      ),
    ).rejects.toThrow(/lowercase hex/);
  });

  it("accepts an async wallet callback", async () => {
    const wallet = fromPrivateKey(TEST_PRIVATE_KEY, SIGNER_ADDR);
    // Wrap in async layer to prove Promise return is handled.
    const asyncWallet = {
      address: wallet.address,
      publicKeyHex: wallet.publicKeyHex,
      sign: async (body: string) => wallet.sign(body),
    };
    const p = await buildAndSignKleverExactPayload(
      { ...baseInput(), wallet: asyncWallet },
      NETWORK_KLEVER_TESTNET,
    );
    const payload = p.payload as { authorization: { attestation: string } };
    expect(payload.authorization.attestation).toMatch(/^[0-9a-f]{128}$/);
  });

  // ── transferTx (v0.3) ────────────────────────────────────

  describe("transferTx (optional fast-path field)", () => {
    const TX_HASH = "deadbeef".repeat(8);

    it("includes transferTx in the payload when set", async () => {
      const p = await buildAndSignKleverExactPayload(
        { ...baseInput(), transferTx: TX_HASH },
        NETWORK_KLEVER_TESTNET,
      );
      const payload = p.payload as { transferTx?: string };
      expect(payload.transferTx).toBe(TX_HASH);
    });

    it("omits transferTx from the payload when not set (backwards compat)", async () => {
      const p = await buildAndSignKleverExactPayload(
        baseInput(),
        NETWORK_KLEVER_TESTNET,
      );
      expect("transferTx" in p.payload).toBe(false);
    });

    it("attestation covers transferTx (verify round-trip)", async () => {
      const p = await buildAndSignKleverExactPayload(
        { ...baseInput(), transferTx: TX_HASH },
        NETWORK_KLEVER_TESTNET,
      );
      const payload = p.payload as {
        asset: string;
        amount: string;
        destination: string;
        nonce: string;
        expiresAt: string;
        transferTx: string;
        authorization: {
          signer: string;
          publicKey: string;
          attestation: string;
        };
      };
      const { attestation, ...auth } = payload.authorization;
      const canonicalBody = canonicalizeForAttestation({
        asset: payload.asset,
        amount: payload.amount,
        destination: payload.destination,
        nonce: payload.nonce,
        expiresAt: payload.expiresAt,
        transferTx: payload.transferTx,
        authorization: auth,
      });
      expect(
        verifyFacilitatorSignature({
          canonicalBody,
          signatureHex: attestation,
          publicKeyHex: payload.authorization.publicKey,
        }),
      ).toBe(true);
    });

    it("rejects malformed transferTx (non-hex) at build time", async () => {
      await expect(
        buildAndSignKleverExactPayload(
          { ...baseInput(), transferTx: "not-a-hex-hash" },
          NETWORK_KLEVER_TESTNET,
        ),
      ).rejects.toThrow();
    });

    it("rejects uppercase transferTx (parity with lowercase-only invariant)", async () => {
      await expect(
        buildAndSignKleverExactPayload(
          { ...baseInput(), transferTx: TX_HASH.toUpperCase() },
          NETWORK_KLEVER_TESTNET,
        ),
      ).rejects.toThrow();
    });
  });
});

describe("parseKleverExactPayload", () => {
  it("accepts a payload built by the signer", async () => {
    const p = await buildAndSignKleverExactPayload(
      baseInput(),
      NETWORK_KLEVER_TESTNET,
    );
    expect(() => parseKleverExactPayload(p.payload)).not.toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => parseKleverExactPayload({ asset: "KLV" })).toThrow();
  });
});
