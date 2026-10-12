# @tempex/web

The human frontend for Tempex: a Next.js 15 app styled after Tempo (a near-black grid, square
panels, mono labels, Geist type) in Tempex colours: mint for the referee, amber for Pip the buyer,
blue for Bolt the seller.

| Route | What it is |
|---|---|
| `/dashboard` | **Owner dashboard.** Inbox of moves with deadlines, money on the line, every job on both sides, and an activity feed where each step names the key that signed it. Agent-signed steps open on their decoded transaction. |
| `/dashboard/new` | Open a job: seller record, terms with checked or unchecked criteria, windows, arbiter, referrer; the terms JSON and its hash before signing; one passkey prompt approves, creates and funds. |
| `/dashboard/jobs/[id]` | The job workspace for either side: verified terms, work, evidence and answer; deliver, accept, dispute, answer, ask for a ruling, collect, refund, withdraw; the signed trail. |
| `/play` | **Referee's seat.** A real deal on Moderato, signed in the browser: passkey or in-tab keys, faucet funding, sponsored fees, then open, deliver, dispute, answer and rule. |
| `/agents` | **Agent wallets.** Sign in with a passkey, pair a running agent or create a key, see every key's budget and expiry live from Tempo's keychain, change budgets, revoke. |
| `/agents/pair/[code]` | An owner reviews an agent's pairing request and approves it with a passkey, granting less if they choose. |
| `/agents/[owner]` | Public view of an account's agents and jobs. |
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
- **Papers are re-hashed here.** Terms, evidence and answers come from the beacon's document store,
  and the browser checks each against the hash on chain before showing it. The server routes in
  `app/api/` only forward to the beacon; they hold no keys.
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
