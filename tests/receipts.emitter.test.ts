import { describe, it, expect, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256";

import {
  createReceiptEmitter,
  fromPrivateKey,
  ReceiptError,
  type KleverWallet,
  type ReceiptInput,
  type ReceiptEmitter,
} from "../src/index.js";
import { canonicalize } from "../src/core/canonicalize.js";
import {
  bytesToHex,
  derivePublicKey,
  verifyFacilitatorSignature,
} from "../src/core/signing.js";

const TEST_PRIVATE_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";
const TEST_PUBLIC_KEY = derivePublicKey(TEST_PRIVATE_KEY);

const PROVIDER_UUID = "11111111-1111-1111-1111-111111111111";
const PROVIDER_WALLET = "klv1provider0000000000000000000000000000000";
const REQUESTER_WALLET = "klv1requester0000000000000000000000000000000";
const KLYX_URL = "https://klyx.example";
const JWT = "test.jwt.token";

function baseReceipt(): ReceiptInput {
  return {
    outcome: "completed",
    requesterWallet: REQUESTER_WALLET,
    paymentAsset: "KLV",
    paymentAmountSmallest: "500000",
    settlementType: "direct",
    invokedAt: "2026-08-21T15:00:00.000Z",
    completedAt: "2026-08-21T15:00:01.234Z",
    nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    capability: "summarize",
  };
}

function mockFetch(
  responses: Array<{ status: number; body: unknown }>,
): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i];
    i++;
    if (!r) throw new Error("mockFetch: exhausted responses");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: new Headers({ "content-type": "application/json" }),
    });
  });
}

function makeEmitter(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof createReceiptEmitter>[0]> = {},
): ReceiptEmitter {
  return createReceiptEmitter({
    klyxApiUrl: KLYX_URL,
    authToken: JWT,
    providerAgentUserId: PROVIDER_UUID,
    wallet: fromPrivateKey(TEST_PRIVATE_KEY, PROVIDER_WALLET),
    fetch: fetchImpl,
    retries: 0,
    ...overrides,
  });
}

describe("createReceiptEmitter — constructor validation", () => {
  it("throws on missing klyxApiUrl", () => {
    expect(() =>
      createReceiptEmitter({
        klyxApiUrl: "",
        authToken: JWT,
        providerAgentUserId: PROVIDER_UUID,
        wallet: fromPrivateKey(TEST_PRIVATE_KEY, PROVIDER_WALLET),
      }),
    ).toThrow(/klyxApiUrl required/);
  });

  it("throws on missing authToken", () => {
    expect(() =>
      createReceiptEmitter({
        klyxApiUrl: KLYX_URL,
        authToken: "",
        providerAgentUserId: PROVIDER_UUID,
        wallet: fromPrivateKey(TEST_PRIVATE_KEY, PROVIDER_WALLET),
      }),
    ).toThrow(/authToken required/);
  });

  it("throws on missing providerAgentUserId", () => {
    expect(() =>
      createReceiptEmitter({
        klyxApiUrl: KLYX_URL,
        authToken: JWT,
        providerAgentUserId: "",
        wallet: fromPrivateKey(TEST_PRIVATE_KEY, PROVIDER_WALLET),
      }),
    ).toThrow(/providerAgentUserId required/);
  });

  it("throws on wallet without address", () => {
    const w = fromPrivateKey(TEST_PRIVATE_KEY, PROVIDER_WALLET);
    expect(() =>
      createReceiptEmitter({
        klyxApiUrl: KLYX_URL,
        authToken: JWT,
        providerAgentUserId: PROVIDER_UUID,
        wallet: { ...w, address: "" },
      }),
    ).toThrow(/wallet\.address required/);
  });

  it("throws on wallet without publicKeyHex", () => {
    const w = fromPrivateKey(TEST_PRIVATE_KEY, PROVIDER_WALLET);
    expect(() =>
      createReceiptEmitter({
        klyxApiUrl: KLYX_URL,
        authToken: JWT,
        providerAgentUserId: PROVIDER_UUID,
        wallet: { ...w, publicKeyHex: "" },
      }),
    ).toThrow(/wallet\.publicKeyHex required/);
  });

  it("throws when wallet.sign is not a function", () => {
    const w = fromPrivateKey(TEST_PRIVATE_KEY, PROVIDER_WALLET);
    expect(() =>
      createReceiptEmitter({
        klyxApiUrl: KLYX_URL,
        authToken: JWT,
        providerAgentUserId: PROVIDER_UUID,
        wallet: { ...w, sign: undefined as unknown as KleverWallet["sign"] },
      }),
    ).toThrow(/sign function required/);
  });
});

describe("createReceiptEmitter — wallet-extension flow", () => {
  it("supports async wallet.sign callback", async () => {
    const inProcess = fromPrivateKey(TEST_PRIVATE_KEY, PROVIDER_WALLET);
    const asyncWallet: KleverWallet = {
      address: inProcess.address,
      publicKeyHex: inProcess.publicKeyHex,
      sign: async (body) => {
        await new Promise((r) => setTimeout(r, 3));
        return inProcess.sign(body) as string;
      },
    };
    const fetchImpl = mockFetch([
      { status: 201, body: { receipt: { receiptId: "r-async", state: "signed" } } },
    ]);
    const emitter = createReceiptEmitter({
      klyxApiUrl: KLYX_URL,
      authToken: JWT,
      providerAgentUserId: PROVIDER_UUID,
      wallet: asyncWallet,
      fetch: fetchImpl as unknown as typeof fetch,
      retries: 0,
    });
    const result = await emitter.emit(baseReceipt());
    expect(result?.receiptId).toBe("r-async");
  });

  it("surfaces wallet.sign throwing as malformed_receipt (no retry)", async () => {
    const onError = vi.fn();
    const brokenWallet: KleverWallet = {
      address: PROVIDER_WALLET,
      publicKeyHex: TEST_PUBLIC_KEY,
      sign: () => {
        throw new Error("hardware wallet timeout");
      },
    };
    const fetchImpl = mockFetch([]);
    const emitter = createReceiptEmitter({
      klyxApiUrl: KLYX_URL,
      authToken: JWT,
      providerAgentUserId: PROVIDER_UUID,
      wallet: brokenWallet,
      fetch: fetchImpl as unknown as typeof fetch,
      retries: 3,
      onError,
    });
    const result = await emitter.emit(baseReceipt());
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();  // never even POSTed
    expect(onError.mock.calls[0][0].code).toBe("malformed_receipt");
    expect(onError.mock.calls[0][0].message).toContain("hardware wallet timeout");
  });

  it("surfaces wallet returning malformed sig as malformed_receipt", async () => {
    const onError = vi.fn();
    const brokenWallet: KleverWallet = {
      address: PROVIDER_WALLET,
      publicKeyHex: TEST_PUBLIC_KEY,
      sign: () => "not-a-real-signature",
    };
    const fetchImpl = mockFetch([]);
    const emitter = createReceiptEmitter({
      klyxApiUrl: KLYX_URL,
      authToken: JWT,
      providerAgentUserId: PROVIDER_UUID,
      wallet: brokenWallet,
      fetch: fetchImpl as unknown as typeof fetch,
      onError,
    });
    const result = await emitter.emit(baseReceipt());
    expect(result).toBeNull();
    expect(onError.mock.calls[0][0].code).toBe("malformed_receipt");
  });
});

describe("createReceiptEmitter.emit — happy path", () => {
  it("signs the receipt with klv-ed25519 and POSTs to /api/agents/receipts", async () => {
    const fetchImpl = mockFetch([
      {
        status: 201,
        body: { receipt: { receiptId: "r-1234", state: "signed" } },
      },
    ]);
    const emitter = makeEmitter(fetchImpl as unknown as typeof fetch);
    const result = await emitter.emit(baseReceipt());
    expect(result).toEqual({ receiptId: "r-1234", state: "signed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${KLYX_URL}/api/agents/receipts`);
    expect(init.method).toBe("POST");

    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe(`Bearer ${JWT}`);

    const body = JSON.parse(init.body as string);
    expect(body.providerAgentUserId).toBe(PROVIDER_UUID);
    expect(body.providerAttestationScheme).toBe("klv-ed25519");
    expect(body.providerAttestation).toMatch(/^[0-9a-f]{128}$/);
    expect(body.canonicalReceiptHash).toMatch(/^[0-9a-f]{64}$/);

    // Verify the attestation actually verifies against the derived
    // public key + the canonical bytes (base payload minus
    // attestation fields).
    const {
      providerAttestation,
      providerAttestationScheme: _s,
      canonicalReceiptHash: _h,
      ...basePayload
    } = body;
    const canonicalBody = canonicalize(basePayload);
    const ok = verifyFacilitatorSignature({
      canonicalBody,
      signatureHex: providerAttestation,
      publicKeyHex: TEST_PUBLIC_KEY,
    });
    expect(ok).toBe(true);

    // Verify canonicalReceiptHash matches SHA-256 of canonical bytes.
    const expectedHash = bytesToHex(
      sha256(new TextEncoder().encode(canonicalBody)),
    );
    expect(body.canonicalReceiptHash).toBe(expectedHash);
  });

  it("fires onEmit hook on success", async () => {
    const onEmit = vi.fn();
    const fetchImpl = mockFetch([
      {
        status: 201,
        body: { receipt: { receiptId: "r-5678", state: "pending_sigs" } },
      },
    ]);
    const emitter = makeEmitter(fetchImpl as unknown as typeof fetch, {
      onEmit,
    });
    await emitter.emit(baseReceipt());
    expect(onEmit).toHaveBeenCalledTimes(1);
    const [result, receipt] = onEmit.mock.calls[0];
    expect(result.receiptId).toBe("r-5678");
    expect(result.state).toBe("pending_sigs");
    expect(receipt.outcome).toBe("completed");
  });

  it("strips null fields from canonical bytes (ADR-013 rule)", async () => {
    const fetchImpl = mockFetch([
      { status: 201, body: { receipt: { receiptId: "r", state: "signed" } } },
    ]);
    const emitter = makeEmitter(fetchImpl as unknown as typeof fetch);
    // Deliberately pass null values (via cast) to exercise stripping.
    const receipt = {
      ...baseReceipt(),
      paymentTxHash: null as unknown as string,
      inputHash: null as unknown as string,
    };
    await emitter.emit(receipt);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // null-valued fields should NOT appear in the POST body (both
    // the signed base + the derived hash exclude them).
    expect("paymentTxHash" in body).toBe(false);
    expect("inputHash" in body).toBe(false);
  });

  it("strips trailing slashes from klyxApiUrl", async () => {
    const fetchImpl = mockFetch([
      { status: 201, body: { receipt: { receiptId: "r", state: "signed" } } },
    ]);
    const emitter = createReceiptEmitter({
      klyxApiUrl: "https://klyx.example///",
      authToken: JWT,
      providerAgentUserId: PROVIDER_UUID,
      wallet: fromPrivateKey(TEST_PRIVATE_KEY, PROVIDER_WALLET),
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await emitter.emit(baseReceipt());
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("https://klyx.example/api/agents/receipts");
  });
});

describe("createReceiptEmitter.emit — error paths", () => {
  it("returns null + calls onError on 409 nonce collision (no retry)", async () => {
    const onError = vi.fn();
    const fetchImpl = mockFetch([
      { status: 409, body: { error: "nonce already exists" } },
      // Would-be-retry-response, must NOT be consumed
      { status: 201, body: { receipt: { receiptId: "r", state: "signed" } } },
    ]);
    const emitter = makeEmitter(fetchImpl as unknown as typeof fetch, {
      onError,
      retries: 3,
    });
    const result = await emitter.emit(baseReceipt());
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    const [err] = onError.mock.calls[0];
    expect(err).toBeInstanceOf(ReceiptError);
    expect(err.code).toBe("nonce_collision");
  });

  it("returns null on 401 unauthorized (no retry)", async () => {
    const onError = vi.fn();
    const fetchImpl = mockFetch([
      { status: 401, body: { error: "invalid token" } },
      { status: 201, body: { receipt: { receiptId: "r", state: "signed" } } },
    ]);
    const emitter = makeEmitter(fetchImpl as unknown as typeof fetch, {
      onError,
      retries: 3,
    });
    const result = await emitter.emit(baseReceipt());
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe("unauthorized");
  });

  it("returns null on 400 malformed (no retry) with body preview in message", async () => {
    const onError = vi.fn();
    const fetchImpl = mockFetch([
      { status: 400, body: { error: "amount too large" } },
    ]);
    const emitter = makeEmitter(fetchImpl as unknown as typeof fetch, {
      onError,
    });
    await emitter.emit(baseReceipt());
    const err = onError.mock.calls[0][0];
    expect(err.code).toBe("malformed_receipt");
    expect(err.message).toContain("amount too large");
  });

  it("retries on 500 up to the configured limit, then returns null", async () => {
    const onError = vi.fn();
    const fetchImpl = mockFetch([
      { status: 500, body: { error: "boom" } },
      { status: 500, body: { error: "boom" } },
      { status: 500, body: { error: "boom" } },
    ]);
    const emitter = makeEmitter(fetchImpl as unknown as typeof fetch, {
      onError,
      retries: 2,
      retryBaseMs: 1, // fast test
    });
    const result = await emitter.emit(baseReceipt());
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[0][0].code).toBe("http_error");
  });

  it("succeeds on second attempt after a transient 500", async () => {
    const fetchImpl = mockFetch([
      { status: 500, body: { error: "transient" } },
      {
        status: 201,
        body: { receipt: { receiptId: "r-retry", state: "signed" } },
      },
    ]);
    const emitter = makeEmitter(fetchImpl as unknown as typeof fetch, {
      retries: 2,
      retryBaseMs: 1,
    });
    const result = await emitter.emit(baseReceipt());
    expect(result?.receiptId).toBe("r-retry");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns null on transport error (fetch throws)", async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const emitter = makeEmitter(fetchImpl as unknown as typeof fetch, {
      onError,
    });
    const result = await emitter.emit(baseReceipt());
    expect(result).toBeNull();
    expect(onError.mock.calls[0][0].code).toBe("transport_error");
  });

  it("returns null on malformed response body", async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () =>
      new Response("not json", {
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
      }),
    );
    const emitter = makeEmitter(fetchImpl as unknown as typeof fetch, {
      onError,
    });
    await emitter.emit(baseReceipt());
    expect(onError.mock.calls[0][0].code).toBe("malformed_response");
  });

  it("returns null when server response lacks receiptId", async () => {
    const onError = vi.fn();
    const fetchImpl = mockFetch([
      { status: 201, body: { receipt: { state: "signed" } } }, // no receiptId
    ]);
    const emitter = makeEmitter(fetchImpl as unknown as typeof fetch, {
      onError,
    });
    await emitter.emit(baseReceipt());
    expect(onError.mock.calls[0][0].code).toBe("malformed_response");
  });
});

describe("ReceiptError shape", () => {
  it("is throwable + carries a stable code enum", () => {
    const err = new ReceiptError("test", "nonce_collision", 409);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ReceiptError);
    expect(err.code).toBe("nonce_collision");
    expect(err.status).toBe(409);
    expect(err.name).toBe("ReceiptError");
  });
});
