import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address, Hex } from 'viem';

import { TOKENS, type TempexAddresses } from './chain.js';

export type { TempexAddresses } from './chain.js';

export {
  CHAIN_ID,
  RPC_URL,
  WS_URL,
  EXPLORER_URL,
  SPONSOR_URL,
  TOKENS,
  TOKEN_DECIMALS,
  explorerTx,
  explorerAddress,
  tokenAmount,
  formatToken,
} from './chain.js';

/// Loads the repo `.env` into process.env. Node's own loader, no dotenv dependency.
/// Tolerates a missing file so the SDK stays usable without one.
export function loadEnv(repoRoot: string = process.cwd()): void {
  for (const candidate of [resolve(repoRoot, '.env'), resolve(repoRoot, '../../.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env var ${name} (see .env.example)`);
  return value;
}

/// Reads the deployed addresses from the environment so every package points at
/// the same escrow. Single source of truth: .env, written by scripts/deploy-escrow.sh.
export function addressesFromEnv(): TempexAddresses {
  return {
    escrow: required('TEMPEX_ESCROW') as Address,
    token: (process.env['TEMPEX_TOKEN'] as Address) ?? TOKENS.alphaUsd,
  };
}

export type Role = 'deployer' | 'buyer' | 'seller' | 'arbiter';

/// Role keypairs live only in the gitignored .env; they are never logged.
export function privateKeyFor(role: Role): Hex {
  const name = `${role.toUpperCase()}_KEY`;
  return required(name) as Hex;
}

export function addressFor(role: Role): Address {
  return required(`${role.toUpperCase()}_ADDRESS`) as Address;
}
