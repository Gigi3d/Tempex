import type { Address, Hex } from 'viem';

import { formatToken } from '@tempex/sdk';

import type { ChainReader } from './chain.js';
import type { JobRecord, LedgerView } from './ledger.js';

export type Money = { units: string; value: string };

export function money(units: bigint, decimals: number): Money {
  return { units: units.toString(), value: formatToken(units, decimals) };
}

const ZERO: Money = { units: '0', value: '0' };

function add(a: Money, units: bigint, decimals: number): Money {
  return money(BigInt(a.units) + units, decimals);
}

export type NetworkStats = {
  generatedAt: string;
  chainId: number;
  network: string;
  escrow: Address;
  token: { address: Address; symbol: string; decimals: number };
  blockRange: { from: string; to: string };
  events: number;
  jobs: {
    total: number;
    created: number;
    funded: number;
    delivered: number;
    accepted: number;
    disputed: number;
    resolved: number;
    refunded: number;
    cancelled: number;
    /// Share of funded jobs that reached a terminal state without a human.
    settlementRate: number;
    /// Share of funded jobs that were disputed. The honest number: a referee that
    /// hides its dispute rate is not worth trusting.
    disputeRate: number;
  };
  money: {
    escrowed: Money;
    paidToSellers: Money;
    refundedToBuyers: Money;
    arbitrationFees: Money;
    platformFees: Money;
    withdrawn: Money;
    stillInEscrow: Money;
  };
  arbitration: {
    verdicts: number;
    avgSellerAwardBps: number | null;
    minSellerAwardBps: number | null;
    maxSellerAwardBps: number | null;
    /// Every award the escrow ever paid out, in basis points. A verdict outside
    /// [0, 10000] would be a bug; this is the public check that there is none.
    bounded: boolean;
    timings: ArbitrationTiming[];
  };
  participants: { buyers: number; sellers: number; unique: number };
  /// The receipts behind every number above. An agent that does not trust the
  /// summary can replay these transactions itself.
  proofs: { jobId: string; stage: string; block: number; tx: Hex }[];
};

export type ArbitrationTiming = {
  jobId: string;
  disputedAt: number;
  verdictAt: number;
  seconds: number;
  blocks: number;
  tx: Hex;
};

export type StatsParams = {
  chainId: number;
  network: string;
  /// Not derivable from events, so the caller supplies it rather than the indexer
  /// inferring it from a log address.
  escrow: Address;
  token: { address: Address; symbol: string; decimals: number };
  /// Measured dispute→verdict latency, sampled from the most recent verdicts.
  reader?: ChainReader;
  timingSampleLimit?: number;
};

/// The network, described entirely by what happened on it.
export async function networkStats(view: LedgerView, params: StatsParams): Promise<NetworkStats> {
  const decimals = params.token.decimals;
  const jobs = view.jobs;
  const funded = jobs.filter((job) => job.funded !== undefined);

  const counts = {
    total: jobs.length,
    created: jobs.filter((job) => job.stage === 'created').length,
    funded: jobs.filter((job) => job.stage === 'funded').length,
    delivered: jobs.filter((job) => job.stage === 'delivered').length,
    accepted: jobs.filter((job) => job.stage === 'accepted').length,
    disputed: jobs.filter((job) => job.dispute !== undefined).length,
    resolved: jobs.filter((job) => job.verdict !== undefined).length,
    refunded: jobs.filter((job) => job.stage === 'refunded').length,
    cancelled: jobs.filter((job) => job.stage === 'cancelled').length,
  };

  const terminal = counts.accepted + counts.resolved + counts.refunded + counts.cancelled;

  let escrowed = ZERO;
  let paidToSellers = ZERO;
  let refundedToBuyers = ZERO;
  let arbitrationFees = ZERO;
  let platformFees = ZERO;

  for (const job of jobs) {
    if (job.funded) escrowed = add(escrowed, job.funded.amount, decimals);
    if (job.accepted) {
      paidToSellers = add(paidToSellers, job.accepted.sellerAmount, decimals);
      platformFees = add(platformFees, job.accepted.platformFee, decimals);
    }
    if (job.verdict) {
      paidToSellers = add(paidToSellers, job.verdict.sellerAmount, decimals);
      refundedToBuyers = add(refundedToBuyers, job.verdict.buyerAmount, decimals);
      arbitrationFees = add(arbitrationFees, job.verdict.arbitrationFee, decimals);
    }
    if (job.refund) refundedToBuyers = add(refundedToBuyers, job.refund.amount, decimals);
  }

  let withdrawn = ZERO;
  for (const entry of view.withdrawals) withdrawn = add(withdrawn, entry.amount, decimals);

  const awards = jobs.flatMap((job) => (job.verdict ? [job.verdict.sellerAwardBps] : []));
  const timings = params.reader
    ? await measureTimings(params.reader, jobs, params.timingSampleLimit ?? 12)
    : [];

  const buyers = new Set(jobs.map((job) => job.buyer.toLowerCase()));
  const sellers = new Set(jobs.map((job) => job.seller.toLowerCase()));

  return {
    generatedAt: new Date().toISOString(),
    chainId: params.chainId,
    network: params.network,
    escrow: params.escrow,
    token: params.token,
    blockRange: { from: view.fromBlock.toString(), to: view.toBlock.toString() },
    events: view.eventCount,
    jobs: {
      ...counts,
      settlementRate: funded.length === 0 ? 0 : round(terminal / funded.length),
      disputeRate: funded.length === 0 ? 0 : round(counts.disputed / funded.length),
    },
    money: {
      escrowed,
      paidToSellers,
      refundedToBuyers,
      arbitrationFees,
      platformFees,
      withdrawn,
      stillInEscrow: money(
        BigInt(escrowed.units) - BigInt(paidToSellers.units) - BigInt(refundedToBuyers.units),
        decimals,
      ),
    },
    arbitration: {
      verdicts: awards.length,
      avgSellerAwardBps: awards.length ? Math.round(sum(awards) / awards.length) : null,
      minSellerAwardBps: awards.length ? Math.min(...awards) : null,
      maxSellerAwardBps: awards.length ? Math.max(...awards) : null,
      bounded: awards.every((bps) => bps >= 0 && bps <= 10_000),
      timings,
    },
    participants: {
      buyers: buyers.size,
      sellers: sellers.size,
      unique: new Set([...buyers, ...sellers]).size,
    },
    proofs: jobs.slice(-12).flatMap((job) => proofsFor(job)),
  };
}

function proofsFor(job: JobRecord): NetworkStats['proofs'] {
  const id = job.jobId.toString();
  const stages: NetworkStats['proofs'] = [
    { jobId: id, stage: 'created', block: job.created.block, tx: job.created.tx },
  ];
  if (job.funded) stages.push({ jobId: id, stage: 'funded', block: job.funded.block, tx: job.funded.tx });
  if (job.delivered) {
    stages.push({ jobId: id, stage: 'delivered', block: job.delivered.block, tx: job.delivered.tx });
  }
  if (job.dispute) {
    stages.push({ jobId: id, stage: 'disputed', block: job.dispute.block, tx: job.dispute.tx });
  }
  if (job.verdict) {
    stages.push({ jobId: id, stage: 'resolved', block: job.verdict.block, tx: job.verdict.tx });
  }
  if (job.accepted) {
    stages.push({ jobId: id, stage: 'accepted', block: job.accepted.block, tx: job.accepted.tx });
  }
  if (job.refund) stages.push({ jobId: id, stage: 'refunded', block: job.refund.block, tx: job.refund.tx });
  return stages;
}

/// How long arbitration actually took, measured from block timestamps.
///
/// Wall-clock latency is the number a buyer cares about and the number a mock cannot
/// produce, so it is read off the chain rather than logged by the arbiter.
export async function measureTimings(
  reader: ChainReader,
  jobs: JobRecord[],
  limit: number,
): Promise<ArbitrationTiming[]> {
  const resolved = jobs.filter((job) => job.dispute && job.verdict).slice(-limit);
  const timestamps = new Map<number, number>();

  async function blockTime(block: number): Promise<number> {
    const cached = timestamps.get(block);
    if (cached !== undefined) return cached;
    const { timestamp } = await reader.getBlock({ blockNumber: BigInt(block) });
    const seconds = Number(timestamp);
    timestamps.set(block, seconds);
    return seconds;
  }

  const timings: ArbitrationTiming[] = [];
  for (const job of resolved) {
    const dispute = job.dispute;
    const verdict = job.verdict;
    if (!dispute || !verdict) continue;
    const disputedAt = await blockTime(dispute.block);
    const verdictAt = await blockTime(verdict.block);
    timings.push({
      jobId: job.jobId.toString(),
      disputedAt,
      verdictAt,
      seconds: Math.max(0, verdictAt - disputedAt),
      blocks: Math.max(0, verdict.block - dispute.block),
      tx: verdict.tx,
    });
  }
  return timings;
}

// --------------------------------------------------------------- reputation

export type ScoreFactor = { label: string; points: number; detail: string };

export type ReputationBand = 'unproven' | 'active' | 'settled' | 'trusted' | 'contested';

export type Reputation = {
  address: Address;
  generatedAt: string;
  blockRange: { from: string; to: string };
  score: number;
  band: ReputationBand;
  /// Every point of the score, itemised. A reputation number nobody can
  /// decompose is just a rumour.
  factors: ScoreFactor[];
  asBuyer: {
    jobs: number;
    escrowed: Money;
    accepted: number;
    disputed: number;
    refunded: number;
  };
  asSeller: {
    jobs: number;
    earned: Money;
    accepted: number;
    disputed: number;
    verdicts: number;
    avgAwardBps: number | null;
    withdrawn: Money;
  };
  counters: {
    settled: number;
    open: number;
    disputesRaised: number;
    disputesAgainst: number;
    withdrawals: number;
    firstBlock: number | null;
    lastBlock: number | null;
  };
  proofJobIds: string[];
  /// How any third party recomputes this score without trusting the beacon.
  recipe: string[];
};

export function reputationFor(view: LedgerView, address: Address, decimals: number): Reputation {
  const target = address.toLowerCase();
  const asBuyerJobs = view.jobs.filter((job) => job.buyer.toLowerCase() === target);
  const asSellerJobs = view.jobs.filter((job) => job.seller.toLowerCase() === target);
  const withdrawals = view.withdrawals.filter((w) => w.account.toLowerCase() === target);

  let escrowed = ZERO;
  for (const job of asBuyerJobs) {
    if (job.funded) escrowed = add(escrowed, job.funded.amount, decimals);
  }
  let earned = ZERO;
  for (const job of asSellerJobs) {
    if (job.accepted) earned = add(earned, job.accepted.sellerAmount, decimals);
    if (job.verdict) earned = add(earned, job.verdict.sellerAmount, decimals);
  }
  let withdrawn = ZERO;
  for (const entry of withdrawals) withdrawn = add(withdrawn, entry.amount, decimals);

  const settled =
    asSellerJobs.filter((job) => job.accepted || job.verdict).length +
    asBuyerJobs.filter((job) => job.accepted || job.verdict || job.refund).length;
  const open = [...asBuyerJobs, ...asSellerJobs].filter(
    (job) => job.stage === 'created' || job.stage === 'funded' || job.stage === 'delivered',
  ).length;
  const disputesRaised = asBuyerJobs.filter((job) => job.dispute).length;
  const disputesAgainst = asSellerJobs.filter((job) => job.dispute).length;
  const awards = asSellerJobs.flatMap((job) => (job.verdict ? [job.verdict.sellerAwardBps] : []));
  const avgAwardBps = awards.length ? Math.round(sum(awards) / awards.length) : null;

  const blocks = [...asBuyerJobs, ...asSellerJobs]
    .flatMap((job) => [job.created.block])
    .filter((block) => block > 0);

  const factors = scoreFactors({
    settledAsSeller: asSellerJobs.filter((job) => job.accepted || job.verdict).length,
    settledAsBuyer: asBuyerJobs.filter((job) => job.accepted || job.verdict || job.refund).length,
    disputesRaised,
    disputesAgainst,
    avgAwardBps,
    volume: BigInt(escrowed.units) + BigInt(earned.units),
    decimals,
  });

  const score = clamp(
    factors.reduce((total, factor) => total + factor.points, 0),
    0,
    1000,
  );

  return {
    address,
    generatedAt: new Date().toISOString(),
    blockRange: { from: view.fromBlock.toString(), to: view.toBlock.toString() },
    score,
    band: bandFor({ score, settled, open, disputesAgainst }),
    factors,
    asBuyer: {
      jobs: asBuyerJobs.length,
      escrowed,
      accepted: asBuyerJobs.filter((job) => job.accepted).length,
      disputed: disputesRaised,
      refunded: asBuyerJobs.filter((job) => job.refund).length,
    },
    asSeller: {
      jobs: asSellerJobs.length,
      earned,
      accepted: asSellerJobs.filter((job) => job.accepted).length,
      disputed: disputesAgainst,
      verdicts: awards.length,
      avgAwardBps,
      withdrawn,
    },
    counters: {
      settled,
      open,
      disputesRaised,
      disputesAgainst,
      withdrawals: withdrawals.length,
      firstBlock: blocks.length ? Math.min(...blocks) : null,
      lastBlock: blocks.length ? Math.max(...blocks) : null,
    },
    proofJobIds: [...asBuyerJobs, ...asSellerJobs].map((job) => job.jobId.toString()),
    recipe: [
      `eth_getLogs on the escrow from block ${view.fromBlock} to ${view.toBlock}`,
      'keep JobCreated where buyer or seller is this address',
      'fold JobFunded, JobDelivered, JobAccepted, DisputeRaised, VerdictResolved, JobRefunded, Withdrawal',
      'apply the factor table in packages/beacon/src/reputation.ts (score is the clamped sum)',
    ],
  };
}

type ScoreInput = {
  settledAsSeller: number;
  settledAsBuyer: number;
  disputesRaised: number;
  disputesAgainst: number;
  avgAwardBps: number | null;
  volume: bigint;
  decimals: number;
};

/// The scoring rule, in one place, in public.
///
/// Neutral by default: a fresh address scores 500, not 0, because Tempex's whole
/// pitch is that an agent with no history can still trade — escrow plus a referee
/// substitutes for reputation. History then moves the score in both directions.
export function scoreFactors(input: ScoreInput): ScoreFactor[] {
  const factors: ScoreFactor[] = [
    {
      label: 'baseline',
      points: 500,
      detail: 'every address starts neutral; escrow and arbitration stand in for history',
    },
  ];

  const sellerPoints = Math.min(240, input.settledAsSeller * 60);
  if (sellerPoints) {
    factors.push({
      label: 'settled-as-seller',
      points: sellerPoints,
      detail: `${input.settledAsSeller} job(s) delivered and paid out, +60 each, capped at +240`,
    });
  }

  const buyerPoints = Math.min(160, input.settledAsBuyer * 40);
  if (buyerPoints) {
    factors.push({
      label: 'settled-as-buyer',
      points: buyerPoints,
      detail: `${input.settledAsBuyer} job(s) closed as buyer, +40 each, capped at +160`,
    });
  }

  if (input.avgAwardBps !== null) {
    const points = clamp(Math.round((input.avgAwardBps - 5000) / 50), -100, 100);
    if (points !== 0) {
      factors.push({
        label: 'verdict-favour',
        points,
        detail: `arbiters awarded this seller ${input.avgAwardBps} bps on average; above 5000 earns, below costs`,
      });
    }
  }

  if (input.disputesAgainst) {
    factors.push({
      label: 'disputed-as-seller',
      points: -50 * input.disputesAgainst,
      detail: `${input.disputesAgainst} dispute(s) raised against this seller, -50 each`,
    });
  }

  if (input.disputesRaised > input.settledAsBuyer) {
    const excess = input.disputesRaised - input.settledAsBuyer;
    factors.push({
      label: 'dispute-happy-buyer',
      points: -25 * excess,
      detail: `${excess} dispute(s) beyond closed deals; buyers who litigate everything are a signal too`,
    });
  }

  const tier = Number(input.volume / 10n ** BigInt(input.decimals));
  if (tier > 0) {
    factors.push({
      label: 'volume',
      points: clamp(tier, 0, 100),
      detail: `+1 per whole token settled through escrow, capped at +100`,
    });
  }

  return factors;
}

function bandFor(input: {
  score: number;
  settled: number;
  open: number;
  disputesAgainst: number;
}): ReputationBand {
  if (input.settled === 0 && input.open === 0) return 'unproven';
  if (input.disputesAgainst > input.settled) return 'contested';
  if (input.score >= 700) return 'trusted';
  if (input.settled > 0) return 'settled';
  return 'active';
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
