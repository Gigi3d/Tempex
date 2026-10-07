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

import { judgePanel, llmConfigFromEnv, type CompleteFn, type LlmConfig, type PanelVerdict } from './llm.js';
import { buildJudgePrompt, SYSTEM_PROMPT } from './prompt.js';
import { analyze, composeRuleRationale, type RuleBand, type RuleSignals } from './rules.js';
import { clamp, clampToBand, withinOffers } from './guardrail.js';

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
  /// The range the parties' final offers allow, as the escrow enforces it.
  offers: { lowBps: number; highBps: number };
  /// The rule band narrowed to the offers: the range the judge was clamped into.
  boundedBand: RuleBand;
  /// signature recovers to the registered arbiter AND the contract agrees with
  /// our digest. False here means the verdict would be rejected on chain.
  certified: boolean;
  money: VerdictMoney;
  band: RuleBand;
  signals: RuleSignals;
  requestedBps?: number;
  /// The judge panel's scores on the open criteria, member by member, with the
  /// quotes that were verified and the scores that were discarded.
  panel?: PanelVerdict;
  /// Set when a panel was configured but could not rule, so the open criteria
  /// stood at the neutral midpoint instead. Operators must see this: a dead key
  /// would otherwise turn every ruling into a rule-engine ruling unnoticed.
  panelFallback?: string;
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
  /// The model call, injectable so the panel can be exercised without a network.
  completeFn?: CompleteFn;
  /// Remembers panel verdicts by their exact inputs, so a retry after a failed
  /// relay re-signs the same scores instead of paying the panel again (and
  /// possibly drawing different ones).
  panelCache?: PanelCache;
};

export type PanelCache = {
  get(key: string): PanelVerdict | undefined;
  set(key: string, verdict: PanelVerdict): void;
};

/// The award a panel's scores imply: verified credit plus each open criterion's
/// weight times its panel score, over the total weight. Inside the rule band by
/// construction, since every open score is between 0 and 1.
export function panelAward(signals: RuleSignals, panel: PanelVerdict): number {
  if (signals.totalWeight <= 0) return 0;
  const scores = new Map(panel.criteria.map((c) => [c.id, c.score]));
  const judged = signals.criteria
    .filter((c) => c.kind !== 'check')
    .reduce((sum, c) => sum + c.weight * (scores.get(c.id) ?? 0.5), 0);
  return clamp(Math.round((10_000 * (signals.earnedWeight + judged)) / signals.totalWeight), 0, 10_000);
}

/// Deterministic prose for a panel ruling: what code decided, what each open
/// criterion scored and on what evidence, and what the panel discarded.
function composePanelRationale(input: {
  signals: RuleSignals;
  panel: PanelVerdict;
  proposalBps: number;
}): string {
  const { signals, panel, proposalBps } = input;
  const lines: string[] = [`Ruled by a ${panel.label}, scoring only the criteria code could not decide.`];
  for (const c of signals.criteria.filter((criterion) => criterion.kind === 'check')) {
    lines.push(`${c.id}: decided by its ${c.check} check, earned ${c.credit!.toFixed(2)} of weight ${c.weight}; ${c.evidence}.`);
  }
  for (const c of panel.criteria) {
    const quotes = panel.members
      .flatMap((m) => m.scores?.find((s) => s.id === c.id)?.verifiedQuotes ?? [])
      .slice(0, 2)
      .map((q) => JSON.stringify(q.slice(0, 80)));
    lines.push(
      `${c.id}: panel median ${c.score.toFixed(2)} from ${c.accepted} accepted score(s)${c.discarded > 0 ? `, ${c.discarded} discarded for claiming credit without a verifiable quote` : ''}${c.neutral ? '; no judge supported it, so it stands at the neutral 0.50' : ''}${quotes.length > 0 ? `; evidence ${quotes.join(', ')}` : ''}.`,
    );
  }
  const failed = panel.members.filter((m) => m.scores === null).length;
  if (failed > 0) lines.push(`${failed} of ${panel.members.length} judges failed and were not counted.`);
  const voice = panel.members.find((m) => m.scores !== null && m.rationale !== '')?.rationale;
  if (voice) lines.push(`A judge's reasoning: ${voice}`);
  lines.push(`Weighted award ${proposalBps} bps.`);
  return lines.join(' ');
}

export { clampToBand, withinOffers };

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
    // Each job names its own arbiter. Spending a model call on a dispute this key
    // cannot sign for would produce a verdict the escrow rejects.
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
    `band ${band.lowBps}-${band.highBps} bps (centre ${band.center}): checks earned ${signals.earnedWeight.toFixed(2)} of ${signals.checkedWeight} checked weight, ${signals.openWeight} of ${signals.totalWeight} left to judgement`,
  );

  // ---- judgement: a panel scores the open criteria, the rule engine otherwise ----
  // When every criterion was decided by a check there is nothing to judge, and
  // no model is asked: the band is a single point.
  const llmConfig = params.llm === undefined ? llmConfigFromEnv() : params.llm;
  const engineWanted = params.engine ?? 'auto';
  const openIds = signals.criteria.filter((c) => c.kind !== 'check').map((c) => c.id);
  let engine: 'llm' | 'rules' = 'rules';
  let model = RULE_ENGINE_MODEL;
  let requestedBps: number | undefined;
  let panel: PanelVerdict | undefined;
  let panelFallback: string | undefined;
  let rationale: string | undefined;
  const ruleRationale = (): string =>
    composeRuleRationale({ jobId: jobIdNum, terms: evidenceCase.terms, signals, band, chosenBps: band.center });

  if (engineWanted === 'llm' && llmConfig === null) {
    throw new RefusalError(['engine "llm" was requested but no OPENAI_API_KEY is configured']);
  }
  if (openIds.length === 0) {
    notes.push('every criterion was decided by its check; no judgement was needed');
  } else if (engineWanted === 'rules' || llmConfig === null) {
    if (llmConfig === null && engineWanted === 'auto') {
      notes.push('no OPENAI_API_KEY configured; open criteria stand at the neutral midpoint');
    }
  } else {
    const user = buildJudgePrompt({
      jobId: jobIdNum,
      job,
      terms: evidenceCase.terms,
      bundle: evidenceCase.bundle,
      ...(response !== undefined ? { response } : {}),
      ...(fetched !== undefined ? { fetched } : {}),
      signals,
      band,
    });
    // Everything the panel sees, and who sits on it: the same key means the
    // same question to the same judges, so the stored answer stands.
    const cacheKey = hashText(
      [SYSTEM_PROMPT, user, llmConfig.models.join(','), String(llmConfig.panelSize)].join('\n\u0000\n'),
    ).slice(2);
    try {
      const cached = params.panelCache?.get(cacheKey);
      if (cached) {
        panel = cached;
        notes.push('judge panel scores reused from an earlier attempt on the same inputs; the panel was not asked again');
        log(`${panel.label}: reused cached scores`);
      } else {
        panel = await judgePanel({
          config: llmConfig,
          system: SYSTEM_PROMPT,
          user,
          openIds,
          deliverable: signals.deliverableText,
          ...(params.completeFn !== undefined ? { completeFn: params.completeFn } : {}),
        });
        params.panelCache?.set(cacheKey, panel);
        log(`${panel.label} used ${panel.usage.inputTokens} input + ${panel.usage.outputTokens} output tokens`);
      }
      engine = 'llm';
      model = panel.label;
      requestedBps = panelAward(signals, panel);
      rationale = composePanelRationale({ signals, panel, proposalBps: requestedBps });
      for (const c of panel.criteria) {
        log(`${c.id}: median ${c.score.toFixed(2)} (${c.accepted} accepted, ${c.discarded} discarded)`);
      }
      const failed = panel.members.filter((m) => m.scores === null);
      for (const member of failed) notes.push(`judge ${member.seat + 1} (${member.model}) failed: ${member.error}`);
      if (failed.length > 0) flags.push(`judge panel short-handed: ${failed.length} of ${panel.members.length} judges failed`);
      log(`${panel.label} proposed ${requestedBps} bps`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (engineWanted === 'llm') throw error;
      panelFallback = reason;
      flags.push('judge panel unavailable: ruled by the rule engine with open criteria at the neutral midpoint');
      notes.push(`judge panel unavailable (${reason}); open criteria stand at the neutral midpoint`);
      log(`WARNING judge panel unavailable: ${reason}`);
    }
  }
  rationale ??= ruleRationale();

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

  // ---- the ruling in money, using the fee rate this job locked at creation ----
  const settlement = disputeSettlement({ amount, arbitrationFeeBps, sellerAwardBps: chosenBps });
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
    ...(requestedBps !== undefined ? { requestedBps } : {}),
    ...(panel !== undefined ? { panel } : {}),
    ...(panelFallback !== undefined ? { panelFallback } : {}),
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
