# Express quickstart — @klyx/x402

End-to-end paid HTTP demo in one process:

- stub facilitator on `localhost:4001` (signs `/verify` + `/settle` with a fixture ed25519 key)
- paid Express endpoint on `localhost:3000/premium` wrapped in `paymentMiddleware`
- client demo — hits `/premium` unpaid (gets 402 with payment options), builds a `klever-exact` payload, retries with `X-PAYMENT` header (gets 200)

## Run it — stub mode (offline, default)

```bash
cd examples/express-quickstart
npm install
npm start
```

Expected output (paraphrased):

```
─── @klyx/x402 quickstart (Express) ───
mode:              STUB (offline)
provider address:  klv1…
requester address: klv1…
paid endpoint:     http://localhost:3000/premium
facilitator:       http://localhost:4001

[1] GET /premium (no payment)
    → status: 402
    → error: x_payment_required
    → paymentOptions: { scheme: "exact", … price: "500000", asset: "KLV" }

[2] GET /premium (with X-PAYMENT header)
    → status: 200
    → body:   { msg: "Thanks for paying! …", paidBy: "klv1…" }

[3] /settle fired in background (stub facilitator processed it)
```

## Run it — hosted mode (real Klyx facilitator on testnet)

```bash
USE_HOSTED_FACILITATOR=1 npm start
```

Skips the stub. Points at the deployed facilitator at `facilitator.klyx.space` with the pubkey registered on the Klyx contract. Expected `[2]` and `[3]` sections:

```
[2] GET /premium (with X-PAYMENT header)
    → status: 402
    → body:   { error: "tx_not_found", … }

[3] ✅ Wire chain verified end-to-end.
```

The 402 with `tx_not_found` is the *correct* response and the point of this mode. The request round-trips through the full wire chain — payload signed with the requester's key, sent over TLS, attestation verified at the facilitator, on-chain tx lookup performed against Klever, response signed by the facilitator, signature verified by the client against the on-chain-registered pubkey. The facilitator correctly rejects the payment because the throwaway requester wallet hasn't broadcast a matching Klever transfer — that's exactly what you want from a real facilitator. Rubber-stamping isn't a feature.

For the full real-KLV round-trip (koperator required, moves testnet KLV, ends with `isValid: true`), see `scripts/demo-x402-real` in the private klyx repo.

## What to change for a real deployment

The stub facilitator rubber-stamps every payment (see comment in `server.mjs`). To go real:

1. **Replace the facilitator URL** with a real one (`https://facilitator.klyx.space` once deployed, or self-host from the `klyx` repo's `docker-compose.yml`).
2. **Replace `publicKeysHex`** with the pubkeys the Klyx contract's `facilitatorPublicKeys()` view returns.
3. **Replace the fixture wallets** with your real Klever wallet — see `fromPrivateKey()` and `generateKleverWallet()` in `@klyx/x402`.
4. **Set `payTo`** to your real `klv1…` address.

Everything else — the middleware, the payload builder, the `X-PAYMENT` header flow — stays identical.

## Hono variant

Same demo in Hono: [`../hono-quickstart`](../hono-quickstart).
