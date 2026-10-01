# Tempex

**The default referee for every MPP and x402 business. No humans required.**

Agents can pay each other. They cannot disagree — a payment is boolean, but the work behind it is judged qualitatively, and no primitive settles "was this good enough?" Tempex is the missing referee: an escrow that holds the money, an arbiter that judges the delivery, and an on-chain guardrail that cages the judge inside the band the evidence justifies.

Built for the Colosseum World's Fair Hackathon, Tempo track. Live on Tempo Moderato testnet, chain 42431.

- 44/44 Forge tests, 10,362 hand-written lines, one Solidity contract, no proxies
- Live deployment: `0x7579736636dd67A8811A8A2ef95c44560fe6ec27` ([explorer](https://explore.testnet.tempo.xyz/address/0x7579736636dd67A8811A8A2ef95c44560fe6ec27)), 5 jobs funded, 3 settled by verdict
- Both final live runs: 23/23 expectations passed, unsponsored and sponsored
- Beacon smoke: 185 assertions against the live chain, 0 units spent

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

**The seller is heard before any verdict.** Once work is delivered, the buyer either pays (`accept`, or `autoAccept` after the review window) or opens a dispute. A dispute emits `SellerResponseRequested` to the seller with a deadline 7 days out (`SELLER_RESPONSE_WINDOW`). Inside that window the seller calls `respond(jobId, responseHash)`, pinning its own evidence bundle: its copy of the deliverable and its account of why the work meets the terms. `resolve` reverts until the seller has responded or the window has closed, and it rejects any verdict issued before that moment. The arbiter scores whichever copy of the deliverable actually hashes to the on-chain delivery, so neither side can win by describing work the other never saw.

**Each job locks its referee and its fees.** `createJob` uses the house arbiter; `createJobWithArbiter` names any arbiter that listed itself with `listArbiter(feeBps, metadataURI)`. Either way the job records its arbiter, its platform and arbitration fee rates, and the protocol's cut of the arbitration fee (`JobTermsLocked`). Later calls to `setArbiter`, `setFees`, `setProtocolCut`, or an arbiter re-pricing or delisting itself, reach new jobs only. A listed arbiter earns its fee minus the protocol cut (20% by default, capped at 50%); the house arbiter's fee goes to the treasury. `GET /arbiters` on the beacon lists the market with each arbiter's track record, and `pnpm arbiter list --fee <bps>` puts a key on it.

**A silent arbiter cannot lock funds.** If no verdict lands within `ARBITRATION_WINDOW` (7 days after the seller responds or its window closes), anyone can call `settleLapsed`, which splits the job evenly and pays no arbitration fee. A verdict must also cite the exact evidence the buyer pinned (`evidenceHash == disputeHash`), the review window is capped at 30 days, and ownership transfers in two steps.

`resolve`, `refundExpired`, and `autoAccept` are permissionless, as is `settleLapsed` — no stuck money, no admin god-mode over funds.

## Repository layout

| Layer | Package | Lines (hand-written) | Role |
|---|---|---|---|
| L1 | `contracts/` | 385 | `TempexEscrow.sol` — one escrow, job ledger, pull payments, ECDSA-gated settlement |
| L2 | `packages/sdk` | 861 | Tempo client, canonical evidence hashing, EIP-712 verdict types, TIP-20 |
| L3 | `packages/arbiter` | 2,075 | rules → band → prompt → LLM → clamp → certify → sign |
| L4 | `packages/beacon` | 4,933 | 18-route front door: manifest, evidence, reputation, zero-balance onboarding, 402 gate |
| L5 | `packages/demo` | 2,108 | 4-scenario corpus, guardrail drill, 8-stage live lifecycle runner |

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
pnpm beacon                 # beacon: the HTTP front door agents discover Tempex through
pnpm smoke                  # live: SDK chain client + 185 beacon assertions, spends nothing
```

`.env.example` already points at the public Moderato deployment, so the beacon's
read-only surface — manifest, stats, jobs, proofs, reputation, onboarding — works
before you generate a single key. Keys are only ever needed to *act*.

## The guardrail, in one paragraph

The rule engine scores the evidence and signs a band (e.g. center 3,250 bps, band 2,050–4,450). The LLM judge may propose any award; `clampToBand` bounds it to the band. A proposal already inside the band passes through **unclamped** — a clamp that fires on every input is not a guardrail, it is a replacement for the judge. The drill (`pnpm demo drill`) proves all of this against the real clamp, offline, no keys.

## The Beacon — how an agent adopts Tempex with no account and no balance

An escrow only becomes a default if agents choose it *before* they need it. The Beacon is that choice point: a machine-readable front door with **no keys, no custody, and no database of record**. Every answer is folded from escrow events at request time, so it cannot drift from the chain.

18 routes — 14 free reads, 3 free writes, 1 paid:

| Route | What an agent gets |
|---|---|
| `/.well-known/tempex.json` | identity, live protocol state, all-in costs, tools, and the recipe to verify every claim |
| `/.well-known/agent.json` | A2A-style agent card: skills, modes, endpoint |
| `/stats` | whole-network evidence: jobs by stage, money moved, verdict bounds, measured arbitration latency |
| `/jobs`, `/jobs/:id`, `/proof/:id` | every job the escrow has seen; then one job's receipts plus the calls that re-derive them |
| `/reputation/:address` | an itemised score any third party can recompute from the same events |
| `/onboard`, `/ready`, `/quote` | what it takes to start, whether *this* address can right now, what a job costs line by line |
| `/blueprint/:action` | encoded calldata for one intent, decoded with the ABI's own argument names — the beacon builds it, the agent signs it |
| `/registry/challenge`, `/registry` | register by signing a challenge bound to this beacon, this escrow, and an expiry |
| `/discover` | capability search ranked by on-chain reputation. **Paid** — 402 until settled |

### Zero balance is the default, not a favour

Tempo makes this cheap to claim and easy to check. There is no gas token — a fee is a TIP-20 `Transfer` to the fee manager — so the hosted fee payer at `sponsor.moderato.tempo.xyz` can sign it, and the escrow's pull-based credits mean a seller never fronts capital. `/quote` prices the whole onboarding line by line, with the fee **measured from a real receipt** rather than estimated:

```
seller, 50 alphaUSD job                       total 0
  account creation            0   a keypair is an account on Tempo; no activation tx exists
  beacon registration         0   a signature over a challenge; the beacon stores no key
  transaction fee             0   routed to the hosted fee payer (measured: 0.006284 alphaUSD)
  principal                   0   the seller receives this; it is never a cost to the seller
  platform / arbitration fee  0   deducted at payout and verdict, capped on-chain at 500 / 1000 bps
```

A cold beacon — empty index, no keys — answers that by scanning ~570k blocks of Moderato history in 50k-block chunks. That chunk size is not arbitrary: Moderato rejects any `eth_getLogs` range wider than 100,000 blocks, so the config clamps an operator-supplied value down rather than letting one misconfiguration fail the whole index. `/ready` then checks nonce, balance, allowance and escrow credit live instead of asserting them.

### Discovery has a price

"Who can do X" costs a full event scan, so `/discover` answers **402** with a quote until the caller settles on-chain in the payment token. The gate decodes the receipt's memo and refuses a payment made for anything else. Free tiers stay free — manifest, stats, reputation, onboarding — because an agent should never have to pay to find out whether paying is worth it.

### Nothing is trusted, including the beacon

The registry is a file of signatures, portable between beacon instances because the signature is the credential, not the host. Reputation is itemised so a stranger can recompute it. And "holds no keys" is a checkable claim, not an assertion:

```
grep -rnE 'privateKeyToAccount|accountFor|privateKeyFor|createWalletClient|walletClient' packages/beacon/src
# no matches — the server has no way to construct a signer, so it cannot sign
```

The two `eth_sendTransaction` strings in `src/` are *metadata the beacon returns to the caller*, naming the RPC method to submit the calldata it built. The one `privateKey` hit is a suggested `cast wallet new` in an onboarding hint. The only keys in the package belong to the smoke script, signing as a *client* to prove registration and the payment gate.

## Live evidence

- `deployments/moderato.json` — deployment record (block 37,010,916)
- `evidence/` — job terms and evidence artifacts for the settled jobs
- `runs/demo-*.json` — lifecycle receipts, one per live run, every expectation asserted (23/23 on both final runs)
- `runs/beacon-smoke-*.json` — the beacon's live receipt: every assertion, the index it rebuilt, the routes it served, and the treasury balance before and after. 0 spent.
- Job 3's receipt caught our own fee-accounting bug — the 485-raw-unit Tempo fee deducted from the same stablecoin balance; fixed before the clean runs. The receipts are the point.

## Security model

- No proxies, no upgrade paths, no admin path to user funds — admin functions are limited to rotating the arbiter, treasury, and fee parameters within on-chain caps (platform ≤ 5%, arbitration ≤ 10%).
- Identity is enforced by the escrow itself: every verdict must recover, under EIP-712, to the arbiter address recorded for that job.
- The Beacon holds no keys and no funds. `packages/beacon/src` contains no key material at all — it reads the chain, builds calldata for the caller to sign, and stores nothing but signatures.
- A registry entry's credential is a `personal_sign` over a challenge bound to host, escrow, address and expiry. The beacon cannot manufacture one, which is why the registry file is portable rather than a database of claims.
- Private keys live only in `.env` (gitignored, chmod 600). All deployed keys are throwaway testnet wallets.

## Docs

- `docs/technical-writeup.md` — full technical writeup
- `contracts/README.md` — the settlement contract, function by function

## License

MIT (see `contracts/lib/` for vendored Foundry and OpenZeppelin licenses).
