/**
 * @klyx/x402 — Hono quickstart
 * ────────────────────────────
 * Same demo as ../express-quickstart, hono-idiomatic. Runs in one
 * Node process (via @hono/node-server) so you see the full flow
 * in your terminal.
 *
 * DEFAULT — stub mode (offline). HOSTED — set
 * `USE_HOSTED_FACILITATOR=1` to point at facilitator.klyx.space
 * with the on-chain-registered pubkey. See the express example's
 * header for the full mode comparison.
 *
 * Also works on Bun (`bun run server.mjs`), Cloudflare Workers,
 * or Deno — that's the point of shipping the middleware for Hono.
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

// ── 0. Mode select ─────────────────────────────────────────
const USE_HOSTED = !!process.env.USE_HOSTED_FACILITATOR;

// ── 1. Fixture keys + facilitator pubkey ───────────────────
const FAC_PRIVATE_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";
const HOSTED_FAC_PUBLIC_KEY =
  "8866e19111b1dfa08a72e12e1c895aaf8d22298d5a46cab78eeda529a43e15b4";

const FAC_PUBLIC_KEY = USE_HOSTED
  ? HOSTED_FAC_PUBLIC_KEY
  : derivePublicKey(FAC_PRIVATE_KEY);
const FAC_URL = USE_HOSTED
  ? "https://facilitator.klyx.space"
  : "http://localhost:4001";

const provider = generateKleverWallet();
const requester = generateKleverWallet();

// ── 2. Stub facilitator (only in stub mode) ────────────────
let facServer = null;
if (!USE_HOSTED) {
  const signedResponse = (body) => {
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
  };
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
  facServer = serve({ fetch: facApp.fetch, port: 4001 });
}

// ── 3. Paid endpoint server ────────────────────────────────
const facilitator = new FacilitatorClient({
  url: FAC_URL,
  publicKeysHex: [FAC_PUBLIC_KEY],
  // SSRF guard: relax only for the localhost stub. Hosted mode
  // uses a public URL and keeps the guard on.
  ...(USE_HOSTED ? {} : { allowPrivateTargets: true }),
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
mode:              ${USE_HOSTED ? "HOSTED (real facilitator)" : "STUB (offline)"}
provider address:  ${provider.address}
requester address: ${requester.address}
paid endpoint:     http://localhost:3000/premium
facilitator:       ${FAC_URL}${
  USE_HOSTED
    ? `\ntrusted pubkey:    ${HOSTED_FAC_PUBLIC_KEY.slice(0, 16)}…`
    : ""
}
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
    // Unique per run so repeated hosted-mode invocations don't
    // trip the facilitator's nonce_reused check.
    nonce: "aaaaaaaaaaaaaaaaaaaa" + Date.now().toString(16).padStart(12, "0"),
    expiresAt: "2030-01-01T00:00:00Z",
    wallet,
  },
  NETWORK_KLEVER_TESTNET,
);
const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

const r2 = await fetch("http://localhost:3000/premium", {
  headers: { "X-PAYMENT": xPayment },
});
const r2body = await r2.json();
console.log(`\n[2] GET /premium (with X-PAYMENT header)`);
console.log(`    → status: ${r2.status}`);
console.log(`    → body:  `, r2body);

if (USE_HOSTED) {
  if (r2body.error === "tx_not_found") {
    console.log(
      `\n[3] ✅ Wire chain verified end-to-end. tx_not_found is expected in
    hosted mode because this demo doesn't broadcast a real Klever
    transfer. For a full real-KLV demo see scripts/demo-x402-real
    in the klyx repo.`,
    );
  } else if (r2.status === 200) {
    console.log(
      `\n[3] ✅ Real on-chain transfer already exists (unlikely — collision?).`,
    );
  } else {
    console.log(
      `\n[3] ⚠️  Unexpected response — status ${r2.status}, error: ${r2body.error}`,
    );
  }
} else {
  await new Promise((r) => setTimeout(r, 50));
  console.log(`\n[3] /settle fired in background`);
}

console.log(`\n─── done ───`);

if (facServer) facServer.close();
appServer.close();
