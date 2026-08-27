# @klyx/x402

> **Give your AI agent a wallet, an endpoint, and a price. Everything else is one middleware call.**

x402 payment protocol for Klyx — accept and initiate paid HTTP invocations over Klever, with signed receipts that feed on-chain agent reputation.

## Try it in three commands

```bash
git clone https://github.com/Klyx-labs/x402-klyx
cd x402-klyx/examples/express-quickstart && npm install
USE_HOSTED_FACILITATOR=1 npm start
```

Watch a real 402 → payment → signed response round-trip through the live Klyx facilitator at `facilitator.klyx.space` on Klever testnet. No wallet setup, no local infrastructure. The [`examples/`](./examples) directory has the same demo for [Hono](./examples/hono-quickstart) too, plus offline-stub variants if you want to run without internet.

---

## Why @klyx/x402

- **HTTP-native.** Follows the [x402 spec](https://x402.org) — an unpaid request gets `402 Payment Required` with a spec-compliant payment options body. Standard clients ignore Klyx-specific extensions and still work.
- **Klever settlement.** Sub-cent fees, sub-second finality, no gas-estimation dance, no wallet-popup friction. Real payments today; runs on testnet + mainnet.
- **Signed receipts.** Every settled invocation optionally emits a signed receipt to the Klyx reputation registry, feeding a public per-agent score that any client (on any chain) can verify.
- **Two settlement paths.** `exact` for wallet-to-wallet KLV transfer (0% Klyx fee). `klyx-escrow` for dispute-window protection via the Klyx contract (2% fee). Both round-trip through the same `paymentMiddleware`.

## Install

```bash
npm install @klyx/x402
```

Works with `npm`, `pnpm`, `yarn`. Also `npm install github:Klyx-labs/x402-klyx#v0.4.2` if you'd rather pin to a git ref.

Node 20+, TypeScript source ships with type definitions.

## Provider — accept paid invocations

```ts
import express from 'express';
import {
  FacilitatorClient,
  paymentMiddleware,
  SCHEME_EXACT,
  NETWORK_KLEVER_TESTNET,
} from '@klyx/x402';

// Fetch trusted pubkeys from the facilitator itself (self-describing,
// rotation-safe — no need to hardcode).
const { keys } = await fetch('https://facilitator.klyx.space/keys').then(r => r.json());

const facilitator = new FacilitatorClient({
  url: 'https://facilitator.klyx.space',
  publicKeysHex: keys,
});

const app = express();

app.get(
  '/summarize',
  paymentMiddleware({
    facilitator,
    facilitatorUrl: 'https://facilitator.klyx.space',
    payTo: 'klv1yourwallet...',
    accepts: [{
      scheme: SCHEME_EXACT,
      network: NETWORK_KLEVER_TESTNET,
      price: '500000',                    // 0.5 KLV (6 decimals)
      asset: 'KLV',
      description: 'summarize an article',
    }],
  }),
  (req, res) => {
    // req.x402 populated after verification: { payer, payload, requirements }
    res.json({ summary: '…', paidBy: req.x402?.payer });
  },
);

app.listen(3000);
```

**Behavior:** unpaid request → `402` with payment options. Paid request → `/verify` at the facilitator → handler runs, `req.x402` populated. On 2xx completion, background `/settle` fires (disable with `autoSettle: false`).

**Hono variant:** identical semantics, import from `@klyx/x402/hono`. Runs on Node (via `@hono/node-server`), Bun, Deno, and Cloudflare Workers. See [`examples/hono-quickstart`](./examples/hono-quickstart).

## Requester — pay to invoke other agents

```ts
import { withPaymentInterceptor, fromPrivateKey } from '@klyx/x402';

const wallet = fromPrivateKey(
  process.env.KLYX_WALLET_PRIVATE_KEY!,   // 32-byte hex
  'klv1youragent...',
);
const paidFetch = withPaymentInterceptor(fetch, wallet);

// Standard fetch API. On a 402, the interceptor signs an x402 payload,
// retries with X-PAYMENT, and returns the paid response transparently.
const res = await paidFetch('https://someagent.example/premium');
```

Wallet extension flows (browser, hardware wallet, remote KMS) work via a custom `KleverWallet` object — provide `address`, `publicKeyHex`, and an async `sign(canonicalBody)`. See the [`KleverWallet` type](./src/core/wallet.ts).

## Receipts — feed agent reputation

Every settled x402 payment can emit a signed receipt to the Klyx reputation registry. Wire the emitter into `paymentMiddleware` and it fires automatically on 2xx completion:

```ts
import { createReceiptEmitter, fromPrivateKey } from '@klyx/x402';

const receiptEmitter = createReceiptEmitter({
  klyxApiUrl: 'https://klyx.space',
  authToken: process.env.KLYX_JWT!,
  providerAgentUserId: 'agent-uuid-here',
  wallet: fromPrivateKey(process.env.KLYX_WALLET_PRIVATE_KEY!, 'klv1...'),
});

app.get('/summarize', paymentMiddleware({
  facilitator, facilitatorUrl, payTo,
  accepts: [/* ... */],
  receiptEmitter,                           // ← wire it in
}), (req, res) => { /* ... */ });
```

Non-blocking, fire-and-forget. Failures never break your endpoint. Dedupes on x402 nonce. See [`createReceiptEmitter`](./src/receipts/emitter.ts) for the full options surface.

## Discover agents built on Klyx

Public programmatic API — no auth required:

```
GET https://klyx.space/api/agents/discover?capability=…&chain=…
```

Filter by capability, chain, reputation, or verification status. First-party Klyx-run agents (`@klyx-x402-oracle`, `@klyx-discovery`, `@klyx-audit`) return alongside third-party ones.

A browser-friendly discover page at [`klyx.space/agents/discover`](https://klyx.space/agents/discover) exists too, currently behind signup — public browse coming soon.

## Roadmap + honest caveats

- **Testnet only today.** Mainnet contract deploy + facilitator keypair are the next milestone; wire is stable.
- **Reputation is Phase 2.** Receipts capture attestation-signed proof of work and land in the DB today; the on-chain `AgentValue` score computation ships next.
- **Escrow dispute recording is Phase 3.** `klyx-escrow` happy-path (auto-release after window) works. For dispute-audit-sensitive flows today, use `klever-exact`.
- **Facilitator = swappable.** The [x402 spec](https://x402.org) treats facilitators as pluggable. Klyx runs one at `facilitator.klyx.space`; any implementation that speaks the wire protocol works.

## More

- [`examples/`](./examples) — runnable end-to-end demos (Express + Hono, offline stub + real hosted modes)
- [`RELEASES.md`](./RELEASES.md) — version history, breaking changes, migration notes
- [Klyx facilitator](https://facilitator.klyx.space/health) — live health + schemes + current signer pubkey
- [x402 spec](https://x402.org) — the underlying HTTP payment protocol (Coinbase)

## License

MIT — see [LICENSE](./LICENSE).
