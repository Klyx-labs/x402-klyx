/**
 * @klyx/x402 — Hono quickstart
 * ────────────────────────────
 * Same demo as ../express-quickstart, hono-idiomatic. Runs
 * everything in ONE Node process (via @hono/node-server) so you
 * can see the full 402 → pay → 200 flow without deploying
 * anything.
 *
 * Also works on Bun (`bun run server.mjs`), Cloudflare Workers,
 * or Deno — that's the point of shipping the middleware for hono.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Buffer } from "node:buffer";
import {
  FacilitatorClient,
  SCHEME_EXACT,
  NETWORK_KLEVER_TESTNET,
  X402_VERSION,
  buildAndSignKleverExactPayload,
  fromPrivateKey,
  generateKleverWallet,
  canonicalize,
  signAttestation,
  derivePublicKey,
} from "@klyx/x402";
import { paymentMiddleware } from "@klyx/x402/hono";

// ── 1. Fixture keys ────────────────────────────────────────
const FAC_PRIVATE_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";
const FAC_PUBLIC_KEY = derivePublicKey(FAC_PRIVATE_KEY);

const provider = generateKleverWallet();
const requester = generateKleverWallet();

// ── 2. Stub facilitator (also Hono, same process) ──────────
const FAC_URL = "http://localhost:4001";

function signedResponse(body) {
  const canonical = canonicalize(body);
  const sig = signAttestation({
    canonicalBody: canonical,
    privateKeyHex: FAC_PRIVATE_KEY,
  });
  return new Response(canonical, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-klyx-facilitator-signature": sig,
    },
  });
}

const facApp = new Hono();
facApp.post("/verify", async (c) => {
  const body = await c.req.json();
  const signer = body?.paymentPayload?.payload?.authorization?.signer;
  return signedResponse({ isValid: true, payer: signer });
});
facApp.post("/settle", async (c) => {
  const body = await c.req.json();
  return signedResponse({
    success: true,
    network: NETWORK_KLEVER_TESTNET,
    payer: body?.paymentPayload?.payload?.authorization?.signer,
    transaction: "deadbeef".repeat(8),
  });
});
const facServer = serve({ fetch: facApp.fetch, port: 4001 });

// ── 3. Paid endpoint server ────────────────────────────────
const facilitator = new FacilitatorClient({
  url: FAC_URL,
  publicKeysHex: [FAC_PUBLIC_KEY],
  // Demo runs on localhost; FacilitatorClient blocks private/
  // loopback hosts by default (SSRF prevention). In prod, omit
  // this — your facilitator will be on a public URL.
  allowPrivateTargets: true,
});

const app = new Hono();
app.get(
  "/premium",
  paymentMiddleware({
    facilitator,
    facilitatorUrl: FAC_URL,
    payTo: provider.address,
    accepts: [
      {
        scheme: SCHEME_EXACT,
        network: NETWORK_KLEVER_TESTNET,
        price: "500000",
        asset: "KLV",
        description: "premium demo endpoint",
      },
    ],
  }),
  (c) => {
    const ctx = c.get("x402");
    return c.json({
      msg: "Thanks for paying! Here is your premium content.",
      paidBy: ctx?.payer,
    });
  },
);
const appServer = serve({ fetch: app.fetch, port: 3000 });

// ── 4. Client demo ─────────────────────────────────────────
console.log(`
─── @klyx/x402 quickstart (Hono) ───
provider address:  ${provider.address}
requester address: ${requester.address}
paid endpoint:     http://localhost:3000/premium
facilitator (stub): ${FAC_URL}
`);

const r402 = await fetch("http://localhost:3000/premium");
console.log(`\n[1] GET /premium (no payment)`);
console.log(`    → status: ${r402.status}`);
const body402 = await r402.json();
console.log(`    → error: ${body402.error}`);
console.log(
  `    → paymentOptions:`,
  JSON.stringify(body402.paymentOptions[0], null, 2),
);

const wallet = fromPrivateKey(requester.privateKeyHex, requester.address);
const paymentPayload = await buildAndSignKleverExactPayload(
  {
    asset: "KLV",
    amount: "500000",
    destination: provider.address,
    nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expiresAt: "2030-01-01T00:00:00Z",
    wallet,
  },
  NETWORK_KLEVER_TESTNET,
);
const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

const r200 = await fetch("http://localhost:3000/premium", {
  headers: { "X-PAYMENT": xPayment },
});
console.log(`\n[2] GET /premium (with X-PAYMENT header)`);
console.log(`    → status: ${r200.status}`);
console.log(`    → body:  `, await r200.json());

await new Promise((r) => setTimeout(r, 50));
console.log(`\n[3] /settle fired in background`);
console.log(`\n─── done ───`);

facServer.close();
appServer.close();
