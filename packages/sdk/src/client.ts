import {
  encodeFunctionData,
  decodeEventLog,
  parseAbiItem,
  type Address,
  type Hex,
  type LocalAccount,
  type Transport,
  type TypedDataDomain,
} from 'viem';
import { Account, Addresses, createClient, http, withFeePayer, type Client } from 'viem/tempo';
import { tempoTestnet } from 'viem/tempo/chains';

import { tempexEscrowAbi } from './abi/TempexEscrow.js';
import { tip20Abi } from './abi/TIP20.js';
import { CHAIN_ID, RPC_URL, SPONSOR_URL, type TempexAddresses } from './config.js';
import { tempexDomain, verdictDigest, type VerdictStruct } from './verdict.js';
import {
  milestoneArgs,
  planProblems,
  type MilestoneJobs,
  type MilestonePlan,
} from './milestones.js';

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export const JOB_STATES = [
  'Created',
  'Funded',
  'Delivered',
  'Disputed',
  'Settled',
  'Refunded',
  'Cancelled',
] as const;

export type JobState = (typeof JOB_STATES)[number];

export type Job = {
  buyer: Address;
  seller: Address;
  amount: bigint;
  deliveryDeadline: number;
  reviewWindow: number;
  deliveredAt: number;
  state: JobState;
  termsHash: Hex;
  deliverableHash: Hex;
  disputeHash: Hex;
  verdictHash: Hex;
  /// Unix seconds the buyer opened the dispute; 0 if never disputed.
  disputedAt: number;
  /// Unix seconds the seller pinned its response; 0 if it has not responded.
  respondedAt: number;
  /// Hash of the seller's response bundle; zero if it has not responded.
  responseHash: Hex;
  /// The arbiter this job settles under, fixed when the job was created.
  arbiter: Address;
  /// Fee rates fixed when the job was created; later admin changes do not reach them.
  platformFeeBps: number;
  arbitrationFeeBps: number;
  /// Treasury's share of the arbitration fee; the arbiter gets the rest. 10000
  /// for jobs judged by the house arbiter.
  protocolCutBps: number;
  /// The buyer's offer pinned at dispute: the most it concedes the seller earned.
  buyerOfferBps: number;
  /// The seller's ask pinned in its response: the least it will accept. 10000
  /// until it responds.
  sellerAskBps: number;
};

/// The range an award must fall in, mirroring `TempexEscrow.awardBounds`: between
/// the buyer's offer and the seller's ask. The full range for a job never disputed.
export function awardBounds(job: Job): { lowBps: number; highBps: number } {
  if (job.disputedAt === 0) return { lowBps: 0, highBps: 10_000 };
  return {
    lowBps: Math.min(job.buyerOfferBps, job.sellerAskBps),
    highBps: Math.max(job.buyerOfferBps, job.sellerAskBps),
  };
}

/// An arbiter's self-listing on the escrow.
export type ArbiterListing = {
  active: boolean;
  feeBps: number;
  metadataURI: string;
};

/// How long a seller has, from the dispute, to pin its evidence before the
/// arbiter may rule. Mirrors `TempexEscrow.SELLER_RESPONSE_WINDOW`.
export const SELLER_RESPONSE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/// How long the arbiter has to rule once evidence closes, after which anyone can
/// settle the dispute on an even split. Mirrors `TempexEscrow.ARBITRATION_WINDOW`.
export const ARBITRATION_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/// Bond a buyer posts to dispute, in bps of the job amount. Mirrors
/// `TempexEscrow.DISPUTE_BOND_BPS`.
export const DISPUTE_BOND_BPS = 500;

export function disputeBond(amount: bigint): bigint {
  return (amount * BigInt(DISPUTE_BOND_BPS)) / 10_000n;
}

/// What a ruling pays each side, bond included. A line-for-line mirror of
/// `TempexEscrow.disputeSettlement`, so a receipt can predict the exact credits
/// before the verdict is relayed: loser pays the fee, the buyer's share comes out
/// of its bond first, and the rest of the bond follows the award.
export function disputeSettlement(params: {
  amount: bigint;
  arbitrationFeeBps: number;
  sellerAwardBps: number;
}): {
  bond: bigint;
  arbitrationFee: bigint;
  sellerAmount: bigint;
  buyerAmount: bigint;
  bondToSeller: bigint;
} {
  const BPS = 10_000n;
  const award = BigInt(params.sellerAwardBps);
  const { amount } = params;
  const bond = disputeBond(amount);
  const fee = (amount * BigInt(params.arbitrationFeeBps)) / BPS;
  const sellerGross = (amount * award) / BPS;
  let sellerFee = (fee * (BPS - award)) / BPS;
  let buyerFee = fee - sellerFee;
  if (sellerFee > sellerGross) {
    buyerFee += sellerFee - sellerGross;
    sellerFee = sellerGross;
  }
  const fromBond = buyerFee < bond ? buyerFee : bond;
  buyerFee -= fromBond;
  const buyerGross = amount - sellerGross;
  if (buyerFee > buyerGross) {
    sellerFee += buyerFee - buyerGross;
    buyerFee = buyerGross;
  }
  const bondToSeller = ((bond - fromBond) * award) / BPS;
  return {
    bond,
    arbitrationFee: fee,
    sellerAmount: sellerGross - sellerFee + bondToSeller,
    buyerAmount: buyerGross - buyerFee + (bond - fromBond - bondToSeller),
    bondToSeller,
  };
}

/// When the seller's response deadline falls, or null if the job was never disputed.
export function responseDeadline(job: Job): number | null {
  return job.disputedAt === 0 ? null : job.disputedAt + SELLER_RESPONSE_WINDOW_SECONDS;
}

/// When the evidence record closed (the seller responded, or its window ran
/// out), mirroring `TempexEscrow.evidenceClosedAt`. Null while still open.
export function evidenceClosedAt(job: Job, now: number): number | null {
  if (job.respondedAt !== 0) return job.respondedAt;
  const deadline = responseDeadline(job);
  return deadline !== null && now > deadline ? deadline : null;
}

/// Tempo-only knobs, surfaced rather than hidden because they change what the
/// transaction means: which lane it occupies, how long it stays valid, who pays.
export type WriteOptions = {
  /// Fee-payer lane. Transactions on different lanes do not share a nonce, so a
  /// single account can submit concurrent payments instead of queueing them.
  nonceKey?: bigint;
  /// Unix seconds. Tempo rejects the transaction outside [validAfter, validBefore].
  validBefore?: number;
  validAfter?: number;
  /// Route the fee to a sponsor via the configured fee-payer transport.
  sponsored?: boolean;
};

const JOB_CREATED = parseAbiItem(
  'event JobCreated(uint256 indexed jobId, address indexed buyer, address indexed seller, uint256 amount, bytes32 termsHash, uint64 deliveryDeadline, uint64 reviewWindow)',
);

/// The two transports below (sponsored and direct) have different RPC schemas,
/// so the client is pinned to the base `Transport` type: one stable client type
/// for both, and the Tempo request fields still come from the chain's own
/// `transactionRequest` formatter.
type TempoClient = Client<Transport, typeof tempoTestnet, LocalAccount>;

/// Tempo receipts carry two fields the base receipt does not: the token that paid
/// the fee and, when sponsored, the fee payer's address.
type TempexReceipt = Awaited<ReturnType<TempoClient['waitForTransactionReceipt']>>;

export type TempexClientParams = {
  account: LocalAccount;
  addresses: TempexAddresses;
  /// Token fees are paid in. Every transaction spends stablecoin, never a gas token.
  feeToken?: Address;
  rpcUrl?: string;
  /// Wraps the transport so `sponsored: true` defers the fee to a fee payer.
  sponsorUrl?: string;
};

/// A role-scoped Tempex client. One instance = one agent identity.
export class TempexClient {
  readonly account: LocalAccount;
  readonly addresses: TempexAddresses;
  readonly feeToken: Address;
  private readonly client: TempoClient;

  constructor(params: TempexClientParams) {
    this.account = params.account;
    this.addresses = params.addresses;
    this.feeToken = params.feeToken ?? params.addresses.token;
    const transport: Transport = params.sponsorUrl
      ? withFeePayer(http(params.rpcUrl ?? RPC_URL), http(params.sponsorUrl))
      : http(params.rpcUrl ?? RPC_URL);
    this.client = createClient({
      account: params.account,
      chain: tempoTestnet,
      feeToken: this.feeToken,
      transport,
    });
  }

  get address(): Address {
    return this.account.address;
  }

  get viem(): TempoClient {
    return this.client;
  }

  // ------------------------------------------------------------ primitives

  /// All writes funnel through here: one place that decides the fee token, the
  /// nonce lane, the validity window, and whether a sponsor pays.
  private async send(
    calls: readonly { to: Address; data: Hex }[],
    options: WriteOptions = {},
  ): Promise<TempexReceipt> {
    const hash = await this.client.sendTransaction({
      calls,
      feeToken: this.feeToken,
      ...(options.nonceKey !== undefined ? { nonceKey: options.nonceKey } : {}),
      ...(options.validBefore !== undefined ? { validBefore: options.validBefore } : {}),
      ...(options.validAfter !== undefined ? { validAfter: options.validAfter } : {}),
      ...(options.sponsored ? { feePayer: true } : {}),
    });

    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`transaction reverted: ${hash}`);
    }
    return receipt;
  }

  private call(functionName: string, args: readonly unknown[]): { to: Address; data: Hex } {
    return {
      to: this.addresses.escrow,
      data: encodeFunctionData({
        abi: tempexEscrowAbi,
        functionName: functionName as never,
        args: args as never,
      }),
    };
  }

  private async read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client.readContract({
      address: this.addresses.escrow,
      abi: tempexEscrowAbi,
      functionName: functionName as never,
      args: args as never,
    }) as Promise<T>;
  }

  // ----------------------------------------------------------------- token

  async tokenBalance(account: Address = this.address): Promise<bigint> {
    return this.client.readContract({
      address: this.addresses.token,
      abi: tip20Abi,
      functionName: 'balanceOf',
      args: [account],
    });
  }

  /// Escrow pulls the job amount with `transferFromWithMemo`, so the buyer grants
  /// an allowance first. One allowance covers every job this client opens.
  async approveEscrow(amount: bigint, options: WriteOptions = {}): Promise<TempexReceipt> {
    return this.send(
      [
        {
          to: this.addresses.token,
          data: encodeFunctionData({
            abi: tip20Abi,
            functionName: 'approve',
            args: [this.addresses.escrow, amount],
          }),
        },
      ],
      options,
    );
  }

  async fundWithFaucet(): Promise<unknown> {
    return this.client.faucet.fund({ account: this.address });
  }

  // ------------------------------------------------------------------ jobs

  /// Creates the job and funds it in a single Tempo transaction.
  ///
  /// Two calls, one atomic write: a buyer can never end up with a job that was
  /// created but never funded. This works because the id is predictable —
  /// batched calls cannot read each other's return values, so the client reads
  /// `nextJobId` first and passes it to `fund` explicitly.
  async createAndFundJob(
    params: {
      seller: Address;
      amount: bigint;
      termsHash: Hex;
      deliveryDeadline: number;
      reviewWindow: number;
      /// A listed arbiter to judge this job. Omit for the house arbiter.
      arbiter?: Address;
    },
    options: WriteOptions = {},
  ): Promise<{ jobId: bigint; hash: Hex }> {
    const predicted = await this.nextJobId();
    const common = [
      params.seller,
      params.amount,
      params.termsHash,
      params.deliveryDeadline,
      params.reviewWindow,
    ] as const;
    const receipt = await this.send(
      [
        params.arbiter === undefined
          ? this.call('createJob', [...common])
          : this.call('createJobWithArbiter', [...common, params.arbiter]),
        this.call('fund', [predicted]),
      ],
      options,
    );
    return { jobId: this.createdJobId(receipt, predicted), hash: receipt.transactionHash };
  }

  /// Opens and funds every tranche of a milestone plan in one atomic Tempo
  /// transaction: approve the total, `createMilestones`, then one `fund` per
  /// tranche, each carrying its own job id as the memo. All or nothing.
  async createAndFundMilestones(
    plan: MilestonePlan,
    params: { reviewWindow: number; arbiter?: Address },
    options: WriteOptions = {},
  ): Promise<MilestoneJobs & { hash: Hex }> {
    const problems = planProblems(plan, Math.floor(Date.now() / 1000));
    if (problems.length > 0) throw new Error(`milestone plan rejected: ${problems.join('; ')}`);
    const { planHash, milestones, total } = milestoneArgs(plan);
    const first = await this.nextJobId();
    const jobIds = milestones.map((_, index) => first + BigInt(index));
    const receipt = await this.send(
      [
        {
          to: this.addresses.token,
          data: encodeFunctionData({
            abi: tip20Abi,
            functionName: 'approve',
            args: [this.addresses.escrow, total],
          }),
        },
        this.call('createMilestones', [
          plan.seller as Address,
          planHash,
          milestones,
          params.reviewWindow,
          params.arbiter ?? ZERO_ADDRESS,
        ]),
        ...jobIds.map((jobId) => this.call('fund', [jobId])),
      ],
      options,
    );
    const firstJobId = this.createdJobId(receipt, first);
    return {
      planHash,
      firstJobId,
      jobIds: milestones.map((_, index) => firstJobId + BigInt(index)),
      ...(params.arbiter !== undefined ? { arbiter: params.arbiter } : {}),
      hash: receipt.transactionHash,
    };
  }

  /// The milestone plan a job belongs to; zero for a standalone job.
  async milestonePlanOf(jobId: bigint): Promise<Hex> {
    return this.read<Hex>('milestonePlanOf', [jobId]);
  }

  async fund(jobId: bigint, options: WriteOptions = {}): Promise<TempexReceipt> {
    return this.send([this.call('fund', [jobId])], options);
  }

  /// Commits to the delivered work by hash and, when `uri` is given, records
  /// where it can be fetched so the arbiter can read the real work itself.
  async deliver(
    jobId: bigint,
    deliverableHash: Hex,
    uri = '',
    options: WriteOptions = {},
  ): Promise<TempexReceipt> {
    return this.send([this.call('deliver', [jobId, deliverableHash, uri])], options);
  }

  /// Where the seller said the delivered work lives; empty if it did not say.
  async deliverableURI(jobId: bigint): Promise<string> {
    return this.read<string>('deliverableURI', [jobId]);
  }

  async accept(jobId: bigint, options: WriteOptions = {}): Promise<TempexReceipt> {
    return this.send([this.call('accept', [jobId])], options);
  }

  async autoAccept(jobId: bigint, options: WriteOptions = {}): Promise<TempexReceipt> {
    return this.send([this.call('autoAccept', [jobId])], options);
  }

  /// Opens a dispute. The escrow pulls a bond of 5% of the job amount, so the
  /// allowance for it rides in the same Tempo transaction, ahead of the call.
  ///
  /// `buyerOfferBps` is the buyer's final offer: the most it concedes the seller
  /// has earned. The arbiter's award cannot go below the lower of this and the
  /// seller's ask. 0 concedes nothing.
  async dispute(
    jobId: bigint,
    disputeHash: Hex,
    buyerOfferBps = 0,
    options: WriteOptions = {},
  ): Promise<TempexReceipt> {
    const bond = await this.read<bigint>('disputeBond', [jobId]);
    return this.send(
      [
        {
          to: this.addresses.token,
          data: encodeFunctionData({
            abi: tip20Abi,
            functionName: 'approve',
            args: [this.addresses.escrow, bond],
          }),
        },
        this.call('dispute', [jobId, disputeHash, buyerOfferBps]),
      ],
      options,
    );
  }

  /// Seller pins its evidence that the work was done, inside the response window
  /// a dispute opens, with its final ask: the least it will accept. The arbiter
  /// will not rule until this lands or the window closes.
  async respond(
    jobId: bigint,
    responseHash: Hex,
    sellerAskBps = 10_000,
    options: WriteOptions = {},
  ): Promise<TempexReceipt> {
    return this.send([this.call('respond', [jobId, responseHash, sellerAskBps])], options);
  }

  /// Relays a signed verdict. Permissionless on purpose: whoever holds the
  /// signature can settle, but only the registered arbiter's signature recovers.
  async resolve(
    jobId: bigint,
    verdict: VerdictStruct,
    signature: Hex,
    options: WriteOptions = {},
  ): Promise<TempexReceipt> {
    return this.send(
      [this.call('resolve', [jobId, verdict, signature])],
      options,
    );
  }

  /// Lists this account as an arbiter buyers can name, or updates its fee and
  /// metadata. A fee change reaches only jobs created afterwards.
  async listArbiter(
    feeBps: number,
    metadataURI: string,
    options: WriteOptions = {},
  ): Promise<TempexReceipt> {
    return this.send([this.call('listArbiter', [feeBps, metadataURI])], options);
  }

  async delistArbiter(options: WriteOptions = {}): Promise<TempexReceipt> {
    return this.send([this.call('delistArbiter', [])], options);
  }

  async arbiterListing(arbiter: Address): Promise<ArbiterListing> {
    const [active, feeBps, metadataURI] = await this.read<readonly [boolean, number, string]>(
      'arbiterListings',
      [arbiter],
    );
    return { active, feeBps: Number(feeBps), metadataURI };
  }

  /// Closes a dispute the arbiter never ruled on, on the contract's even split.
  /// Permissionless, like the other liveness escapes.
  async settleLapsed(jobId: bigint, options: WriteOptions = {}): Promise<TempexReceipt> {
    return this.send([this.call('settleLapsed', [jobId])], options);
  }

  async refundExpired(jobId: bigint, options: WriteOptions = {}): Promise<TempexReceipt> {
    return this.send([this.call('refundExpired', [jobId])], options);
  }

  /// Withdraws the caller's credit. The escrow pays out with
  /// `transferWithMemo(..., "tempex.withdraw")`, so the settlement leg is
  /// reconcilable on the token itself, not only in escrow logs.
  async withdraw(options: WriteOptions = {}): Promise<TempexReceipt> {
    return this.send([this.call('withdraw', [])], options);
  }

  // ----------------------------------------------------------------- reads

  async job(jobId: bigint): Promise<Job> {
    const raw = await this.read<unknown>('getJob', [jobId]);
    return decodeJob(raw);
  }

  async jobCount(): Promise<bigint> {
    return this.read<bigint>('jobCount');
  }

  async nextJobId(): Promise<bigint> {
    return this.read<bigint>('nextJobId');
  }

  /// The escrow's own answer to "is the seller's say over?": its response time,
  /// or the end of the window. 0 while the seller can still respond.
  async evidenceClosedAt(jobId: bigint): Promise<number> {
    return Number(await this.read<bigint>('evidenceClosedAt', [jobId]));
  }

  async credits(account: Address = this.address): Promise<bigint> {
    return this.read<bigint>('credits', [account]);
  }

  /// The contract's own digest. Comparing it to the off-chain signature digest
  /// proves the EIP-712 encoding matches before any gas is spent.
  async verdictDigest(verdict: VerdictStruct): Promise<Hex> {
    return this.read<Hex>('verdictDigest', [verdict]);
  }

  /// Digests the verdict twice — once with viem from the SDK's type definition,
  /// once by asking the deployed contract — and reports both. Divergence here is
  /// the failure mode this project cannot afford: an arbiter that signs verdicts
  /// the escrow will not accept.
  async verdictEncoding(
    verdict: VerdictStruct,
  ): Promise<{ local: Hex; onChain: Hex; matches: boolean }> {
    const local = verdictDigest(verdict, domainFor(this.addresses));
    const onChain = await this.verdictDigest(verdict);
    return { local, onChain, matches: local === onChain };
  }

  // --------------------------------------------------------------- helpers

  /// A batched transaction reports the created job across both calls' logs.
  private createdJobId(receipt: TempexReceipt, fallback: bigint): bigint {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.addresses.escrow.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: [JOB_CREATED], data: log.data, topics: log.topics });
        if (decoded.eventName === 'JobCreated') return decoded.args.jobId as bigint;
      } catch {
        // not a JobCreated log; keep scanning
      }
    }
    return fallback;
  }
}

/// Builds a client for a role using its key from the environment.
export function accountFor(privateKey: Hex): LocalAccount {
  return Account.fromSecp256k1(privateKey);
}

/// EIP-712 domain of the deployed escrow: name "Tempex", version "1", and the
/// contract address as the verifying contract. Both parties and the arbiter must
/// derive it the same way, so it is derived here rather than at each call site.
export function domainFor(addresses: TempexAddresses): TypedDataDomain {
  return tempexDomain(CHAIN_ID, addresses.escrow);
}

export type MemoTransfer = {
  from: Address;
  to: Address;
  amount: bigint;
  memo: Hex;
  /// True when the memo encodes a job id (`0x00..01` for job 1), which is how the
  /// escrow tags funding transfers.
  jobId?: bigint;
};

/// Pulls `TransferWithMemo` entries out of a receipt.
///
/// This is the client-side view of the reconciliation key: the payment transfer
/// in the same transaction that created the job already names the job.
export function memoTransfers(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[]): MemoTransfer[] {
  const found: MemoTransfer[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: tip20Abi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'TransferWithMemo') continue;
      const { from, to, amount, memo } = decoded.args;
      const asJobId = BigInt(memo);
      found.push({
        from,
        to,
        amount,
        memo,
        ...(asJobId > 0n && asJobId < 2n ** 64n ? { jobId: asJobId } : {}),
      });
    } catch {
      // not a TransferWithMemo log; keep scanning
    }
  }
  return found;
}

export type FeePayment = {
  payer: Address;
  amount: bigint;
  token: Address;
};

/// Pulls the transaction fee out of a receipt.
///
/// Tempo has no gas token, so the fee is charged as a TIP-20 `Transfer` of the
/// fee token from whoever paid to the fee manager. It sits in the same receipt as
/// the payments it paid for, which means "the fee is a stablecoin transfer" is a
/// fact a client can read rather than a claim it has to trust.
export function feePaid(
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
  feeManager: Address = Addresses.feeManager,
): FeePayment | null {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: tip20Abi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'Transfer') continue;
      const { from, to, amount } = decoded.args;
      if (to.toLowerCase() !== feeManager.toLowerCase()) continue;
      return { payer: from, amount, token: log.address };
    } catch {
      // not a Transfer log; keep scanning
    }
  }
  return null;
}

function decodeJob(raw: unknown): Job {
  const tuple = Array.isArray(raw)
    ? (raw as unknown[])
    : (raw as Record<string, unknown>);
  const at = (index: number, key: string): unknown =>
    Array.isArray(tuple) ? tuple[index] : tuple[key];

  const stateIndex = Number(at(6, 'state'));
  return {
    buyer: at(0, 'buyer') as Address,
    seller: at(1, 'seller') as Address,
    amount: at(2, 'amount') as bigint,
    deliveryDeadline: Number(at(3, 'deliveryDeadline')),
    reviewWindow: Number(at(4, 'reviewWindow')),
    deliveredAt: Number(at(5, 'deliveredAt')),
    state: JOB_STATES[stateIndex] ?? 'Created',
    termsHash: at(7, 'termsHash') as Hex,
    deliverableHash: at(8, 'deliverableHash') as Hex,
    disputeHash: at(9, 'disputeHash') as Hex,
    verdictHash: at(10, 'verdictHash') as Hex,
    disputedAt: Number(at(11, 'disputedAt') ?? 0),
    respondedAt: Number(at(12, 'respondedAt') ?? 0),
    responseHash: (at(13, 'responseHash') ?? ZERO_BYTES32) as Hex,
    arbiter: (at(14, 'arbiter') ?? ZERO_ADDRESS) as Address,
    platformFeeBps: Number(at(15, 'platformFeeBps') ?? 0),
    arbitrationFeeBps: Number(at(16, 'arbitrationFeeBps') ?? 0),
    protocolCutBps: Number(at(17, 'protocolCutBps') ?? 0),
    buyerOfferBps: Number(at(18, 'buyerOfferBps') ?? 0),
    sellerAskBps: Number(at(19, 'sellerAskBps') ?? 10_000),
  };
}

export function jobStateIndex(state: JobState): number {
  return JOB_STATES.indexOf(state);
}
