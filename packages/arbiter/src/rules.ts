import {
  hashCanonical,
  hashText,
  normalizeCriteria,
  type EvidenceBundle,
  type Job,
  type JobTerms,
  type NormalizedCriterion,
  type SellerResponse,
} from '@tempex/sdk';

import { checkProblem, runCheck } from './checks.js';

/// The rule layer decides only what code can verify, and nothing else.
///
/// Each acceptance criterion in the terms is either a check (a pure function of
/// the delivered bytes: keys present, schema satisfied, language detected, values
/// matching a pattern) or a judgement (anything no code can decide, such as "reads
/// naturally"). Checks are decided exactly and earn their weight in proportion to
/// what they verified. Judgements are left open for the judge, bounded on chain by
/// the parties' final offers.
///
/// So the band is exactly as tight as what was verified:
///   lowBps  = verified credit / total weight
///   highBps = lowBps + open weight / total weight
/// All checks: the band is a single point and no model is needed. All judgement:
/// the band is the full range, and only the offers bound the ruling.
///
/// There is deliberately no keyword scoring. Counting words a criterion shares
/// with a deliverable measures vocabulary, not delivery: it gave honest work in
/// other words near zero and pasted-back criteria full marks.

export type CriterionResult = {
  id: string;
  text: string;
  weight: number;
  /// 'check' was decided by code; 'judge' is left to the judge; 'open' is a
  /// check that could not be applied (unverified deliverable, defective terms)
  /// and is left open like a judgement.
  kind: 'check' | 'judge' | 'open';
  /// the check type, for 'check' and 'open' criteria that carry one
  check?: string;
  /// share of the weight earned, 0..1; set for 'check' criteria only
  credit?: number;
  passed?: boolean;
  /// what was measured, or why the criterion is open
  evidence: string;
};

export type RuleSignals = {
  criteria: CriterionResult[];
  totalWeight: number;
  /// weight decided by checks, and the credit those checks earned
  checkedWeight: number;
  earnedWeight: number;
  /// weight left to the judge: judgement criteria plus checks left open
  openWeight: number;
  artifactsDeclared: number;
  artifactsVerifiable: number;
  /// share of declared artifacts whose claimed hash their own content produces.
  /// Neutral (1) when no artifacts are declared: silence is not a strike.
  evidenceStrength: number;
  integrity: {
    termsHashMatches: boolean;
    /// the deliverable text being checked hashes to the on-chain delivery commitment
    deliverableHashMatches: boolean;
  };
  /// Whose copy of the deliverable was checked. Only a copy whose content hashes
  /// to the on-chain commitment counts as verified.
  scoredCopy: 'uri' | 'buyer' | 'seller' | 'unverified';
  /// The verified deliverable text, so the judge and its citations read the same
  /// bytes the checks did. Undefined when no copy verified.
  deliverableText?: string;
  /// The seller pinned a response to the dispute.
  sellerResponded: boolean;
};

export type RuleBand = {
  center: number;
  lowBps: number;
  highBps: number;
};

export type RuleAnalysis = {
  signals: RuleSignals;
  band: RuleBand;
  /// Hard stops. No signature may be produced while any of these is set.
  blocking: string[];
  /// Soft observations carried into the ruling and the receipt.
  flags: string[];
};

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

export const formatBps = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

/// Everything the arbiter knows before judgement: which copy of the work is the
/// delivered one, what each checkable criterion earned on it, and how much weight
/// is left to judgement.
///
/// Deterministic on purpose. Same files in, same band out, on any machine, with
/// no model in the loop, so a ruling can be re-derived and argued with.
export function analyze(input: {
  jobId: number;
  job: Job;
  terms: JobTerms;
  bundle: EvidenceBundle;
  response?: SellerResponse;
  /// The work as fetched from the URI the seller recorded at delivery, if any.
  fetched?: { uri: string; text: string };
}): RuleAnalysis {
  const { jobId, job, terms, bundle, response, fetched } = input;
  const blocking: string[] = [];
  const flags: string[] = [];

  // ---- integrity: the ruling must be bound to this job's own commitments ----
  const termsHashMatches = hashCanonical(terms) === job.termsHash;
  if (!termsHashMatches) {
    blocking.push(`terms document does not hash to the on-chain termsHash of job ${jobId}`);
  }
  if (bundle.termsHash !== job.termsHash) {
    blocking.push('bundle pins a different termsHash than the on-chain job');
  }
  if (bundle.jobId !== jobId) {
    blocking.push(`bundle is for job ${bundle.jobId}, not job ${jobId}`);
  }
  if (bundle.version !== 1) {
    blocking.push(`unsupported bundle version ${String(bundle.version)}`);
  }
  if (bundle.claim.trim().length < 16) {
    blocking.push('claim is empty or too short to adjudicate');
  }
  let criteria: NormalizedCriterion[] = [];
  try {
    criteria = normalizeCriteria(terms.acceptanceCriteria);
  } catch (error) {
    blocking.push(`the terms' criteria are malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (terms.acceptanceCriteria.length === 0) {
    blocking.push('terms carry no acceptance criteria to rule on');
  }

  // ---- which copy of the deliverable to check ----
  // The chain holds only the deliverable's hash. A declared contentHash proves
  // nothing on its own, so a copy counts only if its content reproduces the
  // on-chain commitment. The copy fetched from the delivery URI outranks both
  // parties'; then the buyer's; then the seller's. Neither side can win by
  // describing work the other side never saw.
  const verifies = (content: string | undefined): content is string =>
    content !== undefined && hashText(content) === job.deliverableHash;
  const buyerCopy = bundle.deliverable.content;
  const sellerCopy = response?.deliverable.content;
  let scoredCopy: RuleSignals['scoredCopy'] = 'unverified';
  let deliverableText: string | undefined;
  if (verifies(fetched?.text)) {
    scoredCopy = 'uri';
    deliverableText = fetched.text;
    if (buyerCopy !== undefined && !verifies(buyerCopy)) {
      flags.push(
        "the buyer's copy of the deliverable does not match the work at the delivery URI; checked the work itself",
      );
    }
  } else if (verifies(buyerCopy)) {
    scoredCopy = 'buyer';
    deliverableText = buyerCopy;
  } else if (verifies(sellerCopy)) {
    scoredCopy = 'seller';
    deliverableText = sellerCopy;
    flags.push(
      buyerCopy === undefined
        ? "the buyer's bundle carries no deliverable text; checked the seller's copy, which hashes to the on-chain delivery"
        : "the buyer's copy of the deliverable does not hash to the on-chain delivery; checked the seller's copy, which does",
    );
  } else {
    flags.push(
      `no copy of the deliverable hashes to the on-chain delivery ${job.deliverableHash}; no check can be applied, so every criterion is left open`,
    );
  }
  const deliverableHashMatches = scoredCopy !== 'unverified';
  if (response === undefined && job.disputedAt > 0) {
    flags.push('the seller did not respond to the dispute within its response window');
  }

  // ---- each criterion: decided by its check, or left open ----
  const results: CriterionResult[] = criteria.map((criterion): CriterionResult => {
    const base = { id: criterion.id, text: criterion.text, weight: criterion.weight };
    if (criterion.check === undefined) {
      return { ...base, kind: 'judge', evidence: 'a judgement criterion: no check can decide it' };
    }
    const type = String((criterion.check as { type?: unknown }).type);
    const problem = checkProblem(criterion.check);
    if (problem !== null) {
      flags.push(`criterion ${criterion.id}'s check cannot be applied (${problem}); it is left to judgement`);
      return { ...base, kind: 'open', check: type, evidence: `the agreed check is defective: ${problem}` };
    }
    if (deliverableText === undefined) {
      return { ...base, kind: 'open', check: type, evidence: 'no verified copy of the deliverable to check' };
    }
    const outcome = runCheck(criterion.check, deliverableText);
    return {
      ...base,
      kind: 'check',
      check: type,
      credit: outcome.credit,
      passed: outcome.passed,
      evidence: outcome.evidence,
    };
  });

  // ---- evidence strength: does the bundle verify against itself? ----
  const artifactsDeclared = bundle.artifacts.length;
  let artifactsVerifiable = 0;
  bundle.artifacts.forEach((artifact, index) => {
    if (artifact.content === undefined || artifact.content.length === 0) {
      if (artifact.uri === undefined) {
        flags.push(`artifact ${index + 1} (${artifact.label}) has neither content nor uri`);
      }
      return;
    }
    if (artifact.contentHash !== undefined && artifact.contentHash !== hashText(artifact.content)) {
      flags.push(`artifact ${index + 1} (${artifact.label}) declares a hash its own content does not produce`);
      return;
    }
    artifactsVerifiable += 1;
  });
  const evidenceStrength = artifactsDeclared === 0 ? 1 : artifactsVerifiable / artifactsDeclared;

  // ---- the band: verified credit is fixed, open weight is the judge's ----
  const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
  const checked = results.filter((r) => r.kind === 'check');
  const checkedWeight = checked.reduce((sum, r) => sum + r.weight, 0);
  const earnedWeight = checked.reduce((sum, r) => sum + r.weight * (r.credit ?? 0), 0);
  const openWeight = totalWeight - checkedWeight;

  const toBps = (weight: number): number =>
    totalWeight > 0 ? clamp(Math.round((10_000 * weight) / totalWeight), 0, 10_000) : 0;
  const lowBps = totalWeight > 0 ? toBps(earnedWeight) : 0;
  const highBps = totalWeight > 0 ? clamp(toBps(earnedWeight + openWeight), lowBps, 10_000) : 10_000;
  // With no model, open weight is neither awarded nor refused: the centre splits
  // it evenly, the same neutral rule the escrow applies to a lapsed dispute.
  const band: RuleBand = { lowBps, highBps, center: Math.round((lowBps + highBps) / 2) };

  const signals: RuleSignals = {
    criteria: results,
    totalWeight,
    checkedWeight,
    earnedWeight,
    openWeight,
    artifactsDeclared,
    artifactsVerifiable,
    evidenceStrength,
    integrity: { termsHashMatches, deliverableHashMatches },
    scoredCopy,
    ...(deliverableText !== undefined ? { deliverableText } : {}),
    sellerResponded: response !== undefined,
  };

  return { signals, band, blocking, flags };
}

/// Deterministic prose for the no-model path. Built from the same results the
/// band came from, so the written rationale cannot claim more than was measured.
export function composeRuleRationale(input: {
  jobId: number;
  terms: JobTerms;
  signals: RuleSignals;
  band: RuleBand;
  chosenBps: number;
  clampedFrom?: number;
}): string {
  const { jobId, terms, signals, band, chosenBps, clampedFrom } = input;
  const lines: string[] = [];

  lines.push(
    'Ruled by the deterministic rule arbiter: no language model was configured, so checkable criteria were decided by their agreed checks and judgement criteria were left at the neutral midpoint.',
  );

  for (const result of signals.criteria) {
    const weight = `weight ${result.weight}`;
    if (result.kind === 'check') {
      lines.push(
        `${result.id} ${JSON.stringify(result.text)} (${result.check}, ${weight}): ${result.passed ? 'met' : `earned ${result.credit!.toFixed(2)}`}; ${result.evidence}.`,
      );
    } else {
      lines.push(`${result.id} ${JSON.stringify(result.text)} (${weight}): open; ${result.evidence}.`);
    }
  }

  lines.push(
    signals.integrity.deliverableHashMatches
      ? `Integrity: the ${signals.scoredCopy === 'uri' ? 'work fetched from the delivery URI' : `${signals.scoredCopy}'s copy`} hashes to the delivery committed on chain, and the terms hash matches the job.`
      : 'Integrity: no copy of the deliverable hashes to the delivery committed on chain, so nothing could be checked.',
  );

  const clampText =
    clampedFrom !== undefined ? ` The requested ${clampedFrom} bps fell outside the band and was clamped.` : '';
  lines.push(
    `Verified credit ${signals.earnedWeight.toFixed(2)} of ${signals.totalWeight} weight, ${signals.openWeight} open; band ${band.lowBps}-${band.highBps} bps; ruling ${chosenBps} bps of the disputed amount, i.e. ${formatBps(chosenBps)} to the seller of ${JSON.stringify(terms.title)} (job ${jobId}).${clampText}`,
  );

  return lines.join(' ');
}
