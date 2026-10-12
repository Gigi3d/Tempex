import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { recoverMessageAddress, toHex, type Address, type Hex } from 'viem';

import type { Reputation } from './reputation.js';

export type RegistryRole = 'seller' | 'buyer' | 'arbiter' | 'relay';

export type RegistryEntry = {
  address: Address;
  name: string;
  /// One paragraph an agent reads to decide whether to hire this one.
  agent: string;
  role: RegistryRole;
  capabilities: string[];
  /// Where the agent can actually be reached. Optional: plenty of agents only
  /// listen to the chain.
  endpoint?: string;
  payment: {
    tokens: Address[];
    minAmount?: string;
    maxAmount?: string;
  };
  policy: {
    templateId: string;
    deliveryDeadlineSeconds: number;
    reviewWindowSeconds: number;
  };
  /// What this agent agrees to be settled by, which is the whole point of listing.
  accepts: {
    arbitration: string;
    escrow: Address;
    network: string;
  };
  registeredAt: string;
  challenge: string;
  message: string;
  signature: Hex;
};

export type RegistryListing = RegistryEntry & {
  rank: number;
  reputation: Pick<Reputation, 'score' | 'band'> & { settled: number; disputesAgainst: number };
};

export type Challenge = {
  address: Address;
  challenge: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
};

export type ChallengeParams = {
  host: string;
  escrow: Address;
  network: string;
  ttlSeconds: number;
};

/// The exact bytes an agent signs to prove it controls an address.
///
/// Human-readable and bound to this beacon, this escrow, and an expiry, so a
/// captured signature cannot be replayed against another beacon or reused after
/// the window closes.
export function challengeMessage(params: {
  host: string;
  address: Address;
  escrow: Address;
  network: string;
  challenge: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return [
    'Register with Tempex Beacon',
    `beacon: ${params.host}`,
    `network: ${params.network}`,
    `escrow: ${params.escrow}`,
    `address: ${params.address}`,
    `issued: ${params.issuedAt}`,
    `expires: ${params.expiresAt}`,
    `challenge: ${params.challenge}`,
  ].join('\n');
}

export type RegisterInput = {
  entry: Omit<RegistryEntry, 'registeredAt' | 'challenge' | 'message' | 'signature'>;
  challenge: string;
  issuedAt: string;
  expiresAt: string;
  signature: Hex;
};

export type RegisterResult =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; reason: string };

type RegistryFile = { version: 1; entries: RegistryEntry[] };

/// Signed agent registrations, stored as a plain JSON file.
///
/// The signature is the trust anchor and it travels with the entry, so a registry
/// can be copied between beacon instances, published, or audited without any of
/// them being able to forge a listing. The beacon holds no keys.
export class Registry {
  private entries: RegistryEntry[] = [];
  private readonly pending = new Map<string, Challenge>();

  constructor(
    private readonly file: string,
    private readonly params: ChallengeParams,
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as RegistryFile;
      this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      // A corrupt registry must not take the beacon down; it serves an empty one
      // and the next registration rewrites the file.
      this.entries = [];
    }
  }

  private persist(): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload: RegistryFile = { version: 1, entries: this.entries };
    writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  issueChallenge(address: Address): Challenge {
    const challenge = toHex(randomBytes(16));
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + this.params.ttlSeconds * 1000);
    const message = challengeMessage({
      host: this.params.host,
      address,
      escrow: this.params.escrow,
      network: this.params.network,
      challenge,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const record: Challenge = {
      address,
      challenge,
      message,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.pending.set(challenge, record);
    return record;
  }

  /// Verifies the signature and records the entry. One challenge, one use.
  async register(input: RegisterInput): Promise<RegisterResult> {
    const pending = this.pending.get(input.challenge);
    if (!pending) {
      return { ok: false, reason: 'unknown or already-used challenge; request a new one from /registry/challenge' };
    }
    this.pending.delete(input.challenge);

    if (Date.now() > Date.parse(pending.expiresAt)) {
      return { ok: false, reason: `challenge expired at ${pending.expiresAt}` };
    }
    if (pending.address.toLowerCase() !== input.entry.address.toLowerCase()) {
      return {
        ok: false,
        reason: `challenge was issued for ${pending.address}, registration names ${input.entry.address}`,
      };
    }

    const message = challengeMessage({
      host: this.params.host,
      address: input.entry.address,
      escrow: this.params.escrow,
      network: this.params.network,
      challenge: input.challenge,
      issuedAt: pending.issuedAt,
      expiresAt: pending.expiresAt,
    });

    let signer: Address;
    try {
      signer = await recoverSigner(message, input.signature);
    } catch (error) {
      return { ok: false, reason: `signature is not a valid personal_sign over the challenge: ${describe(error)}` };
    }
    if (signer.toLowerCase() !== input.entry.address.toLowerCase()) {
      return {
        ok: false,
        reason: `signature recovers to ${signer}, not to the registered address ${input.entry.address}`,
      };
    }

    const entry: RegistryEntry = {
      ...input.entry,
      registeredAt: new Date().toISOString(),
      challenge: input.challenge,
      message,
      signature: input.signature,
    };

    this.entries = this.entries.filter(
      (existing) => existing.address.toLowerCase() !== entry.address.toLowerCase(),
    );
    this.entries.push(entry);
    this.persist();
    return { ok: true, entry };
  }

  get(address: Address): RegistryEntry | undefined {
    const target = address.toLowerCase();
    return this.entries.find((entry) => entry.address.toLowerCase() === target);
  }

  all(): RegistryEntry[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }

  /// The whole file, so one beacon can seed another without trusting it.
  exportFile(): RegistryFile {
    return { version: 1, entries: this.all() };
  }

  async importFile(payload: RegistryFile): Promise<{ added: number; rejected: number }> {
    let added = 0;
    let rejected = 0;
    for (const entry of payload.entries ?? []) {
      if (!(await verifyEntry(entry))) {
        rejected += 1;
        continue;
      }
      this.entries = this.entries.filter(
        (existing) => existing.address.toLowerCase() !== entry.address.toLowerCase(),
      );
      this.entries.push(entry);
      added += 1;
    }
    if (added) this.persist();
    return { added, rejected };
  }
}

/// Re-checks a listing's signature. Anyone can run this on an exported registry,
/// which is what makes the file portable rather than merely copyable.
export async function verifyEntry(entry: RegistryEntry): Promise<boolean> {
  try {
    const signer = await recoverSigner(entry.message, entry.signature);
    return signer.toLowerCase() === entry.address.toLowerCase();
  } catch {
    return false;
  }
}

function recoverSigner(message: string, signature: Hex): Promise<Address> {
  return recoverMessageAddress({ message, signature });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ discovery

export type DiscoveryFilter = {
  capability?: string;
  role?: RegistryRole;
  minScore?: number;
  limit?: number;
};

/// Ranks listings by on-chain history, not by who registered first or who paid.
///
/// Ranking on reputation is what makes the registry worth joining: the reward for
/// settling cleanly is discoverability, and it cannot be bought.
export function rankEntries(
  entries: RegistryEntry[],
  filter: DiscoveryFilter,
  reputationOf: (address: Address) => Pick<Reputation, 'score' | 'band' | 'counters'>,
): RegistryListing[] {
  const wanted = filter.capability?.toLowerCase().trim();
  const matched = entries.filter((entry) => {
    if (filter.role && entry.role !== filter.role) return false;
    if (!wanted) return true;
    return (
      entry.capabilities.some((capability) => capability.toLowerCase().includes(wanted)) ||
      entry.name.toLowerCase().includes(wanted) ||
      entry.agent.toLowerCase().includes(wanted)
    );
  });

  const listings = matched.map((entry) => {
    const reputation = reputationOf(entry.address);
    return {
      ...entry,
      rank: 0,
      reputation: {
        score: reputation.score,
        band: reputation.band,
        settled: reputation.counters.settled,
        disputesAgainst: reputation.counters.disputesAgainst,
      },
    };
  });

  const ranked = listings
    .filter((listing) => (filter.minScore ?? 0) <= listing.reputation.score)
    .sort(
      (a, b) =>
        b.reputation.score - a.reputation.score ||
        b.reputation.settled - a.reputation.settled ||
        a.registeredAt.localeCompare(b.registeredAt),
    )
    .slice(0, filter.limit ?? 25);

  return ranked.map((listing, index) => ({ ...listing, rank: index + 1 }));
}
