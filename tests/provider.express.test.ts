import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Buffer } from "node:buffer";

import {
  FacilitatorClient,
  paymentMiddleware,
  X402_VERSION,
  SCHEME_EXACT,
  NETWORK_KLEVER_TESTNET,
  type ReceiptEmitter,
  type EmittedReceipt,
  type ReceiptInput,
} from "../src/index.js";
import { canonicalize } from "../src/core/canonicalize.js";
import {
  signAttestation,
  derivePublicKey,
} from "../src/core/signing.js";

const TEST_PRIVATE_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";
const TEST_PUBLIC_KEY = derivePublicKey(TEST_PRIVATE_KEY);

const PAY_TO = "klv1provider0000000000000000000000000000000";
const REQUESTER = "klv1requester0000000000000000000000000000000";
const FAC_URL = "https://facilitator.example";

function encodePayment(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** Builds a mocked fetch that dispatches by path + signs responses
 *  with the fixture facilitator key so FacilitatorClient's
 *  signature check passes. */
function makeMockFetch(
  responses: Record<string, { status?: number; body: unknown }>,
) {
  return vi.fn(async (url: string | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    const path = new URL(u).pathname;
    const r = responses[path];
    if (!r) throw new Error(`mockFetch: no response registered for ${path}`);
    const canonicalBody = canonicalize(r.body);
    const sig = signAttestation({
      canonicalBody,
      privateKeyHex: TEST_PRIVATE_KEY,
    });
    return new Response(canonicalBody, {
      status: r.status ?? 200,
      headers: new Headers({
        "content-type": "application/json",
        "x-klyx-facilitator-signature": sig,
      }),
    });
  });
}

function makeFacilitator(mockFetch: typeof fetch): FacilitatorClient {
  return new FacilitatorClient({
    url: FAC_URL,
    publicKeysHex: [TEST_PUBLIC_KEY],
    fetch: mockFetch,
  });
}

function makeApp(
  mockFetch: typeof fetch,
  overrides: Partial<Parameters<typeof paymentMiddleware>[0]> = {},
  handlerStatus = 200,
): express.Express {
  const app = express();
  app.get(
    "/premium",
    paymentMiddleware({
      facilitator: makeFacilitator(mockFetch),
      facilitatorUrl: FAC_URL,
      payTo: PAY_TO,
      accepts: [
        {
          scheme: SCHEME_EXACT,
          network: NETWORK_KLEVER_TESTNET,
          price: "500000",
          asset: "KLV",
          description: "premium endpoint",
        },
      ],
      ...overrides,
    }),
    (req, res) => {
      if (handlerStatus !== 200) {
        res.status(handlerStatus).json({ error: "handler_failed" });
        return;
      }
      res.json({ ok: true, payer: req.x402?.payer });
    },
  );
  return app;
}

const SAMPLE_PAYLOAD = {
  x402Version: X402_VERSION,
  scheme: SCHEME_EXACT,
  network: NETWORK_KLEVER_TESTNET,
  payload: {
    asset: "KLV",
    amount: "500000",
    destination: PAY_TO,
    nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expiresAt: "2030-01-01T00:00:00Z",
    authorization: {
      signer: REQUESTER,
      publicKey: TEST_PUBLIC_KEY,
      attestation: "0".repeat(128),
    },
  },
};

describe("paymentMiddleware — no X-PAYMENT header", () => {
  it("emits 402 with paymentOptions built from accepts", async () => {
    const app = makeApp(makeMockFetch({}) as unknown as typeof fetch);
    const res = await request(app).get("/premium");
    expect(res.status).toBe(402);
    expect(res.body.x402Version).toBe(X402_VERSION);
    expect(res.body.error).toBe("x_payment_required");
    expect(res.body.paymentOptions).toHaveLength(1);
    const opt = res.body.paymentOptions[0];
    expect(opt.scheme).toBe(SCHEME_EXACT);
    expect(opt.network).toBe(NETWORK_KLEVER_TESTNET);
    expect(opt.maxAmountRequired).toBe("500000");
    expect(opt.payTo).toBe(PAY_TO);
    expect(opt.asset).toBe("KLV");
    expect(opt.description).toBe("premium endpoint");
    expect(opt.facilitator).toEqual({ url: FAC_URL });
    expect(opt.resource).toBe("/premium");
  });
});

describe("paymentMiddleware — malformed X-PAYMENT", () => {
  it("emits 402 malformed_payment_header on non-JSON decoded content", async () => {
    const app = makeApp(makeMockFetch({}) as unknown as typeof fetch);
    const res = await request(app)
      .get("/premium")
      .set("X-PAYMENT", Buffer.from("not-json").toString("base64"));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("malformed_payment_header");
  });

  it("emits 402 malformed_payment_header on wrong envelope shape", async () => {
    const app = makeApp(makeMockFetch({}) as unknown as typeof fetch);
    const res = await request(app)
      .get("/premium")
      .set("X-PAYMENT", encodePayment({ scheme: "exact" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("malformed_payment_header");
  });

  it("emits 402 malformed_payment_header when payload is an array", async () => {
    const app = makeApp(makeMockFetch({}) as unknown as typeof fetch);
    const res = await request(app)
      .get("/premium")
      .set(
        "X-PAYMENT",
        encodePayment({
          x402Version: X402_VERSION,
          scheme: SCHEME_EXACT,
          network: NETWORK_KLEVER_TESTNET,
          payload: [],
        }),
      );
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("malformed_payment_header");
  });
});

describe("paymentMiddleware — scheme/network mismatch", () => {
  it("emits 402 unsupported_scheme_network for a scheme we don't accept", async () => {
    const app = makeApp(makeMockFetch({}) as unknown as typeof fetch);
    const res = await request(app)
      .get("/premium")
      .set(
        "X-PAYMENT",
        encodePayment({
          x402Version: X402_VERSION,
          scheme: SCHEME_EXACT,
          network: "base-sepolia",
          payload: {},
        }),
      );
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("unsupported_scheme_network");
  });
});

describe("paymentMiddleware — verify success", () => {
  it("gates the request through on isValid=true and attaches req.x402", async () => {
    const mockFetch = makeMockFetch({
      "/verify": { body: { isValid: true, payer: REQUESTER } },
      "/settle": {
        body: { success: true, network: NETWORK_KLEVER_TESTNET, payer: REQUESTER },
      },
    });
    const app = makeApp(mockFetch as unknown as typeof fetch);
    const res = await request(app)
      .get("/premium")
      .set("X-PAYMENT", encodePayment(SAMPLE_PAYLOAD));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, payer: REQUESTER });
  });
});

describe("paymentMiddleware — verify failure", () => {
  it("emits 402 with the facilitator's invalidReason", async () => {
    const mockFetch = makeMockFetch({
      "/verify": {
        body: { isValid: false, invalidReason: "nonce_reused" },
      },
    });
    const app = makeApp(mockFetch as unknown as typeof fetch);
    const res = await request(app)
      .get("/premium")
      .set("X-PAYMENT", encodePayment(SAMPLE_PAYLOAD));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("nonce_reused");
  });
});

describe("paymentMiddleware — facilitator transport error", () => {
  it("emits 502 facilitator_error with structured code", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const app = makeApp(mockFetch as unknown as typeof fetch);
    const res = await request(app)
      .get("/premium")
      .set("X-PAYMENT", encodePayment(SAMPLE_PAYLOAD));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: "facilitator_error",
      code: "transport_error",
    });
  });
});

describe("paymentMiddleware — autoSettle behavior", () => {
  it("calls /settle after a 2xx response by default", async () => {
    const mockFetch = makeMockFetch({
      "/verify": { body: { isValid: true, payer: REQUESTER } },
      "/settle": {
        body: { success: true, network: NETWORK_KLEVER_TESTNET, payer: REQUESTER },
      },
    });
    const app = makeApp(mockFetch as unknown as typeof fetch);
    await request(app)
      .get("/premium")
      .set("X-PAYMENT", encodePayment(SAMPLE_PAYLOAD));
    // Background settle fires on res.on('finish'); give the event
    // loop a tick before asserting.
    await new Promise((r) => setTimeout(r, 20));
    const paths = mockFetch.mock.calls.map((c) =>
      new URL(c[0] as string).pathname,
    );
    expect(paths).toContain("/verify");
    expect(paths).toContain("/settle");
  });

  it("does NOT call /settle when autoSettle: false", async () => {
    const mockFetch = makeMockFetch({
      "/verify": { body: { isValid: true, payer: REQUESTER } },
    });
    const app = makeApp(mockFetch as unknown as typeof fetch, {
      autoSettle: false,
    });
    await request(app)
      .get("/premium")
      .set("X-PAYMENT", encodePayment(SAMPLE_PAYLOAD));
    await new Promise((r) => setTimeout(r, 20));
    const paths = mockFetch.mock.calls.map((c) =>
      new URL(c[0] as string).pathname,
    );
    expect(paths).toContain("/verify");
    expect(paths).not.toContain("/settle");
  });

  it("does NOT call /settle when handler returns non-2xx (500)", async () => {
    const mockFetch = makeMockFetch({
      "/verify": { body: { isValid: true, payer: REQUESTER } },
    });
    const app = makeApp(mockFetch as unknown as typeof fetch, {}, 500);
    await request(app)
      .get("/premium")
      .set("X-PAYMENT", encodePayment(SAMPLE_PAYLOAD));
    await new Promise((r) => setTimeout(r, 20));
    const paths = mockFetch.mock.calls.map((c) =>
      new URL(c[0] as string).pathname,
    );
    expect(paths).toContain("/verify");
    expect(paths).not.toContain("/settle");
  });
});

describe("paymentMiddleware — receiptEmitter integration", () => {
  function makeCapturingEmitter(): {
    emitter: ReceiptEmitter;
    emits: ReceiptInput[];
  } {
    const emits: ReceiptInput[] = [];
    const emitter: ReceiptEmitter = {
      async emit(r) {
        emits.push(r);
        const result: EmittedReceipt = { receiptId: "r-test", state: "signed" };
        return result;
      },
    };
    return { emitter, emits };
  }

  it("fires the emitter on 2xx completion with derived fields", async () => {
    const mockFetch = makeMockFetch({
      "/verify": { body: { isValid: true, payer: REQUESTER } },
      "/settle": {
        body: {
          success: true,
          network: NETWORK_KLEVER_TESTNET,
          payer: REQUESTER,
          transaction: "deadbeef".repeat(8),
        },
      },
    });
    const { emitter, emits } = makeCapturingEmitter();
    const app = makeApp(mockFetch as unknown as typeof fetch, {
      receiptEmitter: emitter,
      providerEndpointId: "22222222-2222-2222-2222-222222222222",
    });
    await request(app)
      .get("/premium")
      .set("X-PAYMENT", encodePayment(SAMPLE_PAYLOAD));
    await new Promise((r) => setTimeout(r, 30));  // let background emit + settle land

    expect(emits).toHaveLength(1);
    const r = emits[0];
    expect(r.outcome).toBe("completed");
    expect(r.requesterWallet).toBe(REQUESTER);
    expect(r.paymentAsset).toBe("KLV");
    expect(r.paymentAmountSmallest).toBe("500000");
    expect(r.settlementType).toBe("direct");  // exact → direct
    expect(r.nonce).toBe(SAMPLE_PAYLOAD.payload.nonce);
    expect(r.providerEndpointId).toBe("22222222-2222-2222-2222-222222222222");
    expect(r.capability).toBe("premium endpoint");  // from accepts.description
    expect(r.paymentTxHash).toBe("deadbeef".repeat(8));  // from /settle
    expect(r.invokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("passes through X-Klyx-Requester-Agent header when present", async () => {
    const mockFetch = makeMockFetch({
      "/verify": { body: { isValid: true, payer: REQUESTER } },
      "/settle": {
        body: { success: true, network: NETWORK_KLEVER_TESTNET, payer: REQUESTER },
      },
    });
    const { emitter, emits } = makeCapturingEmitter();
    const app = makeApp(mockFetch as unknown as typeof fetch, {
      receiptEmitter: emitter,
    });
    const agentId = "33333333-3333-3333-3333-333333333333";
    await request(app)
      .get("/premium")
      .set("X-PAYMENT", encodePayment(SAMPLE_PAYLOAD))
      .set("X-Klyx-Requester-Agent", agentId);
    await new Promise((r) => setTimeout(r, 30));

    expect(emits[0].requesterAgentUserId).toBe(agentId);
  });

  it("does NOT fire the emitter on non-2xx (handler 500)", async () => {
    const mockFetch = makeMockFetch({
      "/verify": { body: { isValid: true, payer: REQUESTER } },
    });
    const { emitter, emits } = makeCapturingEmitter();
    const app = makeApp(
      mockFetch as unknown as typeof fetch,
      { receiptEmitter: emitter },
      500,
    );
    await request(app)
      .get("/premium")
      .set("X-PAYMENT", encodePayment(SAMPLE_PAYLOAD));
    await new Promise((r) => setTimeout(r, 30));

    expect(emits).toHaveLength(0);
  });

  it("still fires the emitter when autoSettle: false (no tx hash)", async () => {
    const mockFetch = makeMockFetch({
      "/verify": { body: { isValid: true, payer: REQUESTER } },
    });
    const { emitter, emits } = makeCapturingEmitter();
    const app = makeApp(mockFetch as unknown as typeof fetch, {
      receiptEmitter: emitter,
      autoSettle: false,
    });
    await request(app)
      .get("/premium")
      .set("X-PAYMENT", encodePayment(SAMPLE_PAYLOAD));
    await new Promise((r) => setTimeout(r, 30));

    expect(emits).toHaveLength(1);
    expect(emits[0].paymentTxHash).toBeUndefined();
  });
});

describe("paymentMiddleware — constructor validation", () => {
  const fac = makeFacilitator(makeMockFetch({}) as unknown as typeof fetch);
  const baseAccept = [
    {
      scheme: SCHEME_EXACT,
      network: NETWORK_KLEVER_TESTNET,
      price: "1",
      asset: "KLV",
    },
  ];

  it("throws when facilitator is missing", () => {
    expect(() =>
      paymentMiddleware({
        facilitator: undefined as unknown as FacilitatorClient,
        facilitatorUrl: FAC_URL,
        payTo: PAY_TO,
        accepts: baseAccept,
      }),
    ).toThrow(/facilitator required/);
  });

  it("throws when facilitatorUrl is missing", () => {
    expect(() =>
      paymentMiddleware({
        facilitator: fac,
        facilitatorUrl: "",
        payTo: PAY_TO,
        accepts: baseAccept,
      }),
    ).toThrow(/facilitatorUrl required/);
  });

  it("throws when payTo is missing", () => {
    expect(() =>
      paymentMiddleware({
        facilitator: fac,
        facilitatorUrl: FAC_URL,
        payTo: "",
        accepts: baseAccept,
      }),
    ).toThrow(/payTo required/);
  });

  it("throws when accepts is empty", () => {
    expect(() =>
      paymentMiddleware({
        facilitator: fac,
        facilitatorUrl: FAC_URL,
        payTo: PAY_TO,
        accepts: [],
      }),
    ).toThrow(/at least one entry/);
  });
});
