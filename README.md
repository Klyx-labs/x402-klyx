# @klyx/x402

x402 payment protocol client for [Klyx](https://github.com/Klyx-labs) — accept and initiate paid HTTP invocations over Klever, with receipt attestation feeding on-chain agent reputation.

**Status:** `v0` — in active development. Publishing to npm as `@klyx/x402`; the GitHub repo remains `Klyx-labs/x402-klyx`.

> **Just want to try it?** → [`examples/express-quickstart`](./examples/express-quickstart) or [`examples/hono-quickstart`](./examples/hono-quickstart) — clone, `npm install`, `npm start`, watch a paid 402→200 flow run end-to-end in one process.

## What this gives you

If you build an AI agent (or any HTTP service) and want:

- **To accept paid invocations** — drop in a middleware that emits HTTP 402 to unpaid requests, verifies the payment via a Klyx facilitator, and hands the request through when settled.
- **To pay other agents** — drop in a fetch interceptor that transparently handles 402 responses, signs an x402 payment payload with your Klever wallet, and retries.
- **Receipts + reputation** — every settled invocation optionally emits a receipt to Klyx, feeding the agent's on-chain reputation score.

Two settlement paths on Klever:

- `exact` — direct wallet-to-wallet KLV transfer (0% Klyx fee, no dispute recourse)
- `klyx-escrow` — funds held on the Klyx contract for a dispute window, then released (2% Klyx fee)

## Install

```bash
npm install @klyx/x402
# or from git:
npm install github:Klyx-labs/x402-klyx#v0.4.0
```

Works with `pnpm add` and `yarn add`. TypeScript source auto-builds on install via the `prepare` script (git install only).

**Migrating from v0.1?** The wallet interface changed to a callback shape — see [Migrating from v0.1](#migrating-from-v01) at the bottom.

## Quickstart

### Provider — accepting paid invocations (Express)

```ts
import express from 'express';
import {
  FacilitatorClient,
  paymentMiddleware,
  SCHEME_EXACT,
  NETWORK_KLEVER_TESTNET,
} from '@klyx/x402';

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

### Provider — accepting paid invocations (Hono)

Same middleware, hono-idiomatic. Import from the `@klyx/x402/hono` subpath so consumers who only use Express don't pull hono types.

```ts
import { Hono } from 'hono';
import {
  FacilitatorClient,
  SCHEME_EXACT,
  NETWORK_KLEVER_TESTNET,
} from '@klyx/x402';
import { paymentMiddleware, type X402Variables } from '@klyx/x402/hono';

const facilitator = new FacilitatorClient({
  url: 'https://facilitator.klyx.space',
  publicKeysHex: ['<hex pubkey 1>', '<hex pubkey 2>'],
});

// Genericize Hono so c.get('x402') is typed in your handlers.
const app = new Hono<{ Variables: X402Variables }>();

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
        price: '500000',
        asset: 'KLV',
        description: 'summarize an article',
      },
    ],
  }),
  (c) => {
    const { payer } = c.get('x402');
    return c.json({ summary: '…', paidBy: payer });
  },
);

export default app;   // Cloudflare Workers / Bun / Node with @hono/node-server
```

Behavior matches the Express middleware exactly — same 402 body, same header check, same `/verify` + background `/settle`, same `receiptEmitter` + `maxDisputeWindowDays` semantics. Runs anywhere Hono runs (Node, Bun, Deno, Cloudflare Workers).

### Receipts — feeding on-chain agent reputation

Every settled x402 payment can emit a signed receipt to the Klyx API — that's what feeds `AgentValue` (the on-chain reputation score) and makes your agent discoverable + trustable. Wire the emitter into `paymentMiddleware` as an opt-in and it fires automatically after every 2xx completion:

```ts
import { createReceiptEmitter, fromPrivateKey, paymentMiddleware } from '@klyx/x402';

const receiptEmitter = createReceiptEmitter({
  klyxApiUrl: 'https://klyx.space',
  authToken: process.env.KLYX_JWT!,          // provider agent's JWT
  providerAgentUserId: 'agent-uuid-here',    // your agentUserId in Klyx
  wallet: fromPrivateKey(                     // signs the klv-ed25519 attestation
    process.env.KLYX_WALLET_PRIVATE_KEY!,
    'klv1yourwallet...',
  ),
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

**Server-side agent (in-process key):**

```ts
import { withPaymentInterceptor, fromPrivateKey } from '@klyx/x402';

const wallet = fromPrivateKey(
  process.env.KLYX_WALLET_PRIVATE_KEY!,  // 32-byte hex
  'klv1yourwallet...',
);

const paidFetch = withPaymentInterceptor(fetch, wallet, {
  maxAmount: '5000000',  // safety cap: 5 KLV per call max
  onPayment: (info) => {
    console.log(`paid ${info.amount} ${info.asset} to ${info.payTo}`);
  },
});

const res = await paidFetch('https://agent.example/summarize');
```

**Browser / wallet-extension flow (no private key in-process):**

```ts
import { withPaymentInterceptor, type KleverWallet } from '@klyx/x402';

// Wrap whatever your wallet extension exposes for message-signing.
// The library gives you canonical bytes; you return 128-char hex.
const wallet: KleverWallet = {
  address: extensionAccount.address,
  publicKeyHex: extensionAccount.publicKeyHex,
  async sign(canonicalBody) {
    // Popup shows the canonical JSON to the user. On approval:
    return await extension.signMessage(canonicalBody);
  },
};

const paidFetch = withPaymentInterceptor(fetch, wallet, { maxAmount: '5000000' });
```

Same shape works for hardware wallets (Ledger), remote KMS/HSM signers, or anywhere else the caller shouldn't hand raw keys to the library.

Behavior:
- **Non-402 responses pass through unchanged** — no overhead when the endpoint isn't gated
- **On 402** — parses `paymentOptions[]`, picks a `klever-exact` entry matching your preferred network, enforces `maxAmount`, builds + signs (via `wallet.sign`), retries with `X-PAYMENT` set
- **Second 402 surfaces to caller** — no infinite loop; you decide whether to retry manually
- **Errors throw `PaymentError`** with a stable `code` enum: `malformed_402`, `no_compatible_option`, `amount_over_cap`, `unsupported_scheme_client`, `wallet_error` (covers wallet decline / hardware timeout / malformed sig return)

Not in v0:
- `klyx-escrow` scheme (requires on-chain openEscrow tx submission — use `buildKlyxEscrowPayload` from core after submitting the tx yourself)

## What's new in v0.4

**Hono provider middleware** — import from `@klyx/x402/hono` and get the same wire behavior as the Express middleware, drop-in for Cloudflare Workers, Bun, Deno, or Node with `@hono/node-server`. See the [Hono Quickstart](#provider--accepting-paid-invocations-hono) above. No changes required for existing Express consumers.

## What's new in v0.3

**Three additive features, no breaking changes** — existing v0.2.x consumers can bump the git ref to `#v0.3.0` and everything still works.

**1. `generateKleverWallet()` — fresh keypair + `klv1…` address in one call**

```ts
import { generateKleverWallet, fromPrivateKey } from '@klyx/x402';

const { address, publicKeyHex, privateKeyHex } = generateKleverWallet();
// ⚠️ Persist privateKeyHex NOW (env var, secret manager, keystore).
// If lost, funds sent to `address` are unrecoverable.

const wallet = fromPrivateKey(privateKeyHex, address);
```

Random 32-byte ed25519 keypair, `klv1…` address derived via bech32 (Klever wallet convention). Address is 62 chars — matches the Klyx backend's `/api/auth/wallet-login` schema constraint. Not for browser flows where the user's extension holds the key — use an adapter (see `KleverWallet` docs).

**2. `transferTx` on `KleverExactBuildInput`** — optional Klever tx hash of the direct Transfer you submitted. When set, the facilitator does an O(1) `getTransaction(transferTx)` lookup instead of scanning the destination's inbox. Attestation covers the field.

```ts
const payload = await buildAndSignKleverExactPayload({
  asset: 'KLV', amount: '500000', destination, nonce, expiresAt, wallet,
  transferTx: myKoperatorTxHash,   // NEW — pass through from your submission
}, NETWORK_KLEVER_TESTNET);
```

Requires facilitator ≥ the corresponding PR (klyx#627). Older facilitators drop the field via zod strip and fall back to the search path — backwards compat both ways.

**3. `maxDisputeWindowDays` on `AcceptedPayment`** — provider-side cap on how long a `klyx-escrow` payment can lock the funds. Rejects payloads over the cap at the middleware layer with `error: "dispute_window_too_long"`, before hitting the facilitator (saves an RTT). No-op for `klever-exact` (direct settlement has no window).

```ts
paymentMiddleware({
  facilitator, facilitatorUrl, payTo,
  accepts: [{
    scheme: SCHEME_KLYX_ESCROW,
    network: NETWORK_KLEVER_TESTNET,
    price: '500000', asset: 'KLV',
    maxDisputeWindowDays: 7,   // NEW — reject anything > 7 days
  }],
}, handler);
```

## Migrating from v0.1

v0.2 changes the wallet interface from `{ address, privateKeyHex }` to a callback-based `KleverWallet` so browser, hardware-wallet, and remote-KMS flows work — not just in-process private keys.

**Before (v0.1):**

```ts
const wallet = {
  address: 'klv1...',
  privateKeyHex: process.env.KLYX_KEY!,
};
const paidFetch = withPaymentInterceptor(fetch, wallet);
```

**After (v0.2):** wrap in the `fromPrivateKey` helper —

```ts
import { fromPrivateKey } from '@klyx/x402';

const wallet = fromPrivateKey(process.env.KLYX_KEY!, 'klv1...');
const paidFetch = withPaymentInterceptor(fetch, wallet);
```

Same effect, single-line change. `fromPrivateKey` is a thin adapter that derives the pubkey once at construction and implements `sign()` as the same SHA-256 + ed25519 primitive the library used internally in v0.1.

**Wallet-extension flow (new capability, no v0.1 equivalent):**

```ts
const wallet: KleverWallet = {
  address, publicKeyHex,
  async sign(canonicalBody) { return await extension.signMessage(canonicalBody); },
};
```

Applies to both `withPaymentInterceptor` and `createReceiptEmitter` — same wallet type, same migration.

Other v0.2 changes:
- `buildAndSignKleverExactPayload` is now `async` — `await` it (was sync). The exported input type dropped `signer` and `privateKeyHex`; now takes a single `wallet` field.
- `wallet.sign()` return values are validated (128-char lowercase hex, per klv-ed25519). A malformed return throws with a clear error instead of producing garbage signatures the facilitator silently rejects.
- Input validation runs BEFORE `wallet.sign()` is invoked — so a bad payload no longer wastes a hardware-wallet button-press.

## Ecosystem

- **[x402 spec](https://x402.org)** — the base HTTP payment protocol (Coinbase)
- **Klyx facilitator** — verifies + settles Klever payments (self-hostable; a hosted facilitator is coming)
- **Klyx contract** — receipts, escrow, agent registry (on Klever mainnet + testnet)

## License

MIT — see [LICENSE](./LICENSE).
