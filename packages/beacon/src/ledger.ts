import type { Address, Hex } from 'viem';

import {
  headBlock,
  scanEvents,
  type ChainReader,
  type EscrowEvent,
} from './chain.js';

export type JobStage =
  | 'created'
  | 'funded'
  | 'delivered'
  | 'accepted'
  | 'disputed'
  | 'resolved'
  | 'refunded'
  | 'lapsed'
  | 'cancelled';

type Stamp = { block: number; tx: Hex };

export type JobRecord = {
  jobId: bigint;
  buyer: Address;
  seller: Address;
  amount: bigint;
  termsHash: Hex;
  deliveryDeadline: number;
  reviewWindow: number;
  stage: JobStage;
  created: Stamp;
  funded?: Stamp & { amount: bigint };
  delivered?: Stamp & {
    deliverableHash: Hex;
    deliveredAt: number;
    reviewDeadline: number;
    /// where the seller said the work lives, if it said
    uri?: string;
  };
  accepted?: Stamp & { sellerAmount: bigint; platformFee: bigint };
  dispute?: Stamp & {
    disputeHash: Hex;
    disputedAt: number;
    responseDeadline?: number;
    /// the buyer's final offer, in bps of the job amount
    buyerOfferBps?: number;
  };
  /// The seller's answer to the dispute, pinned inside its response window.
  response?: Stamp & { responseHash: Hex; respondedAt: number; sellerAskBps: number };
  verdict?: Stamp & {
    sellerAwardBps: number;
    sellerAmount: bigint;
    buyerAmount: bigint;
    arbitrationFee: bigint;
    evidenceHash: Hex;
    rationaleHash: Hex;
    verdictDigest: Hex;
  };
  refund?: Stamp & { amount: bigint };
  /// The arbiter and fee rates the job locked at creation.
  terms?: Stamp & {
    arbiter: Address;
    platformFeeBps: number;
    arbitrationFeeBps: number;
    protocolCutBps: number;
    /// v3: the minimum arbitration fee the job locked, in token units (0 if none)
    arbitrationFeeFloor?: bigint;
  };
  /// v3: who brought the job, the share of protocol fees it earns, and what it
  /// has been paid so far.
  referral?: Stamp & { referrer: Address; shareBps: number; paid: bigint };
  /// The arbiter never ruled in time; anyone settled it on the default split.
  lapsed?: Stamp & { sellerAmount: bigint; buyerAmount: bigint };
  /// The buyer called the job off before funding it.
  cancelled?: Stamp;
  /// Set when the job is one tranche of a milestone plan.
  milestone?: { planHash: Hex; index: number; count: number };
};

/// An arbiter that listed itself on the escrow, as folded from its events.
export type ArbiterRecord = {
  arbiter: Address;
  active: boolean;
  feeBps: number;
  metadataURI: string;
  listed: Stamp;
  delisted?: Stamp;
};

export type WithdrawalRecord = { account: Address; amount: bigint } & Stamp;

export type LedgerView = {
  fromBlock: bigint;
  toBlock: bigint;
  eventCount: number;
  jobs: JobRecord[];
  withdrawals: WithdrawalRecord[];
  arbiterUpdates: (Stamp & { arbiter: Address })[];
  arbiters: ArbiterRecord[];
  treasuryUpdates: (Stamp & { treasury: Address })[];
  feeUpdates: (Stamp & { platformFeeBps: number; arbitrationFeeBps: number })[];
};

export type LedgerParams = {
  escrow: Address;
  fromBlock: bigint;
  chunkBlocks?: bigint;
};

/// The escrow's history, folded into job records and held in memory.
///
/// Deliberately not a database. A beacon that can be restarted and rebuild its
/// entire view from `eth_getLogs` cannot drift from the chain, cannot be poisoned
/// by a stale write, and can be audited by anyone who runs the same scan.
export class EscrowLedger {
  private readonly reader: ChainReader;
  private readonly params: LedgerParams;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly withdrawals: WithdrawalRecord[] = [];
  private readonly arbiterUpdates: LedgerView['arbiterUpdates'] = [];
  private readonly arbiters = new Map<string, ArbiterRecord>();
  private readonly treasuryUpdates: LedgerView['treasuryUpdates'] = [];
  private readonly feeUpdates: LedgerView['feeUpdates'] = [];
  private scannedTo: bigint | null = null;
  private eventCount = 0;

  constructor(reader: ChainReader, params: LedgerParams) {
    this.reader = reader;
    this.params = params;
  }

  /// Extends the index to the current head. Cheap when already caught up: the scan
  /// starts at the block after the last one seen.
  async sync(): Promise<{ added: number; fromBlock: bigint; toBlock: bigint }> {
    const head = await headBlock(this.reader);
    const start = this.scannedTo === null ? this.params.fromBlock : this.scannedTo + 1n;
    if (start > head) {
      return { added: 0, fromBlock: this.params.fromBlock, toBlock: head };
    }

    const events = await scanEvents(this.reader, {
      escrow: this.params.escrow,
      fromBlock: start,
      toBlock: head,
      chunkBlocks: this.params.chunkBlocks,
    });

    for (const event of events) this.fold(event);
    this.eventCount += events.length;
    this.scannedTo = head;
    return { added: events.length, fromBlock: start, toBlock: head };
  }

  get caughtUpTo(): bigint | null {
    return this.scannedTo;
  }

  view(): LedgerView {
    const jobs = [...this.jobs.values()].sort((a, b) => Number(a.jobId - b.jobId));
    return {
      fromBlock: this.params.fromBlock,
      toBlock: this.scannedTo ?? this.params.fromBlock - 1n,
      eventCount: this.eventCount,
      jobs,
      withdrawals: [...this.withdrawals],
      arbiterUpdates: [...this.arbiterUpdates],
      arbiters: [...this.arbiters.values()],
      treasuryUpdates: [...this.treasuryUpdates],
      feeUpdates: [...this.feeUpdates],
    };
  }

  job(jobId: bigint): JobRecord | undefined {
    return this.jobs.get(jobId.toString());
  }

  private fold(event: EscrowEvent): void {
    const args = event.args;
    const stamp: Stamp = { block: event.blockNumber, tx: event.transactionHash };

    switch (event.name) {
      case 'JobCreated': {
        const jobId = big(args['jobId']);
        this.jobs.set(jobId.toString(), {
          jobId,
          buyer: addr(args['buyer']),
          seller: addr(args['seller']),
          amount: big(args['amount']),
          termsHash: hex(args['termsHash']),
          deliveryDeadline: num(args['deliveryDeadline']),
          reviewWindow: num(args['reviewWindow']),
          stage: 'created',
          created: stamp,
        });
        return;
      }
      case 'MilestonePlanCreated': {
        // Emitted after the plan's JobCreated events in the same transaction, so
        // every tranche is already in the index when its plan is folded.
        const first = big(args['firstJobId']);
        const count = num(args['count']);
        for (let index = 0; index < count; index++) {
          const job = this.mutate(first + BigInt(index));
          if (job) job.milestone = { planHash: hex(args['planHash']), index, count };
        }
        return;
      }
      case 'JobFunded': {
        const job = this.mutate(big(args['jobId']));
        if (job) {
          job.funded = { ...stamp, amount: big(args['amount']) };
          if (job.stage === 'created') job.stage = 'funded';
        }
        return;
      }
      case 'JobDelivered': {
        const job = this.mutate(big(args['jobId']));
        if (job) {
          job.delivered = {
            ...stamp,
            deliverableHash: hex(args['deliverableHash']),
            deliveredAt: num(args['deliveredAt']),
            reviewDeadline: num(args['reviewDeadline']),
          };
          if (job.stage === 'funded') job.stage = 'delivered';
        }
        return;
      }
      case 'DeliverableLocated': {
        const job = this.mutate(big(args['jobId']));
        if (job?.delivered) job.delivered.uri = String(args['uri'] ?? '');
        return;
      }
      case 'JobAccepted': {
        const job = this.mutate(big(args['jobId']));
        if (job) {
          job.accepted = {
            ...stamp,
            sellerAmount: big(args['sellerAmount']),
            platformFee: big(args['platformFee']),
          };
          job.stage = 'accepted';
        }
        return;
      }
      case 'DisputeRaised': {
        const job = this.mutate(big(args['jobId']));
        if (job) {
          job.dispute = {
            ...stamp,
            disputeHash: hex(args['disputeHash']),
            disputedAt: num(args['disputedAt']),
          };
          job.stage = 'disputed';
        }
        return;
      }
      case 'SellerResponseRequested': {
        const job = this.mutate(big(args['jobId']));
        if (job?.dispute) job.dispute.responseDeadline = num(args['responseDeadline']);
        return;
      }
      case 'BuyerOfferPinned': {
        const job = this.mutate(big(args['jobId']));
        if (job?.dispute) job.dispute.buyerOfferBps = num(args['buyerOfferBps']);
        return;
      }
      case 'SellerResponded': {
        const job = this.mutate(big(args['jobId']));
        if (job) {
          job.response = {
            ...stamp,
            responseHash: hex(args['responseHash']),
            respondedAt: num(args['respondedAt']),
            sellerAskBps: num(args['sellerAskBps']),
          };
        }
        return;
      }
      case 'VerdictResolved': {
        const job = this.mutate(big(args['jobId']));
        if (job) {
          job.verdict = {
            ...stamp,
            sellerAwardBps: num(args['sellerAwardBps']),
            sellerAmount: big(args['sellerAmount']),
            buyerAmount: big(args['buyerAmount']),
            arbitrationFee: big(args['arbitrationFee']),
            evidenceHash: hex(args['evidenceHash']),
            rationaleHash: hex(args['rationaleHash']),
            verdictDigest: hex(args['verdictDigest']),
          };
          job.stage = 'resolved';
        }
        return;
      }
      case 'JobTermsLocked': {
        const job = this.mutate(big(args['jobId']));
        if (job) {
          job.terms = {
            ...stamp,
            arbiter: String(args['arbiter']) as Address,
            platformFeeBps: num(args['platformFeeBps']),
            arbitrationFeeBps: num(args['arbitrationFeeBps']),
            protocolCutBps: num(args['protocolCutBps']),
          };
        }
        return;
      }
      case 'ArbitrationFeeFloorLocked': {
        const job = this.mutate(big(args['jobId']));
        if (job?.terms) job.terms.arbitrationFeeFloor = big(args['arbitrationFeeFloor']);
        return;
      }
      case 'JobReferred': {
        const job = this.mutate(big(args['jobId']));
        if (job) {
          job.referral = {
            ...stamp,
            referrer: String(args['referrer']) as Address,
            shareBps: num(args['referralShareBps']),
            paid: 0n,
          };
        }
        return;
      }
      case 'ReferralPaid': {
        const job = this.mutate(big(args['jobId']));
        if (job?.referral) job.referral.paid += big(args['amount']);
        return;
      }
      case 'DisputeLapsed': {
        const job = this.mutate(big(args['jobId']));
        if (job) {
          job.lapsed = {
            ...stamp,
            sellerAmount: big(args['sellerAmount']),
            buyerAmount: big(args['buyerAmount']),
          };
          job.stage = 'lapsed';
        }
        return;
      }
      case 'JobRefunded': {
        const job = this.mutate(big(args['jobId']));
        if (job) {
          job.refund = { ...stamp, amount: big(args['amount']) };
          job.stage = 'refunded';
        }
        return;
      }
      case 'JobCancelled': {
        const job = this.mutate(big(args['jobId']));
        if (job) {
          job.stage = 'cancelled';
          job.cancelled = { ...stamp };
        }
        return;
      }
      case 'Withdrawal': {
        this.withdrawals.push({
          account: addr(args['account']),
          amount: big(args['amount']),
          ...stamp,
        });
        return;
      }
      case 'ArbiterListed': {
        const arbiter = addr(args['arbiter']);
        const { delisted: _previous, ...prior } = this.arbiters.get(arbiter.toLowerCase()) ?? {};
        this.arbiters.set(arbiter.toLowerCase(), {
          ...prior,
          arbiter,
          active: true,
          feeBps: num(args['feeBps']),
          metadataURI: String(args['metadataURI'] ?? ''),
          listed: stamp,
        });
        return;
      }
      case 'ArbiterDelisted': {
        const record = this.arbiters.get(addr(args['arbiter']).toLowerCase());
        if (record) {
          record.active = false;
          record.delisted = stamp;
        }
        return;
      }
      case 'ArbiterUpdated': {
        this.arbiterUpdates.push({ ...stamp, arbiter: addr(args['arbiter']) });
        return;
      }
      case 'TreasuryUpdated': {
        this.treasuryUpdates.push({ ...stamp, treasury: addr(args['treasury']) });
        return;
      }
      case 'FeesUpdated': {
        this.feeUpdates.push({
          ...stamp,
          platformFeeBps: num(args['platformFeeBps']),
          arbitrationFeeBps: num(args['arbitrationFeeBps']),
        });
        return;
      }
      default:
        // Ownership and EIP-712 domain events do not describe a job.
        return;
    }
  }

  private mutate(jobId: bigint): JobRecord | undefined {
    return this.jobs.get(jobId.toString());
  }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;

function big(value: unknown): bigint {
  return typeof value === 'bigint' ? value : BigInt(String(value ?? 0));
}

function num(value: unknown): number {
  return Number(big(value));
}

function addr(value: unknown): Address {
  return typeof value === 'string' ? (value as Address) : ZERO_ADDRESS;
}

function hex(value: unknown): Hex {
  return typeof value === 'string' ? (value as Hex) : ZERO_HASH;
}
