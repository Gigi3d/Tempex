import { decodeEventLog, decodeFunctionData, getAddress, isHash, parseAbi, type Abi, type Address, type Hex } from 'viem';

import { KEYCHAIN_ADDRESS, keychainEventsAbi, tempexEscrowAbi, tip20Abi } from '@tempex/sdk';

import { BeaconError } from './beacon.js';
import type { ChainReader } from './chain.js';
import type { JobRecord } from './ledger.js';

/// Reads a Tempo transaction back from the chain and says, in plain fields, what
/// it did and who signed it.
///
/// Tempo transactions carry the signer in the envelope: a root key signs as the
/// account itself, an access key signs as `keychain` with its `keyId` and the
/// account it acts for. That is how an owner's dashboard can say "your agent
/// translator-bot delivered this" rather than just "you did": it is read from
/// the signature, not from anything an agent reported about itself.

export type Signer = {
  /// The account the transaction acts as (the escrow's msg.sender).
  account: Address;
  /// 'access-key': an agent key under `account`. 'root': the account's own key.
  kind: 'access-key' | 'root';
  keyId: Address | null;
  /// p256 (a P-256 key, as agents use), webAuthn (a passkey), secp256k1.
  signatureType: string;
};

export type DecodedCall = { to: Address; contract: string; function: string | null; args: Record<string, unknown> | null; selector: Hex };
export type DecodedEvent = { address: Address; contract: string; event: string | null; args: Record<string, unknown> | null; logIndex: number };

export type InspectedTx = {
  hash: Hex;
  status: 'success' | 'reverted';
  block: number;
  timestamp: number;
  signer: Signer;
  /// Who paid the fee: a sponsor, or the account itself.
  feePayer: Address | null;
  sponsored: boolean;
  feeToken: Address | null;
  gasUsed: string;
  nonceKey: string | null;
  validBefore: number | null;
  calls: DecodedCall[];
  events: DecodedEvent[];
};

const MAX_CACHED = 5_000;

/// The SDK's TIP-20 ABI carries what Tempex calls; reading receipts back also
/// needs the token's Approval event.
const TOKEN_ABI = [...tip20Abi, ...parseAbi(['event Approval(address indexed owner, address indexed spender, uint256 amount)'])] as Abi;
const CONCURRENCY = 6;

export class TxInspector {
  /// Mined transactions never change, so a lookup is cached for good (bounded).
  private readonly cache = new Map<string, InspectedTx>();

  constructor(
    private readonly reader: ChainReader,
    private readonly known: { escrow: Address; token: Address },
  ) {}

  async inspect(hash: string): Promise<InspectedTx> {
    if (!isHash(hash)) throw new BeaconError('a transaction is addressed by its 32-byte hash', 400);
    const key = hash.toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;

    const request = this.reader.request as unknown as (args: { method: string; params: unknown[] }) => Promise<unknown>;
    const [tx, receipt] = (await Promise.all([
      request({ method: 'eth_getTransactionByHash', params: [hash] }),
      request({ method: 'eth_getTransactionReceipt', params: [hash] }),
    ])) as [RpcTx | null, RpcReceipt | null];
    if (!tx || !receipt) throw new BeaconError(`transaction ${hash} is not on chain (yet)`, 404);

    const inspected: InspectedTx = {
      hash: hash as Hex,
      status: receipt.status === '0x1' ? 'success' : 'reverted',
      block: Number(BigInt(receipt.blockNumber)),
      timestamp: Number(BigInt(tx.blockTimestamp ?? '0x0')),
      signer: signerOf(tx),
      feePayer: receipt.feePayer ? getAddress(receipt.feePayer) : null,
      sponsored: !!receipt.feePayer && receipt.feePayer.toLowerCase() !== tx.from.toLowerCase(),
      feeToken: receipt.feeToken ? getAddress(receipt.feeToken) : tx.feeToken ? getAddress(tx.feeToken) : null,
      gasUsed: BigInt(receipt.gasUsed).toString(),
      nonceKey: tx.nonceKey ?? null,
      validBefore: tx.validBefore ? Number(BigInt(tx.validBefore)) : null,
      calls: (tx.calls ?? (tx.to ? [{ to: tx.to, input: tx.input ?? '0x' }] : [])).map((call) => this.decodeCall(call)),
      events: receipt.logs.map((log) => this.decodeLog(log)),
    };
    if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, inspected);
    return inspected;
  }

  /// Many at once, a few in flight at a time. A transaction that cannot be read
  /// is left out rather than failing the batch.
  async inspectMany(hashes: readonly Hex[]): Promise<Map<string, InspectedTx>> {
    const unique = [...new Set(hashes.map((hash) => hash.toLowerCase()))];
    const out = new Map<string, InspectedTx>();
    let next = 0;
    const worker = async () => {
      while (next < unique.length) {
        const hash = unique[next++]!;
        try {
          out.set(hash, await this.inspect(hash));
        } catch {
          // unreadable just now; the next request tries again
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
    return out;
  }

  private contract(address: string): { name: string; abi: Abi | null } {
    const lower = address.toLowerCase();
    if (lower === this.known.escrow.toLowerCase()) return { name: 'TempexEscrow', abi: tempexEscrowAbi as Abi };
    if (lower === this.known.token.toLowerCase()) return { name: 'TIP-20', abi: TOKEN_ABI };
    if (lower === KEYCHAIN_ADDRESS.toLowerCase()) return { name: 'AccountKeychain', abi: keychainEventsAbi as Abi };
    if (lower.startsWith('0x20c0')) return { name: 'TIP-20', abi: TOKEN_ABI };
    return { name: 'unknown', abi: null };
  }

  private decodeCall(call: { to: string; input?: string; data?: string }): DecodedCall {
    const data = (call.input ?? call.data ?? '0x') as Hex;
    const { name, abi } = this.contract(call.to);
    const base = { to: getAddress(call.to), contract: name, selector: data.slice(0, 10) as Hex };
    if (!abi) return { ...base, function: null, args: null };
    try {
      const decoded = decodeFunctionData({ abi, data });
      return { ...base, function: decoded.functionName, args: named(abi, 'function', decoded.functionName, decoded.args ?? []) };
    } catch {
      return { ...base, function: null, args: null };
    }
  }

  private decodeLog(log: { address: string; data: Hex; topics: Hex[]; logIndex: string }): DecodedEvent {
    const { name, abi } = this.contract(log.address);
    const base = { address: getAddress(log.address), contract: name, logIndex: Number(BigInt(log.logIndex)) };
    if (!abi) return { ...base, event: null, args: null };
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      return { ...base, event: decoded.eventName ?? null, args: plain(decoded.args) as Record<string, unknown> };
    } catch {
      return { ...base, event: null, args: null };
    }
  }
}

type RpcTx = {
  from: string;
  to?: string | null;
  input?: string;
  calls?: { to: string; input?: string; data?: string }[];
  blockTimestamp?: string;
  feeToken?: string | null;
  nonceKey?: string;
  validBefore?: string | null;
  signature?: {
    type?: string;
    userAddress?: string;
    keyId?: string;
    signature?: { type?: string };
  } | null;
};

type RpcReceipt = {
  status: string;
  blockNumber: string;
  gasUsed: string;
  feePayer?: string | null;
  feeToken?: string | null;
  logs: { address: string; data: Hex; topics: Hex[]; logIndex: string }[];
};

/// A keychain envelope names the account it acts for and the key that signed; any
/// other envelope is the account's own key.
export function signerOf(tx: Pick<RpcTx, 'from' | 'signature'>): Signer {
  const signature = tx.signature ?? null;
  const account = getAddress(signature?.userAddress ?? tx.from);
  if (signature?.keyId) {
    return { account, kind: 'access-key', keyId: getAddress(signature.keyId), signatureType: signature.signature?.type ?? 'p256' };
  }
  return { account, kind: 'root', keyId: null, signatureType: signature?.type ?? 'secp256k1' };
}

/// Positional ABI arguments, keyed by their parameter names.
function named(abi: Abi, type: 'function', name: string, args: readonly unknown[]): Record<string, unknown> {
  const item = abi.find((entry) => entry.type === type && 'name' in entry && entry.name === name && 'inputs' in entry && entry.inputs.length === args.length);
  const inputs = item && 'inputs' in item ? item.inputs : [];
  return Object.fromEntries(args.map((value, index) => [inputs[index]?.name || `arg${index}`, plain(value)]));
}

/// JSON-safe: bigints become decimal strings.
function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

// ------------------------------------------------------------------ activity

export type Step =
  | 'created'
  | 'funded'
  | 'delivered'
  | 'accepted'
  | 'disputed'
  | 'responded'
  | 'ruled'
  | 'refunded'
  | 'cancelled'
  | 'settled-lapsed'
  | 'withdrew';

export type ActivityEntry = {
  jobId: string | null;
  step: Step;
  tx: Hex;
  block: number;
  timestamp: number | null;
  /// The address's side of the job, when the entry is about a job.
  side: 'buyer' | 'seller' | null;
  /// Who signed. `self` is true when the address itself acted (by its own key or
  /// one of its agents); false when a third party did (a relayer, a keeper).
  signer: Signer | null;
  self: boolean;
};

type Ref = { block: number | bigint; tx: Hex };

/// Every step a job took, with the transaction that took it.
export function stepsOf(job: JobRecord): { step: Step; ref: Ref }[] {
  const steps: { step: Step; ref: Ref | undefined }[] = [
    { step: 'created', ref: job.created as Ref | undefined },
    { step: 'funded', ref: job.funded as Ref | undefined },
    { step: 'delivered', ref: job.delivered as Ref | undefined },
    { step: 'accepted', ref: job.accepted as Ref | undefined },
    { step: 'disputed', ref: job.dispute as Ref | undefined },
    { step: 'responded', ref: job.response as Ref | undefined },
    { step: 'ruled', ref: job.verdict as Ref | undefined },
    { step: 'refunded', ref: job.refund as Ref | undefined },
    { step: 'cancelled', ref: job.cancelled as Ref | undefined },
    { step: 'settled-lapsed', ref: job.lapsed as Ref | undefined },
  ];
  return steps.filter((entry): entry is { step: Step; ref: Ref } => !!entry.ref?.tx);
}

const MAX_ACTIVITY = 200;

/// What an address did on Tempex, step by step, with the signer of every step read
/// from its transaction. An owner's agents show up here by key id: the dashboard
/// groups by it, so each agent gets its own history without reporting anything.
export async function activityOf(
  inspector: TxInspector,
  address: Address,
  jobs: readonly JobRecord[],
  withdrawals: readonly { account: Address; amount: bigint; block: number; tx: Hex }[],
): Promise<{ address: Address; count: number; entries: ActivityEntry[]; byKey: Record<string, number> }> {
  const lower = address.toLowerCase();
  const pending: { jobId: string | null; step: Step; ref: Ref; side: ActivityEntry['side'] }[] = [];
  for (const job of jobs) {
    const side = job.buyer.toLowerCase() === lower ? 'buyer' : job.seller.toLowerCase() === lower ? 'seller' : null;
    if (!side) continue;
    for (const { step, ref } of stepsOf(job)) pending.push({ jobId: job.jobId.toString(), step, ref, side });
  }
  for (const withdrawal of withdrawals) {
    if (withdrawal.account.toLowerCase() === lower) pending.push({ jobId: null, step: 'withdrew', ref: withdrawal, side: null });
  }
  pending.sort((a, b) => Number(b.ref.block) - Number(a.ref.block));
  const recent = pending.slice(0, MAX_ACTIVITY);
  const inspected = await inspector.inspectMany(recent.map((entry) => entry.ref.tx));

  const byKey: Record<string, number> = {};
  const entries = recent.map((entry): ActivityEntry => {
    const tx = inspected.get(entry.ref.tx.toLowerCase());
    const signer = tx?.signer ?? null;
    const self = signer?.account.toLowerCase() === lower;
    if (self && signer) {
      const key = signer.keyId ?? 'root';
      byKey[key] = (byKey[key] ?? 0) + 1;
    }
    return {
      jobId: entry.jobId,
      step: entry.step,
      tx: entry.ref.tx,
      block: Number(entry.ref.block),
      timestamp: tx?.timestamp ?? null,
      side: entry.side,
      signer,
      self,
    };
  });
  return { address: getAddress(address), count: entries.length, entries, byKey };
}
