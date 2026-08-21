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
