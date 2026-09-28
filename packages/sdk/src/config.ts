import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address, Hex } from 'viem';

export const CHAIN_ID = 42431;
export const RPC_URL = 'https://rpc.moderato.tempo.xyz';
export const WS_URL = 'wss://rpc.moderato.tempo.xyz';
/// Verified live: the bare `explore.tempo.xyz` host serves a shell but 404s on
/// `/tx/<hash>`; the testnet-scoped host resolves Moderato transactions.
export const EXPLORER_URL = 'https://explore.testnet.tempo.xyz';
/// Hosted Tempo fee payer: the app signs the payment, this service signs the fee.
export const SPONSOR_URL = 'https://sponsor.moderato.tempo.xyz';

/// TIP-20 stablecoins predeployed on Moderato. 6 decimals each.
export const TOKENS = {
  pathUsd: '0x20c0000000000000000000000000000000000000',
  alphaUsd: '0x20C0000000000000000000000000000000000001',
  betaUsd: '0x20C0000000000000000000000000000000000002',
  thetaUsd: '0x20C0000000000000000000000000000000000003',
} as const satisfies Record<string, Address>;

export const TOKEN_DECIMALS = 6;

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

export type TempexAddresses = {
  escrow: Address;
  token: Address;
};

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

export function explorerTx(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function tokenAmount(units: string | number, decimals = TOKEN_DECIMALS): bigint {
  const [whole = '0', fraction = ''] = String(units).split('.');
  const padded = fraction.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole + padded);
}

export function formatToken(amount: bigint, decimals = TOKEN_DECIMALS): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}
