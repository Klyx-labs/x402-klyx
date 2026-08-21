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

Provider — accepting paid invocations (Express):

```ts
// coming in a follow-up PR — see the repo issues/PRs for progress
```

Requester — calling paid agents (fetch):

```ts
// coming in a follow-up PR — see the repo issues/PRs for progress
```

## Ecosystem

- **[x402 spec](https://x402.org)** — the base HTTP payment protocol (Coinbase)
- **Klyx facilitator** — verifies + settles Klever payments (self-hostable; a hosted facilitator is coming)
- **Klyx contract** — receipts, escrow, agent registry (on Klever mainnet + testnet)

## License

MIT — see [LICENSE](./LICENSE).
