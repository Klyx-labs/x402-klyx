import { describe, it, expect, vi } from "vitest";
import {
  FacilitatorClient,
  FacilitatorError,
} from "../src/core/facilitatorClient.js";
import { canonicalize } from "../src/core/canonicalize.js";
import { signAttestation, derivePublicKey } from "../src/core/signing.js";
import { X402_VERSION } from "../src/core/types.js";
import {
  NETWORK_KLEVER_TESTNET,
  SCHEME_EXACT,
} from "../src/core/schemes/index.js";

const TEST_PRIVATE_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";
const TEST_PUBLIC_KEY = derivePublicKey(TEST_PRIVATE_KEY);

const REQUEST = {
  x402Version: X402_VERSION,
  paymentPayload: {
    x402Version: X402_VERSION,
    scheme: SCHEME_EXACT,
    network: NETWORK_KLEVER_TESTNET,
    payload: { asset: "KLV", amount: "1" },
  },
  paymentRequirements: {
    scheme: SCHEME_EXACT,
    network: NETWORK_KLEVER_TESTNET,
    maxAmountRequired: "1",
    resource: "test",
    payTo: "klv1provider0000000000000000000000000000000",
    asset: "KLV",
  },
};

function mockFetch(status: number, body: unknown, opts: { sign?: boolean; header?: string } = {}) {
  const canonicalBody = canonicalize(body);
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.sign) {
    const sig = signAttestation({
      canonicalBody,
      privateKeyHex: TEST_PRIVATE_KEY,
    });
    headers.set(opts.header ?? "x-klyx-facilitator-signature", sig);
  }
  return vi.fn(async () => new Response(canonicalBody, { status, headers }));
}

describe("FacilitatorClient.verify", () => {
  it("verifies a signed response against a known key", async () => {
    const responseBody = { isValid: true, payer: "klv1requester0000000000000000000000000000000" };
    const fetchImpl = mockFetch(200, responseBody, { sign: true });
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [TEST_PUBLIC_KEY],
      fetch: fetchImpl,
    });
    const res = await client.verify(REQUEST);
    expect(res.body.isValid).toBe(true);
    expect(res.body.payer).toBe(
      "klv1requester0000000000000000000000000000000",
    );
    expect(res.publicKeyHex).toBe(TEST_PUBLIC_KEY);
    expect(res.signatureHex).toMatch(/^[0-9a-f]{128}$/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws signature_missing when signed mode + no header", async () => {
    const fetchImpl = mockFetch(200, { isValid: true }, { sign: false });
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [TEST_PUBLIC_KEY],
      fetch: fetchImpl,
    });
    await expect(client.verify(REQUEST)).rejects.toBeInstanceOf(
      FacilitatorError,
    );
    await expect(client.verify(REQUEST)).rejects.toMatchObject({
      code: "signature_missing",
    });
  });

  it("throws signature_invalid when sig doesn't verify against any key", async () => {
    const wrongPriv =
      "2222222222222222222222222222222222222222222222222222222222222222";
    const responseBody = { isValid: true };
    // Sign with a key that's NOT in the client's publicKeysHex.
    const canonicalBody = canonicalize(responseBody);
    const sig = signAttestation({
      canonicalBody,
      privateKeyHex: wrongPriv,
    });
    const fetchImpl = vi.fn(async () =>
      new Response(canonicalBody, {
        status: 200,
        headers: new Headers({
          "content-type": "application/json",
          "x-klyx-facilitator-signature": sig,
        }),
      }),
    );
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [TEST_PUBLIC_KEY],
      fetch: fetchImpl,
    });
    await expect(client.verify(REQUEST)).rejects.toMatchObject({
      code: "signature_invalid",
    });
  });

  it("accepts if any key in the rotation set verifies", async () => {
    const otherPriv =
      "3333333333333333333333333333333333333333333333333333333333333333";
    const otherPub = derivePublicKey(otherPriv);
    const fetchImpl = mockFetch(200, { isValid: true }, { sign: true });
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [otherPub, TEST_PUBLIC_KEY],
      fetch: fetchImpl,
    });
    const res = await client.verify(REQUEST);
    expect(res.publicKeyHex).toBe(TEST_PUBLIC_KEY);
  });

  it("skips signature checks when publicKeysHex is empty (dev mode)", async () => {
    const fetchImpl = mockFetch(200, { isValid: true }, { sign: false });
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [],
      fetch: fetchImpl,
    });
    const res = await client.verify(REQUEST);
    expect(res.body.isValid).toBe(true);
  });

  it("surfaces a signed 400 response as a normal parsed body (recoverable)", async () => {
    const responseBody = {
      isValid: false,
      invalidReason: "malformed_request",
    };
    const fetchImpl = mockFetch(400, responseBody, { sign: true });
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [TEST_PUBLIC_KEY],
      fetch: fetchImpl,
    });
    const res = await client.verify(REQUEST);
    expect(res.body.isValid).toBe(false);
    expect(res.body.invalidReason).toBe("malformed_request");
  });

  it("throws http_error on non-recoverable status (500)", async () => {
    const fetchImpl = mockFetch(500, { error: "internal" }, { sign: true });
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [TEST_PUBLIC_KEY],
      fetch: fetchImpl,
    });
    await expect(client.verify(REQUEST)).rejects.toMatchObject({
      code: "http_error",
      status: 500,
    });
  });

  it("throws malformed_response on non-JSON body", async () => {
    const raw = "not-json";
    const sig = signAttestation({
      canonicalBody: raw,
      privateKeyHex: TEST_PRIVATE_KEY,
    });
    const fetchImpl = vi.fn(async () =>
      new Response(raw, {
        status: 200,
        headers: new Headers({
          "content-type": "application/json",
          "x-klyx-facilitator-signature": sig,
        }),
      }),
    );
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [TEST_PUBLIC_KEY],
      fetch: fetchImpl,
    });
    await expect(client.verify(REQUEST)).rejects.toMatchObject({
      code: "malformed_response",
    });
  });

  it("strips trailing slash from url when posting", async () => {
    const fetchImpl = mockFetch(200, { isValid: true }, { sign: true });
    const client = new FacilitatorClient({
      url: "https://facilitator.example///",
      publicKeysHex: [TEST_PUBLIC_KEY],
      fetch: fetchImpl,
    });
    await client.verify(REQUEST);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://facilitator.example/verify",
      expect.any(Object),
    );
  });
});

describe("FacilitatorClient.settle", () => {
  it("hits /settle and returns the parsed body", async () => {
    const responseBody = {
      success: true,
      network: NETWORK_KLEVER_TESTNET,
      payer: "klv1requester0000000000000000000000000000000",
      transaction: "deadbeef",
    };
    const fetchImpl = mockFetch(200, responseBody, { sign: true });
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [TEST_PUBLIC_KEY],
      fetch: fetchImpl,
    });
    const res = await client.settle(REQUEST);
    expect(res.body.success).toBe(true);
    expect(res.body.transaction).toBe("deadbeef");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://facilitator.example/settle",
      expect.any(Object),
    );
  });
});
