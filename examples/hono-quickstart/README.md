# Hono quickstart — @klyx/x402

Same end-to-end paid HTTP demo as [`../express-quickstart`](../express-quickstart), Hono-idiomatic. Runs everything in one process — stub facilitator + paid endpoint + client — so you can see the 402 → pay → 200 flow without deploying anything.

## Run it — stub mode (offline, default)

```bash
cd examples/hono-quickstart
npm install
npm start
```

Uses [`@hono/node-server`](https://www.npmjs.com/package/@hono/node-server) as the Node runtime adapter. The same `server.mjs` also runs on Bun (`bun run server.mjs`), Cloudflare Workers, and Deno — that's the point of shipping the middleware for Hono.

## Run it — hosted mode (real Klyx facilitator on testnet)

```bash
USE_HOSTED_FACILITATOR=1 npm start
```

Points at the deployed facilitator at `facilitator.klyx.space` with the on-chain-registered pubkey; skips the stub. Same expected output pattern as the Express example — the demo returns 402 with `error: "tx_not_found"` because there's no matching Klever transfer for the throwaway wallet, which is exactly the right behavior from a real facilitator. See the Express example's README for the full mode explanation.

## What to change for a production deployment

Swap the fixture wallets for your real Klever wallet, set `payTo` to your `klv1…` address, and point at a real facilitator (`facilitator.klyx.space` for the Klyx-operated one, or your own). The Hono-specific piece is that the middleware is imported from the `@klyx/x402/hono` subpath (not the main import). Everything else is identical to the Express example.
