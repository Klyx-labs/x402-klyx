/**
 * @klyx/x402 — Express quickstart
 * ────────────────────────────────
 * Two modes, one file. Both run in a single process so you see the
 * full flow in your terminal.
 *
 * DEFAULT — stub mode (offline, no external services):
 *   1. in-process STUB FACILITATOR (localhost:4001) that signs
 *      /verify + /settle responses with a fixture ed25519 key and
 *      rubber-stamps every payload
 *   2. PAID ENDPOINT server (localhost:3000) with paymentMiddleware
 *      pointing at the stub
 *   3. CLIENT hits /premium — unpaid → 402, then paid → 200
 *
 * HOSTED mode (real Klyx facilitator on Klever testnet):
 *   Set USE_HOSTED_FACILITATOR=1. Skips the stub; points at the
 *   real facilitator at facilitator.klyx.space + trusts the on-
 *   chain-registered pubkey. The demo returns `tx_not_found`
 *   because it doesn't broadcast a real Klever transfer — that
 *   proves the wire chain end-to-end (Apache → PM2 → facilitator
 *   → Klever API → signed response → client sig verify).
 *
 *   For the full REAL-KLV round-trip (koperator required, moves
 *   real testnet KLV), see scripts/demo-x402-real in the klyx repo.
 *
 *   `USE_HOSTED_FACILITATOR=1 npm start`
 *
 * When you're ready for a production integration:
 *   - drop the stub entirely (already skipped in hosted mode)
 *   - replace the fixture wallets with your real Klever wallet
 *     (see `fromPrivateKey()` and `generateKleverWallet()`)
 *   - point `payTo` at your real klv1 address
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

// ── 0. Mode select ─────────────────────────────────────────
const USE_HOSTED = !!process.env.USE_HOSTED_FACILITATOR;

// ── 1. Fixture keys + facilitator pubkey ───────────────────
// In stub mode: the facilitator signs responses with a fixture
// private key; the client's allowlist is the derived pubkey.
// In hosted mode: the client trusts the pubkey registered on
// the Klyx contract via addFacilitatorPublicKey (queryable via
// facilitatorPublicKeys() view). Rotation-safe: swap this when
// the on-chain set rotates.
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

// Provider (receives payment) and requester (pays) wallets —
// generated fresh so you can see the round-trip work with real
// klv1 bech32 addresses.
const provider = generateKleverWallet();
const requester = generateKleverWallet();

// ── 2. Stub facilitator (only in stub mode) ────────────────
let facServer = null;
if (!USE_HOSTED) {
  const signAndSend = (res, body) => {
    const canonical = canonicalize(body);
    const sig = signAttestation({
      canonicalBody: canonical,
      privateKeyHex: FAC_PRIVATE_KEY,
    });
    res.setHeader("x-klyx-facilitator-signature", sig);
    res.setHeader("content-type", "application/json");
    res.send(canonical);
  };
  const facApp = express();
  facApp.use(express.json());
  facApp.post("/verify", (req, res) => {
    // Toy verifier: rubber-stamps every payload. The real facilitator
    // checks the attestation, nonce reuse, expiry, and on-chain state.
    const signer = req.body?.paymentPayload?.payload?.authorization?.signer;
    signAndSend(res, { isValid: true, payer: signer });
  });
  facApp.post("/settle", (req, res) => {
    signAndSend(res, {
      success: true,
      network: NETWORK_KLEVER_TESTNET,
      payer: req.body?.paymentPayload?.payload?.authorization?.signer,
      transaction: "deadbeef".repeat(8),
    });
  });
  facServer = facApp.listen(4001);
}

// ── 3. Paid endpoint server ────────────────────────────────
const facilitator = new FacilitatorClient({
  url: FAC_URL,
  publicKeysHex: [FAC_PUBLIC_KEY],
  // FacilitatorClient blocks private/loopback hosts by default
  // (SSRF prevention). Only relax that for the stub, which is
  // on localhost. Hosted mode uses a public URL and keeps the
  // guard on.
  ...(USE_HOSTED ? {} : { allowPrivateTargets: true }),
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
    // Unique per run so repeated hosted-mode invocations don't
    // trip the facilitator's nonce_reused check. Stub facilitator
    // ignores nonce reuse.
    nonce: "aaaaaaaaaaaaaaaaaaaa" + Date.now().toString(16).padStart(12, "0"),
    expiresAt: "2030-01-01T00:00:00Z",
    wallet,
  },
  NETWORK_KLEVER_TESTNET,
);
const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString(
  "base64",
);

const r2 = await fetch("http://localhost:3000/premium", {
  headers: { "X-PAYMENT": xPayment },
});
const r2body = await r2.json();
console.log(`\n[2] GET /premium (with X-PAYMENT header)`);
console.log(`    → status: ${r2.status}`);
console.log(`    → body:  `, r2body);

// In hosted mode, tx_not_found is the EXPECTED response — proves the
// wire chain works (Apache → PM2 → facilitator → Klever API → signed
// response → client sig verify), just no matching on-chain transfer
// exists for this fresh throwaway wallet. For the full real-KLV
// round-trip (koperator + funded testnet wallet required), see
// scripts/demo-x402-real in the klyx repo.
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
      `\n[3] ✅ Real on-chain transfer already exists for these throwaway
    wallets (unlikely — collision?). Payment accepted.`,
    );
  } else {
    console.log(
      `\n[3] ⚠️  Unexpected response — status ${r2.status}, error: ${r2body.error}`,
    );
  }
} else {
  await new Promise((r) => setTimeout(r, 50));
  console.log(
    `\n[3] /settle fired in background (stub facilitator processed it)`,
  );
}

console.log(`\n─── done ───`);

if (facServer) facServer.close();
appServer.close();
