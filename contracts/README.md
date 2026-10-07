# TempexEscrow

One escrow for the agent economy. 361 lines of Solidity, no proxies, no upgrade paths, no admin path to user funds. Live on Tempo Moderato (chain 42431) at `0x001c8C3391E591C9CBDFdFE4227e585b86041157` (see `deployments/moderato.json`).

## The ten core operations

**Job lifecycle** — `createJob` · `fund` · `cancel` · `deliver` · `accept` · `autoAccept` · `dispute` · `resolve` · `refundExpired` · `withdraw`

plus views (`getJob`, `nextJobId`, `verdictDigest`) and admin (`setArbiter`, `setTreasury`, `setFees` — capped at 5% platform / 10% arbitration).

## Invariants that matter

- **Custody**: funds move only inside the contract; payouts are pull-based (`withdraw` pays `msg.sender`'s own credits).
- **Bounded settlement**: `resolve` takes `(verdict, signature)`; the signature must recover, under EIP-712, to the arbiter recorded on the job, and the verdict must bind the evidence hash. Anyone may call it — settlement is permissionless.
- **No stuck money**: `refundExpired` (deadline passed, nothing delivered) and `autoAccept` (review window passed, no dispute) are permissionless.
- **No god-mode**: the owner can rotate keys and fees within caps, but can never move a user's funds.

Tempo specifics: fees are TIP-20 transfers to the fee manager, not a gas token — wallet-delta math must account for the fee on every transaction. That is why the contract records amounts, not balances.

## Develop

```bash
forge test     # 25/25
forge build
```

Deploy (see `script/DeployTempex.s.sol`, or `scripts/deploy-escrow.sh` at the repo root):

```bash
forge script script/DeployTempex.s.sol:DeployTempex --rpc-url $TEMPO_RPC_URL --broadcast
```
