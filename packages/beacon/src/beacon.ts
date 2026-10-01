import { resolve } from 'node:path';
import type { Address, Hex } from 'viem';

import { disputeBond, hashCanonical, hashText, tempexEscrowAbi, tip20Abi, tokenAmount } from '@tempex/sdk';

import {
  blueprintAccept,
  blueprintApprove,
  blueprintAutoAccept,
  blueprintCreateAndFund,
  blueprintDeliver,
  blueprintDispute,
  blueprintRespond,
  blueprintRefundExpired,
  blueprintSettleLapsed,
  blueprintListArbiter,
  blueprintDelistArbiter,
  blueprintResolve,
  blueprintWithdraw,
  type Blueprint,
  type BlueprintContext,
} from './blueprint.js';
import {
  escrowConfig,
  headBlock,
  measureFee,
  openChain,
  tokenInfo,
  type ChainReader,
  type EscrowConfig,
  type TokenInfo,
} from './chain.js';
import { beaconConfigFromEnv, ensureDataDir, type BeaconConfig } from './config.js';
import { EscrowLedger, type JobRecord, type JobStage, type LedgerView } from './ledger.js';
import { agentCard, buildManifest, type Manifest } from './manifest.js';
import {
  POLICY_TEMPLATES,
  onboardingPlan,
  policyById,
  quote,
  readiness,
  type OnboardingPlan,
  type PolicyTemplate,
  type Quote,
  type ReadinessReport,
  type Role,
} from './onboard.js';
import {
  PaymentGate,
  type PaymentQuote,
  type PaymentRequirement,
  type SettleResult,
  type Settlement,
} from './payments.js';
import {
  Registry,
  rankEntries,
  type Challenge,
  type DiscoveryFilter,
  type RegisterInput,
  type RegisterResult,
  type RegistryEntry,
  type RegistryListing,
} from './registry.js';
import { money, networkStats, reputationFor, type Money, type NetworkStats, type Reputation } from './reputation.js';

/// Governance reads are cheap but not free. Cached briefly so a burst of agent
/// traffic does not turn into a burst of `eth_call`s, and short enough that an
/// owner changing the arbiter shows up within a minute.
const PROTOCOL_TTL_MS = 60_000;

export type ProtocolState = {
  escrow: EscrowConfig;
  token: TokenInfo;
  readAt: number;
};

export type FeeEvidence = { measured: Money | null; tx: Hex | null; block: number | null; jobId: string | null };

export type RefreshResult = { added: number; fromBlock: bigint; toBlock: bigint; head: bigint };

export type Proof = {
  jobId: string;
  stage: JobStage;
  job: JobRecord;
  /// One line per state change, each with the transaction that caused it.
  timeline: { event: string; block: number; tx: Hex; explorer: string; detail: string }[];
  replay: string[];
};

export type ArbiterSummary = {
  arbiter: Address;
  active: boolean;
  feeBps: number;
  metadataURI: string | null;
  record: {
    jobs: number;
    disputes: number;
    ruled: number;
    lapsed: number;
    openDisputes: number;
    averageSellerAwardBps: number | null;
  };
};

export type BlueprintAction =
  | 'create-and-fund'
  | 'approve'
  | 'deliver'
  | 'accept'
  | 'auto-accept'
  | 'dispute'
  | 'respond'
  | 'resolve'
  | 'refund-expired'
  | 'settle-lapsed'
  | 'list-arbiter'
  | 'delist-arbiter'
  | 'withdraw';

/// Returned verbatim when a resolve request is malformed: the cheapest possible way
/// for an agent to learn the shape is to be told the shape by the error.
const VERDICT_SHAPE =
  'POST {"jobId":"12","verdict":{"sellerAwardBps":7000,"evidenceHash":"0x…","rationaleHash":"0x…","issuedAt":1730000000,"validUntil":1730003600},"signature":"0x…"}';

export const BLUEPRINT_ACTIONS: BlueprintAction[] = [
  'create-and-fund',
  'approve',
  'deliver',
  'accept',
  'auto-accept',
  'dispute',
  'respond',
  'resolve',
  'refund-expired',
  'settle-lapsed',
  'list-arbiter',
  'delist-arbiter',
  'withdraw',
];

/// The beacon: a keyless reader of the escrow that derives everything it serves.
///
/// One object owns the chain reader, the event-sourced ledger, the payment gate and
/// the registry, so the HTTP layer and the CLI cannot disagree about what the
/// network looks like.
export class Beacon {
  private protocol: ProtocolState;
  private fee: FeeEvidence = { measured: null, tx: null, block: null, jobId: null };
  private head: bigint = 0n;

  private constructor(
    readonly config: BeaconConfig,
    readonly reader: ChainReader,
    readonly ledger: EscrowLedger,
    readonly gate: PaymentGate,
    readonly registry: Registry,
    protocol: ProtocolState,
  ) {
    this.protocol = protocol;
  }

  static async open(config: BeaconConfig = beaconConfigFromEnv()): Promise<Beacon> {
    const reader = openChain(config.rpcUrl);
    ensureDataDir(config);

    const [escrow, token] = await Promise.all([
      escrowConfig(reader, config.escrow),
      tokenInfo(reader, config.token, config.escrow),
    ]);

    const ledger = new EscrowLedger(reader, {
      escrow: config.escrow,
      fromBlock: config.indexFromBlock,
      chunkBlocks: config.scanChunkBlocks,
    });
    const registry = new Registry(config.registryFile, {
      host: config.host,
      escrow: config.escrow,
      network: config.network,
      ttlSeconds: config.challengeTtlSeconds,
    });
    const gate = new PaymentGate({
      reader,
      chainId: config.chainId,
      network: config.network,
      rpcUrl: config.rpcUrl,
      explorerUrl: config.explorerUrl,
      token: config.token,
      decimals: token.decimals,
      treasury: config.treasury,
      price: config.discoveryPrice,
      file: resolve(config.dataDir, 'payments.json'),
    });

    const beacon = new Beacon(config, reader, ledger, gate, registry, {
      escrow,
      token,
      readAt: Date.now(),
    });
    await beacon.refresh();
    return beacon;
  }

  get decimals(): number {
    return this.protocol.token.decimals;
  }

  get escrowState(): EscrowConfig {
    return this.protocol.escrow;
  }

  get tokenState(): TokenInfo {
    return this.protocol.token;
  }

  get view(): LedgerView {
    return this.ledger.view();
  }

  /// Extends the index to the head of the chain and, once, finds a real fee to quote.
  async refresh(): Promise<RefreshResult> {
    const sync = await this.ledger.sync();
    this.head = await headBlock(this.reader);
    if (this.fee.measured === null) await this.measureFee();
    return { ...sync, head: this.head };
  }

  /// Governance, refreshed on a short TTL rather than on every request.
  async protocolState(): Promise<ProtocolState> {
    if (Date.now() - this.protocol.readAt < PROTOCOL_TTL_MS) return this.protocol;
    const [escrow, token] = await Promise.all([
      escrowConfig(this.reader, this.config.escrow),
      tokenInfo(this.reader, this.config.token, this.config.escrow),
    ]);
    this.protocol = { escrow, token, readAt: Date.now() };
    return this.protocol;
  }

  /// Finds a real transaction and reads the fee it actually paid.
  ///
  /// A measured fee is the difference between "onboarding is cheap" and "onboarding
  /// costs 0.000485 alphaUSD, here is the receipt".
  private async measureFee(): Promise<void> {
    const jobs = [...this.view.jobs].reverse();
    for (const job of jobs) {
      const tx = job.funded?.tx ?? job.created.tx;
      const payment = await measureFee(this.reader, tx).catch(() => null);
      if (!payment) continue;
      this.fee = {
        measured: money(payment.amount, this.decimals),
        tx: payment.transactionHash,
        block: job.funded?.block ?? job.created.block,
        jobId: job.jobId.toString(),
      };
      return;
    }
  }

  get blueprintContext(): BlueprintContext {
    return {
      escrow: this.config.escrow,
      token: this.config.token,
      rpcUrl: this.config.rpcUrl,
      sponsored: this.config.sponsorUrl !== null,
      measuredFee: this.fee.measured,
    };
  }

  // ------------------------------------------------------------------- reads

  health(): Record<string, unknown> {
    return {
      ok: true,
      name: this.config.name,
      version: this.config.version,
      network: this.config.network,
      chainId: this.config.chainId,
      escrow: this.config.escrow,
      index: {
        fromBlock: this.config.indexFromBlock.toString(),
        caughtUpTo: (this.ledger.caughtUpTo ?? this.config.indexFromBlock - 1n).toString(),
        head: this.head.toString(),
        lagBlocks: (this.head - (this.ledger.caughtUpTo ?? this.head)).toString(),
        events: this.view.eventCount,
        jobs: this.view.jobs.length,
      },
      registry: { listings: this.registry.size() },
      discovery: { enabled: this.gate.enabled, scheme: 'tempo-tx', price: this.gate.price },
      custody: { keys: false, canSign: false, canMoveFunds: false },
      time: new Date().toISOString(),
    };
  }

  async manifest(): Promise<Manifest> {
    const { escrow, token } = await this.protocolState();
    const view = this.view;
    return buildManifest({
      config: this.config,
      escrow,
      token,
      index: {
        fromBlock: view.fromBlock,
        toBlock: view.toBlock,
        head: this.head,
        events: view.eventCount,
        jobs: view.jobs.length,
      },
      fee: { measured: this.fee.measured, tx: this.fee.tx },
      discovery: this.gate.requirement('/discover'),
      registry: { listings: this.registry.size(), file: this.config.registryFile },
    });
  }

  async card(): Promise<Record<string, unknown>> {
    return agentCard(await this.manifest());
  }

  async stats(): Promise<NetworkStats> {
    const { escrow, token } = await this.protocolState();
    return networkStats(this.view, {
      chainId: this.config.chainId,
      network: this.config.network,
      escrow: escrow.escrow,
      token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
      reader: this.reader,
    });
  }

  jobs(filter: { stage?: JobStage; address?: Address; limit?: number } = {}): JobRecord[] {
    const wanted = filter.address?.toLowerCase();
    const matched = this.view.jobs.filter((job) => {
      if (filter.stage && job.stage !== filter.stage) return false;
      if (!wanted) return true;
      return job.buyer.toLowerCase() === wanted || job.seller.toLowerCase() === wanted;
    });
    return matched.slice(-(filter.limit ?? 100)).reverse();
  }

  job(jobId: bigint): JobRecord | undefined {
    return this.ledger.job(jobId);
  }

  /// One job, as a chain of receipts an agent can walk itself.
  proof(jobId: bigint): Proof | null {
    const job = this.ledger.job(jobId);
    if (!job) return null;

    const link = (tx: Hex) => `${this.config.explorerUrl}/tx/${tx}`;
    const timeline: Proof['timeline'] = [
      {
        event: 'JobCreated',
        block: job.created.block,
        tx: job.created.tx,
        explorer: link(job.created.tx),
        detail: `${job.buyer} hired ${job.seller} for ${job.amount} units, terms ${job.termsHash}`,
      },
    ];
    if (job.funded) {
      timeline.push({
        event: 'JobFunded',
        block: job.funded.block,
        tx: job.funded.tx,
        explorer: link(job.funded.tx),
        detail: `${job.funded.amount} units moved into the escrow`,
      });
    }
    if (job.delivered) {
      timeline.push({
        event: 'JobDelivered',
        block: job.delivered.block,
        tx: job.delivered.tx,
        explorer: link(job.delivered.tx),
        detail: `deliverable ${job.delivered.deliverableHash}, review until ${job.delivered.reviewDeadline}`,
      });
    }
    if (job.accepted) {
      timeline.push({
        event: 'JobAccepted',
        block: job.accepted.block,
        tx: job.accepted.tx,
        explorer: link(job.accepted.tx),
        detail: `seller paid ${job.accepted.sellerAmount}, platform fee ${job.accepted.platformFee}`,
      });
    }
    if (job.dispute) {
      timeline.push({
        event: 'DisputeRaised',
        block: job.dispute.block,
        tx: job.dispute.tx,
        explorer: link(job.dispute.tx),
        detail: `dispute evidence ${job.dispute.disputeHash}`,
      });
    }
    if (job.verdict) {
      timeline.push({
        event: 'VerdictResolved',
        block: job.verdict.block,
        tx: job.verdict.tx,
        explorer: link(job.verdict.tx),
        detail:
          `seller awarded ${job.verdict.sellerAwardBps} bps (${job.verdict.sellerAmount}), ` +
          `buyer ${job.verdict.buyerAmount}, arbitration fee ${job.verdict.arbitrationFee}`,
      });
    }
    if (job.refund) {
      timeline.push({
        event: 'JobRefunded',
        block: job.refund.block,
        tx: job.refund.tx,
        explorer: link(job.refund.tx),
        detail: `${job.refund.amount} units returned to the buyer`,
      });
    }

    return {
      jobId: job.jobId.toString(),
      stage: job.stage,
      job,
      timeline,
      replay: [
        `eth_getTransactionReceipt for each tx above; the escrow log in each one is the state change claimed.`,
        `Or re-run the scan: eth_getLogs address=${this.config.escrow} fromBlock=${job.created.block} toBlock=${
          timeline[timeline.length - 1]!.block
        }, and fold the events in block/logIndex order.`,
        `For a resolved job, recompute verdictDigest(verdict) with the domain {name:"Tempex",version:"1",chainId:${this.config.chainId},verifyingContract:${this.config.escrow}} and confirm ecrecover equals arbiter().`,
        `For money movement, the funding transfer carries memo == ${jobId}, and a withdrawal carries the escrow's WITHDRAW_MEMO.`,
      ],
    };
  }

  /// The arbiter market: the house arbiter plus every self-listed one, each with
  /// a track record folded from the jobs that locked it in. Buyers pick from this
  /// list with `create-and-fund {arbiter}`; sellers see the pick before delivering.
  arbiters(): { house: ArbiterSummary; listed: ArbiterSummary[]; note: string } {
    const { jobs, arbiters } = this.view;
    const summarize = (
      arbiter: Address,
      listing: { active: boolean; feeBps: number; metadataURI: string } | null,
    ): ArbiterSummary => {
      const mine = jobs.filter(
        (job) => job.terms?.arbiter.toLowerCase() === arbiter.toLowerCase(),
      );
      const ruled = mine.filter((job) => job.verdict !== undefined);
      const awards = ruled.map((job) => job.verdict!.sellerAwardBps);
      return {
        arbiter,
        active: listing?.active ?? true,
        feeBps: listing?.feeBps ?? this.escrowState.arbitrationFeeBps,
        metadataURI: listing?.metadataURI ?? null,
        record: {
          jobs: mine.length,
          disputes: mine.filter((job) => job.dispute !== undefined).length,
          ruled: ruled.length,
          lapsed: mine.filter((job) => job.lapsed !== undefined).length,
          openDisputes: mine.filter((job) => job.stage === 'disputed').length,
          averageSellerAwardBps:
            awards.length === 0
              ? null
              : Math.round(awards.reduce((sum, bps) => sum + bps, 0) / awards.length),
        },
      };
    };
    return {
      house: summarize(this.escrowState.arbiter, null),
      listed: arbiters
        .map((record) => summarize(record.arbiter, record))
        .sort((a, b) => Number(b.active) - Number(a.active) || b.record.ruled - a.record.ruled),
      note: 'Every figure is folded from escrow events: JobTermsLocked says which arbiter a job locked, VerdictResolved and DisputeLapsed say how it ended. A lapsed dispute is one the arbiter never ruled on in time.',
    };
  }

  /// A buyer may only name an arbiter that is listed right now; checking here turns
  /// a revert the agent would pay for into an error that says what to do instead.
  private listedArbiter(raw: string): Address {
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      throw new BeaconError(`arbiter must be an address, got "${raw}"`, 400, 'GET /arbiters lists who you can choose.');
    }
    const listing = this.view.arbiters.find((record) => record.arbiter.toLowerCase() === raw.toLowerCase());
    if (!listing?.active) {
      throw new BeaconError(
        `${raw} is not a listed arbiter`,
        400,
        'GET /arbiters lists who you can choose; omit "arbiter" to use the house arbiter.',
      );
    }
    return listing.arbiter;
  }

  reputation(address: Address): Reputation {
    return reputationFor(this.view, address, this.decimals);
  }

  onboarding(role: Role, amount?: string, policyId?: string): OnboardingPlan {
    return onboardingPlan({
      config: this.config,
      role,
      amount: amount === undefined ? undefined : this.units(amount),
      decimals: this.decimals,
      measuredFee: this.fee.measured,
      policyId,
    });
  }

  async ready(address: Address, role: Role, amount?: string): Promise<ReadinessReport> {
    return readiness({
      reader: this.reader,
      config: this.config,
      address,
      role,
      amount: amount === undefined ? undefined : this.units(amount),
      decimals: this.decimals,
      measuredFee: this.fee.measured,
      reputation: this.reputation(address),
    });
  }

  quoteFor(role: Role, amount?: string): Quote {
    const value = amount === undefined ? 0n : this.units(amount);
    return quote({
      config: this.config,
      role,
      amount: value,
      decimals: this.decimals,
      measured: this.fee.measured,
      measuredOn:
        this.fee.tx === null || this.fee.block === null || this.fee.jobId === null
          ? null
          : { tx: this.fee.tx, block: this.fee.block, jobId: this.fee.jobId },
    });
  }

  paymentRequirement(resource: string): PaymentRequirement {
    return this.gate.requirement(resource);
  }

  paymentQuote(resource: string): PaymentQuote | null {
    return this.gate.enabled ? this.gate.issueQuote(resource) : null;
  }

  settle(resource: string, header: string | null, quoteId: string | null): Promise<SettleResult> {
    return this.gate.settle(resource, header, quoteId);
  }

  // -------------------------------------------------------------- blueprints

  /// Encodes one intent. The caller signs it; the beacon cannot.
  ///
  /// `sponsored` defaults to the beacon's config. An agent that would rather pay the
  /// fee itself says so, and gets calldata whose fee treatment matches what it will
  /// actually broadcast.
  async blueprintFor(
    action: BlueprintAction,
    params: Record<string, unknown>,
    options: { sponsored?: boolean } = {},
  ): Promise<Blueprint> {
    const ctx =
      options.sponsored === undefined
        ? this.blueprintContext
        : { ...this.blueprintContext, sponsored: options.sponsored };

    switch (action) {
      case 'create-and-fund': {
        const buyer = address(params['buyer'], 'buyer');
        const seller = address(params['seller'], 'seller');
        if (buyer.toLowerCase() === seller.toLowerCase()) {
          throw new BeaconError('the escrow reverts when buyer and seller are the same address', 400);
        }
        const amount = this.units(required(params['amount'], 'amount'));
        const policy = policyById(String(params['policy'] ?? 'standard'));
        const now = Math.floor(Date.now() / 1000);
        const [nextJobId, allowance] = await Promise.all([
          this.reader.readContract({
            address: this.config.escrow,
            abi: tempexEscrowAbi,
            functionName: 'nextJobId',
          }) as Promise<bigint>,
          this.reader.readContract({
            address: this.config.token,
            abi: tip20Abi,
            functionName: 'allowance',
            args: [buyer, this.config.escrow],
          }) as Promise<bigint>,
        ]);
        return blueprintCreateAndFund(ctx, {
          buyer,
          seller,
          amount,
          termsHash: this.hash(params['termsHash'], params['terms'], 'terms'),
          deliveryDeadline: seconds(params['deliveryDeadline'], now + policy.deliveryDeadlineSeconds),
          reviewWindow: seconds(params['reviewWindow'], policy.reviewWindowSeconds),
          ...(params['arbiter'] !== undefined
            ? { arbiter: this.listedArbiter(String(params['arbiter'])) }
            : {}),
          nextJobId,
          allowance,
        });
      }
      case 'approve':
        return blueprintApprove(ctx, this.units(required(params['amount'], 'amount')));
      case 'deliver':
        return blueprintDeliver(
          ctx,
          big(required(params['jobId'], 'jobId')),
          this.hash(params['deliverableHash'], params['deliverable'], 'deliverable'),
        );
      case 'accept':
        return blueprintAccept(ctx, big(required(params['jobId'], 'jobId')));
      case 'auto-accept':
        return blueprintAutoAccept(ctx, big(required(params['jobId'], 'jobId')));
      case 'dispute': {
        const jobId = big(required(params['jobId'], 'jobId'));
        const job = this.ledger.job(jobId);
        if (!job) {
          throw new BeaconError(
            `job ${jobId} is not in this beacon's index`,
            404,
            'GET /jobs lists the jobs this beacon has seen; the bond is 5% of the job amount, so the job must exist.',
          );
        }
        return blueprintDispute(
          ctx,
          jobId,
          this.hash(params['disputeHash'], params['evidence'], 'evidence'),
          disputeBond(job.amount),
        );
      }
      case 'respond':
        return blueprintRespond(
          ctx,
          big(required(params['jobId'], 'jobId')),
          this.hash(params['responseHash'], params['response'], 'response'),
        );
      case 'resolve': {
        const jobId = big(required(params['jobId'], 'jobId'));
        const verdict = params['verdict'] as Record<string, unknown> | undefined;
        if (!verdict) {
          throw new BeaconError('resolve needs a signed verdict object', 400, VERDICT_SHAPE);
        }
        const signature = String(params['signature'] ?? '') as Hex;
        if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
          throw new BeaconError(
            'resolve needs a 65-byte signature over the verdict',
            400,
            'Sign the EIP-712 Verdict with the arbiter key; GET /.well-known/tempex.json returns the domain and the verdictDigest selector.',
          );
        }
        return blueprintResolve(
          ctx,
          jobId,
          {
            sellerAwardBps: Number(verdict['sellerAwardBps'] ?? 0),
            evidenceHash: String(verdict['evidenceHash'] ?? '') as Hex,
            rationaleHash: String(verdict['rationaleHash'] ?? '') as Hex,
            issuedAt: BigInt(String(verdict['issuedAt'] ?? 0)),
            validUntil: BigInt(String(verdict['validUntil'] ?? 0)),
          },
          signature,
        );
      }
      case 'refund-expired':
        return blueprintRefundExpired(ctx, big(required(params['jobId'], 'jobId')));
      case 'settle-lapsed':
        return blueprintSettleLapsed(ctx, big(required(params['jobId'], 'jobId')));
      case 'list-arbiter': {
        const feeBps = Number(required(params['feeBps'], 'feeBps'));
        if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > this.escrowState.maxArbitrationFeeBps) {
          throw new BeaconError(
            `feeBps must be an integer from 0 to ${this.escrowState.maxArbitrationFeeBps}`,
            400,
            'POST {"feeBps":250,"metadataURI":"https://you.example/arbiter.json"}; the URI should describe your model, rules and contact.',
          );
        }
        return blueprintListArbiter(ctx, feeBps, String(params['metadataURI'] ?? ''));
      }
      case 'delist-arbiter':
        return blueprintDelistArbiter(ctx);
      case 'withdraw':
        return blueprintWithdraw(ctx);
    }
  }

  // ---------------------------------------------------------------- registry

  challenge(addr: Address): Challenge {
    return this.registry.issueChallenge(addr);
  }

  register(input: RegisterInput): Promise<RegisterResult> {
    return this.registry.register(input);
  }

  listings(): RegistryEntry[] {
    return this.registry.all();
  }

  /// Ranked by derived reputation, which is the only ranking nobody can buy.
  discover(filter: DiscoveryFilter): RegistryListing[] {
    return rankEntries(this.registry.all(), filter, (addr) => this.reputation(addr));
  }

  exportRegistry(): { version: 1; entries: RegistryEntry[] } {
    return this.registry.exportFile();
  }

  /// The policy templates the arbiter's rule engine actually implements, served
  /// whole: an agent picks terms from a table it can read, not from a doc it has
  /// to trust.
  policies(): PolicyTemplate[] {
    return POLICY_TEMPLATES;
  }

  // ---------------------------------------------------------------- helpers

  /// Accepts "25", "25.5" or a raw unit string, and says which it took.
  units(amount: string): bigint {
    return tokenAmount(amount, this.decimals);
  }

  private hash(explicit: unknown, source: unknown, label: string): Hex {
    if (typeof explicit === 'string' && explicit.startsWith('0x') && explicit.length === 66) {
      return explicit as Hex;
    }
    if (source === undefined) {
      throw new BeaconError(
        `${label} is required: pass ${label}Hash (bytes32) or ${label} (any JSON to hash)`,
        400,
        `Send "${label}": "text" or any JSON value; the beacon hashes it canonically and shows the digest in the decoded call, so you can check it before signing.`,
      );
    }
    return typeof source === 'string' ? hashText(source) : hashCanonical(source);
  }
}

/// Every error an agent can receive carries the fix with it.
export class BeaconError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'BeaconError';
  }
}

function required(value: unknown, label: string): string {
  if (value === undefined || value === null || value === '') {
    throw new BeaconError(`${label} is required`, 400);
  }
  return String(value);
}

function address(value: unknown, label: string): Address {
  const raw = required(value, label);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new BeaconError(`${label} must be a 20-byte address, got "${raw}"`, 400);
  }
  return raw as Address;
}

function big(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new BeaconError(`expected an integer, got "${value}"`, 400);
  }
}

/// Absolute unix seconds. A caller may pass a duration by mistake, and a duration
/// interpreted as a deadline is a job that expires in 1970 — so anything that looks
/// like a duration is rejected rather than silently accepted.
function seconds(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new BeaconError(`expected a unix timestamp, got "${String(value)}"`, 400);
  if (parsed < 1_000_000_000) {
    throw new BeaconError(
      `expected an absolute unix timestamp, got ${parsed}; if you meant a duration, add it to the current time`,
      400,
    );
  }
  return Math.floor(parsed);
}
