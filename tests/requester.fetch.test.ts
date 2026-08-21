import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";

import {
  withPaymentInterceptor,
  PaymentError,
  X402_VERSION,
  SCHEME_EXACT,
  SCHEME_KLYX_ESCROW,
  NETWORK_KLEVER_TESTNET,
  NETWORK_KLEVER_MAINNET,
  type KleverWallet,
  type PaymentAttemptInfo,
} from "../src/index.js";
import type { Http402Body, PaymentOption } from "../src/index.js";
import { derivePublicKey } from "../src/core/signing.js";
import { parseKleverExactPayload } from "../src/core/schemes/kleverExact.js";

const TEST_PRIVATE_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";
const TEST_PUBLIC_KEY = derivePublicKey(TEST_PRIVATE_KEY);

const SIGNER = "klv1requester0000000000000000000000000000000";
const PROVIDER = "klv1provider0000000000000000000000000000000";
const FAC_URL = "https://facilitator.example";
const RESOURCE = "/premium";

const wallet: KleverWallet = {
  address: SIGNER,
  privateKeyHex: TEST_PRIVATE_KEY,
};

function make402Body(overrides?: {
  options?: PaymentOption[];
}): Http402Body {
  return {
    x402Version: X402_VERSION,
    error: "x_payment_required",
    paymentOptions: overrides?.options ?? [
      {
        scheme: SCHEME_EXACT,
        network: NETWORK_KLEVER_TESTNET,
        maxAmountRequired: "500000",
        resource: RESOURCE,
        payTo: PROVIDER,
        asset: "KLV",
        facilitator: { url: FAC_URL },
      },
    ],
  };
}

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "content-type": "application/json" }),
  });
}

/** Sequence-driven mock fetch: returns each provided response in
 *  order across calls. */
function makeSequencedFetch(
  responses: Response[],
): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i];
    i++;
    if (!r) throw new Error("mockFetch: exhausted responses");
    return r.clone();
  });
}

describe("withPaymentInterceptor — passthrough", () => {
  it("returns non-402 responses as-is (no retry)", async () => {
    const inner = makeSequencedFetch([makeResponse(200, { ok: true })]);
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet);
    const res = await paid("https://agent.example/premium");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("returns 404 as-is (no retry, no throw)", async () => {
    const inner = makeSequencedFetch([makeResponse(404, { error: "gone" })]);
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet);
    const res = await paid("https://agent.example/nope");
    expect(res.status).toBe(404);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe("withPaymentInterceptor — 402 → build + sign + retry", () => {
  it("builds klever-exact payload and retries with X-PAYMENT set", async () => {
    const inner = makeSequencedFetch([
      makeResponse(402, make402Body()),
      makeResponse(200, { ok: true, served: true }),
    ]);
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet);
    const res = await paid("https://agent.example/premium");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, served: true });
    expect(inner).toHaveBeenCalledTimes(2);

    // Second call must have X-PAYMENT header with a valid encoded
    // klever-exact payload.
    const retryCall = inner.mock.calls[1];
    const retryInit = retryCall[1] as RequestInit;
    const headers = new Headers(retryInit.headers);
    const xPayment = headers.get("x-payment");
    expect(xPayment).toBeTruthy();

    // Decode + validate the payload envelope + inner shape.
    const decoded = Buffer.from(xPayment!, "base64").toString("utf-8");
    const envelope = JSON.parse(decoded);
    expect(envelope.x402Version).toBe(X402_VERSION);
    expect(envelope.scheme).toBe(SCHEME_EXACT);
    expect(envelope.network).toBe(NETWORK_KLEVER_TESTNET);
    // parseKleverExactPayload does the strict schema check on the
    // inner payload — proves the interceptor built a wire-valid
    // payload the facilitator would accept.
    const inner_payload = parseKleverExactPayload(envelope.payload);
    expect(inner_payload.asset).toBe("KLV");
    expect(inner_payload.amount).toBe("500000");
    expect(inner_payload.destination).toBe(PROVIDER);
    expect(inner_payload.authorization.signer).toBe(SIGNER);
    expect(inner_payload.authorization.publicKey).toBe(TEST_PUBLIC_KEY);
    expect(inner_payload.authorization.attestation).toMatch(/^[0-9a-f]{128}$/);
  });

  it("preserves caller-provided headers on retry (auth, content-type)", async () => {
    const inner = makeSequencedFetch([
      makeResponse(402, make402Body()),
      makeResponse(200, { ok: true }),
    ]);
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet);
    await paid("https://agent.example/premium", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer abc",
      },
      body: JSON.stringify({ query: "hi" }),
    });

    const retryInit = inner.mock.calls[1][1] as RequestInit;
    const retryHeaders = new Headers(retryInit.headers);
    expect(retryHeaders.get("content-type")).toBe("application/json");
    expect(retryHeaders.get("authorization")).toBe("Bearer abc");
    expect(retryHeaders.get("x-payment")).toBeTruthy();
    expect(retryInit.method).toBe("POST");
    expect(retryInit.body).toBe(JSON.stringify({ query: "hi" }));
  });

  it("does NOT retry a second 402 (no infinite loop)", async () => {
    const inner = makeSequencedFetch([
      makeResponse(402, make402Body()),
      makeResponse(402, {
        ...make402Body(),
        error: "invalid_signature",
      }),
    ]);
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet);
    const res = await paid("https://agent.example/premium");
    // Second 402 surfaces to caller — didn't loop into a 3rd request.
    expect(res.status).toBe(402);
    expect(inner).toHaveBeenCalledTimes(2);
    const secondBody = await res.json();
    expect(secondBody.error).toBe("invalid_signature");
  });

  it("fires onPayment hook with attempt info", async () => {
    const inner = makeSequencedFetch([
      makeResponse(402, make402Body()),
      makeResponse(200, { ok: true }),
    ]);
    const onPayment = vi.fn<[PaymentAttemptInfo], void>();
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet, {
      onPayment,
    });
    await paid("https://agent.example/premium");
    expect(onPayment).toHaveBeenCalledTimes(1);
    const info = onPayment.mock.calls[0][0];
    expect(info.scheme).toBe(SCHEME_EXACT);
    expect(info.network).toBe(NETWORK_KLEVER_TESTNET);
    expect(info.amount).toBe("500000");
    expect(info.asset).toBe("KLV");
    expect(info.payTo).toBe(PROVIDER);
    expect(info.resource).toBe(RESOURCE);
    expect(info.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates a fresh nonce per call", async () => {
    const nonces: string[] = [];
    const onPayment = (info: PaymentAttemptInfo) => nonces.push(info.nonce);

    const inner = makeSequencedFetch([
      makeResponse(402, make402Body()),
      makeResponse(200, { ok: true }),
      makeResponse(402, make402Body()),
      makeResponse(200, { ok: true }),
    ]);
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet, {
      onPayment,
    });
    await paid("https://agent.example/a");
    await paid("https://agent.example/b");
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});

describe("withPaymentInterceptor — 402 body malformed", () => {
  it("throws malformed_402 on non-JSON body", async () => {
    const inner = vi.fn(async () =>
      new Response("not json", {
        status: 402,
        headers: new Headers({ "content-type": "text/plain" }),
      }),
    );
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet);
    await expect(paid("https://agent.example/premium")).rejects.toMatchObject({
      code: "malformed_402",
    });
  });

  it("throws malformed_402 when paymentOptions is missing", async () => {
    const inner = makeSequencedFetch([
      makeResponse(402, { x402Version: X402_VERSION, error: "x" }),
    ]);
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet);
    await expect(paid("https://agent.example/premium")).rejects.toMatchObject({
      code: "malformed_402",
    });
  });

  it("throws malformed_402 when maxAmountRequired isn't an integer string", async () => {
    const badBody: Http402Body = make402Body({
      options: [
        {
          scheme: SCHEME_EXACT,
          network: NETWORK_KLEVER_TESTNET,
          maxAmountRequired: "not-a-number",
          resource: RESOURCE,
          payTo: PROVIDER,
          asset: "KLV",
          facilitator: { url: FAC_URL },
        },
      ],
    });
    const inner = makeSequencedFetch([makeResponse(402, badBody)]);
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet);
    await expect(paid("https://agent.example/premium")).rejects.toMatchObject({
      code: "malformed_402",
    });
  });
});

describe("withPaymentInterceptor — no compatible option", () => {
  it("throws no_compatible_option when only wrong-network offered", async () => {
    const inner = makeSequencedFetch([
      makeResponse(
        402,
        make402Body({
          options: [
            {
              scheme: SCHEME_EXACT,
              network: NETWORK_KLEVER_MAINNET,
              maxAmountRequired: "500000",
              resource: RESOURCE,
              payTo: PROVIDER,
              asset: "KLV",
              facilitator: { url: FAC_URL },
            },
          ],
        }),
      ),
    ]);
    // preference defaults to klever-testnet — mainnet-only offer means no match
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet);
    await expect(paid("https://agent.example/premium")).rejects.toMatchObject({
      code: "no_compatible_option",
    });
  });

  it("throws no_compatible_option when only klyx-escrow offered (unsupported client-side)", async () => {
    // klyx-escrow filtered out by pickOption's scheme filter, so
    // the "no compatible option" branch fires (not unsupported_scheme_client).
    const inner = makeSequencedFetch([
      makeResponse(
        402,
        make402Body({
          options: [
            {
              scheme: SCHEME_KLYX_ESCROW,
              network: NETWORK_KLEVER_TESTNET,
              maxAmountRequired: "500000",
              resource: RESOURCE,
              payTo: PROVIDER,
              asset: "KLV",
              facilitator: { url: FAC_URL },
            },
          ],
        }),
      ),
    ]);
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet);
    await expect(paid("https://agent.example/premium")).rejects.toMatchObject({
      code: "no_compatible_option",
    });
  });

  it("picks the preferred option when multiple offered", async () => {
    const inner = makeSequencedFetch([
      makeResponse(
        402,
        make402Body({
          options: [
            // klyx-escrow first (should be skipped by client)
            {
              scheme: SCHEME_KLYX_ESCROW,
              network: NETWORK_KLEVER_TESTNET,
              maxAmountRequired: "500000",
              resource: RESOURCE,
              payTo: PROVIDER,
              asset: "KLV",
              facilitator: { url: FAC_URL },
            },
            // klever-exact matching preferred network
            {
              scheme: SCHEME_EXACT,
              network: NETWORK_KLEVER_TESTNET,
              maxAmountRequired: "500000",
              resource: RESOURCE,
              payTo: PROVIDER,
              asset: "KLV",
              facilitator: { url: FAC_URL },
            },
          ],
        }),
      ),
      makeResponse(200, { ok: true }),
    ]);
    const onPayment = vi.fn<[PaymentAttemptInfo], void>();
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet, {
      onPayment,
    });
    const res = await paid("https://agent.example/premium");
    expect(res.status).toBe(200);
    expect(onPayment.mock.calls[0][0].scheme).toBe(SCHEME_EXACT);
  });
});

describe("withPaymentInterceptor — amount cap", () => {
  it("throws amount_over_cap when 402 asks for more than maxAmount", async () => {
    const inner = makeSequencedFetch([
      makeResponse(
        402,
        make402Body({
          options: [
            {
              scheme: SCHEME_EXACT,
              network: NETWORK_KLEVER_TESTNET,
              maxAmountRequired: "10000000",
              resource: RESOURCE,
              payTo: PROVIDER,
              asset: "KLV",
              facilitator: { url: FAC_URL },
            },
          ],
        }),
      ),
    ]);
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet, {
      maxAmount: "5000000",
    });
    await expect(paid("https://agent.example/premium")).rejects.toMatchObject({
      code: "amount_over_cap",
    });
    // Only one fetch call — did NOT sign or retry after cap rejection.
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("proceeds when amount is at or below maxAmount", async () => {
    const inner = makeSequencedFetch([
      makeResponse(402, make402Body()),
      makeResponse(200, { ok: true }),
    ]);
    const paid = withPaymentInterceptor(inner as unknown as typeof fetch, wallet, {
      maxAmount: "500000",  // exactly the ask
    });
    const res = await paid("https://agent.example/premium");
    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe("withPaymentInterceptor — constructor validation", () => {
  it("throws on missing wallet.address", () => {
    expect(() =>
      withPaymentInterceptor(fetch, {
        address: "",
        privateKeyHex: TEST_PRIVATE_KEY,
      }),
    ).toThrow(/address required/);
  });

  it("throws on missing wallet.privateKeyHex", () => {
    expect(() =>
      withPaymentInterceptor(fetch, {
        address: SIGNER,
        privateKeyHex: "",
      }),
    ).toThrow(/privateKeyHex required/);
  });
});

describe("PaymentError shape", () => {
  it("is throwable + has a stable code enum", () => {
    const err = new PaymentError("test", "malformed_402");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PaymentError);
    expect(err.code).toBe("malformed_402");
    expect(err.name).toBe("PaymentError");
  });
});
