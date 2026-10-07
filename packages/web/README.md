# @tempex/web

The human frontend for Tempex: a Next.js 15 app styled after Tempo (a near-black grid, square
panels, mono labels, Geist type) in Tempex colours: mint for the referee, amber for Pip the buyer,
blue for Bolt the seller.

| Route | What it is |
|---|---|
| `/play` | **Judge's seat.** A real deal on Moderato, signed in the browser: passkey or in-tab keys, faucet funding, sponsored fees, then open, deliver, dispute, answer and rule. |
| `/demo` | Demo Theater: job 4 replayed from its receipt in five acts. Works offline. |
| `/cases`, `/cases/[id]` | The four-scenario corpus, with the clamp playground running the real guardrail. |
| `/explorer`, `/explorer/[id]`, `/proof/[id]` | Every job from the beacon, and a shareable receipt with an OG image. |
| `/arbiters`, `/reputation/[addr]`, `/quote`, `/console` | The market, reputations, a price quote, and the agent console (readiness check, calldata blueprints). |

## What runs where

- **Keys stay on the device.** Pip signs with a WebAuthn passkey (the private key never leaves the
  authenticator) or with a P-256 key that WebCrypto holds in the tab. Bolt always uses an in-tab key.
  The site stores no accounts and holds no keys.
- **Fees are sponsored** by `sponsor.moderato.tempo.xyz`, and Pip is funded from Tempo's faucet,
  so nobody needs gas or a wallet extension.
- **The referee is a separate process.** `pnpm court` puts the arbiter behind HTTP; `/api/court/[id]`
  forwards the browser's evidence case to it. The court rules only when the bundle hashes to the job's
  on-chain `disputeHash`, the job names its key, and evidence is closed. Without `TEMPEX_COURT_URL`
  the deal still runs on chain and waits for the arbiter's watcher.
- **Read pages fall back to a baked snapshot** (`pnpm bake` with the beacon up), so the demo survives
  bad wifi.

## Environment

| Variable | Used for |
|---|---|
| `TEMPEX_BEACON_URL` | The public beacon (default `http://127.0.0.1:8787`). |
| `TEMPEX_COURT_URL` | The arbiter's court, e.g. `https://court.example` running `pnpm court --sponsored`. |
| `TEMPEX_ESCROW`, `TEMPEX_TOKEN` | Only if neither the court nor the snapshot supplies them. |
| `NEXT_PUBLIC_SITE_URL` | Absolute links in QR codes and OG images. |

```bash
pnpm --filter @tempex/web bake     # refresh data/snapshot.json from the beacon and runs/
pnpm --filter @tempex/web dev
pnpm --filter @tempex/web test     # browser-built evidence reproduces the corpus; receipt math
```
