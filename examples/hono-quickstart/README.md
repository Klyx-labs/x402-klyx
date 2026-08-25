# Hono quickstart — @klyx/x402

Same end-to-end paid HTTP demo as [`../express-quickstart`](../express-quickstart), Hono-idiomatic. Runs everything in one process — stub facilitator + paid endpoint + client — so you can see the 402 → pay → 200 flow without deploying anything.

## Run it

```bash
cd examples/hono-quickstart
npm install
npm start
```

Uses [`@hono/node-server`](https://www.npmjs.com/package/@hono/node-server) as the Node runtime adapter. The same `server.mjs` also runs on Bun (`bun run server.mjs`), Cloudflare Workers, and Deno — that's the point of shipping the middleware for Hono.

## What to change for a real deployment

Same as the Express quickstart — swap the stub facilitator URL for a real one, replace `publicKeysHex` with what the Klyx contract's `facilitatorPublicKeys()` returns, plug in your real Klever wallet, set `payTo` to your `klv1…` address. See [`../express-quickstart/README.md`](../express-quickstart/README.md#what-to-change-for-a-real-deployment) for details.

The only Hono-specific piece: the middleware is imported from the `@klyx/x402/hono` subpath (not the main import). Everything else is identical.
