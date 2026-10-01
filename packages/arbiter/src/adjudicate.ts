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
} from '@tempex/sdk';
import { decodeEventLog, parseAbiItem, type Address, type Hex } from 'viem';

import { judgeWithLlm, llmConfigFromEnv, type LlmConfig } from './llm.js';
import { buildJudgePrompt, SYSTEM_PROMPT } from './prompt.js';
import { analyze, composeRuleRationale, type RuleBand, type RuleSignals } from './rules.js';

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

/// The name that shows up in receipts when no model was in the loop.
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

export type AdjudicationEngine = 'auto' | 'rules' | 'llm';

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
  arbitrationFee: bigint;
  arbitrationFeeBps: number;
  sellerAmount: bigint;
  buyerAmount: bigint;
};

export type AdjudicationResult = {
  jobId: number;
  engine: 'llm' | 'rules';
  model: string;
  amount: bigint;
  evidenceHash: Hex;
  ruling: Ruling;
  verdict: VerdictStruct;
  signature: Hex;
  digest: Hex;
  recovered: Address;
  registeredArbiter: Address;
  /// signature recovers to the registered arbiter AND the contract agrees with
  /// our digest. False here means the verdict would be rejected on chain.
  certified: boolean;
  money: VerdictMoney;
  band: RuleBand;
  signals: RuleSignals;
  requestedBps?: number;
  clamped: boolean;
  flags: string[];
  notes: string[];
  relay?: RelayReceipt;
};

export type AdjudicateParams = {
  client: TempexClient;
  jobId: bigint;
  evidenceCase: EvidenceCase;
  engine?: AdjudicationEngine;
  llm?: LlmConfig | null;
  ttlSeconds?: number;
  now?: number;
  dryRun?: boolean;
  relay?: boolean;
  /// Tempo knobs for the relay transaction: nonce lane, validity window, and
  /// whether a sponsor pays the fee.
  writeOptions?: WriteOptions;
  log?: (line: string) => void;
};

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/// The guardrail, in one place: whatever a judge proposes is pulled into the band
/// the objective signals justify. Exported so it can be exercised without a live
/// dispute — this is the line the "bounded judge" claim rests on.
export function clampToBand(
  requestedBps: number,
  band: RuleBand,
): { bps: number; clamped: boolean } {
  const bps = clamp(requestedBps, band.lowBps, band.highBps);
  return { bps, clamped: bps !== requestedBps };
}

/// Evidence bundle in, signed verdict out.
///
/// The order matters and is the point of the design: pin the evidence, derive the
/// objective band, let the judge speak inside it, then certify against the live
/// contract before anything is broadcast. Nothing is signed until the text
/// signals have been computed, and nothing is relayed until the deployed escrow
/// has confirmed it would accept the signature.
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

  // ---- objective signals and the band they imply ----
  const analysis = analyze({
    jobId: jobIdNum,
    job,
    terms: evidenceCase.terms,
    bundle: evidenceCase.bundle,
    ...(response !== undefined ? { response } : {}),
  });
  if (analysis.blocking.length > 0) throw new RefusalError(analysis.blocking);
  const { signals, band, flags } = analysis;
  log(
    `objective band ${band.lowBps}-${band.highBps} bps (centre ${band.center}); coverage ${
      signals.coverage === null ? 'n/a' : signals.coverage.toFixed(2)
    }, evidence strength ${signals.evidenceStrength.toFixed(2)}, claim ${signals.corroboration}`,
  );

  // ---- judgement: the model when configured, the rule engine otherwise ----
  const llmConfig = params.llm === undefined ? llmConfigFromEnv() : params.llm;
  const engineWanted = params.engine ?? 'auto';
  let engine: 'llm' | 'rules' = 'rules';
  let model = RULE_ENGINE_MODEL;
  let requestedBps: number | undefined;
  let confidence: number | undefined;
  let factors: string[] = [];
  let rationale: string;

  if (engineWanted === 'rules' || llmConfig === null) {
    if (engineWanted === 'llm' && llmConfig === null) {
      throw new RefusalError(['engine "llm" was requested but no OPENAI_API_KEY is configured']);
    }
    rationale = composeRuleRationale({
      jobId: jobIdNum,
      terms: evidenceCase.terms,
      signals,
      band,
      chosenBps: band.center,
    });
    if (llmConfig === null && engineWanted === 'auto') {
      notes.push('no OPENAI_API_KEY configured; ruled by the deterministic rule engine');
    }
  } else {
    try {
      const outcome = await judgeWithLlm({
        config: llmConfig,
        system: SYSTEM_PROMPT,
        user: buildJudgePrompt({
          jobId: jobIdNum,
          job,
          terms: evidenceCase.terms,
          bundle: evidenceCase.bundle,
          ...(response !== undefined ? { response } : {}),
          signals,
          band,
        }),
      });
      engine = 'llm';
      model = outcome.model;
      requestedBps = outcome.ruling.sellerAwardBps;
      confidence = outcome.ruling.confidence;
      factors = outcome.ruling.factors;
      rationale = outcome.ruling.rationale;
      if (outcome.unconstrainedFormat) {
        notes.push('judge endpoint rejected JSON mode; fell back to a plain completion');
      }
      log(`judge ${model} proposed ${requestedBps} bps`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (engineWanted === 'llm') throw error;
      notes.push(`judge unavailable (${reason}); ruled by the deterministic rule engine`);
      log(`judge unavailable: ${reason}`);
      rationale = composeRuleRationale({
        jobId: jobIdNum,
        terms: evidenceCase.terms,
        signals,
        band,
        chosenBps: band.center,
      });
    }
  }

  // ---- clamp the judge into the band derived from facts ----
  const candidate = requestedBps ?? band.center;
  const { bps: chosenBps, clamped } = clampToBand(candidate, band);
  if (clamped) {
    notes.push(
      `ruling clamped from ${candidate} bps into the objective band [${band.lowBps}, ${band.highBps}]`,
    );
    log(`clamped ${candidate} -> ${chosenBps} bps (band ${band.lowBps}-${band.highBps})`);
  }

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
    ...(confidence !== undefined ? { confidence } : {}),
    ...(factors.length > 0 ? { factors } : {}),
  };
  const verdict = verdictFromRuling(ruling);
  const signature = await signVerdict(client.account, verdict, domainFor(client.addresses));

  // ---- certify: would the deployed escrow accept this exact verdict? ----
  const { local, onChain, matches } = await client.verdictEncoding(verdict);
  const recovered = await recoverVerdictSigner(verdict, signature, domainFor(client.addresses));
  const { arbiter: registeredArbiter, arbitrationFeeBps } = await escrowArbiterConfig(client);

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

  // ---- the ruling in money, using the fee schedule the escrow holds now ----
  const arbitrationFee = (amount * BigInt(arbitrationFeeBps)) / 10_000n;
  const remaining = amount - arbitrationFee;
  const sellerAmount = (remaining * BigInt(chosenBps)) / 10_000n;
  const money: VerdictMoney = {
    amount,
    arbitrationFee,
    arbitrationFeeBps,
    sellerAmount,
    buyerAmount: remaining - sellerAmount,
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
    band,
    signals,
    ...(requestedBps !== undefined ? { requestedBps } : {}),
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
