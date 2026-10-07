#!/usr/bin/env bash
# Deploy TempexEscrow to Tempo Moderato.
#
# Delegates to packages/sdk/scripts/deploy.ts, which sends the creation as a
# Tempo type-0x76 transaction paid in the payment token, then verifies the live
# runtime against the forge build and reads every constructor setting back.
# Stock forge can do neither the transaction type nor the fee token, and
# `forge script` underestimates Tempo's creation gas (see deployments notes).
#
# Env (in .env or the shell): DEPLOYER_KEY, TEMPEX_OWNER, TEMPEX_ARBITER,
# TEMPEX_TREASURY, optional TEMPEX_TOKEN and fee bps. Flags pass through:
#   --faucet  fund the deployer from the testnet faucet first
#   --dry     stop after preflight
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm deploy:escrow "$@"
