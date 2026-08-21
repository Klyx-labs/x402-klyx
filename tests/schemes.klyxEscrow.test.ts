import { describe, it, expect } from "vitest";
import {
  buildKlyxEscrowPayload,
  parseKlyxEscrowPayload,
} from "../src/core/schemes/klyxEscrow.js";
import {
  NETWORK_KLEVER_TESTNET,
  SCHEME_KLYX_ESCROW,
} from "../src/core/schemes/index.js";
import { X402_VERSION } from "../src/core/types.js";

const PROVIDER_ADDR = "klv1provider0000000000000000000000000000000";

function baseInput() {
  return {
    asset: "KLV",
    amount: "500000",
    provider: PROVIDER_ADDR,
    nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    expiresAt: "2030-01-01T00:00:00Z",
    disputeWindowDays: 30,
    openEscrowTx: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  };
}

describe("buildKlyxEscrowPayload", () => {
  it("produces a wire-ready envelope with the escrow scheme + network", () => {
    const p = buildKlyxEscrowPayload(baseInput(), NETWORK_KLEVER_TESTNET);
    expect(p.x402Version).toBe(X402_VERSION);
    expect(p.scheme).toBe(SCHEME_KLYX_ESCROW);
    expect(p.network).toBe(NETWORK_KLEVER_TESTNET);
    const payload = p.payload as { openEscrowTx: string; disputeWindowDays: number };
    expect(payload.openEscrowTx).toBe(baseInput().openEscrowTx);
    expect(payload.disputeWindowDays).toBe(30);
  });

  it("rejects a non-hex openEscrowTx", () => {
    expect(() =>
      buildKlyxEscrowPayload(
        { ...baseInput(), openEscrowTx: "not-a-hex-tx-hash" },
        NETWORK_KLEVER_TESTNET,
      ),
    ).toThrow();
  });

  it("rejects zero or negative dispute window", () => {
    expect(() =>
      buildKlyxEscrowPayload(
        { ...baseInput(), disputeWindowDays: 0 },
        NETWORK_KLEVER_TESTNET,
      ),
    ).toThrow();
    expect(() =>
      buildKlyxEscrowPayload(
        { ...baseInput(), disputeWindowDays: -1 },
        NETWORK_KLEVER_TESTNET,
      ),
    ).toThrow();
  });

  it("rejects a dispute window greater than 365 days", () => {
    expect(() =>
      buildKlyxEscrowPayload(
        { ...baseInput(), disputeWindowDays: 400 },
        NETWORK_KLEVER_TESTNET,
      ),
    ).toThrow();
  });

  it("rejects non-integer amount", () => {
    expect(() =>
      buildKlyxEscrowPayload(
        { ...baseInput(), amount: "0.5" },
        NETWORK_KLEVER_TESTNET,
      ),
    ).toThrow();
  });
});

describe("parseKlyxEscrowPayload", () => {
  it("round-trips a built payload", () => {
    const p = buildKlyxEscrowPayload(baseInput(), NETWORK_KLEVER_TESTNET);
    expect(() => parseKlyxEscrowPayload(p.payload)).not.toThrow();
  });

  it("rejects missing openEscrowTx", () => {
    const { openEscrowTx: _drop, ...rest } = baseInput();
    expect(() => parseKlyxEscrowPayload(rest)).toThrow();
  });
});
