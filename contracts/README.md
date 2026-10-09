# TempexEscrow

One escrow for the agent economy. Live on Tempo Moderato (chain 42431) at
`0xe3E3Dece68B7D8AD3dc8638B38bf546FF594268a`, version 3.0.0, behind an ERC-1967
proxy (see `deployments/moderato.json`).

## What v3 changed

- **Upgradeable (UUPS).** Users call the proxy; the owner key can replace the
  implementation with `upgradeToAndCall`. That key can therefore change any rule,
  including how escrowed funds move. It is one key today (the deployer,
  `0xEA4D…62F5`) and should become a multisig behind a timelock before the escrow
  holds meaningful value. The verdict domain is bound to the proxy, so signed
  verdicts survive upgrades.
- **Launch guards**, all owner-set, none able to touch a job already funded:
  - `setNewJobsPaused`: no job can be created or funded. Deliver, accept,
    dispute, respond, resolve, settleLapsed, refundExpired and withdraw keep working.
  - `setLimits(maxJobAmount, maxOpenValue)`: a per-job cap and a cap on the value
    held by all open jobs (`openValue`). Live: 500 and 25,000 alphaUSD.
  - `setArbitrationFeeFloor`: a minimum arbitration fee, locked per job at
    creation, never above the job amount, and not applied to an arbiter listed at
    a zero fee. `arbitrationFee(jobId)` returns the exact fee. Live: 0.5 alphaUSD.
  - `setReferralShare`: `createJobWithReferrer` names who brought a job, and that
    referrer is paid this share (locked per job, at most 50%) of everything the
    protocol earns on it. Live: 20%.
- `getJob` reads exactly as before; the new per-job terms live in `jobExtras`.

## Core operations

**Job lifecycle**: `createJob` · `createJobWithArbiter` · `createJobWithReferrer` ·
`createMilestones` · `fund` · `cancel` · `deliver` · `accept` · `autoAccept` ·
`dispute` · `respond` · `resolve` · `settleLapsed` · `refundExpired` · `withdraw`

Views: `getJob`, `jobExtras`, `arbitrationFee`, `nextJobId`, `verdictDigest`,
`awardBounds`, `evidenceClosedAt`, `version`. Admin: `setArbiter`, `setTreasury`,
`setFees` (capped at 5% platform / 10% arbitration), `setProtocolCut`, the four
guards above, and `upgradeToAndCall`.

## Invariants that matter

- **Custody**: payouts are pull-based (`withdraw` pays `msg.sender`'s own
  credits). Under the current implementation no function moves a user's funds
  anywhere else. An upgrade could change that, which is why the upgrade key is
  the escrow's main trust assumption.
- **Bounded settlement**: a verdict must recover, under EIP-712, to the arbiter
  the job locked, bind the pinned evidence hash, and land inside both parties'
  final offers. Anyone may relay it.
- **Conservation**: every ruling pays out exactly the escrowed amount plus the
  bond, at any award and any fee floor (fuzzed in `TempexEscrowV3.t.sol`).
- **No stuck money**: `refundExpired`, `autoAccept` and `settleLapsed` are
  permissionless, and the pause never blocks them.

Tempo specifics: fees are TIP-20 transfers to the fee manager, not a gas token,
so wallet-delta math must account for the fee on every transaction. That is why
the contract records amounts, not balances.

## Develop

```bash
forge test     # 85 tests: 61 original + 24 for v3 (proxy, guards, floor, referrals)
forge build --sizes
```

The implementation is 23,701 bytes, 875 under the EIP-170 limit; new features
will need room made first.

## Deploy and upgrade

Deploy with `pnpm deploy:escrow` from the repo root (`packages/sdk/scripts/deploy.ts`):
stock forge cannot send Tempo's type-0x76 transaction or pay fees in a TIP-20
token. It deploys the implementation, then the proxy (initialized in its own
constructor), sets the guards from `TEMPEX_MAX_JOB_AMOUNT`, `TEMPEX_MAX_OPEN_VALUE`,
`TEMPEX_ARBITRATION_FLOOR` and `TEMPEX_REFERRAL_SHARE_BPS` in one batched
transaction, then verifies both runtimes against this build and reads every
setting back. `script/DeployTempex.s.sol` does the same deployment for EVM chains
forge can broadcast to.

To upgrade: deploy a new implementation, then call `upgradeToAndCall(newImpl, "")`
on the proxy from the owner key. Add new state variables only after the last one
declared; never reorder or remove them.
