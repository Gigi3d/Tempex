import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address } from 'viem';

import {
  CHAIN_ID,
  EXPLORER_URL,
  RPC_URL,
  SPONSOR_URL,
  TOKENS,
  addressesFromEnv,
  loadEnv,
  tokenAmount,
} from '@tempex/sdk';

/// Block the escrow was deployed at. Nothing before it can mention Tempex, so the
/// indexer treats it as the genesis of its own history and never scans further back.
export const DEPLOYMENT_BLOCK = 37_010_916n;

/// Default price of a paid discovery query, in alphaUSD.
///
/// Not a revenue model — a spam price. An agent asking "who can do X" costs the
/// beacon a full event scan, so the query is priced at roughly twenty transaction
/// fees. Free tiers stay free: manifest, stats, reputation, onboarding.
export const DEFAULT_DISCOVERY_PRICE = '0.01';

/// Blocks per `eth_getLogs` request.
///
/// Moderato rejects a range wider than `MAX_SCAN_CHUNK_BLOCKS` with "query exceeds
/// max block range", so the default sits comfortably under it. A cold start still
/// catches up in a handful of requests, and a beacon that was offline for a week
/// degrades into more requests rather than one call that fails the whole index.
export const DEFAULT_SCAN_CHUNK_BLOCKS = 50_000n;

/// The widest range a single `eth_getLogs` may ask Moderato for.
export const MAX_SCAN_CHUNK_BLOCKS = 100_000n;

export type BeaconConfig = {
  /// What the manifest calls itself. Agents match on this, so it is config, not code.
  name: string;
  version: string;
  /// Public origin agents should call back on. Distinct from the listen address so a
  /// beacon behind a tunnel or proxy advertises the right URL.
  host: string;
  listen: string;
  port: number;

  chainId: number;
  network: string;
  rpcUrl: string;
  explorerUrl: string;
  /// Tempo's hosted fee payer. Its presence is what makes zero-balance onboarding real.
  sponsorUrl: string | null;

  escrow: Address;
  token: Address;
  /// Where discovery fees go. Empty means the beacon serves discovery for free.
  treasury: Address | null;
  discoveryPrice: bigint;

  /// Blocks per `eth_getLogs` request. Clamped to `MAX_SCAN_CHUNK_BLOCKS`, the widest
  /// range Moderato will serve, so a misconfigured beacon cannot fail its own index.
  scanChunkBlocks: bigint;
  indexFromBlock: bigint;

  /// Signed agent registrations. A plain JSON file: the signatures are the trust
  /// anchor, so the file can be copied between beacon instances without loss.
  dataDir: string;
  registryFile: string;

  /// How long a registration challenge stays valid. Short enough that a captured
  /// challenge cannot be replayed after the agent notices.
  challengeTtlSeconds: number;
};

export function beaconConfigFromEnv(repoRoot: string = process.cwd()): BeaconConfig {
  loadEnv(repoRoot);
  const addresses = addressesFromEnv();
  const port = Number(process.env['BEACON_PORT'] ?? 8787);
  const listen = process.env['BEACON_LISTEN'] ?? '127.0.0.1';
  const dataDir = resolve(process.env['BEACON_DATA_DIR'] ?? resolve(root(repoRoot), '.beacon'));

  return {
    name: process.env['BEACON_NAME'] ?? 'Tempex Beacon',
    version: process.env['BEACON_VERSION'] ?? '0.1.0',
    host: stripTrailingSlash(process.env['BEACON_HOST'] ?? `http://${listen}:${port}`),
    listen,
    port,

    chainId: CHAIN_ID,
    network: process.env['BEACON_NETWORK'] ?? 'tempo:moderato',
    rpcUrl: process.env['TEMPO_RPC_URL'] ?? RPC_URL,
    explorerUrl: EXPLORER_URL,
    sponsorUrl: process.env['BEACON_SPONSOR_URL'] ?? SPONSOR_URL,

    escrow: addresses.escrow,
    token: (process.env['TEMPEX_TOKEN'] as Address) ?? addresses.token ?? TOKENS.alphaUsd,
    treasury: (process.env['BEACON_TREASURY'] ?? process.env['TEMPEX_TREASURY'] ?? '') as Address,
    discoveryPrice: tokenAmount(process.env['BEACON_DISCOVERY_PRICE'] ?? DEFAULT_DISCOVERY_PRICE),

    scanChunkBlocks: scanChunkBlocks(process.env['BEACON_SCAN_CHUNK_BLOCKS']),
    indexFromBlock: BigInt(process.env['TEMPEX_INDEX_FROM_BLOCK'] ?? DEPLOYMENT_BLOCK),

    dataDir,
    registryFile: resolve(dataDir, process.env['BEACON_REGISTRY_FILE'] ?? 'registry.json'),
    challengeTtlSeconds: Number(process.env['BEACON_CHALLENGE_TTL'] ?? 300),
  };
}

/// Clamps an operator-supplied scan chunk to something the RPC will actually serve.
///
/// Too wide and every `eth_getLogs` is rejected outright; zero or negative and the
/// scanner's block loop never advances. Both are silent ways to break the index.
function scanChunkBlocks(raw: string | undefined): bigint {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SCAN_CHUNK_BLOCKS;
  const value = BigInt(raw.trim());
  if (value < 1n) return DEFAULT_SCAN_CHUNK_BLOCKS;
  return value > MAX_SCAN_CHUNK_BLOCKS ? MAX_SCAN_CHUNK_BLOCKS : value;
}

/// Loads the repo `.env` from either the package directory or the workspace root.
function root(repoRoot: string): string {
  return existsSync(resolve(repoRoot, '.env')) ? repoRoot : resolve(repoRoot, '../..');
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function endpoint(config: BeaconConfig, path: string): string {
  return `${config.host}${path.startsWith('/') ? path : `/${path}`}`;
}

export function ensureDataDir(config: BeaconConfig): void {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
}
