/**
 * @klyx/x402 — Express quickstart
 * ────────────────────────────────
 * Runs everything in ONE process so you can see the full flow:
 *
 *   1. an in-process STUB FACILITATOR (localhost:4001) that signs
 *      /verify + /settle responses with a fixture ed25519 key
 *   2. a PAID ENDPOINT server (localhost:3000) that wraps /premium
 *      in paymentMiddleware and points at the stub facilitator
 *   3. a CLIENT that hits /premium — first unpaid (gets 402), then
 *      builds a klever-exact payment payload and retries (gets 200)
 *
 * `npm install && npm start` — no external services, no wallet setup,
 * no facilitator to deploy. Watch the flow in your terminal.
 *
 * When you're ready for real payments, swap:
 *   - the stub facilitator URL → your Klyx facilitator
 *   - the fixture wallet key   → your real Klever wallet
 *   - the payTo address        → your real klv1 address
 */

import express from "express";
import { Buffer } from "node:buffer";
import {
  FacilitatorClient,
  paymentMiddleware,
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

// ── 1. Fixture keys ────────────────────────────────────────
// The facilitator signs responses with an ed25519 key; the
// client trusts responses signed by any pubkey in its
// publicKeysHex allowlist. In prod, the allowlist comes from
// the Klyx contract's facilitatorPublicKeys() view.
const FAC_PRIVATE_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";
const FAC_PUBLIC_KEY = derivePublicKey(FAC_PRIVATE_KEY);

// Provider (receives payment) and requester (pays) wallets —
// generated fresh so you can see the round-trip work with
// real klv1 bech32 addresses.
const provider = generateKleverWallet();
const requester = generateKleverWallet();

// ── 2. Stub facilitator ────────────────────────────────────
const FAC_URL = "http://localhost:4001";

function signAndSend(res, body) {
  const canonical = canonicalize(body);
  const sig = signAttestation({
    canonicalBody: canonical,
    privateKeyHex: FAC_PRIVATE_KEY,
  });
  res.setHeader("x-klyx-facilitator-signature", sig);
  res.setHeader("content-type", "application/json");
  res.send(canonical);
}

const facApp = express();
facApp.use(express.json());
facApp.post("/verify", (req, res) => {
  // Toy verifier: rubber-stamps every payload. A real facilitator
  // checks the attestation, nonce reuse, expiry, and on-chain state.
  const signer = req.body?.paymentPayload?.payload?.authorization?.signer;
  signAndSend(res, { isValid: true, payer: signer });
});
facApp.post("/settle", (req, res) => {
  signAndSend(res, {
    success: true,
    network: NETWORK_KLEVER_TESTNET,
    payer: req.body?.paymentPayload?.payload?.authorization?.signer,
    transaction: "deadbeef".repeat(8), // fake tx hash
  });
});
const facServer = facApp.listen(4001);

// ── 3. Paid endpoint server ────────────────────────────────
const facilitator = new FacilitatorClient({
  url: FAC_URL,
  publicKeysHex: [FAC_PUBLIC_KEY],
  // Demo runs on localhost; FacilitatorClient blocks
  // private/loopback hosts by default (SSRF prevention). In
  // prod, omit this — your facilitator will be on a public URL.
  allowPrivateTargets: true,
});

const app = express();
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
        price: "500000", // 0.5 KLV
        asset: "KLV",
        description: "premium demo endpoint",
      },
    ],
  }),
  (req, res) => {
    res.json({
      msg: "Thanks for paying! Here is your premium content.",
      paidBy: req.x402?.payer,
    });
  },
);
const appServer = app.listen(3000);

// ── 4. Client demo ─────────────────────────────────────────
console.log(`
─── @klyx/x402 quickstart (Express) ───
provider address:  ${provider.address}
requester address: ${requester.address}
paid endpoint:     http://localhost:3000/premium
facilitator (stub): ${FAC_URL}
`);

// (a) Unpaid request → 402 with payment options
const r402 = await fetch("http://localhost:3000/premium");
console.log(`\n[1] GET /premium (no payment)`);
console.log(`    → status: ${r402.status}`);
const body402 = await r402.json();
console.log(`    → error: ${body402.error}`);
console.log(`    → paymentOptions:`, JSON.stringify(body402.paymentOptions[0], null, 2));

// (b) Build a payment payload and retry
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
const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString(
  "base64",
);

const r200 = await fetch("http://localhost:3000/premium", {
  headers: { "X-PAYMENT": xPayment },
});
console.log(`\n[2] GET /premium (with X-PAYMENT header)`);
console.log(`    → status: ${r200.status}`);
console.log(`    → body:  `, await r200.json());

// Give the background /settle call a beat to land before we exit.
await new Promise((r) => setTimeout(r, 50));
console.log(`\n[3] /settle fired in background (stub facilitator logged it above)`);
console.log(`\n─── done ─── (Ctrl+C or wait for auto-exit)`);

facServer.close();
appServer.close();
