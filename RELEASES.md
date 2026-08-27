# Releases

Version history + migration notes for `@klyx/x402`. Point-in-time record; the [README](./README.md) always reflects current-tip behavior.

---

## v0.4.2 — README rewrite

Docs-only republish so npmjs.com surfaces the rewritten README + this release history file. No library changes.

- README trimmed 345 → 148 lines; leads with a three-command hosted-facilitator demo, opinionated "why" bullets, honest roadmap.
- New `RELEASES.md` (this file) — version history + migration notes moved out of README, now included in the npm tarball.
- Provider example in the README now shows fetching pubkeys from `facilitator.klyx.space/keys` (self-describing rotation-set endpoint) instead of hardcoding.

## v0.4.1 — Hosted-facilitator toggle in examples

Docs + examples update; no library changes.

- Both quickstart examples (`express-quickstart` + `hono-quickstart`) now support an `USE_HOSTED_FACILITATOR=1` env toggle. Skips the in-process stub; points `FacilitatorClient` at the deployed Klyx facilitator at `facilitator.klyx.space` with the on-chain-registered pubkey.
- Nonce in examples is now timestamp-based (was hardcoded static — would trip `nonce_reused` on the real facilitator on repeat runs).
- SSRF `allowPrivateTargets` guard now conditional (stub-only) — hosted mode keeps the guard on.

## v0.4.0 — Hono provider middleware

- New `paymentMiddleware` for Hono, imported from `@klyx/x402/hono` subpath. Same wire behavior as the Express middleware; runs on Node (`@hono/node-server`), Bun, Deno, Cloudflare Workers.
- Consumers can genericize their Hono instance with `Hono<{ Variables: X402Variables }>()` to get typed `c.get('x402')` in handlers.
- Zero breaking changes. Existing Express consumers unaffected.

## v0.3.0 — Wallet gen + fast-path + escrow-window cap

Three additive features, no breaking changes.

### `generateKleverWallet()`

Fresh keypair + `klv1…` address in one call.

```ts
import { generateKleverWallet, fromPrivateKey } from '@klyx/x402';

const { address, publicKeyHex, privateKeyHex } = generateKleverWallet();
// ⚠️ Persist privateKeyHex NOW (env, secret manager, keystore).
// If lost, funds sent to `address` are unrecoverable.

const wallet = fromPrivateKey(privateKeyHex, address);
```

Random 32-byte ed25519 keypair, `klv1…` address derived via bech32. 62 chars — matches the Klyx backend's `/api/auth/wallet-login` schema. Not for browser flows where the extension holds the key; use an adapter.

### `transferTx` on `KleverExactBuildInput`

Optional Klever tx hash of the direct Transfer you submitted. When set, the facilitator does an O(1) `getTransaction(transferTx)` lookup instead of scanning the destination's inbox. Attestation covers the field.

```ts
const payload = await buildAndSignKleverExactPayload({
  asset: 'KLV', amount: '500000', destination, nonce, expiresAt, wallet,
  transferTx: myKoperatorTxHash,   // NEW
}, NETWORK_KLEVER_TESTNET);
```

Backwards compat both ways — older facilitators drop the field via zod strip and fall back to the search path.

### `maxDisputeWindowDays` on `AcceptedPayment`

Provider-side cap on how long a `klyx-escrow` payment can lock the funds. Rejects payloads over the cap at the middleware layer with `error: "dispute_window_too_long"`, before hitting the facilitator (saves an RTT). No-op for `klever-exact`.

```ts
paymentMiddleware({
  facilitator, facilitatorUrl, payTo,
  accepts: [{
    scheme: SCHEME_KLYX_ESCROW,
    network: NETWORK_KLEVER_TESTNET,
    price: '500000', asset: 'KLV',
    maxDisputeWindowDays: 7,   // NEW
  }],
}, handler);
```

---

## Migrating from v0.1

v0.2 changed the wallet interface from `{ address, privateKeyHex }` to a callback-based `KleverWallet` so browser, hardware-wallet, and remote-KMS flows work — not just in-process private keys.

**Before (v0.1):**

```ts
const wallet = {
  address: 'klv1...',
  privateKeyHex: process.env.KLYX_KEY!,
};
const paidFetch = withPaymentInterceptor(fetch, wallet);
```

**After (v0.2+):** wrap in the `fromPrivateKey` helper —

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
- `buildAndSignKleverExactPayload` is now `async` — `await` it. Input type dropped `signer` and `privateKeyHex`; now takes a single `wallet` field.
- `wallet.sign()` return values are validated (128-char lowercase hex, per klv-ed25519). A malformed return throws with a clear error instead of producing garbage signatures the facilitator silently rejects.
- Input validation runs BEFORE `wallet.sign()` is invoked — so a bad payload no longer wastes a hardware-wallet button-press.
