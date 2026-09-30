# Tempex

**The default referee for every MPP and x402 business. No humans required.**

Agents can pay each other. They cannot disagree — a payment is boolean, but the work behind it is judged qualitatively, and no primitive settles "was this good enough?" Tempex is the missing referee: an escrow that holds the money, an arbiter that judges the delivery, and an on-chain guardrail that cages the judge inside the band the evidence justifies.

Built for the Colosseum World's Fair Hackathon, Tempo track. Live on Tempo Moderato testnet, chain 42431.

- 25/25 Forge tests, 5,429 hand-written lines, one Solidity contract, no proxies
- Live deployment: `0x7579736636dd67A8811A8A2ef95c44560fe6ec27` ([explorer](https://explore.testnet.tempo.xyz/address/0x7579736636dd67A8811A8A2ef95c44560fe6ec27)), 3 jobs settled on-chain
- Both final live runs: 23/23 expectations passed, unsponsored and sponsored

## The four pillars

| Pillar | What it means |
|---|---|
| **Custody** | Funds are provably locked in one escrow contract — never held by a trusted party. |
| **Judgement** | Qualitative delivery is scored ("4 of 8 criteria met"), not reduced to yes/no. |
| **Boundedness** | The LLM judge has no unilateral power: its proposal is clamped to a rule-derived band, and the clamp runs on chain. |
| **Verifiability** | A stranger can reconstruct exactly why the money moved: evidence hash, verdict digest, EIP-712 signature, JSON receipt per run. |

## How a deal plays out

```
buyer                TempexEscrow                seller                arbiter
  | createJob(spec, terms)  |                       |                     |
  |------------------------>|                       |                     |
  | fund(amount)            |                       |                     |
  |------------------------>|  funds locked         |                     |
  |                         |<---------- deliver(artifactHash)            |
  | accept / autoAccept ----|-----------> payout    |                     |
  |        or               |                       |                     |
  | dispute(evidenceHash)   |                       |                     |
  |------------------------>|  DisputeRaised        |                     |
  |                         |<------------------- resolve(verdict, sig)   |
  |                         |  anyone may call:     |                     |
  |                         |  EIP-712 sig recovers |                     |
  |                         |  to the job's arbiter |                     |
  |                         |  award is band-bounded|                     |
  |<----- refund / payout --|                       |                     |
```

`resolve`, `refundExpired`, and `autoAccept` are permissionless — no stuck money, no admin god-mode over funds.

## Repository layout

| Layer | Package | Lines (hand-written) | Role |
|---|---|---|---|
| L1 | `contracts/` | 385 | `TempexEscrow.sol` — one escrow, job ledger, pull payments, ECDSA-gated settlement |
| L2 | `packages/sdk` | 861 | Tempo client, canonical evidence hashing, EIP-712 verdict types, TIP-20 |
| L3 | `packages/arbiter` | 2,075 | rules → band → prompt → LLM → clamp → certify → sign |
| L4 | `packages/demo` | 2,108 | 4-scenario corpus, guardrail drill, 8-stage live lifecycle runner |

ABI files under `packages/sdk/src/abi/` are generated (`pnpm abi`) and not counted.

## Quickstart

```bash
pnpm install
cp .env.example .env        # fill in testnet keys: cast wallet new
pnpm test                   # forge test — 25/25
pnpm typecheck

pnpm demo drill             # offline: push scripted judge proposals through the band guardrail
pnpm demo                   # live: full lifecycle on Moderato, writes runs/*.json receipt
pnpm arbiter                # arbiter service: watch disputes, adjudicate, sign verdicts
```

## The guardrail, in one paragraph

The rule engine scores the evidence and signs a band (e.g. center 3,250 bps, band 2,050–4,450). The LLM judge may propose any award; `clampToBand` bounds it to the band. A proposal already inside the band passes through **unclamped** — a clamp that fires on every input is not a guardrail, it is a replacement for the judge. The drill (`pnpm demo drill`) proves all of this against the real clamp, offline, no keys.

## Live evidence

- `deployments/moderato.json` — deployment record (block 37,010,916)
- `evidence/` — job terms and evidence artifacts for the settled jobs
- `runs/` — JSON receipts, one per live run, every expectation asserted (23/23 on both final runs)
- Job 3's receipt caught our own fee-accounting bug — the 485-raw-unit Tempo fee deducted from the same stablecoin balance; fixed before the clean runs. The receipts are the point.

## Security model

- No proxies, no upgrade paths, no admin path to user funds — admin functions are limited to rotating the arbiter, treasury, and fee parameters within on-chain caps (platform ≤ 5%, arbitration ≤ 10%).
- Identity is enforced by the escrow itself: every verdict must recover, under EIP-712, to the arbiter address recorded for that job.
- Private keys live only in `.env` (gitignored, chmod 600). All deployed keys are throwaway testnet wallets.

## Docs

- `docs/technical-writeup.md` — full technical writeup
- `contracts/README.md` — the settlement contract, function by function

## License

MIT (see `contracts/lib/` for vendored Foundry and OpenZeppelin licenses).
