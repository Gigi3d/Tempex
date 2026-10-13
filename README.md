# Tempex

**Bounded settlement for agent-to-agent commerce, built on Tempo.**

Agents pay into escrow inside limits their owners set. Code checks what both sides agreed. If they still disagree, a published rule settles it, and the payout can never land outside the range both sides offered. No judge, no model.

**Try it live (testnet):** [tempex-web.fly.dev](https://tempex-web.fly.dev) · **Pitch deck:** [PDF](https://gigi3d.github.io/Tempex/deck/tempex-deck.pdf)

Built for the Colosseum World's Fair Hackathon, Tempo track. Live on Tempo Moderato testnet (chain 42431).

## The problem

Agents can already do real work: label images, transcribe calls, clean data. What they can't do is pay each other safely. Today you either give an agent a card with no limits, or a human approves every payment. Neither scales, and neither answers "the work came back 80% done".

Our first market is **data labeling**: small, checkable tasks worth $5 to $500, where "pay and hope" isn't acceptable and nobody hires a lawyer.

## How it works

1. **You set the limits.** Each agent gets its own Tempo access key with a budget, an expiry, and access to the Tempex escrow only. You approve it with a passkey and can revoke it in one tap. The chain enforces the limits.
2. **Agents do the deals.** The buyer's agent locks stablecoins in escrow. The seller's agent delivers. Every step is signed by the key that took it.
3. **Disputes settle by rule.** Each agreed check pays its share of the price. Anything no check can decide splits at the midpoint. The result is clamped between the buyer's offer and the seller's ask, and the contract rejects any award outside that range.

```
buyer ── createAndFund ──▶ escrow ◀── deliver ── seller
  │                          │
  ├── accept ───────────────▶ seller paid
  └── dispute (offer) ──▶ seller responds (ask) ──▶ rule settles inside [offer, ask]
```

Other safeguards:
- The seller is always heard before a ruling.
- Disputes cost the buyer a 5% bond, and the loser pays.
- If no ruling arrives within 7 days, anyone can split the job evenly.
- `resolve`, `autoAccept`, `refundExpired` and `settleLapsed` are permissionless, so no money can get stuck.

## Built on Tempo

| Tempo feature | How Tempex uses it |
|---|---|
| Access keys | Per-agent budgets and expiry, enforced by the chain, not by us |
| Passkeys (WebAuthn) | Owners sign without seed phrases, from any synced device |
| Fee sponsorship | Agents start working with zero balance |
| TIP-20 `transferWithMemo` | Every payment carries its job id, so it reconciles itself |
| Batched calls | Approve, create and fund a job in one atomic transaction |

## Status

- **Escrow v3:** [`0xe3E3…268a`](https://explore.testnet.tempo.xyz/address/0xe3E3Dece68B7D8AD3dc8638B38bf546FF594268a), a UUPS proxy, verified.
- **Launch guards:** 500 αUSD per job and 25,000 across open jobs.
- **Real jobs:** more than 25 have run end to end on testnet, including disputes settled by rule. Receipts are in `runs/` and evidence in `evidence/`.
- **Tests:** 85 Foundry tests (two fuzzed), plus 39 arbiter, 16 beacon, 15 agent and 24 web tests.
- **Honest caveats:**
  - Every job so far was opened by us.
  - One disclosed key can upgrade the escrow. It moves to a timelocked multisig, after an audit, before mainnet.

## Repository

| Path | What it is |
|---|---|
| `contracts/` | `TempexEscrow.sol`: escrow, job ledger, pull payments, bounded settlement |
| `packages/sdk` | Tempo client, canonical hashing, EIP-712 verdicts |
| `packages/arbiter` | The settlement rule (`tempex-rules/1`) and the court service |
| `packages/beacon` | Read-only HTTP front door: jobs, reputation, onboarding, document store. Holds no keys. |
| `packages/agent` | Agent wallets: scoped, budgeted, revocable access keys, plus a CLI |
| `packages/web` | The app: dashboard, agent wallets, Sandbox, explorer, cases |
| `packages/demo` | Live lifecycle runner, guardrail drill and testnet seeding |
| `deploy/fly/` | Fly.io configs for web, beacon and court |

## Quickstart

```bash
pnpm install
cp .env.example .env            # testnet keys: cast wallet new
pnpm check                      # contracts, typecheck and all tests
pnpm demo drill                 # offline: try to push awards past the bounds
pnpm demo                       # live: full lifecycle on Moderato
pnpm --filter @tempex/web dev   # the website
```

`.env.example` already points at the public Moderato deployment, so the read-only parts work before you create any key.

## Security

- **Custody:** funds sit in one escrow contract, never with us. The upgrade key is the main trust assumption today, and it is disclosed in the beacon's manifest.
- **Owner powers:** fee and guard changes only affect new jobs. Fees are capped on chain (platform ≤ 5%, arbitration ≤ 10%).
- **Signed verdicts:** every verdict must recover (EIP-712) to the arbiter recorded for that job.
- **Keys:** private keys live only in a gitignored `.env`. All deployed keys are throwaway testnet wallets.

More detail: [`contracts/README.md`](contracts/README.md) and [`packages/agent/README.md`](packages/agent/README.md).

## License

MIT, see [`LICENSE`](LICENSE).
