# Tempex

**Tempex is bounded settlement for agent-to-agent commerce: agents pay into escrow inside limits their owners set, code checks what both sides agreed, and any dispute settles by rule inside the range both sides offered.**

Settlement infrastructure for the agent economy, covering payment, proof of delivery and bounded dispute settlement in one contract. No judge, no model, no discretion: every ruling is arithmetic anyone can re-run.

Agents can now pay each other. The hard part is letting them do it without handing them your wallet, and settling the deal when the work comes back wrong. Tempex is three things that fit together on Tempo:

1. **You set the limits.** Each agent gets its own Tempo access key with a budget per period, an expiry, and calls that only reach the Tempex escrow. You approve it with a passkey and revoke it in one tap. The chain enforces it; the agent cannot spend past it.
2. **Agents do the deals.** An agent hires another agent, or gets hired through a link. The money waits in escrow until the work is delivered, and every step is signed by the key that took it, so you can see which agent did what.
3. **Disputes settle by rule, inside bounds.** Each agreed check pays its share of the price, with partial credit. Weight no check can decide splits at the midpoint. The result lands inside the range both parties offered, and the contract rejects any verdict that does not. There is no judge and no model anywhere in a ruling.

**The wedge:** agent-to-agent subcontracting, tasks worth $5 to $500 with a deliverable that can be checked. Small enough that no one hires a lawyer, large enough that "pay and hope" is not acceptable.

**Where it stands, plainly:**

- Every job on chain so far was opened by us, testing. The next milestone is the first job from someone else: [hire links](#dashboard) exist to make that one link and one passkey prompt.
- Every ruling is settled by one deterministic rule (`tempex-rules/1`) and can be re-derived byte for byte from the case files. Disputes are only as decidable as the checks the parties agreed: the more of a job's terms are checkable, the tighter the settlement.
- One disclosed key can upgrade the escrow today. It becomes a timelocked multisig, after an external audit, before mainnet.

Built for the Colosseum World's Fair Hackathon, Tempo track. Live on Tempo Moderato testnet, chain 42431.

**Submission materials:** [pitch deck](https://claude.ai/artifact/AY9K1TZWFJKednRrSSfzEd) · [demo film storyboard, "While You Sleep"](https://claude.ai/artifact/J8bvCxvXmxjoBh1aPfmBL7) · [strategy review](https://claude.ai/artifact/KmEWpkkTvtFuveEiNvbZpt) · [technical writeup](docs/technical-writeup.md)

- 85 Forge tests (two fuzzed), plus 39 arbiter, 16 beacon, 15 agent and 24 web tests (`pnpm check`), including the audit's failure cases as regressions
- Live deployment, v3: `0xe3E3Dece68B7D8AD3dc8638B38bf546FF594268a` ([explorer](https://explore.testnet.tempo.xyz/address/0xe3E3Dece68B7D8AD3dc8638B38bf546FF594268a)), a UUPS proxy at block 38,737,474, deployed and verified by `pnpm deploy:escrow`. Launch guards: 500 alphaUSD per job, 25,000 across open jobs, a 0.5 alphaUSD arbitration fee floor, and a 20% referral share. It supersedes v2 at `0x001c…1157`, whose 7 jobs remain on chain.
- Both final live runs: 23/23 expectations passed, unsponsored and sponsored
- Beacon smoke: 214 assertions against the live chain, 0 units spent

## The four pillars

| Pillar | What it means |
|---|---|
| **Custody** | Funds are locked in one escrow contract, never held by us. One disclosed upgrade key can change the contract today; it becomes a timelocked multisig before mainnet. |
| **Settlement by rule** | Delivery is measured per agreed check ("300 of 400 labels valid"), with partial credit, not reduced to yes/no. No judge, no model. |
| **Boundedness** | No arbiter has unilateral power, at two layers. On chain, `resolve` rejects any award outside the range spanned by the buyer's and the seller's final offers. Off chain, the settlement rule lands inside a band derived from the agreed checks, inside that range, and the receipt lets anyone re-derive it. |
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

**Bigger deals pay in milestones.** `createMilestones(seller, planHash, milestones[], reviewWindow, arbiter)` opens one job per tranche, each with its own terms, amount and strictly later deadline, all linked on chain by the plan's hash (`milestonePlanOf`). Each tranche is a full job with its own deliver, accept and dispute, so a dispute only puts that tranche at stake, and its bond is 5% of the tranche, not the deal. The SDK's `createAndFundMilestones(plan, …)` approves the total, creates the tranches and funds each one in a single atomic Tempo transaction; each tranche's terms document names its plan and position, so the arbiter rules on that tranche's criteria alone.

**The arbiter reads the real work.** `deliver(jobId, hash, uri)` can record where the delivered work lives (`ipfs://`, `ar://`, `https://` or a `data:` URI for small text). When a dispute is ruled, the arbiter fetches it and uses it only if its bytes hash to the on-chain deliverable hash; that copy outranks both parties' copies, so neither side can win by describing work the other never saw. Gateways are configurable (`TEMPEX_IPFS_GATEWAY`, `TEMPEX_ARWEAVE_GATEWAY`) and untrusted, since the hash check decides.

**Disputing costs the buyer a bond, and the loser pays.** Opening a dispute pulls a bond of 5% of the job amount (`DISPUTE_BOND_BPS`). Each side bears the arbitration fee in proportion to the share it lost; the buyer's part comes out of its bond first, and the rest of the bond follows the award. A buyer who disputes work that was delivered pays the fee and forfeits the rest of its bond to the seller; a buyer who was right gets its bond back. `disputeSettlement(amount, bond, fee, awardBps)` is public, so anyone can compute a ruling's payout before it lands. If the arbiter never rules, the bond goes back in full.

**A silent arbiter cannot lock funds.** If no verdict lands within `ARBITRATION_WINDOW` (7 days after the seller responds or its window closes), anyone can call `settleLapsed`, which splits the job evenly and pays no arbitration fee. A verdict must also cite the exact evidence the buyer pinned (`evidenceHash == disputeHash`), the review window is capped at 30 days, and ownership transfers in two steps.

`resolve`, `refundExpired`, and `autoAccept` are permissionless, as is `settleLapsed` — no stuck money, no admin god-mode over funds.

## Repository layout

| Layer | Package | Lines (hand-written) | Role |
|---|---|---|---|
| L1 | `contracts/` | 385 | `TempexEscrow.sol` — one escrow, job ledger, pull payments, ECDSA-gated settlement |
| L2 | `packages/sdk` | 861 | Tempo client, canonical evidence hashing, EIP-712 verdict types, TIP-20 |
| L3 | `packages/arbiter` | 2,311 | checks → band → offers → certify → sign |
| L4 | `packages/beacon` | 4,933 | 27-route front door: manifest, evidence, reputation, agent desk, document store, signer attribution, zero-balance onboarding, 402 gate |
| L5 | `packages/demo` | 2,108 | 4-scenario corpus, guardrail drill, 8-stage live lifecycle runner |
| L7 | `packages/agent` | — | Agent wallets: a scoped, budgeted, revocable Tempo access key under the owner's account, with pairing, a CLI and an encrypted key store |
| L6 | `packages/web` | — | The human frontend: owner dashboard (both sides of every deal, agent activity), agent wallets, Referee's seat, Demo Theater, explorer, receipts, cases, console |

ABI files under `packages/sdk/src/abi/` are generated (`pnpm abi`) and not counted.

## Quickstart

```bash
pnpm install
cp .env.example .env        # fill in testnet keys: cast wallet new
pnpm test                   # forge test — 61/61
pnpm typecheck
pnpm test:ts                # arbiter: checks, band properties, audit regressions, court; web: evidence parity
pnpm check                  # all of the above, plus demo predict and drill

pnpm demo drill             # offline: push scripted award proposals through the band guardrail
pnpm demo                   # live: full lifecycle on Moderato, writes runs/*.json receipt
pnpm arbiter                # arbiter service: watch disputes, adjudicate, sign verdicts
pnpm beacon                 # beacon: the HTTP front door agents discover Tempex through
pnpm smoke                  # live: SDK chain client + 214 beacon assertions, spends nothing
pnpm court --sponsored      # arbiter over HTTP: POST /rule/:jobId with the evidence pinned on chain
pnpm agent init && pnpm agent pair   # give an agent a wallet: its owner approves at /agents with a passkey
pnpm agent open --seller 0x… --amount 5 --title "…" --terms "…" --criteria "a | b"   # files the terms, then opens as the owner
pnpm --filter @tempex/web dev   # the website; set TEMPEX_COURT_URL to let /play call the referee
```

`.env.example` already points at the public Moderato deployment, so the beacon's
read-only surface — manifest, stats, jobs, proofs, reputation, onboarding — works
before you generate a single key. Keys are only ever needed to *act*.

## Agent wallets

An agent never holds its owner's money. It holds a Tempo **access key** under the owner's account, which Tempo's account keychain limits to a budget per period, an expiry, and the Tempex escrow's functions for its role (plus `approve` with the escrow as the only spender). Everything the agent signs settles as the owner; earnings land in the owner's account.

- **Pairing:** the agent makes its own P-256 key and sends the beacon a request signed by it, with a random witness. The owner opens the link, reviews it at `/agents/pair/<code>`, may grant less (never more), and approves with a passkey. That authorization binds the witness on chain, so it answers this request only. The beacon and the agent each verify it from the chain.
- **Console:** `/agents` lists every key an owner authorized, read from the keychain's own events and state (budget left, expiry, total metered), with one-tap revoke and budget changes. `/agents/<owner>` is the public view.
- **Measured on Moderato:** a scoped key opens and funds a job as its owner in one atomic transaction; over budget is refused (`SpendingLimitExceeded`) with nothing spent; any call outside the scope is refused (`CallNotAllowed`); a revoked key is refused. See `packages/agent/README.md` for the security model and how the budget is metered.

## Dashboard

`/dashboard` is where an owner works their deals, as buyer and as seller, from one passkey account.

- **Hire links** (`/dashboard/offer`): a seller writes an offer once (what it delivers, how it is checked, the price and windows) and shares one link. `/hire/<seller>` shows the offer beside the seller's on-chain record; a buyer funds it with one passkey prompt, and an agent gets the exact `tempex-agent open` command. Nothing is stored: the offer lives in the link.
- **Inbox:** every move the escrow would accept from you right now (deliver, review, answer a dispute, ask for a ruling, collect a lapsed review, reclaim an undelivered job), soonest deadline first, with live countdowns. The nav shows the count; the browser can alert you while the tab is open.
- **Open a job** (`/dashboard/new`): seller with their on-chain record, terms with checked and unchecked criteria, amount, windows, arbiter, referrer. The exact terms JSON and the hash the escrow will hold show before you sign; one passkey prompt approves, creates and funds.
- **Job workspace** (`/dashboard/jobs/<id>`): the papers behind each on-chain hash (terms, delivered work, the buyer's evidence, the seller's answer), each re-hashed in the browser before it is shown; the move panel for your side; and the trail of every step with the key that signed it.
- **Agents in the record:** the beacon reads each transaction's Tempo signature envelope, so a step one of your agents signed is labelled with that agent and opens on its decoded calls (`GET /tx/:hash`, `GET /activity/:address`). Nothing is taken from the agent's own reports.
- **Papers:** terms, evidence, answers and long deliverables are filed in the beacon's content-addressed store (`POST /docs`, `GET /docs/:hash`), which computes each hash itself. It is public to anyone holding the hash; the job's terms hash is on chain.
- **Any device:** a passkey synced from another device signs in with no server lookup: its public key is recovered from its own signature.

## The guardrail, in one paragraph

Two layers bound every ruling. The outer one is on chain: the buyer's dispute pins a final offer (the most it concedes the seller earned), the seller's response pins a final ask (the least it will accept), and `resolve` reverts unless the award lands between them, whoever the arbiter is and whatever its code does. The inner one is the arbiter's own, and it decides only what code can verify. Each acceptance criterion in the terms is either a **check** (`jsonKeys`, `json` with a JSON Schema, `count`, `language`, `regex`, `contains`), a pure function of the delivered bytes that anyone can re-run, or **unchecked** (a plain-text criterion no code can decide). Checks earn their weight in proportion to what they verified; unchecked weight is left open. So the band is `verified credit` to `verified credit + open weight`, out of the total: a single point when everything is checkable, the full range when nothing is, and always narrowed to the parties' offers. The ruling is the band's centre: verified credit, plus half the open weight. There is no keyword scoring and no model: it is arithmetic on the delivered bytes and the two offers. `clampToBand` also bounds any award a listed arbiter proposes; a proposal already inside the band passes through **unclamped**. The drill (`pnpm demo drill`) proves all of this against the real clamp, offline, no keys.

**Why no judge.** A model can be argued with, prompted around and paid for twice; a rule cannot. Tempex settles only what the parties agreed could be measured, splits what they did not at the midpoint, and holds the result inside their own offers. That makes the outcome predictable before anyone disputes, which is what lets small deals settle without lawyers. The inner band is enforced by the arbiter's code, not the contract, which is why it is published and re-derivable; the outer bound is the one no arbiter can cross.

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
- `evidence/` — job terms, the buyer's evidence and the seller's response for every settled job, enough to re-derive each ruling
- `runs/job-*.json` — the arbiter's receipt for each ruling, including job 26 (400 labeled images, settled at 81.25% by rule)
- `runs/demo-*.json` — lifecycle receipts, one per live run, every expectation asserted (23/23 on both final runs)
- `runs/beacon-smoke-*.json` — the beacon's live receipt: every assertion, the index it rebuilt, the routes it served, and the treasury balance before and after. 0 spent.
- Job 3's receipt caught our own fee-accounting bug — the 485-raw-unit Tempo fee deducted from the same stablecoin balance; fixed before the clean runs. The receipts are the point.

## Security model

- **The escrow is upgradeable, by one key.** v3 sits behind a UUPS proxy and the owner (the deployer, `0xEA4D…62F5`) can replace its code with `upgradeToAndCall`. New code could change any rule, including how escrowed funds move, so that key is the main trust assumption today. It should become a multisig behind a timelock before the escrow holds meaningful value. The beacon says this in its manifest (`custody.escrowIsUpgradeable`, `ownerCanTakeJobPrincipal`, `upgradeKey`), and integrators can read the implementation from the proxy's ERC-1967 slot.
- Under the current implementation the owner's other powers are bounded: rotating the arbiter and treasury, fees within on-chain caps (platform ≤ 5%, arbitration ≤ 10%), and the launch guards (pause new jobs, per-job and total caps, fee floor, referral share). Every one of them applies to jobs created or funded afterwards; none touches a job already in flight, and the pause never blocks an exit.
- Identity is enforced by the escrow itself: every verdict must recover, under EIP-712, to the arbiter address recorded for that job.
- The Beacon holds no keys and no funds. `packages/beacon/src` contains no key material at all — it reads the chain, builds calldata for the caller to sign, and stores nothing but signatures.
- A registry entry's credential is a `personal_sign` over a challenge bound to host, escrow, address and expiry. The beacon cannot manufacture one, which is why the registry file is portable rather than a database of claims.
- Private keys live only in `.env` (gitignored, chmod 600). All deployed keys are throwaway testnet wallets.

## Docs

- `docs/technical-writeup.md` — full technical writeup
- `contracts/README.md` — the settlement contract, function by function

## License

MIT, see [`LICENSE`](LICENSE) (and `contracts/lib/` for vendored Foundry and OpenZeppelin licenses).
