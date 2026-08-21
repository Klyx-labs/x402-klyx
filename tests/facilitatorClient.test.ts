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

  it("skips signature checks when publicKeysHex is empty + allowUnsigned (dev mode)", async () => {
    const fetchImpl = mockFetch(200, { isValid: true }, { sign: false });
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [],
      allowUnsigned: true,
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

describe("FacilitatorClient constructor validation (#609/#612 hardening)", () => {
  const fetchImpl = mockFetch(200, { isValid: true }, { sign: true });

  it("throws on empty publicKeysHex without allowUnsigned (#609)", () => {
    expect(
      () =>
        new FacilitatorClient({
          url: "https://facilitator.example",
          publicKeysHex: [],
          fetch: fetchImpl,
        }),
    ).toThrow(/allowUnsigned/);
  });

  it("throws on malformed key in publicKeysHex (empty string)", () => {
    expect(
      () =>
        new FacilitatorClient({
          url: "https://facilitator.example",
          publicKeysHex: [""],
          fetch: fetchImpl,
        }),
    ).toThrow(/publicKeysHex\[0\]/);
  });

  it("throws on uppercase key in publicKeysHex (lowercase-only per parity)", () => {
    const upper = TEST_PUBLIC_KEY.toUpperCase();
    expect(
      () =>
        new FacilitatorClient({
          url: "https://facilitator.example",
          publicKeysHex: [upper],
          fetch: fetchImpl,
        }),
    ).toThrow(/lowercase hex/);
  });

  it("throws on wrong-length key in publicKeysHex", () => {
    expect(
      () =>
        new FacilitatorClient({
          url: "https://facilitator.example",
          publicKeysHex: ["aabbcc"],
          fetch: fetchImpl,
        }),
    ).toThrow(/32-byte/);
  });

  it("throws on non-http(s) URL scheme (#612)", () => {
    expect(
      () =>
        new FacilitatorClient({
          url: "ftp://facilitator.example",
          publicKeysHex: [TEST_PUBLIC_KEY],
          fetch: fetchImpl,
        }),
    ).toThrow(/unsupported protocol/);
    expect(
      () =>
        new FacilitatorClient({
          url: "file:///etc/passwd",
          publicKeysHex: [TEST_PUBLIC_KEY],
          fetch: fetchImpl,
        }),
    ).toThrow(/unsupported protocol/);
  });

  it("throws on unparseable URL", () => {
    expect(
      () =>
        new FacilitatorClient({
          url: "not-a-url",
          publicKeysHex: [TEST_PUBLIC_KEY],
          fetch: fetchImpl,
        }),
    ).toThrow(/invalid url/);
  });

  it("throws on localhost without allowPrivateTargets (#612)", () => {
    expect(
      () =>
        new FacilitatorClient({
          url: "http://localhost:9082",
          publicKeysHex: [TEST_PUBLIC_KEY],
          fetch: fetchImpl,
        }),
    ).toThrow(/private\/loopback/);
  });

  it("throws on RFC1918 hosts without allowPrivateTargets", () => {
    for (const host of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "127.0.0.1"]) {
      expect(
        () =>
          new FacilitatorClient({
            url: `http://${host}:9082`,
            publicKeysHex: [TEST_PUBLIC_KEY],
            fetch: fetchImpl,
          }),
      ).toThrow(/private\/loopback/);
    }
  });

  it("throws on AWS-metadata link-local (169.254.169.254)", () => {
    expect(
      () =>
        new FacilitatorClient({
          url: "http://169.254.169.254/latest/api/token",
          publicKeysHex: [TEST_PUBLIC_KEY],
          fetch: fetchImpl,
        }),
    ).toThrow(/private\/loopback/);
  });

  it("accepts private host with allowPrivateTargets: true (dev docker)", () => {
    expect(
      () =>
        new FacilitatorClient({
          url: "http://facilitator:9082",  // docker-compose service name (not numeric, not localhost)
          publicKeysHex: [TEST_PUBLIC_KEY],
          fetch: fetchImpl,
        }),
    ).not.toThrow();
    expect(
      () =>
        new FacilitatorClient({
          url: "http://localhost:9082",
          publicKeysHex: [TEST_PUBLIC_KEY],
          allowPrivateTargets: true,
          fetch: fetchImpl,
        }),
    ).not.toThrow();
  });

  it("throws on missing url", () => {
    expect(
      () =>
        new FacilitatorClient({
          url: "",
          publicKeysHex: [TEST_PUBLIC_KEY],
          fetch: fetchImpl,
        }),
    ).toThrow(/url required/);
  });
});

describe("FacilitatorClient response body caps (#611 hardening)", () => {
  it("throws body_too_large when declared Content-Length exceeds cap", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("{}", {
        status: 200,
        headers: new Headers({
          "content-type": "application/json",
          "content-length": String(128 * 1024),  // 128 KiB > 64 KiB cap
          "x-klyx-facilitator-signature": "0".repeat(128),
        }),
      }),
    );
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [TEST_PUBLIC_KEY],
      fetch: fetchImpl,
    });
    await expect(client.verify(REQUEST)).rejects.toMatchObject({
      code: "body_too_large",
    });
  });

  it("throws body_too_large on actual oversized body when Content-Length was absent/lying", async () => {
    const oversized = "x".repeat(65 * 1024);  // > 64 KiB
    const fetchImpl = vi.fn(async () =>
      new Response(oversized, {
        status: 200,
        headers: new Headers({
          "content-type": "application/json",
          // no content-length header — forces post-read check
          "x-klyx-facilitator-signature": "0".repeat(128),
        }),
      }),
    );
    const client = new FacilitatorClient({
      url: "https://facilitator.example",
      publicKeysHex: [TEST_PUBLIC_KEY],
      fetch: fetchImpl,
    });
    await expect(client.verify(REQUEST)).rejects.toMatchObject({
      code: "body_too_large",
    });
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
