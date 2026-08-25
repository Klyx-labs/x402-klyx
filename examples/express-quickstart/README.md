# Express quickstart — @klyx/x402

End-to-end paid HTTP demo in one process:

- stub facilitator on `localhost:4001` (signs `/verify` + `/settle` with a fixture ed25519 key)
- paid Express endpoint on `localhost:3000/premium` wrapped in `paymentMiddleware`
- client demo — hits `/premium` unpaid (gets 402 with payment options), builds a `klever-exact` payload, retries with `X-PAYMENT` header (gets 200)

## Run it

```bash
cd examples/express-quickstart
npm install
npm start
```

Expected output (paraphrased):

```
─── @klyx/x402 quickstart (Express) ───
provider address:  klv1…
requester address: klv1…
paid endpoint:     http://localhost:3000/premium
facilitator (stub): http://localhost:4001

[1] GET /premium (no payment)
    → status: 402
    → error: x_payment_required
    → paymentOptions: { scheme: "exact", … price: "500000", asset: "KLV" }

[2] GET /premium (with X-PAYMENT header)
    → status: 200
    → body:   { msg: "Thanks for paying! …", paidBy: "klv1…" }

[3] /settle fired in background
```

## What to change for a real deployment

The stub facilitator rubber-stamps every payment (see comment in `server.mjs`). To go real:

1. **Replace the facilitator URL** with a real one (`https://facilitator.klyx.space` once deployed, or self-host from the `klyx` repo's `docker-compose.yml`).
2. **Replace `publicKeysHex`** with the pubkeys the Klyx contract's `facilitatorPublicKeys()` view returns.
3. **Replace the fixture wallets** with your real Klever wallet — see `fromPrivateKey()` and `generateKleverWallet()` in `@klyx/x402`.
4. **Set `payTo`** to your real `klv1…` address.

Everything else — the middleware, the payload builder, the `X-PAYMENT` header flow — stays identical.

## Hono variant

Same demo in Hono: [`../hono-quickstart`](../hono-quickstart).
