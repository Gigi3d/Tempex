import type { Address, Hex } from 'viem';

/// Pure job math, mirrored line for line from `TempexEscrow`. No network, no
/// filesystem: safe to import in a browser through `@tempex/sdk/browser`.

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
  /// for jobs settled by the house arbiter.
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

/// The fee a ruling charges. A mirror of `TempexEscrow.arbitrationFee`: the
/// job's locked rate, raised to its locked floor when the rate is not zero, and
/// never more than the job amount. Escrows before v3 have no floor (0).
export function arbitrationFeeFor(params: {
  amount: bigint;
  arbitrationFeeBps: number;
  arbitrationFeeFloor?: bigint;
}): bigint {
  if (params.arbitrationFeeBps === 0) return 0n;
  let fee = (params.amount * BigInt(params.arbitrationFeeBps)) / 10_000n;
  const floor = params.arbitrationFeeFloor ?? 0n;
  if (fee < floor) fee = floor;
  if (fee > params.amount) fee = params.amount;
  return fee;
}

/// What a ruling pays each side, bond included. A line-for-line mirror of
/// `TempexEscrow.disputeSettlement`, so a receipt can predict the exact credits
/// before the verdict is relayed: loser pays the fee, the buyer's share comes out
/// of its bond first, and the rest of the bond follows the award.
export function disputeSettlement(params: {
  amount: bigint;
  arbitrationFeeBps: number;
  sellerAwardBps: number;
  /// the job's locked minimum fee (v3 escrows); ignored when `arbitrationFee` is given
  arbitrationFeeFloor?: bigint;
  /// the exact fee, as `TempexEscrow.arbitrationFee(jobId)` reports it
  arbitrationFee?: bigint;
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
  const fee =
    params.arbitrationFee ??
    arbitrationFeeFor({
      amount,
      arbitrationFeeBps: params.arbitrationFeeBps,
      ...(params.arbitrationFeeFloor !== undefined ? { arbitrationFeeFloor: params.arbitrationFeeFloor } : {}),
    });
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
