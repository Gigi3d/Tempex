import {
  domainFor,
  hashCanonical,
  hashText,
  recoverVerdictSigner,
  responseHashOf,
  signVerdict,
  verdictFromRuling,
  type EvidenceCase,
  type Ruling,
  type TempexClient,
  type VerdictStruct,
  type WriteOptions,
  SELLER_RESPONSE_WINDOW_SECONDS,
  awardBounds,
  disputeSettlement,
  fetchDeliverable,
} from '@tempex/sdk';
import { decodeEventLog, parseAbiItem, type Address, type Hex } from 'viem';

import { analyze, composeRuleRationale, type RuleBand, type RuleSignals } from './rules.js';
import { clampToBand, withinOffers } from './guardrail.js';

const VERDICT_RESOLVED = parseAbiItem(
  'event VerdictResolved(uint256 indexed jobId, uint16 sellerAwardBps, uint256 sellerAmount, uint256 buyerAmount, uint256 arbitrationFee, bytes32 evidenceHash, bytes32 rationaleHash, bytes32 verdictDigest)',
);

/// Room between the host clock and the chain clock. A verdict marked valid from
/// "now" reverts if this machine's clock runs a few seconds ahead of the block
/// that executes it; a small backdating makes the window robust without changing
/// what it means.
const ISSUED_AT_SKEW_SECONDS = 30;
const DEFAULT_TTL_SECONDS = 86_400;
const ZERO_HASH = `0x${'0'.repeat(64)}`;

/// The settlement rule's name, recorded in every ruling so a reader knows which
/// arithmetic produced it.
export const RULE_ENGINE_MODEL = 'tempex-rules/1';

/// Raised when the arbiter will not sign. Distinct from a crash: a refusal is the
/// system working, and the reasons are meant to be read out.
export class RefusalError extends Error {
  override readonly name = 'RefusalError';
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`arbiter refused to rule: ${reasons.join('; ')}`);
    this.reasons = reasons;
  }
}

export type RelayReceipt = {
  jobId: number;
  hash: Hex;
  /// digest stored by the escrow in the VerdictResolved event
  digest: Hex;
  sellerAwardBps: number;
  sellerAmount: bigint;
  buyerAmount: bigint;
  arbitrationFee: bigint;
};

/// The ruling in money, as the escrow will compute it. The fee is charged before
/// the split, so the award in bps does not by itself say what either party
/// receives; a receipt that records only the bps leaves the reader to redo the
/// arithmetic against a fee schedule that may since have changed.
export type VerdictMoney = {
  amount: bigint;
  /// the buyer's dispute bond, settled with the ruling
  bond: bigint;
  /// the part of the bond forfeited to the seller
  bondToSeller: bigint;
  arbitrationFee: bigint;
  arbitrationFeeBps: number;
  /// everything credited to the seller, forfeited bond included
  sellerAmount: bigint;
  /// everything credited to the buyer, bond refund included
  buyerAmount: bigint;
};

export type AdjudicationResult = {
  jobId: number;
  engine: 'rules';
  model: string;
  amount: bigint;
  evidenceHash: Hex;
  ruling: Ruling;
  verdict: VerdictStruct;
  signature: Hex;
  digest: Hex;
  recovered: Address;
  registeredArbiter: Address;
  /// The range the parties' final offers allow, as the escrow enforces it.
  offers: { lowBps: number; highBps: number };
  /// The rule band narrowed to the offers: the range the settlement lands in.
  boundedBand: RuleBand;
  /// signature recovers to the registered arbiter AND the contract agrees with
  /// our digest. False here means the verdict would be rejected on chain.
  certified: boolean;
  money: VerdictMoney;
  band: RuleBand;
  signals: RuleSignals;
  clamped: boolean;
  flags: string[];
  notes: string[];
  relay?: RelayReceipt;
};

export type AdjudicateParams = {
  client: TempexClient;
  jobId: bigint;
  evidenceCase: EvidenceCase;
  ttlSeconds?: number;
  now?: number;
  dryRun?: boolean;
  relay?: boolean;
  /// Tempo knobs for the relay transaction: nonce lane, validity window, and
  /// whether a sponsor pays the fee.
  writeOptions?: WriteOptions;
  log?: (line: string) => void;
};

export { clampToBand, withinOffers };

/// Evidence bundle in, signed verdict out.
///
/// The order matters and is the point of the design: pin the evidence, run the
/// agreed checks, narrow the result to the range both parties offered, then
/// certify against the live contract before anything is broadcast. Every step is
/// arithmetic on public inputs, so anyone can re-derive the ruling.
export async function adjudicate(params: AdjudicateParams): Promise<AdjudicationResult> {
  const { client, jobId, evidenceCase } = params;
  const log = params.log ?? (() => {});
  const dryRun = params.dryRun ?? false;
  const jobIdNum = Number(jobId);
  const notes: string[] = [];

  const job = await client.job(jobId);
  const amount = job.amount;
  let response = evidenceCase.response;
  let evidenceClosedAt = 0;

  // ---- the evidence must be the evidence the buyer pinned on chain ----
  const evidenceHash = hashCanonical(evidenceCase.bundle);
  if (dryRun) {
    if (job.state !== 'Disputed') {
      notes.push(`dry run against job ${jobIdNum} in state ${job.state}; nothing will be relayed`);
    }
  } else {
    if (job.state !== 'Disputed') {
      throw new RefusalError([`job ${jobIdNum} is ${job.state}, not Disputed`]);
    }
    // Each job names its own arbiter. A verdict from any other key is one the
    // escrow rejects.
    if (job.arbiter.toLowerCase() !== client.address.toLowerCase()) {
      throw new RefusalError([
        `job ${jobIdNum} is assigned to arbiter ${job.arbiter}, not this key ${client.address}`,
      ]);
    }
    if (job.disputeHash !== evidenceHash) {
      throw new RefusalError([
        `bundle hashes to ${evidenceHash} but job ${jobIdNum} pinned ${job.disputeHash} at dispute time`,
      ]);
    }

    // ---- the seller is heard before anyone rules ----
    evidenceClosedAt = await client.evidenceClosedAt(jobId);
    if (evidenceClosedAt === 0) {
      throw new RefusalError([
        `job ${jobIdNum}: the seller can respond until ${new Date((job.disputedAt + SELLER_RESPONSE_WINDOW_SECONDS) * 1000).toISOString()}; no ruling before then unless it responds`,
      ]);
    }
    const responded = job.responseHash !== ZERO_HASH;
    if (responded) {
      if (response === undefined) {
        throw new RefusalError([
          `job ${jobIdNum}: the seller pinned response ${job.responseHash} but its response file is not on hand`,
        ]);
      }
      const responseHash = responseHashOf(response);
      if (responseHash !== job.responseHash) {
        throw new RefusalError([
          `seller response hashes to ${responseHash} but job ${jobIdNum} pinned ${job.responseHash}`,
        ]);
      }
    } else if (response !== undefined) {
      notes.push('a seller response file is on hand but was never pinned on chain; it was not considered');
      response = undefined;
    }
  }

  // ---- the work itself, from where the seller said it lives ----
  // Fetched rather than taken from either party, and trusted only if its bytes
  // reproduce the on-chain deliverableHash. A failed or mismatched fetch is noted
  // and the analysis falls back to the parties' copies.
  let fetched: { uri: string; text: string } | undefined;
  const uri = await client.deliverableURI(jobId).catch(() => '');
  if (uri !== '') {
    try {
      const got = await fetchDeliverable(uri);
      if (got.hash === job.deliverableHash) {
        fetched = { uri, text: got.text };
        log(`read the delivered work from ${uri.slice(0, 64)} (${got.bytes} bytes, hash matches)`);
      } else {
        notes.push(`the content at the delivery URI hashes to ${got.hash}, not the delivered ${job.deliverableHash}; it was not used`);
      }
    } catch (error) {
      notes.push(`could not read the delivery URI: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- objective signals and the band they imply ----
  const analysis = analyze({
    jobId: jobIdNum,
    job,
    terms: evidenceCase.terms,
    bundle: evidenceCase.bundle,
    ...(response !== undefined ? { response } : {}),
    ...(fetched !== undefined ? { fetched } : {}),
  });
  if (analysis.blocking.length > 0) throw new RefusalError(analysis.blocking);
  const { signals, band: ruleBand, flags } = analysis;

  // ---- the parties' final offers bound the band, as the escrow will ----
  const offers = awardBounds(job);
  const band = withinOffers(ruleBand, offers);
  if (band.lowBps !== ruleBand.lowBps || band.highBps !== ruleBand.highBps) {
    notes.push(
      `the parties' offers [${offers.lowBps}, ${offers.highBps}] narrowed the rule band [${ruleBand.lowBps}, ${ruleBand.highBps}] to [${band.lowBps}, ${band.highBps}]`,
    );
  }
  log(
    `band ${band.lowBps}-${band.highBps} bps (centre ${band.center}): checks earned ${signals.earnedWeight.toFixed(2)} of ${signals.checkedWeight} checked weight, ${signals.openWeight} of ${signals.totalWeight} without a check`,
  );

  // ---- settle: checks decide what they can, the rest splits at the midpoint ----
  // Verified credit is fixed. Weight no check could decide is neither awarded nor
  // refused: it splits evenly, the same neutral rule the escrow applies to a
  // lapsed dispute. The result is then held inside the parties' offers.
  const openWeight = signals.openWeight;
  if (openWeight === 0) notes.push('every criterion was decided by its check');
  else notes.push(`${openWeight} of ${signals.totalWeight} weight had no check; it splits at the midpoint of the band`);
  const rationale = composeRuleRationale({ jobId: jobIdNum, terms: evidenceCase.terms, signals, band, chosenBps: band.center });
  const engine = 'rules' as const;
  const model = RULE_ENGINE_MODEL;
  const { bps: chosenBps, clamped } = clampToBand(band.center, band);

  // ---- commit the ruling to a struct the escrow will accept ----
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const ruling: Ruling = {
    jobId: jobIdNum,
    sellerAwardBps: chosenBps,
    evidenceHash,
    rationaleHash: hashText(rationale),
    rationale,
    // Never earlier than the moment the seller's say closed: the escrow rejects a
    // verdict that predates the evidence it was supposed to weigh.
    issuedAt: Math.max(now - ISSUED_AT_SKEW_SECONDS, evidenceClosedAt),
    validUntil: now + (params.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    model,
  };
  const verdict = verdictFromRuling(ruling);
  const signature = await signVerdict(client.account, verdict, domainFor(client.addresses));

  // ---- certify: would the deployed escrow accept this exact verdict? ----
  const { local, onChain, matches } = await client.verdictEncoding(verdict);
  const recovered = await recoverVerdictSigner(verdict, signature, domainFor(client.addresses));
  // Certify against the arbiter and fee the job locked at creation, not the
  // escrow's current defaults: those apply to new jobs only.
  const registeredArbiter = job.arbiter;
  const arbitrationFeeBps = job.arbitrationFeeBps;

  const signerIsArbiter = recovered.toLowerCase() === registeredArbiter.toLowerCase();
  const certified = matches && signerIsArbiter;
  if (!matches) {
    notes.push('the deployed escrow disagrees with the off-chain digest for this verdict');
  }
  if (!signerIsArbiter) {
    notes.push(
      `signature recovers to ${recovered} but the escrow's arbiter is ${registeredArbiter}`,
    );
  }
  log(`digest ${local} ${matches ? '== ' : '!= '} on-chain ${onChain}`);
  log(`signature recovers to ${recovered}${signerIsArbiter ? ' (registered arbiter)' : ' (NOT the arbiter)'}`);

  // ---- the ruling in money, using the fee this job locked at creation ----
  // Read from the escrow itself: since v3 a job may also lock a minimum fee,
  // and the escrow's arithmetic is the one that pays out.
  const arbitrationFee = await client.arbitrationFee(jobId);
  const settlement = disputeSettlement({ amount, arbitrationFeeBps, sellerAwardBps: chosenBps, arbitrationFee });
  const money: VerdictMoney = {
    amount,
    bond: settlement.bond,
    bondToSeller: settlement.bondToSeller,
    arbitrationFee: settlement.arbitrationFee,
    arbitrationFeeBps,
    sellerAmount: settlement.sellerAmount,
    buyerAmount: settlement.buyerAmount,
  };

  const result: AdjudicationResult = {
    jobId: jobIdNum,
    engine,
    model,
    amount,
    evidenceHash,
    ruling,
    verdict,
    signature,
    digest: local,
    recovered,
    registeredArbiter,
    certified,
    money,
    band: ruleBand,
    offers,
    boundedBand: band,
    signals,
    clamped,
    flags,
    notes,
  };

  if (params.relay) {
    if (dryRun) throw new Error('relay requested on a dry run');
    if (!certified) {
      throw new RefusalError([
        'refusing to relay: the deployed escrow would not accept this verdict',
      ]);
    }
    const receipt = await client.resolve(jobId, verdict, signature, params.writeOptions ?? {});
    const relay = decodeVerdictResolved(receipt.logs, client.addresses.escrow);
    if (relay === null) {
      throw new Error(`resolve tx ${receipt.transactionHash} emitted no VerdictResolved event`);
    }
    if (relay.digest.toLowerCase() !== local.toLowerCase()) {
      throw new Error(
        `escrow stored digest ${relay.digest} but the arbiter signed ${local}`,
      );
    }
    // The prediction in the receipt must be the transfer that actually happened.
    if (
      relay.sellerAmount !== money.sellerAmount ||
      relay.buyerAmount !== money.buyerAmount ||
      relay.arbitrationFee !== money.arbitrationFee
    ) {
      throw new Error(
        `escrow paid seller ${relay.sellerAmount} / buyer ${relay.buyerAmount} / fee ${relay.arbitrationFee}, but the ruling predicted ${money.sellerAmount} / ${money.buyerAmount} / ${money.arbitrationFee}`,
      );
    }
    result.relay = { ...relay, hash: receipt.transactionHash };
    log(`relayed resolve in ${receipt.transactionHash}`);
  }

  return result;
}

/// Reads the escrow's arbiter address and arbitration fee together: every verdict
/// is certified against both, and since they live in the same contract the two
/// reads belong in one place.
export async function escrowArbiterConfig(
  client: TempexClient,
): Promise<{ arbiter: Address; arbitrationFeeBps: number }> {
  const abi = [
    {
      type: 'function',
      name: 'arbiter',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'address' }],
    },
    {
      type: 'function',
      name: 'arbitrationFeeBps',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint16' }],
    },
  ] as const;

  const [arbiter, feeBps] = await Promise.all([
    client.viem.readContract({
      address: client.addresses.escrow,
      abi,
      functionName: 'arbiter',
    }),
    client.viem.readContract({
      address: client.addresses.escrow,
      abi,
      functionName: 'arbitrationFeeBps',
    }),
  ]);

  return { arbiter: arbiter as Address, arbitrationFeeBps: Number(feeBps) };
}

/// Reads the escrow's own record of a settlement out of a `resolve` receipt.
/// Exported so any consumer relaying a verdict can check the money the escrow
/// actually moved against the money the ruling predicted, from one decoder.
export function decodeVerdictResolved(
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
  escrow: Address,
): Omit<RelayReceipt, 'hash'> | null {
  for (const entry of logs) {
    if (entry.address.toLowerCase() !== escrow.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [VERDICT_RESOLVED],
        data: entry.data,
        topics: entry.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'VerdictResolved') continue;
      const args = decoded.args;
      return {
        jobId: Number(args.jobId),
        digest: args.verdictDigest,
        sellerAwardBps: Number(args.sellerAwardBps),
        sellerAmount: args.sellerAmount,
        buyerAmount: args.buyerAmount,
        arbitrationFee: args.arbitrationFee,
      };
    } catch {
      // not a VerdictResolved log; keep scanning
    }
  }
  return null;
}
