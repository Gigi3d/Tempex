import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { getAddress, isAddress, isHash, type Address, type Hex } from 'viem';
import { Actions } from 'viem/tempo';

import {
  KEYCHAIN_ADDRESS,
  PAIRING_TTL_SECONDS,
  keychainEventsAbi,
  pairingProblems,
  provesPairing,
  type AgentRole,
  type PairingRequest,
  type SignedPairingRequest,
} from '@tempex/sdk';

import { BeaconError } from './beacon.js';
import type { ChainReader } from './chain.js';

/// The agent desk: where an agent asks its owner for a key, and where anyone can
/// see an owner's agents.
///
/// It holds no keys and decides nothing. A pairing request must be signed by the
/// key it is for; the owner's approval is an on-chain authorization the desk
/// reads back from the chain, bound to the request by its witness. Agents and
/// owners can both re-check every step against the chain themselves.

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const MAX_PENDING = 500;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 10;
/// How long an approved pairing stays readable, so the agent's poll can find it.
const KEEP_AFTER_APPROVAL_MS = 60 * 60 * 1000;
const AGENTS_CACHE_MS = 4_000;

export type PairingStatus = 'pending' | 'approved' | 'expired';

export type Pairing = {
  code: string;
  status: PairingStatus;
  request: PairingRequest;
  createdAt: number;
  expiresAt: number;
  approval?: { owner: Address; tx: Hex; at: number };
};

type Profile = { name: string; role: AgentRole; owner: Address; pairedAt: string; pairing: string; limit: string; period: number };

export type AgentKey = {
  keyId: Address;
  name: string | null;
  role: AgentRole | null;
  /// The budget per period the pairing asked for (the owner may have granted less;
  /// `remaining` is what the keychain enforces).
  limit: string | null;
  period: number | null;
  keyType: string;
  expiry: number;
  revoked: boolean;
  expired: boolean;
  spendPolicy: string;
  remaining: string | null;
  periodEnd: number | null;
  spent: string;
  authorized: { block: number; tx: Hex };
  revokedAt?: { block: number; tx: Hex };
};

export class AgentDesk {
  private readonly pairings = new Map<string, Pairing>();
  private readonly hits = new Map<string, number[]>();
  private readonly cache = new Map<string, { at: number; value: AgentKey[] }>();
  private profiles: Record<string, Profile>;

  constructor(
    private readonly options: {
      reader: ChainReader;
      chainId: number;
      escrow: Address;
      token: Address;
      fromBlock: bigint;
      chunkBlocks: bigint;
      approveUrl: string;
      profilesFile: string;
    },
  ) {
    this.profiles = existsSync(options.profilesFile)
      ? (JSON.parse(readFileSync(options.profilesFile, 'utf8')) as Record<string, Profile>)
      : {};
  }

  /// Step 1, from the agent: a signed request for a key. Answers with a short
  /// code and the link the owner opens to approve it.
  request(body: unknown, ip: string): { code: string; approveUrl: string; expiresAt: string; request: PairingRequest } {
    this.limitRate(ip);
    this.sweep();
    if (this.pairings.size >= MAX_PENDING) throw new BeaconError('too many pairings in flight; try again shortly', 429);
    const signed = body as SignedPairingRequest;
    const problems = pairingProblems(signed, { chainId: this.options.chainId, escrow: this.options.escrow });
    if (problems.length > 0) throw new BeaconError(`pairing request refused: ${problems.join('; ')}`, 400);
    for (const pairing of this.pairings.values()) {
      if (pairing.status === 'pending' && pairing.request.keyId.toLowerCase() === signed.request.keyId.toLowerCase()) {
        throw new BeaconError(`key ${signed.request.keyId} already has a pairing in flight (${pairing.code})`, 409);
      }
    }
    const code = this.newCode();
    const now = Date.now();
    const pairing: Pairing = {
      code,
      status: 'pending',
      request: { ...signed.request, keyId: getAddress(signed.request.keyId), name: signed.request.name.trim() },
      createdAt: now,
      expiresAt: now + PAIRING_TTL_SECONDS * 1000,
    };
    this.pairings.set(code, pairing);
    return { code: display(code), approveUrl: `${this.options.approveUrl}/${display(code)}`, expiresAt: new Date(pairing.expiresAt).toISOString(), request: pairing.request };
  }

  /// Anyone may read a pairing by its code: it holds a public key, a name and a
  /// budget, never a secret. The owner's page reads it to show what it approves;
  /// the agent polls it to learn when it has an owner.
  get(code: string): Pairing {
    this.sweep();
    const pairing = this.pairings.get(normalize(code));
    if (!pairing) throw new BeaconError('no such pairing, or it expired', 404, 'Ask the agent to run `tempex-agent pair` again.');
    return { ...pairing, code: display(pairing.code) };
  }

  /// Step 3, from the owner's browser after its authorization landed: the desk
  /// reads the transaction itself and records the pairing only if that one
  /// transaction authorized the requested key and bound the request's witness.
  async confirm(code: string, body: Record<string, unknown>): Promise<Pairing> {
    const pairing = this.get(code);
    const stored = this.pairings.get(normalize(code))!;
    if (pairing.status === 'approved') return pairing;
    if (pairing.status !== 'pending') throw new BeaconError('this pairing expired', 410);
    const tx = body['tx'];
    if (typeof tx !== 'string' || !isHash(tx)) throw new BeaconError('body must carry the authorization transaction hash as "tx"', 400);
    const receipt = await this.options.reader.getTransactionReceipt({ hash: tx as Hex }).catch(() => null);
    if (!receipt) throw new BeaconError('that transaction is not on chain yet; confirm again in a moment', 409);
    if (receipt.status !== 'success') throw new BeaconError('that transaction reverted', 400);
    const owner = provesPairing(receipt.logs as never, stored.request);
    if (!owner) {
      throw new BeaconError('that transaction did not authorize this key under this pairing\'s witness', 400);
    }
    stored.status = 'approved';
    stored.approval = { owner, tx: tx as Hex, at: Date.now() };
    stored.expiresAt = Date.now() + KEEP_AFTER_APPROVAL_MS;
    this.profiles[stored.request.keyId.toLowerCase()] = {
      name: stored.request.name,
      // Also a label (the scopes the owner signed are what bind), and only ever a
      // narrowing of what was asked: an agent that asked for both may be granted one.
      role:
        body['role'] === stored.request.role || (stored.request.role === 'both' && (body['role'] === 'buyer' || body['role'] === 'seller'))
          ? (body['role'] as AgentRole)
          : stored.request.role,
      owner,
      pairedAt: new Date().toISOString(),
      pairing: display(stored.code),
      // A display label only (the keychain enforces the real budget), and never
      // above what the agent asked for.
      limit:
        typeof body['limit'] === 'string' && /^\d{1,30}$/.test(body['limit']) && BigInt(body['limit']) <= BigInt(stored.request.limit)
          ? body['limit']
          : stored.request.limit,
      period: stored.request.period,
    };
    this.saveProfiles();
    this.cache.delete(owner.toLowerCase());
    return { ...stored, code: display(stored.code) };
  }

  /// Every key an owner has authorized, read from the keychain's own events and
  /// state: budget left, expiry, revocation, total spent. Names come from
  /// pairings made through this desk; a key authorized elsewhere shows unnamed.
  async agentsOf(ownerRaw: string): Promise<{ owner: Address; agents: AgentKey[] }> {
    if (!isAddress(ownerRaw)) throw new BeaconError('owner must be an address', 400);
    const owner = getAddress(ownerRaw);
    const cached = this.cache.get(owner.toLowerCase());
    if (cached && Date.now() - cached.at < AGENTS_CACHE_MS) return { owner, agents: cached.value };

    const { reader, fromBlock, chunkBlocks, token } = this.options;
    const head = await reader.getBlockNumber();
    const authorized = new Map<string, { block: number; tx: Hex }>();
    const revoked = new Map<string, { block: number; tx: Hex }>();
    const spent = new Map<string, bigint>();
    for (let from = fromBlock; from <= head; from += chunkBlocks) {
      const to = from + chunkBlocks - 1n > head ? head : from + chunkBlocks - 1n;
      const [auths, revokes, spends] = await Promise.all(
        (['KeyAuthorized', 'KeyRevoked', 'AccessKeySpend'] as const).map((name) =>
          reader.getLogs({
            address: KEYCHAIN_ADDRESS,
            event: keychainEventsAbi.find((item) => item.name === name)!,
            args: { account: owner },
            fromBlock: from,
            toBlock: to,
          } as never),
        ),
      );
      for (const log of auths as unknown as { args: { publicKey: Address }; blockNumber: bigint; transactionHash: Hex }[]) {
        authorized.set(log.args.publicKey.toLowerCase(), { block: Number(log.blockNumber), tx: log.transactionHash });
      }
      for (const log of revokes as unknown as { args: { publicKey: Address }; blockNumber: bigint; transactionHash: Hex }[]) {
        revoked.set(log.args.publicKey.toLowerCase(), { block: Number(log.blockNumber), tx: log.transactionHash });
      }
      for (const log of spends as unknown as { args: { publicKey: Address; token: Address; amount: bigint } }[]) {
        if (log.args.token.toLowerCase() !== token.toLowerCase()) continue;
        const key = log.args.publicKey.toLowerCase();
        spent.set(key, (spent.get(key) ?? 0n) + log.args.amount);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const agents = await Promise.all(
      [...authorized.entries()].map(async ([key, stamp]): Promise<AgentKey> => {
        const keyId = getAddress(key);
        const meta = await Actions.accessKey.getMetadata(reader, { account: owner, accessKey: keyId } as never);
        const limit =
          meta.spendPolicy === 'limited' && !meta.isRevoked
            ? await Actions.accessKey.getRemainingLimit(reader, { account: owner, accessKey: keyId, token } as never).catch(() => null)
            : null;
        const profile = this.profiles[key];
        const expiry = Number(meta.expiry);
        return {
          keyId,
          name: profile && profile.owner === owner ? profile.name : null,
          role: profile && profile.owner === owner ? profile.role : null,
          limit: profile && profile.owner === owner ? profile.limit : null,
          period: profile && profile.owner === owner ? profile.period : null,
          keyType: meta.keyType,
          expiry,
          revoked: meta.isRevoked,
          expired: expiry !== 0 && expiry < now,
          spendPolicy: meta.spendPolicy,
          remaining: limit ? limit.remaining.toString() : null,
          periodEnd: limit?.periodEnd ? Number(limit.periodEnd) : null,
          spent: (spent.get(key) ?? 0n).toString(),
          authorized: stamp,
          ...(revoked.has(key) ? { revokedAt: revoked.get(key)! } : {}),
        };
      }),
    );
    agents.sort((a, b) => b.authorized.block - a.authorized.block);
    this.cache.set(owner.toLowerCase(), { at: Date.now(), value: agents });
    return { owner, agents };
  }

  private limitRate(ip: string): void {
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) throw new BeaconError('too many pairing requests from this address; wait a few minutes', 429);
    recent.push(now);
    this.hits.set(ip, recent);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [code, pairing] of this.pairings) {
      if (pairing.expiresAt <= now) {
        if (pairing.status === 'pending') pairing.status = 'expired';
        if (pairing.expiresAt + 5 * 60 * 1000 <= now) this.pairings.delete(code);
      }
    }
  }

  private newCode(): string {
    for (;;) {
      const bytes = randomBytes(8);
      let code = '';
      for (const byte of bytes) code += CODE_ALPHABET[byte % 32];
      if (!this.pairings.has(code)) return code;
    }
  }

  private saveProfiles(): void {
    const file = this.options.profilesFile;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(this.profiles, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
}

function normalize(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

function display(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
