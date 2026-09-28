#!/usr/bin/env bash
# Deploy TempexEscrow to Tempo Moderato.
#
# Why not `forge script`: forge script ignores --gas-limit for the broadcast and sends with
# its own estimate (2.85M for this contract). Tempo prices contract creation far above the
# EVM default (measured: ~11.0M gas for 13,090 bytes of runtime code), so the tx reverts
# out of gas. `forge create` honors --gas-limit.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
. ./.env
set +a

: "${TEMPO_RPC_URL:?set TEMPO_RPC_URL in .env}"
: "${DEPLOYER_KEY:?set DEPLOYER_KEY in .env}"
: "${DEPLOYER_ADDRESS:?set DEPLOYER_ADDRESS in .env}"
: "${TEMPEX_TOKEN:?set TEMPEX_TOKEN in .env}"
: "${TEMPEX_ARBITER:?set TEMPEX_ARBITER in .env}"
: "${TEMPEX_TREASURY:?set TEMPEX_TREASURY in .env}"

forge create src/TempexEscrow.sol:TempexEscrow \
  --root contracts \
  --rpc-url "$TEMPO_RPC_URL" \
  --private-key "$DEPLOYER_KEY" \
  --broadcast \
  --gas-limit "${DEPLOY_GAS_LIMIT:-20000000}" \
  --tempo.fee-token "$TEMPEX_TOKEN" \
  --constructor-args \
    "$TEMPEX_TOKEN" \
    "$DEPLOYER_ADDRESS" \
    "$TEMPEX_ARBITER" \
    "$TEMPEX_TREASURY" \
    "${TEMPEX_PLATFORM_FEE_BPS:-50}" \
    "${TEMPEX_ARBITRATION_FEE_BPS:-200}"
