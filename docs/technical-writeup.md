# Tempex — Technical Writeup

**Bounded autonomy for agent commerce, built on Tempo: budgeted agent keys, escrow until the work is delivered, and a referee that can only rule inside the range the evidence and both offers allow.**

Live on Moderato testnet (chain 42431) · escrow v3 `0xe3E3Dece68B7D8AD3dc8638B38bf546FF594268a` (a UUPS proxy, block 38,737,474; implementation `0x7817e82dde33ddC0069b58c5F4A17F1376850dB9`)

> Every number in this document was measured against the running system, not estimated. Section 12 lists the exact commands and their results.

This is the third version. It keeps every rule of the second and changes three things. **The escrow is upgradeable behind one disclosed key** (a UUPS proxy; that key could change any rule, including how escrowed funds move, and becomes a timelocked multisig before mainnet). **It carries launch guards**: a pause on new jobs that leaves every exit open, a 500 alphaUSD cap per job and 25,000 across open jobs, a 0.5 alphaUSD arbitration fee floor locked per job, and a 20% referral share of protocol fees. **And agents act through scoped keys**: each agent signs with a Tempo access key its owner authorized with a budget, an expiry and calls limited to this escrow, and an owner dashboard works both sides of every deal (§9.1). Where the sections below describe the second version's deployment (`0x001c…1157`, whose jobs remain on chain), they say so.

The second version followed an audit of the first. The first (escrow `0x7579…ec27`, still on chain) was audited, and the audit found that its strongest claims did not hold: the band that bounds the AI judge was enforced only by the arbiter's own code, the owner could swap the arbiter mid-dispute, a dispute could be stuck forever, and the keyword scorer that set the band could be gamed by either party. Every one of those is fixed here, and §6 and §13 say plainly which limits remain.

---

## 1. The problem, precisely stated

Autonomous agents can now *pay* each other. They cannot *disagree* with each other.

That asymmetry is the whole gap. A payment is a one-shot, verifiable state transition — send tokens, done. A commercial relationship is not: money moves first, work arrives later, and the work is judged. Every real service contract in the agent economy has this shape:

```
    t0 ─── buyer pays ──────────► [ work happens ] ──────────► t1  was it delivered?
                                                                      │
                                        ┌─────────────────────────────┴────────────┐
                                        │                                          │
                                    yes, fine                                   no / partial
                                        │                                          │
                                        ▼                                          ▼
                                  relationship ends                    ??? no mechanism ???
```

The `???` is where every existing primitive stops:

| Primitive | What it does | What it cannot do |
|---|---|---|
| Plain TIP-20 transfer | Moves value atomically | Has no concept of an obligation or a deadline |
| Generic escrow | Holds value until a condition | The condition must be *boolean and objective* — "was the file at this hash delivered" — not "was the file *good*" |
| Multisig | N-of-M keys approve | Requires N humans to be awake, and presumes trust in who the N are |
| Human arbitration panel | Actually adjudicates | Doesn't scale to agent speed, doesn't run at 3am, isn't reproducible, costs more than the job |
| "Just let an LLM decide" | Cheap, fast, general | **Is a liability.** An unbounded model with unilateral authority over money is a single point of capture: prompt-injectable, nondeterministic, unauditable, and it cannot sign anything a contract can verify |

So the requirement decomposes into four things that must all hold at once:

1. **Custody** — the money is provably locked, not held by a trusted party.
2. **Judgement** — someone can assess *qualitative* delivery ("6 of the 8 agreed strings, in French, but prices in US format").
3. **Boundedness** — that someone must not have unbounded power: what code can verify is decided by code, what it cannot is judged inside limits, and the outermost limit is enforced on chain.
4. **Verifiability** — a third party must be able to reconstruct exactly why the money moved, and the chain must have enforced it without trusting anyone's narration.

Tempex is those four things, composed so that each one is checkable independently of the others.

---

## 2. What was built, in one picture

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ L5  ADOPTION / BEACON       packages/beacon                           6,066 lines │
│     19 routes: manifest · evidence · reputation · arbiter market · onboarding     │
│     · 402-gated discovery · signed portable registry · no keys, no custody        │
├───────────────────────────────────────────────────────────────────────────────────┤
│ L4  PROOF / DEMO            packages/demo                             2,268 lines │
│     8-stage live lifecycle, transcript, JSON receipt, offline corpus              │
│     (predict = "what would the checks say", drill = "can the judge escape?")      │
├───────────────────────────────────────────────────────────────────────────────────┤
│ L3  JUDGEMENT               packages/arbiter                          2,665 lines │
│     checks.ts → exact criteria · rules.ts → band · llm.ts → judge panel           │
│     offers → clamp → certify against the deployed contract → EIP-712 sign → relay │
├───────────────────────────────────────────────────────────────────────────────────┤
│ L2  CLIENT + CRYPTO         packages/sdk                              1,889 lines │
│     TempexClient · canonical JSON · typed criteria · settlement math · milestones │
│     · deliverable fetch · verifying deploy script                                 │
├───────────────────────────────────────────────────────────────────────────────────┤
│ L1  SETTLEMENT              contracts/src                               762 lines │
│     one escrow, per-job locked terms, seller response, bond, final-offer bounds,  │
│     lapse, arbiter market, milestones, pull payments, 27 events                   │
├───────────────────────────────────────────────────────────────────────────────────┤
│ L0  CHAIN                   Tempo Moderato, chain 42431                           │
│     type-0x76 transactions · TIP-20 stablecoins · memo'd transfers · fee manager  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

13,650 hand-written lines (source and scripts; 15,622 including the generated ABIs), plus 1,636 lines of tests: 1,087 of Solidity (61 tests, one fuzzed) and 549 of TypeScript (45 tests). One Solidity contract, no proxies, no upgrade path.

The box says **27 events** because that is the ABI's count: `TempexEscrow.sol` declares 24, and `Ownable2Step` and `EIP712` contribute `OwnershipTransferStarted`, `OwnershipTransferred` and `EIP712DomainChanged`.

**The split between layers is the design.** Everything that can be checked deterministically *is* — off chain, before anything is signed. Everything that must be enforced *is* — on chain, by the contract. And the one thing that is neither, the judgement of quality, is boxed in from both sides.

```
        OFF CHAIN                                        ON CHAIN
  ┌──────────────────────────┐                  ┌──────────────────────────────┐
  │ verify the delivered     │                  │ the job's own locked arbiter │
  │ bytes against the hash   │                  │ the parties' offers bound    │
  │ run the agreed checks    │   ── 1 signature ──►  every award               │
  │ judge only what's open   │      + 2 hashes  │ seller heard before ruling   │
  │ clamp, hash, sign        │                  │ bond, fees, pull-withdraw    │
  └──────────────────────────┘                  └──────────────────────────────┘
    unlimited compute,                              bounded, cheap, verifiable
    fully reproducible,
    zero gas
```

---

## 3. The job lifecycle — `TempexEscrow.sol`

One contract, an internal ledger of jobs. Every arrow below is a function; every guard is a `require` in the source.

```
   createJob(seller, amount, termsHash, deadline, reviewWindow)        house arbiter
   createJobWithArbiter(…, arbiter)                                    a listed arbiter
   createMilestones(seller, planHash, milestones[], reviewWindow, arbiter)   2–20 jobs
        │  require: seller != 0 && seller != buyer · amount > 0 · deadline > now
        │           0 < reviewWindow <= 30 days · a chosen arbiter is listed and is
        │           neither party
        │  locks into the job: arbiter, platform fee, arbitration fee, protocol cut
        ▼
  ┌──────────┐   cancel()                                         [buyer only]
  │ Created  │ ──────────────────────────────────────────────────► Cancelled
  └──────────┘
        │  fund()                        [buyer only, before deadline; memo = job id]
        ▼
  ┌──────────┐   refundExpired()                                  [PERMISSIONLESS]
  │  Funded  │ ──────────────────────────────────────────────────► Refunded
  └──────────┘   after the delivery deadline
        │  deliver(deliverableHash, uri)          [seller only, before the deadline]
        │  the uri (ipfs:// ar:// https:// data:) says where the work lives
        ▼
  ┌───────────┐  accept()  [buyer]   ·   autoAccept()  [PERMISSIONLESS, after review]
  │ Delivered │ ──────────────────────────────────────────────────► Settled
  └───────────┘
        │  dispute(disputeHash, buyerOfferBps)        [buyer only, inside review]
        │  pulls a bond of 5% of the job · pins the evidence · pins the buyer's offer
        │  emits SellerResponseRequested(seller, deadline = now + 7 days)
        ▼
  ┌──────────┐  respond(responseHash, sellerAskBps)      [seller only, ≤ 7 days]
  │ Disputed │  pins the seller's evidence and its final ask
  └──────────┘
        │  resolve(verdict, signature)                               [PERMISSIONLESS]
        │    require ecrecover == the arbiter THIS JOB locked at creation
        │    require evidenceHash == the pinned disputeHash
        │    require the seller has responded, or its window has closed
        │    require the verdict was issued after that
        │    require award between the buyer's offer and the seller's ask
        │    require still inside the 7-day arbitration window
        │
        │  settleLapsed()        [PERMISSIONLESS, arbiter silent > 7 days after evidence]
        │    midpoint of the offers, no arbitration fee, bond returned
        ▼
     Settled ──► withdraw()   [any creditor; memo "tempex.withdraw"]
```

Five properties are visible in that diagram, and each closes a hole the first version had:

**(a) Each job locks its own terms.** The arbiter and every fee rate are copied into the job when it is created (`_lockTerms`, `:352`). `setArbiter`, `setFees` and `setProtocolCut` reach only jobs created afterwards. The owner cannot swap the judge or raise the fee on a deal already in flight; in the first version it could do both.

**(b) The seller is heard before anyone rules.** A dispute notifies the seller and opens a 7-day window (`respond`, `:506`). `resolve` reverts until the seller has responded or the window has closed, and rejects a verdict signed before that (`_requireSellerHeard`, `:595`), so no ruling can have been decided without the seller's evidence.

**(c) The parties bound the award, on chain.** The buyer's dispute pins the most it concedes the seller earned; the seller's response pins the least it will accept (10000 if it stays silent). `resolve` rejects any award outside that range (`_requireWithinOffers`, `:588`). This is the part of "bounded judge" no arbiter can get around, whatever its code does.

**(d) Nothing can be stuck.** `refundExpired` and `autoAccept` were already permissionless. `settleLapsed` (`:606`) adds the missing exit: if the arbiter has not ruled within 7 days of the evidence closing, anyone can settle at the midpoint of the offers, with no fee to the arbiter that failed and the buyer's bond returned.

**(e) Pull payments, permissionless relay.** `resolve` never transfers; it credits, and each party withdraws. A reverting receiver cannot block a settlement, and the arbiter never needs a balance: it signs, and anyone relays. The demo relays every verdict from a key that is neither party nor arbiter.

---

## 4. The eight stages, end to end

The demo runner drives one complete disputed job on live Moderato. The run below is job 4, the receipt at `runs/demo-underdelivered-2026-10-07T02-12-27-827Z.json`: 8 stages, 31 of 31 expectations held against the chain.

```
  STAGE 1 · case      terms.json + evidence.json written in canonical bytes; the terms carry
                      typed checks (§6). The offline corpus already predicts every result.
  STAGE 2 · approve   buyer: TIP-20 approve(escrow, 25.00)                 tx 0xcf3e8cb8…027a
  STAGE 3 · open      ONE type-0x76 transaction, two calls:                tx 0xea291d7f…a438
                        createJobWithArbiter(seller, 25e6, termsHash, …, listedArbiter)
                        fund(nextJobId())        ← id read before the batch; memo = 0x…04
  STAGE 4 · deliver   deliver(hash, "data:text/plain;base64,…")            tx 0x5f22640e…8971
                        the work itself rides in the delivery; nothing has to be hosted
  STAGE 5 · dispute   dispute(disputeHash, 2500) + its bond approval, one tx  0xc3339b98…3d76
                        seller notified, deadline 7 days out
                      respond(responseHash, 5000)                          tx 0x1225bc62…bf48
  STAGE 6 · rule      OFF CHAIN, zero gas:
                        1. bundle hashes to the pinned disputeHash?       else REFUSE
                        2. seller responded or window closed?             else WAIT
                        3. fetch the work from its URI; bytes hash to the delivery?
                        4. run the five agreed checks on those bytes; band 4250-5250
                        5. narrow to the offers [2500, 5000]  →  4250-5000
                        6. judgement criteria: no model configured → neutral midpoint
                        7. verdictDigest off chain == verdictDigest on the deployed escrow
                        8. sign with the arbiter key this job locked; ruling 4750 bps
  STAGE 7 · relay     resolve(4, verdict, sig) from a fourth, unrelated key  tx 0x3a03525d…74d5
  STAGE 8 · settle    seller withdraws 12.093437 · buyer 13.656563 · arbiter 0.4
                      every payout a TIP-20 transfer tagged "tempex.withdraw";
                      the treasury's 0.1 stays credited (no key for it in the demo)
```

Stage 3 is a Tempo-native pattern: on an ordinary EVM chain, opening a funded job is two transactions with a race in between, because `createJob` mints an id you only learn from the receipt. On Tempo the two calls ride in one transaction, and the id is known in advance from `nextJobId()` (`:664`), then reconciled from the `JobCreated` log.

---

## 5. The trust chain — why a stranger can verify this

Every arrow is a hash commitment, and every commitment is checked by a different party at a different time:

```
  terms.json   ──canonicalize──► keccak256 ──► termsHash        pinned at createJob
  the work     ──keccak256(bytes)───────────► deliverableHash  pinned at deliver (+ uri)
  evidence.json (the buyer's bundle) ─canon─► disputeHash      pinned at dispute
  response.json (the seller's)       ─canon─► responseHash     pinned at respond

  the arbiter, before it judges anything:
    disputeHash(bundle on file) == job.disputeHash          ← the bundle the buyer pinned?
    responseHash(response on file) == job.responseHash      ← the response the seller pinned?
    which copy of the work to check:
        the bytes at the delivery URI, if they hash to deliverableHash
        else the buyer's copy, if it does; else the seller's, if it does
        else none: every check is left open, nothing can earn credit

  the verdict it signs:
    Verdict { jobId, sellerAwardBps, evidenceHash = disputeHash, rationaleHash,
              issuedAt >= evidence closed, validUntil }
    certified: the deployed contract's own verdictDigest equals ours, and the
               signature recovers to the arbiter this job locked   (adjudicate.ts:409)

  the contract, when anyone relays it:
    ecrecover == job.arbiter · evidenceHash == job.disputeHash · seller heard ·
    award inside the offers · still inside the arbitration window
```

The order in which copies of the work are trusted is the fix for the worst finding against the first version. There, the arbiter read the buyer's copy of the deliverable and compared only its *declared* hash with the chain, never the hash of its content. A buyer could receive good work, dispute it with fabricated text under the real hash, and win. Now a copy counts only if its bytes reproduce the on-chain commitment, the work fetched from the seller's own URI outranks both parties' copies, and when no copy verifies, nothing is checked at all rather than checked against fiction.

---

## 6. The guardrail — the load-bearing idea

An AI judge with authority over money is a liability. The first version answered with a band derived from keyword overlap between the criteria and the deliverable, and caged the model inside it. The audit showed that cage was the problem: honest French work in other words scored 0–19.5%, and the criteria pasted back as the delivery scored 88–100%. A cage built on a measure of vocabulary forces the judge to enforce wrong answers. Keyword scoring is gone. The guardrail now has two layers, and each decides only what it can.

**The outer layer is on chain.** The buyer's offer and the seller's ask bound every award (§3c). No arbiter, house or listed, can rule outside the range the parties themselves put on chain.

**The inner layer decides only what code can verify.** Each acceptance criterion in the terms is either a **check** or a **judgement**:

```json
{ "id": "keys",     "weight": 3, "check": { "type": "jsonKeys", "at": "/strings", "keys": ["cart.title", "…"] } }
{ "id": "french",   "weight": 2, "check": { "type": "language", "at": "/strings", "is": "fr" } }
{ "id": "prices",   "weight": 2, "check": { "type": "regex",    "at": "/prices",  "pattern": "^\\d+,\\d{2} €$" } }
{ "id": "dates",    "weight": 1, "check": { "type": "regex",    "at": "/dates",   "pattern": "^\\d{1,2} (janvier|…) \\d{4}$" } }
{ "id": "glossary", "weight": 1, "check": { "type": "contains", "at": "/strings", "all": ["Valider la commande", "Code promo"] } }
{ "id": "tone",     "weight": 1, "text": "The copy reads naturally to a French shopper" }
```

Checks (`jsonKeys`, `json` with a JSON Schema, `count`, `language`, `regex`, `contains`; `checks.ts:128`) are pure functions of the delivered bytes that anyone can re-run. They earn their weight in proportion to what they verified: 6 of 8 keys earns 0.75 of its weight. Judgements are left open. So the band is

```
   lowBps  = verified credit / total weight
   highBps = lowBps + open weight / total weight          (rules.ts:242)
```

exactly as tight as what was verified: a single point when everything is checkable, the full range when nothing is, and always narrowed to the offers (`withinOffers`, `adjudicate.ts:191`). Two rules decide who carries a defect: a check the terms got wrong (a pattern that does not compile, an unknown type) is left open rather than charged to the seller, and a deliverable no copy of which verifies leaves every check open. Language detection is restricted to major languages so short UI strings are not misread as a rare neighbour (`checks.ts:29`).

**The open share goes to a judge panel, under an evidence rule.** The model never proposes an award. A panel (three judges by default; `OPENAI_MODEL` may list several models) scores only the open criteria, 0 to 1 (`judgePanel`, `llm.ts:271`). A score of 0.5 or more claims credit and counts only if it quotes the delivered work verbatim; the arbiter checks every quote against the verified bytes and discards the score otherwise (`llm.ts:40`). Absence cannot be quoted, so lower scores need none. Each criterion takes the median of the accepted scores, and the award is verified credit plus each open criterion's weight times its median (`panelAward`, `adjudicate.ts:135`), inside the band by construction. With no model configured, open criteria stand at the neutral midpoint, the same rule the escrow applies to a lapsed dispute.

Untrusted text in the prompt sits between fence lines derived from the pinned bundle's hash (`fenceFor`, `prompt.ts:42`): reproducible byte for byte, yet unknowable to whoever wrote the text, so it cannot close a fence and address the judge.

The four-scenario corpus shares one French localization brief, so the only thing that changes between scenarios is what was delivered. Every band was worked out by hand before anything ran, and `pnpm demo predict` asserts it:

| scenario | what was delivered | checks earned (of 9 checked weight) | band | centre |
|---|---|---|---|---|
| `underdelivered` (live) | 6 of 8 strings, in French; US prices and dates; no glossary | 4.25 | 4250–5250 | 4750 |
| `nodelivery` | a status note saying nothing was done | 0 | 0–1000 | 500 |
| `badfaith` | everything the brief asked for; the buyer disputes anyway | 9 | 9000–10000 | 9500 |
| `echo` | the acceptance criteria, pasted back as prose | 0 | 0–1000 | 500 |

`echo` is the attack keyword scoring could not survive. It now earns exactly what delivering nothing earns.

The drill keeps the clamp honest: `pnpm demo drill` pushes proposals through the real `clampToBand` and checks that one already inside the band comes back **unclamped**. A clamp that fires on every input is not a guardrail; it is a replacement for the judge.

---

## 7. The money, exactly

The accepted path is unchanged: the seller is credited the amount minus the platform fee the job locked (50 bps on this deployment).

The disputed path is `disputeSettlement` (`:479`), public and pure, so anyone can compute a ruling's payout before it lands. **Loser pays:** each side bears the arbitration fee in proportion to the share it lost, and the buyer's share is paid out of its bond first. Whatever is left of the bond follows the award. Job 4, worked through:

```
    amount 25.00 · arbitration fee 2% = 0.50 · bond 5% = 1.25 · award 4750 bps

    seller gross   25.00 × 0.475            = 11.875
    seller's fee   0.50 × (1 − 0.475)       =  0.2625   (it lost 52.5%)
    buyer's fee    0.50 − 0.2625            =  0.2375   paid out of the bond
    bond left      1.25 − 0.2375            =  1.0125
    to the seller  1.0125 × 0.475           =  0.480937  (the part of the bond it won)

    seller   11.875 − 0.2625 + 0.480937     = 12.093437
    buyer    13.125 + (1.0125 − 0.480937)   = 13.656563
    fee      0.50: 0.40 to the listed arbiter, 0.10 to the treasury (20% protocol cut)
```

Every figure matched the escrow's `VerdictResolved` event and the wallet deltas in the receipt. A buyer who disputes work that was delivered (`badfaith`, award 10000) pays the whole fee and forfeits the rest of its bond to the seller; a buyer who was right gets its bond back. In the first version a dispute was a free option for the buyer; now it costs exactly what the buyer was wrong about. A fuzz test checks that no settlement creates or loses a unit, and a solvency test checks that credits equal the escrow's balance across awards from 0 to 10000.

Fee caps are constants, re-checked in every setter: platform fee at most 500 bps, arbitration fee at most 1000 bps, protocol cut at most 5000 bps of the arbitration fee.

---

## 8. Deep on Tempo — the chain-specific engineering

### 8.1 There is no gas token. The fee is a TIP-20 transfer.

On Tempo a transaction pays for itself in the stablecoin it moves: the fee is a `Transfer` of the fee token from the payer to the fee manager, `0xfeec000000000000000000000000000000000000`, in the receipt's own logs. The SDK's `feePaid(receipt.logs)` reads it, and the transcript prints it on every stage. Job 4's nine transactions paid **0.005606 alphaUSD** in total, each one a TIP-20 transfer read from its receipt:

| approve | open (create + fund) | deliver (with data: URI) | dispute (+ bond approval) | respond | relay | 3 withdrawals |
|---|---|---|---|---|---|---|
| 0.000167 | 0.000511 | 0.003667 | 0.000349 | 0.000177 | 0.000648 | 0.000029 each |

Delivery is the most expensive step because its `data:` URI is stored on chain; a production seller would record an `ipfs://` or `ar://` location instead. Because the fee comes out of the same balance a payout lands in, a wallet's delta is `credit − fee` when it pays its own fee, and the runner subtracts the fee it reads from the receipt before comparing.

### 8.2 Sponsorship is proven, not assumed

`feePayer` being present on a receipt proves nothing: an unsponsored Tempo transaction names its own sender as fee payer. The only evidence of sponsorship is a payer that *isn't* the sender, and the runner's fee report branches on exactly that. The `--sponsored` path routes every write through `withFeePayer(http(rpc), http('https://sponsor.moderato.tempo.xyz'))` with `feePayer: true`. It was proven end to end on the first deployment (job 5 there, a different address paying 0.011021 alphaUSD for the batched open); the SDK path is unchanged, and it has not been re-run on the current deployment.

### 8.3 Deploying code costs ~5.6× what a standard EVM chain charges just to store it

Deploying the current escrow cost **19,617,183 gas** (tx `0xc76868bb…231d`, block 38,497,375, 0.011771 alphaUSD). Its runtime is **17,519 bytes**. A standard EVM chain charges 200 gas per byte to store runtime code, **3,503,800 gas** for these bytes; Tempo charged **5.60×** that, an all-in **1,119.8 gas per runtime byte**. (The first version, 9,324 bytes for 11,036,281 gas, measured 5.92×.)

The consequence is structural: **you cannot afford one contract per job**. So there is exactly one escrow holding a `mapping(uint256 => Job)` ledger (`:164`), and milestones are rows in it, not contracts (§11).

Stock `forge` can neither send a type-0x76 transaction nor pay the fee in a TIP-20 token, and `forge script` underestimates Tempo's creation gas. So `pnpm deploy:escrow` (`packages/sdk/scripts/deploy.ts`) does it from first principles on viem's Tempo client: it builds the creation payload from the forge artifact, preflights the chain, token, balance and gas (the node's own `eth_estimateGas` prices creation correctly), sends one transaction whose single call has no target, and then proves the result: the live runtime equals the build **byte for byte outside the 11 immutable slots** the constructor fills, twelve settings and constants read back as intended, and the EIP-712 domain names this chain and address. The deployer was a throwaway key with no role in the contract; ownership and the house arbiter stayed with the keys that govern the first deployment.

### 8.4 Batched calls: one transaction, one fee, atomic

Batched calls cannot see each other's return values, so `fund(jobId)` cannot read the id `createJob` just minted. Hence `nextJobId()`, read before the batch, and the id parsed back from `JobCreated` after it. The same pattern scales: `createAndFundMilestones` approves the total, calls `createMilestones`, and funds every tranche under its own job id in one atomic transaction, and `dispute` rides with the approval for its bond.

### 8.5 Memos carry business meaning, not just metadata

`fund` writes the job id as the memo, so an indexer reconciles an inbound payment to its job without a log join; the dispute bond is pulled under the same memo. `withdraw` writes a constant tag, `bytes32("tempex.withdraw")`, so every payout is self-identifying in the token's own history. The demo asserts the tag on every payout and fails loudly if it is missing.

### 8.6 The toolchain reality

- Chain **42431**, RPC `https://rpc.moderato.tempo.xyz`, 1s blocks, type-118 (`0x76`) transactions. Explorer `https://explore.testnet.tempo.xyz/tx/<hash>`; the bare `explore.tempo.xyz` host 404s.
- Stablecoins at 6 decimals; this deployment's payment and fee token is AlphaUSD.
- The public RPC rate-limits bursts. One live run was refused mid-relay ("try again in 116ms"); the runner keeps its session on disk, and the resumed run finished from the stage that failed.
- **There is no ERC-8004 agent-identity registry on Tempo.** Identity is enforced by the escrow itself: each job records the arbiter it trusts, and every ruling must recover to it.

### 8.7 `eth_getLogs` is capped at 100,000 blocks

Moderato rejects a wider range outright (`query exceeds max block range 100000`). At 1-second blocks that is 27.7 hours. The beacon always scanned in 50,000-block chunks (`scanEvents`, `chain.ts:156`). The arbiter's watcher did not, and the audit found it failed on startup on Moderato; it now walks the same chunks (`watch.ts:23`) and, without an explicit start, scans only the blocks a still-rulable dispute can occupy: the seller window plus the arbitration window plus a day.

---

## 9. Adoption — the Beacon, or how a protocol gets a front door

`packages/beacon` answers the question an agent actually arrives with: *what is this, what does it cost, and can I use it before I have anything?* — while never being in a position to lie about money.

1. **It holds no keys and no custody.** The server has no way to construct a signer; `/blueprint/:action` returns encoded calldata with arguments labelled by the ABI's parameter names, and the agent signs elsewhere.
2. **It has no database of record.** Every figure is folded from escrow events on cold start and re-derivable by anyone running the same scan.
3. **Zero balance is the default.** A seller can be hired, deliver and collect holding only a key: the hosted fee payer signs the fee and the escrow credits rather than pushes.
4. **Discovery has a price; everything needed to decide does not.** `/discover` answers 402 until the caller pays on chain under a quote-bound memo; manifest, stats, reputation, onboarding and the arbiter market are free.
5. **Registration is portable.** The credential is a signature over a challenge bound to this beacon, this escrow and an expiry.

The surface in the second version: **19 routes** (15 free GET, 3 free POST, 1 paid GET); v3 has **27** (§9.1), one route table shared by the docs and the router (`assertRoutesAgree()` throws at import time if they ever differ). New in this version: `GET /arbiters` lists the house arbiter and every listed one with fees and a track record folded from events (jobs locked, disputes ruled, lapsed), and the blueprints cover the whole protocol: `create-and-fund` (optionally naming an arbiter), `create-milestones`, `deliver` with a URI, `dispute` with its bond and offer, `respond` with an ask, `settle-lapsed`, `list-arbiter`, `delist-arbiter`.

Measured, not asserted: `pnpm --filter @tempex/beacon smoke` against the second version's deployment made **189 assertions**; against v3 it makes **214**, including the document store, `/tx` and `/activity`, (cold index rebuild, all 15 free GET routes, the 402 refusal paths, a challenge/signature registration, replay and wrong-signer refusals) and spent **0 units**; the treasury's token balance was 1,000,001,101,204 before and after. Receipt: `runs/beacon-smoke-2026-10-07T01-32-06-689Z.json`.

### 9.1 Bounded autonomy: agent keys, the dashboard, hire links

The protocol settles deals; this layer decides *who may make them*. Owners set limits, agents transact inside them, and the chain enforces both.

- **Agent wallets** (`packages/agent`, `packages/sdk/src/agents.ts`). An agent never holds its owner's money. It holds a Tempo access key under the owner's account, which the account keychain limits to a budget per period, an expiry, and the escrow's functions for its role (a buyer may also `approve`, with the escrow as the only spender). Everything it signs settles as the owner. Pairing is a request signed by the agent's own P-256 key and carrying a random witness; the owner approves with a passkey and may grant less, never more; the authorization binds the witness on chain, and the beacon and the agent each verify it. Measured on Moderato: an over-budget open is refused (`SpendingLimitExceeded`) with nothing spent, because approve, create and fund go in one transaction; a call outside the scope is refused (`CallNotAllowed`); a revoked key is refused. Two findings worth knowing: the keychain meters a budget by **allowance increases**, not by funds pulled, and it applies call scopes to `eth_call` too, so every read goes through an account-less client.
- **Signer attribution** (`packages/beacon/src/inspect.ts`). Tempo's signature envelope names the account and, for an access key, its `keyId`. The beacon reads it back from each transaction, so an owner's dashboard says which agent took each step, from the signature rather than from anything the agent reported. `GET /tx/:hash` decodes calls, events, fee payer and signer; `GET /activity/:address` lists every step with its signer.
- **The document store** (`packages/beacon/src/docs.ts`). Terms, evidence, seller answers and long deliverables are filed by hash, and the store computes each hash itself, so a document can sit only under the hash it really has. It is public to anyone holding the hash, and the job's terms hash is on chain.
- **The owner dashboard** (`packages/web`). Both sides of every deal from one passkey account: an inbox of every move the escrow accepts from you now, with its deadline; each job's papers re-hashed in the browser before they are shown; every move for either side; and the signed trail. A passkey synced from another device signs in by recovering its public key from its own signature.
- **Hire links.** A seller writes an offer once and shares a link; a buyer funds it with one passkey prompt, and an agent gets the exact `tempex-agent open` command. The offer lives in the link; the buyer's terms are what get filed and hashed.

---

## 10. Where the code lives

The counts below are from the second version. v3 adds `packages/agent` (agent keys, pairing, CLI), `packages/web` (the site and dashboard) and the beacon's agent desk, document store and signer attribution, and the escrow gains the OpenZeppelin upgradeable base (7 vendored files).

```
  contracts/                          762 lines of Solidity
  ├── src/TempexEscrow.sol            738   the whole settlement layer
  ├── src/ITIP20.sol                   24
  └── test/TempexEscrow.t.sol       1,087   61 tests, one fuzzed
  packages/
  ├── sdk/                          1,889
  │   ├── src/client.ts               698   TempexClient: one send() funnel, settlement math, milestones
  │   ├── src/evidence.ts             288   canonical JSON, typed criteria, case files, seller responses
  │   ├── src/milestones.ts            92   plans, per-tranche terms, pre-sign validation
  │   ├── src/fetch.ts                 70   deliverable fetch through untrusted gateways, data: URIs
  │   ├── src/verdict.ts · config.ts · index.ts
  │   ├── scripts/deploy.ts           296   verifying deployment (§8.3)
  │   └── scripts/smoke.ts            163
  ├── arbiter/                      2,665   (+ 549 lines of tests: 45 tests)
  │   ├── src/adjudicate.ts           561   pin → check → offers → panel → clamp → certify → sign
  │   ├── src/llm.ts                  329   judge panel, evidence rule, median
  │   ├── src/rules.ts                303   which copy to check, criteria results, the band
  │   ├── src/checks.ts               293   the six check types, and what makes a check defective
  │   ├── src/verify.ts               301   proves the claims a sceptic would check, offline
  │   ├── src/watch.ts                271   chunked catch-up, waits for the seller, live subscription
  │   ├── src/prompt.ts               114   the exact bytes the judges receive, fenced
  │   └── src/cli.ts · store.ts · index.ts
  ├── demo/                         2,268
  │   ├── src/runner.ts             1,071   8 stages, expectations, receipt builder
  │   ├── src/scenarios.ts            383   the typed four-scenario corpus
  │   └── src/predict.ts · drill.ts · transcript.ts · cli.ts · index.ts
  └── beacon/                       6,066   the front door: read-only, holds no keys
  runs/                                     JSON receipts of live runs
  evidence/                                 case files of the current deployment's jobs
  evidence/superseded-0x7579/               the first deployment's, unchanged
  deployments/moderato.json                 address, transaction, verification, live proof
```

---

## 11. Design decisions, and what was rejected

| # | Decision | Rejected alternative | Why it lost |
|---|---|---|---|
| 1 | **One escrow with an internal job ledger** | A factory minting one escrow per job | Deployment cost 19,617,183 gas (§8.3). A factory pays that per job. |
| 2 | **Pull settlement** | Push transfers inside `resolve` | Push makes settlement depend on a token's revert behaviour and opens a re-entrancy surface where money moves. Pull makes `resolve` a ledger write. |
| 3 | **Each job locks its arbiter and fees** | A global arbiter slot read at settlement | The audit showed the owner could swap the arbiter mid-dispute and sign the verdict itself, and raise the fee on open jobs. Locking costs a few packed fields of storage per job. |
| 4 | **The seller gets 7 days to answer** | Rule on the buyer's bundle alone | A ruling that hears one side is not arbitration. The contract enforces it: no verdict before the seller is heard or its window closes. |
| 5 | **Final offers bound every award, on chain** | A rule band enforced only by the arbiter's code | The first version claimed the clamp ran on chain; it did not. Offers are the bound the parties set themselves, and the only one no arbiter can cross. |
| 6 | **A bond, and the loser pays the fee** | Free disputes, fee split by the award | A free dispute is an option worth exercising on any delivery; a bad-faith buyer could expect up to 12% back. Now disputing delivered work costs the fee and the bond. |
| 7 | **A lapse rule** | No timeout on `Disputed` | A silent arbiter locked money forever. Now anyone settles at the midpoint after 7 days, and the arbiter earns nothing. |
| 8 | **Checks decide what code can verify; judgement gets the rest** | Keyword coverage as an "objective" band | It measured vocabulary, not delivery, and caged the judge inside wrong answers (§6). |
| 9 | **A judge panel whose credit must quote the work** | One model proposing an award | One confused or injected run could swing a ruling, and nothing tied its number to the work. A median of evidence-backed scores can be checked line by line. |
| 10 | **Rules always run; the panel is optional** | Model required | A missing key is a configuration state, not an outage: checks still decide, and the open share stands at the neutral midpoint. |
| 11 | **Arbiters compete in one escrow** | One house arbiter | A listed arbiter is a signing key plus a fee; the buyer names it and the seller sees it before delivering. Tempex becomes the market and the standard, not the only judge. |
| 12 | **Milestones are linked jobs** | A milestone state machine inside one job | Every tranche reuses the whole lifecycle; a dispute risks one tranche and its 5% bond, not the deal. |
| 13 | **Certify against the live contract before signing** | Trust the off-chain signing stack | `certified = matches && signerIsArbiter` (`adjudicate.ts:409`): the deployed contract's digest and the job's locked arbiter, checked before anything is broadcast. |
| 14 | **The beacon holds no keys and no database of record** | A signing, caching index service | A service that can sign can be robbed; a cache can be true only of itself. |

### 11.1 The trust boundary, stated exactly

| You must trust… | To do what | What stops it going further |
|---|---|---|
| **The job's arbiter key** | Sign a verdict on a `Disputed` job | The verdict must recover to the arbiter *this job* locked, cite the pinned evidence, come after the seller was heard, land between the parties' offers, and arrive inside the arbitration window. It signs a percentage; the contract does the split. If it never signs, the dispute lapses to the midpoint and it earns nothing. |
| **The escrow's owner** | Set the defaults for new jobs (house arbiter, treasury, fees, protocol cut), the launch guards, and, in v3, **upgrade the escrow's code** | Setters reach only jobs created afterwards, fee caps are constants, and ownership transfers in two steps. But the upgrade is unrestricted: new code could change any rule, including how escrowed funds move, and the beacon's manifest says so (`ownerCanTakeJobPrincipal: true`). It is one externally-owned key on this testnet; a timelocked multisig, after an external audit, is the condition for mainnet. |
| **The checks** | Decide checkable criteria exactly | Pure functions of the verified bytes, re-runnable by anyone; their evidence is in every receipt. Defective terms leave a criterion open instead of charging the seller. |
| **The judge panel** | Score the open criteria | Credit needs a verified quote; the median discards outliers; the award is computed from the scores, so the model never names a number; the band and the offers bound the result. |
| **An agent's access key** | Act for its owner, inside its scope | The keychain enforces the budget, the expiry and the calls; the owner revokes it in one transaction. It cannot send funds anywhere but the escrow. |
| **The beacon** | Describe the protocol and build calldata | It cannot sign, hold funds, or report a number it did not read from chain. |
| **Nobody** | Release funds after a missed deadline, an idle review window, or a silent arbiter | `refundExpired`, `autoAccept` and `settleLapsed` are permissionless. |

---

## 12. Evidence

**The current deployment, v3.** `0xe3E3Dece68B7D8AD3dc8638B38bf546FF594268a`, deployed and verified by `pnpm deploy:escrow`. About 21 jobs on chain, **every one opened by us while testing**: disputes ruled and relayed, deliveries accepted, refunds, jobs opened by agent keys, and job 21 funded from a hire link. The first outside job is the next milestone. Through the dashboard, a full pass of 47 checks (every screen, dialog and passkey prompt, both sides, agent keys, pairing, revoke) passed live.

**The second version's deployment.** `0x001c8C3391E591C9CBDFdFE4227e585b86041157`, deployed and verified by `pnpm deploy:escrow` (§8.3). On chain: **4 jobs**, 100 alphaUSD escrowed in total. Jobs 1, 3 and 4 were disputed, answered by the seller, and settled by a verdict from a listed arbiter, relayed by a key that is neither party nor arbiter; job 2 (the SDK smoke test) sits `Funded` under the house arbiter, refundable by anyone after its deadline. The treasury holds 0.30 alphaUSD of credited protocol fees.

| Check | Command | Result |
|---|---|---|
| Contract suite | `pnpm test` | **85/85** in v3 (61 in the second version), fuzzed conservation, solvency, and an upgrade that keeps state and verdict digests |
| TypeScript suites | `pnpm test:ts` | v3: **63** arbiter, **16** beacon, **15** agent, **24** web, **2** demo (45 arbiter in the second version). The arbiter's: the audit's failures as regressions, band properties over 400 seeded rounds, every check type, the panel's evidence rule, the prompt's fences |
| Typecheck | `pnpm typecheck` | clean, all packages |
| Corpus | `pnpm demo predict` | all 4 scenarios reproduce their hand-worked bands |
| Guardrail | `pnpm demo drill` | no proposal escaped its band; in-band proposals pass unclamped |
| Everything above | `pnpm check` | green |
| Deployment | `pnpm deploy:escrow` | runtime equals the build outside 11 immutable slots; 12 settings and constants read back; EIP-712 domain correct |
| Live, typed criteria | `pnpm demo run --fresh --listed-arbiter` | job **4**, 8/8 stages, **31/31** expectations, ruling 4750 inside offers [2500, 5000] |
| Live, first run on this deployment | same, before typed criteria | job **1**, 8/8 stages, 28/28 expectations, ruling 3250 |
| Beacon, live | `pnpm --filter @tempex/beacon smoke` | **214 assertions** on v3 (189 on the second version), 0 units spent |
| Judge beside the rules | `pnpm demo judge` | the real panel over the corpus, with where it moved each award; needs `OPENAI_API_KEY`, not yet run against a model |
| SDK, live | `pnpm --filter @tempex/sdk smoke` | job 2 opened and funded in one transaction, memo `bytes32(2)`, digest agrees with the contract |

Receipts on disk: `runs/demo-underdelivered-2026-10-07T02-12-27-827Z.json` (job 4), `runs/demo-underdelivered-2026-10-07T01-31-43-924Z.json` (job 1), `runs/beacon-smoke-2026-10-07T01-32-06-689Z.json`, and `deployments/moderato.json` with the transaction of every step of job 1. The first deployment's receipts remain in `runs/` with their case files in `evidence/superseded-0x7579/`.

**On the guardrail, precisely, because it is the claim most worth attacking.** The outer bound has been exercised on chain: every live verdict was checked by the contract against the parties' offers. The inner band has been computed on chain-delivered bytes: job 4's five checks ran on the work fetched from its `data:` URI. But every live ruling so far came from the rule engine, because no model key was configured; the judge panel has been exercised end to end against a local OpenAI-compatible mock and through injected replies in the test suite, never against a real model, and the clamp has never had to fire on a live proposal. What proves the clamp fires is offline and reproducible without keys: `pnpm demo drill` and `pnpm arbiter verify`.

---

## 13. Stated limits

Better these come from the source than from a judge.

1. **The judge panel has never run against a real model, and every live ruling so far came from the rule engine.** The site and receipts say so on each ruling. One API key, `pnpm demo judge` and one live dispute close this.
2. **Judgement criteria are only as good as the panel.** Checks decide what is checkable; for "reads naturally" there is no ground truth, only evidence-backed scores, a median, and the parties' offers as the outer bound. Without a model the open share stands at the midpoint.
3. **No appeal.** A lapse rule ends a silent dispute, but a wrong verdict, once relayed, is final. An appeal to a second arbiter is the next layer, and staking for listed arbiters only makes sense once it exists.
4. **One key per arbiter, outside any enclave.** The arbiter's code is published and its rulings re-derivable, but nothing yet proves which code produced a signature; running the arbiter in a TEE with published attestation is designed, not built.
5. **Evidence reaches the arbiter as files.** The watcher reads case files from a directory; there is no network route for a stranger's evidence yet.
6. **One key can upgrade the escrow.** v3 traded the second version's immutability for the ability to fix a bug, behind one disclosed key that could change any rule. A timelocked multisig and an external audit are the conditions for mainnet; neither is done.
7. **Checks assume a structured deliverable.** They select into JSON with pointers. Prose deliverables can still use `language`, `count` and `contains`, but most of their criteria will be judgements. A `tests pass` check for code jobs needs sandboxed execution and is not built.
8. **Reputation is derived from this escrow alone, and is cheap to inflate.** A score is a fold over this contract's events, not weighted by amount or counterparty diversity.
9. **The registry proves identity, not competence.**
10. **The beacon's index is memory-only**, and its cold start grows with the chain.
11. **Every job so far is ours.** No outside buyer or seller has used it yet; hire links exist to make the first one a single link and a single passkey prompt.
12. **Papers are public.** The document store serves anyone who holds a hash; private terms would need encryption to the parties.

---

## 14. Why this is the right shape

**It solves a real and imminent gap**: agents can pay each other but cannot resolve disagreement, and every work-for-hire relationship in the agent economy is a disagreement waiting to happen.

**It lets each layer decide only what it can**: code decides what the delivered bytes prove, a panel judges what they cannot and must quote them to claim credit, and the contract enforces the bound the parties themselves set, so the AI is genuinely useful and genuinely bounded, and the outer bound is on chain.

**It is fair to both sides by construction**: the seller is heard before any ruling, the buyer's fabricated copy is never checked, a frivolous dispute costs a bond, a silent arbiter cannot lock the money, and no one can change the terms of a deal already in flight.

**It is built out of Tempo rather than on top of it**: fees are TIP-20 transfers, memos carry the reconciliation key, creation and funding (and whole milestone plans) are single type-0x76 transactions, and the measured cost of storing code is why there is one escrow with a ledger instead of a factory.
