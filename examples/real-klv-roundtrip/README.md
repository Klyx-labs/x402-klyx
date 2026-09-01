# Real-KLV round-trip — x402 end-to-end on Klever testnet

The offline stub examples ([`../express-quickstart`](../express-quickstart), [`../hono-quickstart`](../hono-quickstart)) prove the HTTP wire flow with a rubber-stamping local facilitator. This example proves the **rest of it**: real KLV moves on chain, the deployed Klyx facilitator queries Klever, and the client sees `isValid: true` against on-chain-anchored payment.

## What it does

1. Loads a funded testnet wallet from `./.wallet.demo.json`
2. Broadcasts a real 0.5 KLV Transfer via `koperator` from your wallet to a throwaway recipient, embedding the x402 nonce in the tx message
3. Builds a klever-exact payment payload referencing that tx hash (fast-path)
4. Fetches the trusted facilitator pubkey set from `https://facilitator.klyx.space/keys`
5. POSTs `/verify` — the real facilitator looks up the tx on Klever, cross-checks the payload, signs the response
6. Client verifies the response signature against the on-chain pubkey set
7. Prints `✅ REAL KLV ROUND-TRIP PASS` on `isValid: true`

## Prerequisites

- **Node 20+**
- **`koperator`** — Klever's CLI. Install via [Klever SDK](https://docs.klever.finance/setup-node/install-koperator), default location `~/klever-sdk/koperator` (override with `KOPERATOR` env)
- **A funded testnet wallet** — see setup below

## Setup + run

```bash
cd examples/real-klv-roundtrip
npm install
npm start
```

**First run** auto-generates a fresh testnet keypair at `.wallet.demo.json` (gitignored) and exits with a "fund me" banner. Fund the printed address via [`https://faucet.testnet.klever.finance/`](https://faucet.testnet.klever.finance/) — ~5 KLV is plenty for many runs — then `npm start` again to run the actual round-trip.

Subsequent runs reuse the same wallet.

Expected output (paraphrased):

```
[1] Loaded funded wallet: klv1…
[2] Provider (throwaway): klv1…
[3] Nonce: aaaa…
[4] Broadcasting real Transfer via koperator...
[5] Transfer confirmed. txHash = a1b2c3…
    explorer: https://testnet.kleverscan.org/transaction/a1b2c3…
[6] Waiting 10s for the Klever API indexer to see the tx...
[7] Trusted facilitator pubkey set: 2 key(s)
[8] POST https://facilitator.klyx.space/verify (with transferTx fast-path)

--- /verify response ---
{
  "isValid": true,
  "payer": "klv1…"
}

✅ REAL KLV ROUND-TRIP PASS
```

Cost per run: 0.5 KLV + a few hundred smallest-units in network fees. Testnet KLV; no real economic value.

## Why this exists as a separate example

The stub examples show what `@klyx/x402` **does** end-to-end within the HTTP handshake — sign a payload, handle a 402, retry with `X-PAYMENT`, verify signatures. But the actual on-chain settlement is out-of-band for `klever-exact`: this library doesn't broadcast the transfer for you (Klever has no meta-transaction primitive like EIP-3009 on Base — see the [main README](../../README.md#real-payments--what-this-package-does-and-doesnt-do)).

That means a real x402 payment on Klever is a **two-step flow**: broadcast a Klever Transfer (this example uses `koperator`), then attach the resulting tx hash to the x402 payload. This example demonstrates both steps + verifies against the live facilitator, so you can point at it as proof the settlement path works end-to-end.

## Troubleshooting

**`invalidReason: "tx_not_found"`** — the Klever indexer hasn't seen the tx yet, or the payload doesn't match the on-chain tx shape. Retry in 30 seconds. If it persists, check that koperator's Transfer succeeded (returned a hash, tx exists on the explorer with status `success`).

**`invalidReason: "nonce_reused"`** — the nonce was previously claimed. The example generates a timestamp-based nonce per run, so this shouldn't happen; if you see it, you might have run twice within a millisecond.

**`OutOfFunds` from koperator** — you passed an amount larger than the wallet holds. Remember `koperator account send` takes **decimal KLV** (e.g. `0.5`), not smallest units — the example handles this, but if you customize it beware.

**`koperator: not found`** — install from Klever SDK docs, or set `KOPERATOR=/path/to/koperator` env.
