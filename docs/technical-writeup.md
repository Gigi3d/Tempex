# Tempex — Technical Writeup

**Agentic arbitration and settlement layer for the agent economy, built on Tempo.**

Live on Moderato testnet (chain 42431) · escrow `0x7579736636dd67A8811A8A2ef95c44560fe6ec27`

> Every number in this document was measured against the running system, not estimated. Section 11 lists the exact commands and their results.

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
2. **Judgement** — someone can assess *qualitative* delivery ("the localization sprint covered 4 of 8 acceptance criteria").
3. **Boundedness** — that someone, if it's a model, must not have unbounded power. Its output must be caged inside a deterministic envelope, and the cage must be visible on chain.
4. **Verifiability** — a third party must be able to reconstruct exactly why the money moved, and the chain must have enforced it without trusting anyone's narration.

Tempex is those four things, composed so that each one is checkable independently of the others.

---

## 2. What was built, in one picture

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ L5  ADOPTION / BEACON       packages/beacon                           4,933 lines │
│     18 routes: manifest · evidence · reputation · zero-balance onboarding         │
│     · 402-gated discovery · signed portable registry · no keys, no custody        │
├───────────────────────────────────────────────────────────────────────────────────┤
│ L4  PROOF / DEMO            packages/demo                             2,108 lines │
│     8-stage live lifecycle, transcript, JSON receipt, offline corpus              │
│     (predict = "what would the rules say", drill = "can the judge escape?")       │
├───────────────────────────────────────────────────────────────────────────────────┤
│ L3  JUDGEMENT               packages/arbiter                          2,075 lines │
│     rules.ts → band · prompt.ts → the exact bytes sent · llm.ts → judge           │
│     clampToBand → certify against the deployed contract → EIP-712 sign → relay    │
├───────────────────────────────────────────────────────────────────────────────────┤
│ L2  CLIENT + CRYPTO         packages/sdk                                861 lines │
│     TempexClient · canonical JSON hashing · EIP-712 verdict type · TIP-20 parsing │
├───────────────────────────────────────────────────────────────────────────────────┤
│ L1  SETTLEMENT              contracts/src                               385 lines │
│     one escrow, internal job ledger, pull payments, ECDSA verdict gate, 14 events │
├───────────────────────────────────────────────────────────────────────────────────┤
│ L0  CHAIN                   Tempo Moderato, chain 42431                           │
│     type-0x76 transactions · TIP-20 stablecoins · memo'd transfers · fee manager  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

10,362 hand-written lines (11,513 including generated ABIs). Five packages, one Solidity contract, no proxies, no upgrade path, no admin god-mode over user funds.

The box says **14 events** because that is the ABI's count, not the source's: `TempexEscrow.sol` declares 12, and `Ownable` and `EIP712` contribute `OwnershipTransferred` and `EIP712DomainChanged`. A reader who runs `grep -c "^    event " contracts/src/TempexEscrow.sol` gets 12 and is right; both numbers describe the same contract.

**The split between layers is the design.** Everything that can be checked deterministically *is* — off chain, before anything is signed. Everything that must be enforced *is* — on chain, by the contract, using only a 65-byte signature and two `bytes32` hashes as inputs.

```
        OFF CHAIN                                        ON CHAIN
  ┌──────────────────────────┐                  ┌──────────────────────────────┐
  │ read the evidence        │                  │                              │
  │ compute objective band   │                  │  credits[] ledger            │
  │ ask the model inside it  │   ── 1 signature ──►  ECDSA vs arbiter slot     │
  │ clamp, hash, sign        │      + 2 hashes  │  fee split, pull-withdraw    │
  └──────────────────────────┘                  └──────────────────────────────┘
    unlimited compute,                              bounded, cheap, verifiable
    fully reproducible,                             ~ the only part that must be
    zero gas                                        trust-minimised
```

---

## 3. The job lifecycle — `TempexEscrow.sol`

One contract, an internal ledger of jobs, ten externally-callable lifecycle functions. Every arrow below is a function; every guard is a `require` quoted from the source.

```
   createJob(seller, amount, termsHash, deliveryDeadline, reviewWindow)
        │  require: seller != 0 && seller != msg.sender
        │           amount > 0 · deadline > now · reviewWindow > 0
        ▼
  ┌──────────┐   cancel()                       [buyer only]
  │ Created  │ ────────────────────────────────────────────────► Cancelled
  └──────────┘
        │
        │  fund()                                   [buyer only, before deadline]
        │  ┌──────────────────────────────────────────────────────────────────┐
        │  │ paymentToken.transferFromWithMemo(                               │
        │  │     msg.sender, address(this), job.amount, bytes32(jobId))       │
        │  │                  ▲                                               │
        │  │                  └── the memo IS the job id. No log-joining,     │
        │  │                      no off-chain correlation table.            │
        │  └──────────────────────────────────────────────────────────────────┘
        ▼
  ┌──────────┐   refundExpired()                  [PERMISSIONLESS]
  │  Funded  │ ────────────────────────────────────────────────► Refunded
  └──────────┘   requires block.timestamp > job.deliveryDeadline
        │
        │  deliver(deliverableHash)                 [seller only]
        │  requires block.timestamp <= job.deliveryDeadline
        │  sets deliveredAt; reviewDeadline = deliveredAt + reviewWindow
        ▼
  ┌───────────┐
  │ Delivered │
  └───────────┘
     │      │
     │      │  dispute(disputeHash)                  [buyer only]
     │      │  requires block.timestamp <= deliveredAt + reviewWindow
     │      │                     ▲
     │      │                     └── evidence is SEALED here. The bundle the
     │      │                         arbiter will read is pinned by hash
     │      │                         BEFORE any judgement exists.
     │      ▼
     │  ┌──────────┐
     │  │ Disputed │
     │  └──────────┘
     │      │
     │      │  resolve(jobId, verdict, signature)      [PERMISSIONLESS]
     │      │  ┌────────────────────────────────────────────────────────────┐
     │      │  │ require state == Disputed                                  │
     │      │  │ require verdict.jobId == jobId      ← can't replay verdict  │
     │      │  │ require awardBps <= 10_000          ← can't over-pay        │
     │      │  │ require issuedAt <= now <= validUntil ← verdicts EXPIRE      │
     │      │  │ require ECDSA.recover(verdictDigest(verdict), signature)    │
     │      │  │         == arbiter                  ← the only signature    │
     │      │  │                                        check in the system  │
     │      │  └────────────────────────────────────────────────────────────┘
     │      ▼
     │  accept()                     [buyer]        autoAccept()  [PERMISSIONLESS]
     │  └──────────┬──────────────────────────────────────┬─────  after review window
     ▼             ▼                                      ▼
  ┌────────────────────────────────────────────────────────────────┐
  │                            Settled                             │
  │   credits[seller] += …   credits[buyer] += …   credits[treasury] += fee │
  └────────────────────────────────────────────────────────────────┘
        │
        │  withdraw()   [any creditor, any time]
        │  paymentToken.transferWithMemo(msg.sender, amount, bytes32("tempex.withdraw"))
        │  zeroes credits[msg.sender] BEFORE the external call (nonReentrant + CEI)
        ▼
  stablecoins land in the wallet, tagged
```

Three deliberate architectural choices are visible in that diagram:

**(a) Pull payments, not push.** `resolve` never transfers. It *credits*. `withdraw` moves. This means a reverting receiver, a gas-griefing token, or a reentrant recipient cannot block a settlement — the ruling lands regardless, and each party collects on their own gas. It also makes the on-chain effect of a verdict a pure ledger write, which is exactly what you want when the thing writing it is an automated agent: `resolve` cannot fail for reasons outside the verdict's own validity.

**(b) `resolve` is permissionless.** The arbiter does not need to hold ETH, or a balance of anything, or even be online at the right moment. It signs; anyone relays. The demo proves this by relaying with a **third wallet that is neither party nor arbiter** (`runner.ts:602`, `stageRelay`) — and the contract accepts it, because `ECDSA.recover` is the only authority that matters. This is a real property, not a rhetorical one: it means the arbitration service is a *signing service*, not a *transaction-sending service*, and it can run with zero operational balance.

**(c) `refundExpired` and `autoAccept` are permissionless.** Dead money has a liveness escape hatch that does not depend on either counterparty being alive or honest. The demo's own job history on Moderato shows both halves of this: jobs 1 and 2 are sitting in `Funded`, which is *correct* — nothing is stuck, either the seller delivers or anyone on earth can refund them after their deadlines.

---

## 4. The eight stages, end to end

The demo runner drives a complete disputed-and-resolved job on live Moderato. Eight stages, five wallets, one of them a pure relayer, one of them a hosted fee payer:

```
  buyer            ESCROW              seller           arbiter          relayer         sponsor
  0x…f39e         0x7579…ec27          0x…5e7a          0x92F3…C4A8      0x…            sponsor.moderato…
    │                 │                   │                 │               │              │
    │
    │ ── STAGE 1 · case ──────────────────────────────────────────────────────────────────────
    │   write terms.json + evidence.json in CANONICAL byte form
    │   → the bytes on disk ARE the bytes that hash to termsHash / disputeHash
    │
    │ ── STAGE 2 · approve ───────────────────────────────────────────────────────────────────
    │  TIP-20 approve(escrow, 25.00 alphaUSD)
    ├────────────────►│
    │
    │ ── STAGE 3 · open ──────────────────────────────────────────────────────────────────────
    │  ONE type-0x76 transaction, TWO calls, ATOMIC:
    │    calls = [ createJob(seller, 25e6, termsHash, deadline, window),
    │              fund(nextJobId()) ]     ← nextJobId() read BEFORE broadcast
    ├────────────────►│  emit JobCreated(jobId=4, …, termsHash)
    │                 │  emit JobFunded(4, 25.00)          ← TIP-20 Transfer, memo = 0x…04
    │                 │
    │                 │◄──── STAGE 4 · deliver ─────────────────────────────────────────────────
    │                 │  deliver(jobId, keccak256(deliverable))
    │                 │  emit JobDelivered(4, hash, t, t+window)     [seller self-pays fee]
    │                 │
    │                 │◄──── STAGE 5 · dispute ─────────────────────────────────────────────────
    │                 │  dispute(4, hashCanonical(bundle))
    │                 │  emit DisputeRaised(4, disputeHash, t)        [buyer self-pays fee]
    │                 │
    │                 │              ── STAGE 6 · rule (OFF CHAIN, zero gas) ──────────────────
    │                 │                   │  1. read Job(4) + terms.json + evidence.json
    │                 │                   │  2. RECOMPUTE disputeHashOf(case) and compare
    │                 │                   │     to job.disputeHash  ── MISMATCH ⇒ REFUSE
    │                 │                   │  3. caseIntegrity(case)  ── problems ⇒ REFUSE
    │                 │                   │  4. analyze() → coverage, corroboration, BAND
    │                 │                   │  5. buildJudgePrompt() → exact bytes → LLM
    │                 │                   │  6. clampToBand(proposal, band) → {bps, clamped}
    │                 │                   │  7. verdictDigest(verdict) off-chain
    │                 │                   │     ==  verdictDigest(verdict) ON THE DEPLOYED
    │                 │                   │         CONTRACT (read-only eth_call)
    │                 │                   │     ── MISMATCH ⇒ REFUSE TO SIGN
    │                 │                   │  8. sign verdict with arbiter key
    │                 │◄── STAGE 7 · relay ────────────────────────────────────────────────────
    │                 │  resolve(4, verdict, signature)   ← sent by RELAYER, not the arbiter
    │                 │  emit VerdictResolved(4, 3250, 7.9625, 16.5375, 0.50,
    │                 │                       evidenceHash, rationaleHash, verdictDigest)
    │
    │◄── STAGE 8 · settle ────────────────────────────────────────────────────────────────────
    │  buyer.withdraw()   → 16.5375 alphaUSD, memo "tempex.withdraw"
    │  seller.withdraw()  →  7.9625 alphaUSD, memo "tempex.withdraw"
    │  treasury.withdraw()→  0.5000 alphaUSD, memo "tempex.withdraw"
    │
    └─ receipt written: transcript + expectations + adjudication, 23/23 checked
```

Note what stage 3 actually accomplishes. On any ordinary EVM chain, opening a funded job is two transactions with a race in between: `createJob` mints an id you only learn from the receipt, so `fund` must wait for inclusion. On Tempo, the two calls ride in **one** transaction, one fee, atomically — and the id is obtainable in advance from `nextJobId()` (`TempexEscrow.sol:313`), with the real id parsed back out of the receipt's `JobCreated` log afterwards to confirm the batch landed where the client predicted. That's a chain-native pattern, not a port.

---

## 5. The trust chain — why a stranger can verify this

This is the part that makes the whole system more than "an LLM with a wallet". Every arrow is a hash commitment, and every commitment is checked by a different party at a different time:

```
┌─ EVIDENCE ──────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│   terms.json ──canonicalize()──► keccak256 ──► termsHash ────┐                   │
│        │                                                      │  createJob()      │
│        │  canonicalize = JSON.stringify with keys sorted      │  ──► ON CHAIN     │
│        │  RECURSIVELY, arrays preserved. Both parties, any    │                   │
│        │  runtime, any key order ⇒ SAME bytes ⇒ SAME hash.    │                   │
│        │                                                      │                   │
│   deliverable ──keccak256──────────────► deliverableHash ────┼─► deliver()       │
│        │                                                      │                   │
│   evidence.json (claim + deliverable + artifacts)             │                   │
│        └──canonicalize()──► keccak256 ──► disputeHash ────────┘─► dispute()       │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
              the arbiter, independently, before it will judge anything:
                                    │
              ┌─────────────────────┴─────────────────────┐
              │  disputeHashOf(case) === job.disputeHash  │  ← is this the bundle
              │                                           │    the buyer pinned?
              │  caseIntegrity(case) === []               │  ← does the terms doc hash
              │                                           │    to what the bundle pins?
              │                                           │    (check reported as PROSE,
              │                                           │     not as a wrong hash)
              └─────────────────────┬─────────────────────┘
                                    ▼
┌─ JUDGEMENT ─────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│   analyze(job, terms, bundle)                                                   │
│        ├── scoreCriterion() per acceptance criterion → coverage 0.00–1.00        │
│        │     (salient-term presence, negation-awareness, stopword-filtered)      │
│        ├── artifact verification: declared vs. hash-verifiable                   │
│        ├── deliverableHash integrity vs. the on-chain delivery commitment        │
│        └── corroboration: does the buyer's claim match what's actually there?    │
│                                    │                                            │
│                                    ▼                                            │
│              RuleBand { lowBps, highBps, center }        ← DETERMINISTIC,        │
│                                    │                        gas-free, testable   │
│                                    ▼                                            │
│              buildJudgePrompt(...)  → the EXACT user message bytes               │
│                                    │   (reproducible: the arbiter has no other   │
│                                    ▼    inputs, so a reviewer can rebuild it)    │
│              judgeWithLlm()  → { sellerAwardBps, confidence, factors, rationale }│
│                                    │   ← the model's UNCONSTRAINED opinion       │
│                                    ▼                                            │
│              clampToBand(proposal, band) → { bps, clamped }                      │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─ SIGNATURE ─────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│   rationaleHash = keccak256(rationale)        ← the model is committed to its    │
│   evidenceHash  = hashCanonical(bundle)         own prose. Full text lives in    │
│                                                 the receipt; only the hash       │
│   Verdict {                                     crosses the wire.                │
│     jobId,                                                                       │
│     sellerAwardBps: the CLAMPED number,      ┐                                   │
│     evidenceHash,                            │  six fields, field-for-field     │
│     rationaleHash,                           │  identical to the Solidity       │
│     issuedAt,                                │  struct (SDK verdict.ts:13)      │
│     validUntil                               ┘                                   │
│   }                                                                              │
│        │                                                                         │
│        ├──► verdictDigest(v, domain)   OFF CHAIN (viem hashTypedData)            │
│        │                                                                         │
│        └──► verdictDigest(v)           ON CHAIN  (eth_call to the real escrow)   │
│                    │                                                             │
│                    └──── CERTIFICATION: both must be equal ──── else REFUSE      │
│                                                                                 │
│        └──► signVerdict(arbiterKey) → 65-byte secp256k1 signature                │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─ SETTLEMENT ────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│   resolve(jobId, verdict, signature)    ← broadcast by ANYONE                    │
│      digest = verdictDigest(verdict)          [computed by the CONTRACT]         │
│      require ECDSA.recover(digest, sig) == arbiter     ← the one gate            │
│      → credits[seller] / credits[buyer] / credits[treasury]                      │
│      → withdraw() → TIP-20 Transfer with memo "tempex.withdraw"                  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The **certification step** is the one to point at. `adjudicate.ts:270` is `const certified = matches && signerIsArbiter;` — the arbiter does not sign a verdict it has not first round-tripped through the *deployed contract's own* `verdictDigest`. That single line closes an entire class of bug that otherwise only surfaces as a mysterious revert on a live network: a domain-separator mismatch, a field-order drift, a `uint64`-vs-`uint256` widening mistake, a chain-id error. Off-chain signing code and on-chain verification code are two independent implementations of one spec, and they are pinned to each other *before* money is at stake. The comment on `VERDICT_TYPES` says it plainly: *"Any divergence here produces signatures the contract rejects, so the shape is asserted against the live contract's `verdictDigest` in the demo run."*

This is also why there is no upgrade path and no proxy. The arbiter's authority is a single storage slot (`arbiter`, `TempexEscrow.sol:77`) that the owner can rotate, and the *only* thing that slot can do is validate a signature. There is no function that lets the owner move escrowed funds, seize credits, or void a job. The worst-case admin action is choosing who judges future disputes — which is exactly the trust assumption a buyer and seller need to consent to anyway when they transact, and which is public, per-job, and changeable.

---

## 6. The guardrail — the load-bearing idea

If there is one thing to defend in a Q&A, it's this. An LLM arbiter that can output any number between 0 and 10000 is a liability, because the model is the *only* thing standing between a prompt injection and your money. So the model is not given authority. It is given a **range**, derived deterministically from the evidence, and its answer is clamped into that range mechanically:

```
                        evidence: coverage = 0.375, corroboration = grounded,
                                  deliverableHash matches, evidence strength = 1.00
                                                    │
                                                    ▼
        center = round(10000 × coverage)            = 3750
        center -= 500   (claim is 'grounded')       = 3250
        verified = hashMatches && coverage≠null && strength==1.00  ⇒  TRUE
        halfWidth = 1200 (verified)  |  2500 (unverified)
                                                    │
                                                    ▼
   ┌──────────────────── THE BAND ─────────────────────────────────────┐
   │                                                                   │
   │  0        2050                    3250                  4450   10000
   │  ├──────────┼───────────────────────┼─────────────────────┼───────┤
   │             │◄──── ±1200 bps ──────►│                             │
   │             │                                                 →   │
   └───────────────────────────────────────────────────────────────────┘

                the judge proposes anywhere it likes:

        proposal  -8000 ────────► clamped to 2050   clamped=true   ┐
        proposal   3100 ────────► passes through    clamped=false  │ the clamp is RECORDED
        proposal  10000 ────────► clamped to 4450   clamped=true   ┘ and written into the
                                                                    ruling that is signed
```

Two properties make this a real guardrail rather than theatre:

**The band is a function of the evidence alone.** `analyze()` is pure, deterministic, gas-free TypeScript (`rules.ts:180`). Same case files in, same band out, forever, on any machine. It is not the model's opinion of the band — the model never sees a chance to influence it. The band is computed *first*, and the prompt *tells* the model what it is, in a `## Guardrail` section that states the numbers and the consequence (`prompt.ts:94-97`).

**The clamp is asymmetric in the right direction.** An unverified case — hash mismatch, no scoreable criteria, artifacts that don't verify — gets a *wider* band (±2500) because the rules legitimately know less. A verified case gets a *narrower* one (±1200) because the rules know more. So the model's discretion is *largest exactly where the evidence is weakest*, which is the honest allocation: when the deterministic layer can't tell, a general reasoner should be granted more room, not less. And the drift signals push the centre: a grounded claim (the buyer's story matches the artifacts) nudges toward the buyer; a contradicted claim or a deliverable-hash mismatch nudges toward the seller — both by a bounded 500 bps, never enough to override the coverage term.

Then comes the discipline that keeps it from being a rubber stamp. `drill.ts` pushes every scenario's `drill` proposals through `clampToBand` and checks five invariants, the third of which is the one that matters:

> **a proposal already inside the band must come back `clamped: false`.**
>
> *"A clamp that fires on every input is not a guardrail, it is a replacement for the judge."*

That's the failure mode nobody tests for. If the clamp were wrong — a sign error, an off-by-one, a band narrower than intended — *every* verdict would come back clamped, and the system would look identical from the outside: money still moves, rulings still land, the demo still passes. The judge would just be decorative, and nobody would notice for months. So the drill asserts the negative: at least one honest proposal must survive untouched. It runs offline in milliseconds, and `pnpm demo drill` prints *"the guardrail held on all 4 scenarios: no judge proposal escaped its band."*

The four-scenario corpus is designed to hit each regime:

| scenario | amount | coverage | corroboration | centre | band | what it exercises |
|---|---|---|---|---|---|---|
| `underdelivered` | 25.00 alphaUSD | 0.375 | grounded | 3250 | 2050–4450 | partial credit, the demo's live case |
| `nodelivery` | 40.00 alphaUSD | 0.00 | grounded | 0 | 0–1200 | band clamped at the 0 floor |
| `badfaith` | 18.00 alphaUSD | 1.00 | **contradicted** | 10000 | 8800–10000 | claim contradicted by the artifacts; band clamped at the 10000 ceiling |
| `admission` | 12.50 alphaUSD | 0.75 | grounded | 7000 | 5800–8200 | seller's own text admits the gap |

`pnpm demo predict` runs the *real* `analyze()` over all four and asserts the numbers above — *"all 4 scenarios reproduce their expected band"*. That is a regression test on the arbitration policy itself, and it requires no chain, no key, and no API key. Change a stopword or a nudge constant and the band moves, predict fails, and it tells you which scenario and which field.

---

## 7. The money, exactly

`resolve` (`TempexEscrow.sol:262-271`) is four lines of arithmetic. Here is what happens to 25.00 alphaUSD:

```
    escrow holds 25.00 alphaUSD
                 │
                 │  arbitrationFee = amount × arbitrationFeeBps / 10000
                 │                = 25.00 × 200/10000        = 0.5000
                 ▼
        ┌────────────────────────────────────────────────► credits[treasury]
        │
    remaining = amount − fee = 24.5000
                 │
                 │  sellerAmount = remaining × verdict.sellerAwardBps / 10000
                 │              = 24.50 × 3250/10000             = 7.9625
                 │  buyerAmount  = remaining − sellerAmount      = 16.5375
                 ▼
        ┌────────────────────────────────────────────────► credits[seller] 7.9625
        └────────────────────────────────────────────────► credits[buyer] 16.5375

    the accept() path is simpler — no arbiter, no dispute:
        fee = amount × platformFeeBps / 10000   (50 bps = 0.5%)
        sellerAmount = amount − fee
```

Two things worth noting. First, **the arbitration fee is charged before the split**, on the whole disputed amount, and is not the arbiter's to award — the prompt says so explicitly (`prompt.ts:13`: *"The arbitration fee is charged before your split and is not yours to award."*). The model cannot steer it. Second, `sellerAwardBps` applies to `remaining`, not to `amount`, which means a 10000 award returns `amount − fee`, not `amount` — the fee is unavoidable on the dispute path, and that's intentional: it's what makes a dispute expensive enough to be worth adjudicating and cheap enough (2%) not to be punitive.

The fee ceilings are capped in code, not in policy: `MAX_PLATFORM_FEE_BPS = 500` and `MAX_ARBITRATION_FEE_BPS = 1_000` (`TempexEscrow.sol:25-26`), enforced in both the constructor and `setFees`. The owner cannot set a 50% take rate on this deployment, ever.

---

## 8. Deep on Tempo — the chain-specific engineering

This is the part that distinguishes a Tempo project from an EVM project deployed to Tempo. Every item below is something the code does *because* the chain works this way, and each is verifiable in the run receipt.

### 8.1 There is no gas token. The fee is a TIP-20 transfer.

On Tempo, a transaction pays for itself in the same stablecoin it moves. The fee is not `gasUsed × gasPrice` of a native asset — it is a `Transfer` of the fee token from the payer to the **fee manager**, `0xfeec000000000000000000000000000000000000`, appearing in the receipt's own logs:

```
  ONE TYPE-0x76 TRANSACTION, ONE RECEIPT, TWO TIP-20 TRANSFERS

  receipt.logs = [
     ┌─ 0: TIP-20 Transfer ──────────────────────────────────────────────────┐
     │    from: buyer                                     ← the actual payment│
     │    to:   0x7579…ec27  (the escrow)                                     │
     │    value: 25.000000 alphaUSD                                           │
     │    memo:  0x000…04    ← the JOB ID, as a 32-byte memo                  │
     └────────────────────────────────────────────────────────────────────────┘
     ┌─ 1: TIP-20 Transfer ──────────────────────────────────────────────────┐
     │    from: buyer                                     ← the transaction fee│
     │    to:   0xfeec000000000000000000000000000000000000000                 │
     │    value: 0.000485 alphaUSD                                            │
     └────────────────────────────────────────────────────────────────────────┘
  ]
```

That identity — *the fee is just another transfer in the same list* — is the kind of thing that turns into a bug if you don't notice it, and into a feature if you do. It turned into both here:

- **The bug:** the demo's wallet-delta expectations were off by exactly `0.000485` on three accounts, consistently, across runs. Root cause: `after − before` on a stablecoin balance is `credit − fee`, because the fee is deducted from the *same balance* the credit landed in. The fix is arithmetic, not hand-waving — `runner.ts` now subtracts the fee it can see in the receipt from the expected delta, and it asserts the fee's payer is the sender before doing so.
- **The feature:** `feePaid(receipt.logs)` in the SDK scans logs for a `Transfer` whose `to` is the fee manager and returns `{ payer, amount, token }`. The transcript prints a `fee` row on every stage: `the sender paid 0.000485 alphaUSD — charged as a TIP-20 transfer, because Tempo has no gas token`. **The demo's transcript is a receipt of the chain's own fee mechanism**, not a claim about it.

### 8.2 Sponsorship is proven, not assumed

`feePayer` being present on a receipt proves nothing — an ordinary unsponsored Tempo transaction names its own sender as fee payer. The only evidence of sponsorship is that the payer *isn't* the sender. The SDK's `reportFeePayer` (`runner.ts:729`) branches on exactly that:

```
   receipt.feePayer === sender   →   "the sender paid 0.000485 alphaUSD"        [unsponsored]
   receipt.feePayer !== sender   →   "sponsored by 0x58aa…442c — it paid
                                      0.011021 alphaUSD"                       [sponsored]
```

Both branches were verified live. The `--sponsored` run routes through `withFeePayer(http(rpc), http('https://sponsor.moderato.tempo.xyz'))` and `feePayer: true` on the request (`client.ts:89-102`, `client.ts:116-134`), and the receipt shows a *different* address paying a *larger* fee for the same work — because the batched transaction is bigger.

Honest note: on the fresh job the sponsorship run cost more in absolute terms than the unsponsored run, because it batched more work. Sponsorship is about *who pays*, not *how much*.

### 8.3 Deploying code costs ~5.9× what a standard EVM chain charges just to store it. That's a design constraint.

Deploying the escrow cost **11,036,281 gas** (`deployments/moderato.json`, tx `0xd27c7cd8…`, block 37,010,916, status `0x1`). Its runtime bytecode is **9,324 bytes**, verifiable two independent ways: `deployedBytecode.object` in `contracts/out/TempexEscrow.sol/TempexEscrow.json`, and `eth_getCode` at `0x7579736636dd67A8811A8A2ef95c44560fe6ec27`, which returns those same 9,324 bytes from the live chain. The creation payload actually sent was 11,217 bytes — 11,025 of initcode plus 192 of constructor arguments, in `calls[0].input` of the type-0x76 transaction (the payload is *not* at the top-level `input`; that field is empty for batched transactions).

A standard EVM chain charges 200 gas per byte to deposit runtime code, so storing these same 9,324 bytes costs **1,864,800 gas** before any execution gas. One Tempo deployment cost **5.92×** that — an all-in effective **1,183.6 gas per runtime byte** (11,036,281 ÷ 9,324).

On the record: an earlier revision of this section quoted a "~800 gas/byte" Tempo tariff and a 13,090-byte runtime. Neither was measured, and 13,090 is not this contract's runtime size. The numbers above are the measured ones, and every input is reproducible from a receipt or from the chain.

The consequence is structural: **you cannot afford one contract per job.** A factory that deployed a per-job escrow would cost 11M gas per job. So Tempex has exactly one escrow holding a `mapping(uint256 => Job)` ledger (`TempexEscrow.sol:83`), and per-job data lives in storage, not in code. The fee model has to accommodate it too — a marketplace on Tempo cannot fund itself with per-job contract creation. This is the kind of chain-specific cost structure that a ported EVM design would trip over on day one, and it's why `refundExpired`/`autoAccept` being *permissionless* matters more here than it would elsewhere: a single shared contract means a single shared keeper surface, and anyone can be the keeper.

`forge script` deployment also does not work on this chain — the deployment was done with a direct type-0x76 transaction, which is recorded in the deployment notes along with the failed attempts.

### 8.4 Batched calls: one transaction, one fee, atomic

`createJob` + `fund` in one transaction. The pattern has a specific wrinkle the code handles explicitly: **batched calls cannot see each other's return values**, so `fund(jobId)` cannot read the id `createJob` just minted. Hence `nextJobId()` (`TempexEscrow.sol:313`), a view the client calls *before* building the batch, and `createdJobId(receipt.logs)` in the SDK, which parses the id back out of the `JobCreated` event and reconciles. On-chain proof: `deployments/moderato.json` records job 2's batched open at `gasUsed: 1320324`, one fee.

```
   NAIVE (any EVM chain)                          TEMPO (batched)
   ─────────────────────                          ───────────────
   tx1: createJob(...)                            tx: calls = [ createJob(...),
   ...wait for inclusion...                                        fund(nextJobId()) ]
   tx2: fund(receipt.jobId)                            one signature, one fee, atomic
   two fees, one race window                            reconcile id from JobCreated log
```

### 8.5 Memos carry business meaning, not just metadata

Tempo's TIP-20 exposes `transferWithMemo`. Tempex uses the memo field for two different jobs:

- **`fund` writes the job id as the memo**: `transferFromWithMemo(msg.sender, address(this), amount, bytes32(jobId))`. An indexer reconciling inbound payments to jobs needs *no* contract-log join — the payment carries its own reconciliation key. The deployment file records the memo-bearing-fund feature with its event topic (`0x57bc7354…`) and a proof transaction.
- **`withdraw` writes a brand tag**: `WITHDRAW_MEMO = bytes32("tempex.withdraw")` = `0x74656d7065782e7769746864726177…`. Every settlement payout is self-identifying in the token's own transfer history — you can distinguish a Tempex payout from any other transfer without a single contract call. The demo *asserts* this: `withdrawCredit` (`runner.ts:684`) finds the memo'd transfer in the receipt and fails loudly if the tag is missing.

The distinction is deliberate: funding memos carry **variable data** (which job), withdrawal memos carry **a constant tag** (what kind of event this is). One memo namespace, two uses, no collision.

### 8.6 The toolchain reality

- Chain **42431**, RPC `https://rpc.moderato.tempo.xyz`, WS `wss://rpc.moderato.tempo.xyz`, 1s blocks, type-118 (`0x76`) transactions.
- Explorer: `https://explore.testnet.tempo.xyz/tx/<hash>`. The bare `explore.tempo.xyz` host **404s** — verified live, and recorded in `config.ts` with a comment so nobody re-derives it.
- `viem/tempo` re-exports `Addresses` and `withFeePayer` but **not** `Hex`. `createClient` from `'viem/tempo'` arrives decorated with public, wallet, and tempo actions.
- Stablecoins at 6 decimals: pathUSD `0x20c0…0000`, AlphaUSD `…0001`, BetaUSD `…0002`, ThetaUSD `…0003`. This deployment's fee token and payment token are both AlphaUSD.
- **There is no ERC-8004 agent-identity registry on Tempo.** Verified against the chain's address book in `viem` (`src/tempo/Addresses.js` exports `accountKeychain`, `addressRegistry`, `nonceManager`, `signatureVerifier`, `stablecoinDex`, `tip20Factory`, `tip403Registry`, `zoneFactory`… with no identity or reputation registry), and against the Tempo introduction notes, which say nothing about one. `.env.example` originally carried a `TEMPO_8004=1` flag describing a feature that did not exist; that line was removed and replaced with an honest note: *"agent identity is enforced by the escrow itself, not by an agent registry… the escrow records the arbiter it trusts, and every ruling must recover to that address under EIP-712 or `resolve` reverts."* Claiming a standard you don't integrate is worse than not integrating it.

### 8.7 `eth_getLogs` is capped at 100,000 blocks. That cap sets an indexer's maximum downtime.

The beacon keeps no database. Its index is rebuilt from `eth_getLogs` on every cold start (`ledger.ts:69`: *"Deliberately not a database. A beacon that can be restarted and rebuild its entire view from `eth_getLogs` cannot drift from the chain, cannot be poisoned by a stale write, and can be audited by anyone who runs the same scan."*). That makes the chain's read limits load-bearing rather than incidental.

Moderato rejects a wider range outright:

```
InvalidParamsRpcError: query exceeds max block range 100000
```

At 1-second blocks, 100,000 blocks is **27.7 hours of chain**. The escrow deployed at block 37,010,916; the head is now past 37,581,537 — a span of ~570,000 blocks, nearly six times the ceiling. So "scan from deployment to head" fails on the first call, and fails in the hardest way to catch: it works against a freshly deployed contract and breaks the first time the beacon has been offline for a day.

`scanEvents` (`chain.ts:151`) therefore walks the range in slices of `DEFAULT_SCAN_CHUNK_BLOCKS = 50_000n`, and `config.ts:114` clamps an operator-supplied `BEACON_SCAN_CHUNK_BLOCKS` back under `MAX_SCAN_CHUNK_BLOCKS = 100_000n`. The clamp exists because the failure mode is configuration-shaped — one well-meaning env var would turn every cold start into an RPC error, and the error would name the RPC, not the env var.

The trade is chosen, not inherited: ~12 requests to rebuild a complete index today, growing by ~86,400 blocks a day, in exchange for a service with no state to lose, no state to poison, and no state to trust. Statelessness costs requests. A database costs an argument about whose numbers are right.

---

## 9. Adoption — the Beacon, or how a protocol gets a front door

The four pillars in §1 are trust properties. None of them answers the question an agent actually arrives with, which is: *what is this, what does it cost, and can I use it before I have anything?*

A protocol with no front door waits to be discovered. `packages/beacon` is 4,933 lines whose entire job is to answer that question truthfully, while never being in a position to lie about money.

**Five constraints, each of which removes a way to be wrong.**

1. **It holds no keys and no custody.** `chain.ts:30`: *"Read-only chain access. No account, no key: a beacon that cannot sign cannot move funds, and that is a property worth being able to state plainly."* It is checkable: `grep -rnE 'privateKeyToAccount|accountFor|privateKeyFor|createWalletClient|walletClient' packages/beacon/src` returns nothing, so the server has no way to construct a signer. The two `eth_sendTransaction` strings in `src/` are metadata returned *to the caller*, naming the RPC method for calldata the beacon built; the single `privateKey` hit is a suggested `cast wallet new` in an onboarding hint. The only private keys in the package live in `scripts/smoke.ts`, signing as a *client* — used to prove the server refuses what it is handed.
2. **It has no database of record.** Every figure is folded from events on cold start and re-derivable by anyone running the same scan (§8.7). Nothing it says can be true only of itself.
3. **Zero balance is the default, not a favour.** `/quote` prices onboarding line by line and returns **total 0** for a seller, with the transaction fee *measured from a real receipt* — 6,284 units = 0.006284 alphaUSD on tx `0xfbb77eb2…`, block 37,026,074, jobId 5 — rather than estimated. Tempo is what makes that claim honest: no gas token means the hosted fee payer can sign the fee, and the escrow's pull-based credits mean a seller never fronts capital.
4. **Discovery has a price; everything an agent needs to decide does not.** `/discover` answers **402** with a quote until the caller settles on chain in the payment token, and the gate decodes the receipt's memo so a payment made for anything else is refused. `config.ts:22`: *"Not a revenue model — a spam price… Free tiers stay free: manifest, stats, reputation, onboarding."* An agent should never have to pay to find out whether paying is worth it.
5. **Registration is portable.** The credential is a signature over a challenge bound to *this* beacon, *this* escrow, and an expiry (`registry.ts:62`), so it cannot be replayed against another beacon or reused after the window closes — and the resulting registry file can be served by any other beacon without either trusting the other. The signature is the credential, not the host.

**Two structural choices worth naming.**

- **One route table, read by both the docs and the router.** `manifest.ts:26`: *"Shared so the documented API and the served API cannot drift apart — a manifest that advertises a route the server does not implement is worse than no manifest."* It is enforced rather than hoped for: `assertRoutesAgree()` (`server.ts:188`) runs at **import time** and throws if the documented set and the implemented set differ in *either* direction. 18 HTTP routes (14 free GET, 3 free POST, 1 paid GET) and 17 CLI commands over the same surface, with drift made impossible at process start.
- **Every error carries its fix.** `BeaconError` has a `hint` field — `beacon.ts:615`: *"Every error an agent can receive carries the fix with it."* So a 400 says `Send "terms": "text" or any JSON value; the beacon hashes it canonically and shows the digest in the decoded call, so you can check it before signing` instead of `invalid request`. An agent that hits it recovers without a human, which is the entire point of a front door for machines.

**What the beacon deliberately cannot do:** sign, hold funds, adjudicate, or hand an agent something to sign without showing its work. `/blueprint/:action` returns encoded calldata with arguments labelled by the ABI's own parameter names — `blueprint.ts:68`: *"An agent that cannot name what it is about to sign cannot check it, and checking before signing is the point of a blueprint."* The agent signs elsewhere, with a key the beacon has never seen.

That is the adoption thesis in one sentence: **the beacon makes Tempex easy to start using and impossible to be defrauded by while starting**, because the entity doing the convincing has no authority over anything.

Measured, not asserted: `pnpm --filter @tempex/beacon smoke` runs **185 assertions against the live chain** — a cold index rebuild over 578,075 blocks (37,010,916→37,588,991), all 14 free GET routes, the 402 refusal path, a challenge/signature registration, replay and wrong-signer refusals, and a settled job's proof — then finishes with the treasury balance provably unchanged at 1,000,001,101,204 units. Receipt: `runs/beacon-smoke-2026-09-30T17-32-38-630Z.json`.

---

## 10. Where the code lives

```
  816387b2/
  ├── contracts/                     385 lines of Solidity
  │   ├── src/TempexEscrow.sol        361   the whole settlement layer
  │   └── src/ITIP20.sol               24   minimal interface: transfer/transferWithMemo/
  │                                          transferFromWithMemo/approve/balanceOf/decimals
  ├── packages/
  │   ├── sdk/                       861    shared by every process
  │   │   ├── src/client.ts          442    TempexClient: every read, every write, one funnel
  │   │   ├── src/evidence.ts        169    canonical JSON, hashing, case files, integrity
  │   │   ├── src/verdict.ts          92    EIP-712 mirror of the contract's typehash
  │   │   ├── src/config.ts           89    chain constants, env loading, address resolution
  │   │   ├── src/index.ts            69    the package's public surface
  │   │   └── src/abi/             1,151    generated: TempexEscrow.ts 1,051 · TIP20.ts 100
  │   ├── arbiter/                 2,075    the judge
  │   │   ├── src/adjudicate.ts      419    the pipeline + CERTIFICATION before signing
  │   │   ├── src/rules.ts           418    the deterministic band engine
  │   │   ├── src/cli.ts             361    adjudicate / watch / verify
  │   │   ├── src/verify.ts          275    proves the three claims a sceptic would check
  │   │   ├── src/watch.ts           221    catch-up log scan + live WS subscription
  │   │   ├── src/llm.ts             184    OpenAI-compatible judge over plain fetch
  │   │   ├── src/prompt.ts          102    the exact bytes the model receives
  │   │   ├── src/store.ts            57    rulings on disk
  │   │   └── src/index.ts            38
  │   ├── demo/                    2,108    the proof
  │   │   ├── src/runner.ts          960    8 stages, 23 expectations, receipt builder
  │   │   ├── src/scenarios.ts       338    4-case corpus with asserted expectations
  │   │   ├── src/cli.ts             265    help/stages/scenarios/predict/drill/run
  │   │   ├── src/predict.ts         218    offline band reproduction
  │   │   ├── src/transcript.ts      170    the one artifact read twice
  │   │   ├── src/drill.ts           113    the guardrail invariants
  │   │   └── src/index.ts            44
  │   └── beacon/                  4,933    the front door — read-only, holds no keys
  │       ├── src/beacon.ts          664    the Beacon class: 24 reads over one folded index
  │       ├── src/manifest.ts        594    the route table, shared by docs and router
  │       ├── src/server.ts          569    18 HTTP routes, 402 on /discover, body caps
  │       ├── src/onboard.ts         517    policy templates, readiness, all-in quotes
  │       ├── src/reputation.ts      486    network stats, measured latency, itemised score
  │       ├── src/cli.ts             425    17 commands over the same surface, JSON out
  │       ├── src/payments.ts        394    quote → memo → settle, verified against logs
  │       ├── src/registry.ts        328    challenge/sign registration, portable file
  │       ├── src/ledger.ts          279    events folded into job records, in memory
  │       ├── src/blueprint.ts       241    encoded calldata per intent; the agent signs
  │       ├── src/chain.ts           198    read-only chain access, chunked log scans
  │       ├── src/config.ts          136    beacon env, deployment block, chunk clamping
  │       ├── src/index.ts           102
  │       └── scripts/smoke.ts       737    185 live assertions; writes runs/beacon-smoke-*.json
  ├── runs/                                 JSON receipts of live runs
  └── deployments/moderato.json             addresses, txs, and the notes on how they got there
```

The pieces worth quoting:

**`client.ts:116` — `send()` is the single funnel.** Every state-changing call in the whole system goes through one function that assembles a `sendTransaction` with `calls[]`, `feeToken`, optional `nonceKey` / `validBefore` / `validAfter` / `feePayer`, waits, and throws on revert. One place to reason about gas, sponsorship, batching, and nonce keys. `createAndFundJob`, `deliver`, `dispute`, `resolve`, `withdraw` are each ~15 lines because of it.

**`rules.ts:326-340` — the band.** Fifteen lines that decide the entire guardrail. Coverage × 10000, a bounded ±500 nudge from corroboration, a ±500 nudge if the delivered artifact doesn't match its on-chain commitment, then a half-width of 1200 if verified and 2500 if not. Every constant is named and at the top of the file. This is the code that limits the AI.

**`adjudicate.ts:132` — the ordering.** *"pin the evidence, derive the objective band, let the judge speak inside it, then certify against the live contract before anything is broadcast."* Four phases, in that order, for a reason: you cannot judge before you've pinned, you cannot clamp before you've derived, and you must never broadcast before you've certified.

**`adjudicate.ts:270` — `const certified = matches && signerIsArbiter;`.** The line that makes off-chain and on-chain agree.

**`llm.ts:43` — `llmConfigFromEnv` returns `null` when no key.** *"an unconfigured judge must never be able to stall a dispute."* The arbiter degrades to the deterministic rule engine and *says so in the transcript* rather than failing or silently pretending. A missing API key is a configuration state, not an outage.

**`watch.ts:60` — two entry points.** *"an agent that only hears about disputes opened while it happens to be running is not an arbitration service: a catch-up scan over past logs, then a live subscription."* Restart-safety is a design requirement, not a nice-to-have — an arbiter that loses disputes when it reboots is worse than no arbiter, because the parties have already escrowed against it.

**`verify.ts:135` — `verifyArbiter`.** Proves the three claims in the order a sceptic would check them: *the files reproduce the pinned hash, the band is a function of those files, and the signature would be accepted by the deployed escrow.* It runs against a **fabricated dispute that never happened**, with deliberately non-real accounts — so the verification harness itself proves it isn't resting on live state.

**`transcript.ts` — one artifact read twice.** *"Every line goes through here, so the transcript on screen and the JSON receipt are one artifact read twice."* The terminal output and the machine-readable receipt cannot diverge, because there is one writer.

---

## 11. Design decisions, and what was rejected

A writeup that lists only what was built reads like marketing, because it hides the branch points. Every row below names an alternative that was genuinely available and the measured or structural reason it lost. Where the reason is a number, the number is in a receipt or in the source at the cited line.

| # | Decision | Rejected alternative | Why it lost |
|---|---|---|---|
| 1 | **One escrow with an internal job ledger** | A factory minting one escrow per job | Deploying this runtime costs **11,036,281 gas** (§8.3) — 5.92× what a standard EVM chain charges merely to *store* the same 9,324 bytes. A factory pays that per job instead of once. The isolation a factory would have bought is already provided by `_jobs[jobId]` and per-account `credits[]`, so it was separation nobody needed at a price every user would feel. |
| 2 | **Pull settlement**: rulings credit `credits[]`, parties call `withdraw()` | Push — `resolve()` transfers to both parties inline | Push makes the escrow's solvency depend on a token's revert behaviour and opens a re-entrancy surface at the exact moment money moves. Pull means **`resolve()` makes zero external calls** — read `:248-283`: state writes and one `emit`, nothing else. The `nonReentrant` on it is therefore redundant by construction, and was kept deliberately: a belt on a brace that already holds. |
| 3 | **Three owner powers, both fee caps as `constant`** | Proxy + pause + blacklist + `rescueTokens` | `setArbiter`, `setTreasury`, `setFees` are the entire admin surface (`:341-360`). `MAX_PLATFORM_FEE_BPS = 500` and `MAX_ARBITRATION_FEE_BPS = 1_000` are `constant` and re-checked *inside* `setFees`, so the owner cannot raise a fee past 5% / 10% even in principle. `grep -rniE "pause\|delegatecall\|proxy\|blacklist\|rescue\|sweep\|emergencyWithdraw" contracts/src` returns **nothing**. The consequence worth stating plainly: **the owner cannot move one unit of user funds**, because `withdraw()` pays `credits[msg.sender]` and only `msg.sender` can call it (`:300-306`). |
| 4 | **Permissionless relay; authority is the signature** | The arbiter broadcasts its own verdict | If the arbiter must send the transaction, the arbiter needs gas, a funded key and uptime — three new failure modes bolted onto the one role that already has to be trusted. Instead `resolve` has no `onlyArbiter` and anyone may relay it; the only thing that decides is `ECDSA.recover(digest, signature) == arbiter` (`:260`). The arbiter's failure mode collapses to **refusal** — never theft, never censorship-by-fee. |
| 5 | **`createJob` and `fund` separate, then batched into one type-0x76 tx** | A single fused `createAndFund` | Separation is what makes `cancel()` meaningful: a job that exists unfunded can be withdrawn without ever touching the token. The usual cost of separating them — two transactions, and a window where a job sits unfunded — is removed by Tempo batching: one tx, two calls, `gasUsed: 1,320,324` (`deployments/moderato.json`). `nextJobId()` (`:313`) exists **only** because batched calls cannot see each other's return values; it is a Tempo-shaped workaround, not an API flourish. |
| 6 | **The model receives a band, not a decision** | Let the LLM return `sellerAwardBps` directly | An unbounded model is the only thing standing between a prompt injection and someone's money. `clampToBand` (`adjudicate.ts:117`) makes the model's number advisory inside a range the evidence computed — and the clamp is *recorded* in the ruling, so a rubber stamp is visible as one rather than passing unnoticed. |
| 7 | **Rules always run; the LLM is optional** | LLM required, rules only as a fallback | `llmConfigFromEnv` returns `null` when no key is configured (`llm.ts:43`) and the pipeline continues deterministically, saying so in the transcript. A missing API key becomes a **configuration state, not an outage**: no dispute can be stalled by a vendor, a quota, or a latency spike. |
| 8 | **Certify against the live contract before broadcasting** | Trust the off-chain signing stack | `adjudicate.ts:270`: `const certified = matches && signerIsArbiter;`. The digest is recomputed by the *deployed* contract and the recovered signer is compared to the *registered* arbiter before anything is sent. Off-chain and on-chain are made to agree by a check, not by the accident of sharing a library. |
| 9 | **The beacon holds no keys and no database of record** | A signed, cached, "fast" index service | A service that can sign can be robbed; a cache can be true only of itself. Every figure is re-folded from chain events on cold start (§8.7), and grepping `packages/beacon/src` for wallet construction returns nothing (§9, constraint 1). It is slower, and it is incapable of the two worst failure modes a front door can have. |
| 10 | **One route table, read by both the docs and the router** | Hand-maintained API documentation | `assertRoutesAgree()` is called at **import time** (`server.ts:188`) and throws if the documented set and the implemented set differ in *either* direction. Documentation drift is not discouraged here, it is unstartable: the process will not boot. |
| 11 | **Discovery is paid; every decision-relevant read is free** | Free discovery, or a subscription | An agent must be able to learn *what this is, what it costs, and whether it can start with nothing* before it spends anything — so manifest, stats, reputation and onboarding are free (14 free GET routes in the live receipt). `/discover` answers **402** with a quote because an unpriced enumeration endpoint on a service meant to run unattended is a DoS vector. Priced spam, free judgement. |
| 12 | **Every error carries its own fix** | Conventional error strings | `BeaconError.hint` means a 400 arrives with the corrected request inside it. The consumer is a machine with no human to ask, so `invalid request` is a dead end — and dead ends, not fees, are what actually stop adoption. |

### 11.1 The trust boundary, stated exactly

"Trustless" is a marketing word and this system is not one. Here is the real list: who you must trust, for what, and what physically stops it going further. Every row is checkable in the cited source.

| You must trust… | To do what | What stops it going further |
|---|---|---|
| **The arbiter's key** | Sign a verdict on a `Disputed` job | It signs a *percentage*, never an amount. `sellerAwardBps <= BPS_DENOMINATOR` is enforced on chain (`:255`), the verdict must be inside `[issuedAt, validUntil]`, it is bound to one `jobId` and to the exact `evidenceHash` / `rationaleHash` it evaluated, and the contract does the split itself (`:262-271`). There is no argument by which the arbiter can address funds to itself. |
| **The escrow's owner** | Change arbiter, treasury, and fees | Three functions, both caps `constant` and re-checked, and **no path to user funds** — `withdraw()` pays `credits[msg.sender]` and nothing else. No pause, no proxy, no delegatecall, no rescue, no blacklist: verified by grep, not by promise. `setFees` also cannot reach backwards — *"Fees apply to jobs settled after this call; open jobs are unaffected"* (`:353`). |
| **The rule engine** | Compute the band the judge is confined to | It is 418 lines with every constant named at the top of `rules.ts`, reproducible offline by `pnpm demo predict` across all four scenarios, and printed into the transcript on every run. A wrong band is auditable; a hidden one is not. |
| **The LLM** | Propose a number | Nothing — and that is the design. Its proposal is clamped, the clamp is recorded, and the signature covers the *clamped* value, so what lands on chain is provably inside the band whether the model cooperated or not. The model is never the last word. |
| **The beacon** | Tell an agent what this protocol is and what it costs | It cannot sign (no wallet construction anywhere in `src`), cannot hold funds (no custody), and cannot report a number it did not read (no database of record). Its single paid route settles on chain and is verified against logs before the gate opens. |
| **Nobody** | Release funds on a missed deadline or an idle review window | `refundExpired` (`:287`) and `autoAccept` (`:214`) are deliberately permissionless, so any keeper — or the counterparty themselves — can close a stuck job. Liveness does not depend on Tempex being online, funded, or even existing. |

The one row with no mitigation is the arbiter's **refusal**: if it never signs, a `Disputed` job has no timeout and no alternate path (§13, limit 2). That is written down rather than papered over, because a trust model with a labelled hole is survivable and one with a hidden hole is not.

---

## 12. Evidence

**The results first, in the form a sceptic can check.** Tempex is deployed on Tempo Moderato and has real state: **5 jobs**, of which 1–2 sit `Funded` and idle (refundable by anyone after their deadlines) and 3–5 were `Resolved` by signed verdict. Across them, **150 alphaUSD was escrowed, 23.8875 was paid out to sellers, 76.5 remains in escrow**, and **9 withdrawals** have been pulled — not pushed, because `resolve()` credits and the parties withdraw. That accounting is not a database; a cold beacon scan folded it from **29 events** and then cross-checked itself against the contract, finding `jobCount()=5` and `nextJobId()=6`. **19 receipts** are on disk as proofs for anyone who wants to re-derive any of it.

Two full end-to-end runs are complete: job **4** unsponsored, job **5** with every write routed through the hosted fee payer at `0x58aa…442c`. Each passed **8/8 stages, 23/23 expectations, 0 skipped**. The **25/25** Solidity tests and **185** live beacon assertions pass too, with the beacon spending **0 units** and the treasury balance unchanged at 1,000,001,101,204 — the point being that the read layer provably cannot move money.

Cost, measured from receipts rather than estimated: the unsponsored run paid **0.027070 alphaUSD across 8 transactions** (largest single fee 0.010888); the sponsored run paid **0.028595 across 8** (largest 0.011021), with the fee payer absorbing it. Every one of those is a TIP-20 `Transfer` to `0xfeec…0000`, because there is no gas token on this chain. And the figure the beacon uses to price onboarding for a seller with **zero balance** is not a guess: **6,284 units = 0.006284 alphaUSD**, read off tx `0xfbb77eb2…` in block 37,026,074 for jobId 5 — which is why that quote can honestly return **total 0**.

Everything below was run, not estimated:

| Check | Command | Result |
|---|---|---|
| Contract test suite | `forge test` | **25/25 passing** |
| Typecheck, all 5 packages | `pnpm -r exec tsc --noEmit` | **clean** |
| Policy regression | `pnpm demo predict` | *"all 4 scenarios reproduce their expected band"* |
| Guardrail invariants | `pnpm demo drill` | *"the guardrail held on all 4 scenarios: no judge proposal escaped its band"* |
| Live E2E, unsponsored | `pnpm demo run --fresh` | job **4**, **23/23** expectations, 8/8 stages, 0 skipped |
| Live E2E, sponsored | `pnpm demo run --fresh --sponsored` | job **5**, **23/23** expectations, 8/8 stages |
| Contract deployment | tx `0xd27c7cd8…`, block 37,010,916 | `0x7579736636dd67A8811A8A2ef95c44560fe6ec27`, gasUsed 11,036,281 |
| Batched create+fund | job 2 open | one tx, `gasUsed: 1,320,324` |
| Fee mechanism | both runs | fee visible as a TIP-20 `Transfer` to `0xfeec…0000`, payer asserted |
| Memo reconciliation | both runs | `0x000…05` on funding, `tempex.withdraw` on every payout |
| Beacon cold start | `pnpm --filter @tempex/beacon smoke` | 29 events folded into **5 jobs**, blocks 37,010,916→37,588,991, agreeing with `jobCount()=5`, `nextJobId()=6` |
| Beacon, live | same | **185 assertions**, 0 failures, **0 units spent**, treasury balance unchanged at 1,000,001,101,204 |
| Manifest honesty | same | governance in the manifest equals `arbiter()`/`treasury()`/`owner()` read live; fee **measured** from tx `0xfbb77eb2…`, not estimated |
| Route consistency | `assertRoutesAgree()` at import | 18 routes, 9 tools, 1 paid — docs and router cannot diverge, or the process will not start |
| Paid discovery gate | `GET /discover` unpaid | **402**; five distinct ways of not paying all refused, zero units moved |
| Registration integrity | `POST /registry` | replayed challenge → 400; wrong signer → 400 *"signature recovers to …"*; entry re-verifies offline |

Receipts on disk: `runs/demo-underdelivered-2026-09-26T18-49-36-666Z.json` (unsponsored, job 4), `runs/demo-underdelivered-2026-09-26T18-54-40-645Z.json` (sponsored, job 5), and `runs/beacon-smoke-2026-09-30T17-32-38-630Z.json` (the beacon's 185-assertion live run, all eight steps with every assertion and evidence line). Each demo receipt carries 20 top-level keys including `expectations` (23 entries, 23 passed), `transcript` (90 beats for job 4, 91 for job 5), `session`, `corpus`, and a full `adjudication` block with the band, the clamp flag, both hashes, and the digest. The beacon receipt is written **last**, after every assertion, so a receipt can only exist for a run that passed end to end.

**On the clamp, precisely, because it is the claim most worth attacking.** All three live verdicts awarded **3,250 bps** and all three recorded `"clamped": false`, inside a band of `[2050, 4450]`. That is not evidence the guardrail works — 3,250 *is* the band's centre, and with no `OPENAI_API_KEY` the rule engine proposed its own centre, so there was nothing to clamp. The honest reading: **the clamp has never had to fire on chain.** What proves it fires is offline and reproducible without keys — `verifyArbiter` pushes `lowBps − 2500` and `highBps + 2500` through the real `clampToBand` and asserts both come back clamped while the centre passes through untouched (`verify.ts:192-203`), and `pnpm demo drill` runs the same check across all four corpus scenarios, including the invariant that a proposal already inside the band must return `clamped: false`. A guardrail that has only ever been exercised by its own author's inputs is exactly why §6 quotes the code instead of the outcome.

---

## 13. Stated limits

Better these come from the source than from a judge.

1. **The LLM path has never executed live.** `OPENAI_API_KEY` is empty in `.env`, so every run to date went through the deterministic rule engine, and the transcript says so in plain English: `no OPENAI_API_KEY configured; ruled by the deterministic rule engine`. The LLM code path is written, typechecked, and has a fallback contract, but it is **unexercised against a real endpoint**. One pasted key and one `pnpm demo run` closes this.
2. **No appeal, no arbiter-liveness fallback.** If the arbiter never signs, a `Disputed` job has no timeout and no alternate path. The escape hatches (`refundExpired`, `autoAccept`) cover `Funded` and `Delivered`, not `Disputed`. The honest framing: the arbiter is a trusted-but-constrained role, and its *only* failure mode is refusal, never theft.
3. **No proxy, no upgrade path.** Deliberate — an upgradeable escrow is an upgradeable promise — but it means a bug is permanent. The 25-test suite and the batch of live jobs are the mitigation.
4. **`rules.ts` scores by salient-term coverage**, which is a heuristic, not semantic understanding. It is good at "the spec said *glossary* and the deliverable never mentions a glossary" and bad at judging quality. That's precisely why the band widens when verification fails and why the LLM layer exists at all.
5. **No TypeScript test files.** The offline harness *is* `predict` + `drill` + `verifyArbiter` + the beacon's 185-assertion live smoke, which is arguably better evidence (they test the policy and the served claims, not the plumbing) but it isn't a conventional test suite and a reader looking for `*.test.ts` will not find one.
6. **The beacon's index is memory-only, and its cold start grows with the chain.** ~578k blocks today, +86,400 a day, walked in 50k chunks (§8.7). It is correct by construction and gets slower by construction. A snapshot cache would fix the latency and reintroduce exactly the drift the design removes; the production answer is a checkpointed snapshot that is still re-verifiable against the chain, which is not built.
7. **Reputation is derived from this escrow alone.** A score of 518 means *"518 on Tempex's Moderato deployment"*, not a portable cross-protocol identity. The registry signature travels between beacon instances; the history behind the score does not, because that history lives in one contract's events.
8. **The registry proves identity, not competence.** A registration signature binds host, escrow, address and expiry — deliberately *not* the name or the capabilities, which the agent self-declares. The smoke run prints this limit out loud (`the signature binds host, escrow, address and expiry — not the name or capabilities`) rather than leaving a reader to discover it.

---

## 14. Why this is the right shape

Four sentences, if the clock is short.

**It solves a real and imminent gap**: agents can pay each other but cannot resolve disagreement, and every work-for-hire relationship in the agent economy is a disagreement waiting to happen.

**It uses the model where models are good and the rules where rules are good**: the deterministic layer reads the evidence, the model reasons inside a band the rules computed, the contract enforces a signature the model cannot forge — so the AI is genuinely useful and genuinely bounded, and the bound is on chain, not in a policy document.

**It is built out of Tempo rather than on top of it**: the fee is a TIP-20 transfer to the fee manager, funding memos carry the reconciliation key, `createJob`+`fund` is one batched type-0x76 transaction, sponsorship is a proven fee-payer difference, and the measured 11,036,281-gas cost of deploying a 9,324-byte runtime is why there is one escrow with an internal ledger instead of a factory. Every one of those is visible in a receipt you can open on `explore.testnet.tempo.xyz`.

**It can be adopted by something that has never heard of it**: the beacon answers *what is this, what does it cost, can I use it with no balance* in machine-readable JSON, prices the one expensive query so spam costs something, carries its fix inside every error, and holds no keys at all — so the front door can be trusted by an agent that trusts nothing, including the front door.
