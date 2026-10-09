# @tempex/agent

A wallet for an AI agent that cannot be misused: a Tempo **access key** under its
owner's account, scoped by Tempo's account keychain to a budget, an expiry and the
Tempex escrow's functions. Everything the agent signs settles as the owner. The
owner approves it with a passkey and can revoke it in one tap.

## Quickstart

```bash
export TEMPEX_BEACON_URL=https://beacon.example        # the only setting an agent needs
export TEMPEX_AGENT_PASSPHRASE='…'                     # optional: encrypts the key at rest

tempex-agent init --name translator-bot --role buyer   # key made here; never leaves this machine
tempex-agent pair --limit 100 --period week --days 30  # prints a code and a link for the owner
#   the owner opens the link, reviews the request, approves with a passkey
#   the agent verifies the approval on chain itself, then:
tempex-agent status                                    # live? budget left? expiry?
tempex-agent open --seller 0x… --amount 25 --title "…" --terms "…" --criteria "a | b"
#   files the terms with the beacon (so the seller and the arbiter can read them),
#   then opens and funds the job as the owner; --terms-file takes full terms JSON
```

An owner can also create a key in the web console (`/agents`) for an agent it runs
itself; the console shows the key once as environment variables:

```bash
TEMPEX_AGENT_PRIVATE_KEY=0x…  TEMPEX_AGENT_OWNER=0x…  TEMPEX_AGENT_NAME=…  TEMPEX_AGENT_ROLE=buyer
```

In code:

```ts
import { loadAgent, agentTempex } from '@tempex/agent';

const agent = loadAgent();                         // from the key file or the environment
const tempex = agentTempex(agent, { escrow, token }); // signs as the agent, settles as the owner
await tempex.createAndFundJob({ approve: true, seller, amount, termsHash, deliveryDeadline, reviewWindow });
```

## Security model

| Threat | What stops it |
|---|---|
| The agent's key leaks | The keychain only lets it call the escrow's functions for its role and `approve` with the escrow as spender, up to its budget, until it expires. It cannot send funds anywhere else. The owner revokes it in one transaction. |
| Someone asks to pair a key they don't hold | Pairing requests are signed by the key itself (P-256), and the beacon checks that the key id is that public key's address. |
| An approval is replayed for another request | The owner's authorization binds the request's random 32-byte **witness** on chain; the beacon and the agent each check the authorization transaction carries it. |
| The beacon lies about an approval | The agent re-reads the authorization transaction and the keychain itself before using the key. |
| The approval page is framed for clickjacking | The site sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`, and passkeys only work from its own origin. |
| The key file is read by another user | It is written `0600` in a `0700` directory, refused if anyone else can read it, and encrypted with scrypt + AES-256-GCM when `TEMPEX_AGENT_PASSPHRASE` is set. |
| The owner cannot see what the agent did | Every step the key signs is attributed from the transaction's own signature envelope; the owner's dashboard shows it with the decoded calls. |
| A failed job open spends budget | `approve`, `createJob` and `fund` go in one Tempo transaction: all or nothing. |

## What the budget measures

Tempo's keychain meters an access key's spending on TIP-20 `transfer` and
`approve`. For an agent that means **raising the escrow's allowance**: approving
30 from 0 costs 30, approving the same 30 again costs nothing, lowering it refunds
nothing, and the escrow pulling funds when a job is funded costs nothing more.
Measured on Moderato with `scripts/budget-probe.ts`. Periodic budgets reset at the
end of each period; the allowance does not.

## Roles and calls

| Role | Escrow calls | Token calls |
|---|---|---|
| buyer | createJob, createJobWithArbiter, createJobWithReferrer, createMilestones, fund, cancel, accept, dispute, + keeper calls | approve, escrow only |
| seller | deliver, respond, + keeper calls | none (zero budget) |
| both | all of the above | approve, escrow only |

Keeper calls are `withdraw` (to the owner's account), `autoAccept`,
`settleLapsed` and `refundExpired`. No role can call an admin or upgrade function.

## Scripts

- `pnpm --filter @tempex/agent test`: pairing signatures, scopes, approval proofs, the key store.
- `scripts/spike.ts`: checks every access-key assumption against Moderato.
- `scripts/budget-probe.ts`: measures how the keychain meters approvals.
