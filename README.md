# x402-klyx

x402 payment protocol client for [Klyx](https://github.com/Klyx-labs) — accept and initiate paid HTTP invocations over Klever, with receipt attestation feeding on-chain agent reputation.

**Status:** `v0` — in active development. Git-installable today, npm publish comes once the API stabilizes.

## What this gives you

If you build an AI agent (or any HTTP service) and want:

- **To accept paid invocations** — drop in a middleware that emits HTTP 402 to unpaid requests, verifies the payment via a Klyx facilitator, and hands the request through when settled.
- **To pay other agents** — drop in a fetch interceptor that transparently handles 402 responses, signs an x402 payment payload with your Klever wallet, and retries.
- **Receipts + reputation** — every settled invocation optionally emits a receipt to Klyx, feeding the agent's on-chain reputation score.

Two settlement paths on Klever:

- `exact` — direct wallet-to-wallet KLV transfer (0% Klyx fee, no dispute recourse)
- `klyx-escrow` — funds held on the Klyx contract for a dispute window, then released (2% Klyx fee)

## Install

Not on npm yet. Install directly from git:

```bash
# Pinned to a release tag (recommended)
npm install github:Klyx-labs/x402-klyx#v0.1.0

# Or a specific commit
npm install github:Klyx-labs/x402-klyx#<sha>
```

Also works with `pnpm add` and `yarn add`. TypeScript source auto-builds on install via the `prepare` script.

## Quickstart

### Provider — accepting paid invocations (Express)

```ts
import express from 'express';
import {
  FacilitatorClient,
  paymentMiddleware,
  SCHEME_EXACT,
  NETWORK_KLEVER_TESTNET,
} from 'x402-klyx';

const app = express();

const facilitator = new FacilitatorClient({
  url: 'https://facilitator.klyx.space',
  // Ed25519 public keys advertised by the Klyx contract's
  // facilitatorPublicKeys() view. Rotate here when the on-chain
  // set rotates.
  publicKeysHex: ['<hex pubkey 1>', '<hex pubkey 2>'],
});

app.get(
  '/summarize',
  paymentMiddleware({
    facilitator,
    facilitatorUrl: 'https://facilitator.klyx.space',
    payTo: 'klv1yourwallet...',
    accepts: [
      {
        scheme: SCHEME_EXACT,
        network: NETWORK_KLEVER_TESTNET,
        price: '500000',   // 0.5 KLV (6-decimals)
        asset: 'KLV',
        description: 'summarize an article',
      },
    ],
  }),
  (req, res) => {
    // req.x402 is populated after successful verification:
    //   req.x402.payer      — klv1... address that paid
    //   req.x402.payload    — the raw payment payload
    //   req.x402.requirements — what we asked for
    res.json({ summary: '…', paidBy: req.x402?.payer });
  },
);

app.listen(3000);
```

Behavior:
- Request with no `X-PAYMENT` header → HTTP 402 with `paymentOptions[]` from your `accepts` array
- Request with `X-PAYMENT` → base64-decoded, cross-checked, sent to `/verify` on the facilitator
- On `isValid: true` → your handler runs, `req.x402` populated
- On a 2xx response → `/settle` fires in the background (disable with `autoSettle: false`)
- On any facilitator transport / signature failure → HTTP 502 with structured `code`

### Receipts — feeding on-chain agent reputation

Every settled x402 payment can emit a signed receipt to the Klyx API — that's what feeds `AgentValue` (the on-chain reputation score) and makes your agent discoverable + trustable. Wire the emitter into `paymentMiddleware` as an opt-in and it fires automatically after every 2xx completion:

```ts
import { createReceiptEmitter, paymentMiddleware } from 'x402-klyx';

const receiptEmitter = createReceiptEmitter({
  klyxApiUrl: 'https://klyx.space',
  authToken: process.env.KLYX_JWT!,          // provider agent's JWT
  providerAgentUserId: 'agent-uuid-here',    // your agentUserId in Klyx
  wallet: {                                   // signs the klv-ed25519 attestation
    address: 'klv1yourwallet...',
    privateKeyHex: process.env.KLYX_WALLET_PRIVATE_KEY!,
  },
  onError: (err, receipt) => {
    // Failed emissions do NOT block your response; log/alert here.
    console.error(`receipt emission failed (${err.code})`, receipt.nonce);
  },
});

app.get('/summarize', paymentMiddleware({
  facilitator,
  facilitatorUrl: 'https://facilitator.klyx.space',
  payTo: 'klv1yourwallet...',
  accepts: [{ scheme: SCHEME_EXACT, network: NETWORK_KLEVER_TESTNET, price: '500000', asset: 'KLV' }],
  receiptEmitter,                              // ← wire it in
  providerEndpointId: 'endpoint-uuid-here',   // optional
}), (req, res) => {
  res.json({ summary: '...' });
});
```

Behavior:
- Fires on 2xx completion (non-2xx skips — client got an error, no receipt)
- Non-blocking — the emitter is fire-and-forget; a Klyx API outage doesn't break your endpoint
- Signs each receipt with your wallet's ed25519 key (klv-ed25519 scheme per ADR-017 D17)
- Deduplicates via the x402 payment nonce (409 on collision = already recorded = no-op)
- Retries transport errors with backoff; skips retries for deterministic failures (401, 409, 400)

Standalone use (without the middleware):

```ts
const result = await receiptEmitter.emit({
  outcome: 'completed',
  requesterWallet: 'klv1requester...',
  paymentAsset: 'KLV',
  paymentAmountSmallest: '500000',
  paymentTxHash: '...',
  settlementType: 'direct',
  invokedAt: '2026-08-21T15:00:00Z',
  completedAt: '2026-08-21T15:00:01Z',
  nonce: 'aaaa...',
});
// { receiptId: '...', state: 'signed' } | null (on error)
```

### Requester — calling paid agents (fetch)

```ts
import { withPaymentInterceptor } from 'x402-klyx';

const wallet = {
  address: 'klv1yourwallet...',
  privateKeyHex: process.env.KLYX_WALLET_PRIVATE_KEY!,  // 32-byte hex
};

const paidFetch = withPaymentInterceptor(fetch, wallet, {
  maxAmount: '5000000',  // safety cap: 5 KLV per call max
  onPayment: (info) => {
    console.log(`paid ${info.amount} ${info.asset} to ${info.payTo}`);
  },
});

// Drop-in wherever you'd normally use fetch. If the endpoint
// returns 402, the interceptor builds + signs a klever-exact
// payload and retries automatically.
const res = await paidFetch('https://agent.example/summarize', {
  method: 'POST',
  body: JSON.stringify({ url: '...' }),
  headers: { 'content-type': 'application/json' },
});

if (res.status === 200) {
  const data = await res.json();
  // ...
}
```

Behavior:
- **Non-402 responses pass through unchanged** — no fetch overhead when the endpoint isn't gated
- **On 402** — parses `paymentOptions[]`, picks a `klever-exact` entry matching your preferred network, enforces `maxAmount`, builds + signs a payload with your wallet's ed25519 key, retries with `X-PAYMENT` set
- **Second 402 surfaces to caller** — no infinite loop; you decide whether to retry manually
- **Errors throw `PaymentError`** with a stable `code` enum: `malformed_402`, `no_compatible_option`, `amount_over_cap`, `unsupported_scheme_client`, `wallet_error`

Not in v0:
- `klyx-escrow` scheme (requires on-chain openEscrow tx submission — use `buildKlyxEscrowPayload` from core after submitting the tx yourself)
- Callback-style wallet signing (only in-process `privateKeyHex` today; wallet-extension bridges land in a follow-up)

## Ecosystem

- **[x402 spec](https://x402.org)** — the base HTTP payment protocol (Coinbase)
- **Klyx facilitator** — verifies + settles Klever payments (self-hostable; a hosted facilitator is coming)
- **Klyx contract** — receipts, escrow, agent registry (on Klever mainnet + testnet)

## License

MIT — see [LICENSE](./LICENSE).
