import {
  hashCanonical,
  hashText,
  type EvidenceBundle,
  type Job,
  type JobTerms,
} from '@tempex/sdk';

/// The arbiter's job is to split a disputed remainder, never more than the job is
/// worth. These are the only knobs that turn text signals into a number, and they
/// are named so a reader can argue with them.
///
/// Coverage is the whole centre: the share of the agreed criteria the artifact
/// actually addresses, in basis points. Evidence strength deliberately does not
/// move the number — a bundle that verifies itself is evidence the seller kept
/// good records, not evidence the seller worked. It narrows the band instead.
///
/// How far a ruling may stray from the objective centre. Tight when the evidence
/// binds to the chain, wide when it does not.
const BAND_HALF_WIDTH_BPS = 1200;
const UNVERIFIED_BAND_HALF_WIDTH_BPS = 2500;
/// A claim that names a gap the artifact really has is worth this much, and a
/// claim the artifact contradicts costs the same.
const CORROBORATION_NUDGE_BPS = 500;
/// Criteria scoring below this are "under-delivered" for corroboration purposes.
const GAP_THRESHOLD = 0.6;
/// Terms shorter than this are noise, not content.
const MIN_TERM_LENGTH = 4;

/// Words that say nothing about whether a deliverable met a criterion.
const STOPWORDS = new Set(
  `a an and are as at be been being but by can could did do does doing for from had has have
   having he her here his how i if in into is it its may might must no nor not of on only or
   other our out over said shall she should so some such than that the their them then there
   these they this those through to under until up upon use used uses using via was we were
   what when where which while who whom why will with within without would you your yours
   about above after again against all also am among any because before below between both
   during each few more most other own same too very well`
    .split(/\s+/)
    .filter(Boolean),
);

/// Words that flip the terms that follow them.
const NEGATORS = new Set(
  `not never no none nor cannot cant without nothing missing absent omitted
   skipped pending failed fails fail lacks lacking unapplied untranslated
   unlocalized unfinished incomplete`
    .split(/\s+/)
    .filter(Boolean),
);

/// A negation reaches to the end of its sentence. A semicolon is deliberately
/// not a boundary: a list continued after one still belongs to the clause that
/// introduced it.
const SENTENCE_SPLIT = /[.!?\n]+/;

/// Crude plural folding, not a stemmer. "strings" and "string" are the same
/// vocabulary to a reader, and a matcher that treats them as different terms
/// scores a delivered criterion as missed over a trailing s.
function fold(token: string): string {
  return token.length >= 4 && token.endsWith('s') && !token.endsWith('ss')
    ? token.slice(0, -1)
    : token;
}

const sentences = (text: string): string[][] =>
  text
    .split(SENTENCE_SPLIT)
    .map((sentence) =>
      sentence
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .map(fold),
    );

const tokenize = (text: string): string[] => sentences(text).flat();

const isSalient = (token: string): boolean =>
  token.length >= MIN_TERM_LENGTH && !STOPWORDS.has(token);

/// Distinctive lowercase words in a piece of text: the vocabulary a criterion is
/// about, minus filler. Used on both sides of the comparison, so "the invoice is
/// signed" and "signed invoice" reduce to the same two terms.
export function salientTerms(text: string): string[] {
  const found = new Set<string>();
  for (const token of tokenize(text)) if (isSalient(token)) found.add(token);
  return [...found];
}

/// Splits a text's vocabulary into terms it states as present and terms it
/// raises only inside a negation.
///
/// "the glossary was not applied" names the glossary in order to say it is
/// absent. A keyword matcher that cannot tell the two apart scores the seller's
/// own admission of a gap as delivery, which is how a text scorer inflates a
/// ruling.
///
/// Within a sentence, a negation flips every term that follows it; a term stated
/// plainly in any sentence still counts as present, because the artifact really
/// does discuss it. Coverage is scored against `present` alone; `negated` is kept
/// as the artifact's record of what it did not deliver.
export function classifyTerms(text: string): { present: Set<string>; negated: Set<string> } {
  const present = new Set<string>();
  const negated = new Set<string>();
  for (const tokens of sentences(text)) {
    let flipped = false;
    for (const token of tokens) {
      if (NEGATORS.has(token)) {
        flipped = true;
        continue;
      }
      if (!isSalient(token)) continue;
      if (flipped) negated.add(token);
      else present.add(token);
    }
  }
  for (const token of present) negated.delete(token);
  return { present, negated };
}

export type CriterionScore = {
  criterion: string;
  /// share of the criterion's distinctive terms present in the deliverable
  score: number;
  matched: string[];
  missing: string[];
};

export type RuleSignals = {
  criteria: CriterionScore[];
  /// mean criterion score, or null when there is no text to score
  coverage: number | null;
  artifactsDeclared: number;
  artifactsVerifiable: number;
  /// share of declared artifacts whose claimed hash their own content produces.
  /// Neutral (1) when no artifacts are declared: silence is not a strike.
  evidenceStrength: number;
  /// Terms the artifact raises only inside a negation: its own record of what it
  /// did not deliver. Sorted, so the digest over these signals is stable.
  admitted: string[];
  integrity: {
    termsHashMatches: boolean;
    deliverableHashMatches: boolean;
  };
  /// Does the claim point at a gap the artifact actually has?
  corroboration: 'grounded' | 'contradicted' | 'unknown';
  weakest: CriterionScore | null;
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

function scoreCriterion(criterion: string, haystack: Set<string>): CriterionScore | null {
  const wanted = salientTerms(criterion);
  if (wanted.length === 0) return null;
  const matched = wanted.filter((term) => haystack.has(term));
  const missing = wanted.filter((term) => !haystack.has(term));
  return { criterion, score: matched.length / wanted.length, matched, missing };
}

/// Everything the arbiter knows before judgement: what the artifact covers, what
/// the evidence verifies, and whether the claim is corroborated by the text.
///
/// Deterministic on purpose. Same files in, same band out, on any machine, with
/// no model in the loop — so a ruling can be re-derived and argued with.
export function analyze(input: {
  jobId: number;
  job: Job;
  terms: JobTerms;
  bundle: EvidenceBundle;
}): RuleAnalysis {
  const { jobId, job, terms, bundle } = input;
  const blocking: string[] = [];
  const flags: string[] = [];

  // ---- integrity: the ruling must be bound to this job's own commitments ----
  const termsHashMatches = hashCanonical(terms) === job.termsHash;
  if (!termsHashMatches) {
    blocking.push(
      `terms document does not hash to the on-chain termsHash of job ${jobId}`,
    );
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
  if (terms.acceptanceCriteria.length === 0) {
    blocking.push('terms carry no acceptance criteria to rule on');
  }

  const deliverableHashMatches = bundle.deliverable.contentHash === job.deliverableHash;
  if (!deliverableHashMatches) {
    flags.push(
      `deliverable contentHash ${bundle.deliverable.contentHash} does not match the on-chain delivery ${job.deliverableHash}`,
    );
  }

  // ---- coverage: how much of the agreed criteria the artifact speaks to ----
  const textPieces = [bundle.deliverable.content ?? '', ...bundle.artifacts.map((a) => a.content ?? '')]
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
  // Each piece is classified on its own so a negation never reaches across a
  // boundary between the deliverable and an artifact.
  const haystack = new Set<string>();
  const admittedTerms = new Set<string>();
  for (const piece of textPieces) {
    const classified = classifyTerms(piece);
    for (const term of classified.present) haystack.add(term);
    for (const term of classified.negated) admittedTerms.add(term);
  }
  for (const term of haystack) admittedTerms.delete(term);
  // Only terms an agreed criterion asks for. Prose is full of incidental
  // negations ("nothing was produced"); admitting those as gaps would bury the
  // ones that bear on a criterion.
  const criterionTerms = new Set(
    terms.acceptanceCriteria.flatMap((criterion) => salientTerms(criterion)),
  );
  const admitted = [...admittedTerms].filter((term) => criterionTerms.has(term)).sort();

  const criteria = terms.acceptanceCriteria
    .map((criterion) => scoreCriterion(criterion, haystack))
    .filter((score): score is CriterionScore => score !== null);
  if (criteria.length < terms.acceptanceCriteria.length) {
    flags.push(
      `${terms.acceptanceCriteria.length - criteria.length} criteria had no distinctive terms and were not scored`,
    );
  }

  let coverage: number | null = null;
  if (textPieces.length === 0) {
    flags.push('bundle carries no deliverable text, so coverage cannot be scored');
  } else if (criteria.length > 0) {
    coverage = criteria.reduce((sum, c) => sum + c.score, 0) / criteria.length;
  } else {
    flags.push('no criterion could be scored against the deliverable');
  }

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
      flags.push(
        `artifact ${index + 1} (${artifact.label}) declares a hash its own content does not produce`,
      );
      return;
    }
    artifactsVerifiable += 1;
  });
  const evidenceStrength = artifactsDeclared === 0 ? 1 : artifactsVerifiable / artifactsDeclared;

  // ---- corroboration: is the complaint about a gap that actually exists? ----
  const weakest = criteria.reduce<CriterionScore | null>(
    (worst, c) => (worst === null || c.score < worst.score ? c : worst),
    null,
  );
  const gaps = criteria.filter((c) => c.score < GAP_THRESHOLD);
  // A claim is a complaint: the terms it raises inside a negation still name the
  // thing it is complaining about, so both halves of the claim's vocabulary count.
  const claimClassified = classifyTerms(bundle.claim);
  const claimTerms = new Set([...claimClassified.present, ...claimClassified.negated]);
  const admittedClaimed = admitted.filter((term) => claimTerms.has(term));
  let corroboration: RuleSignals['corroboration'] = 'unknown';
  if (criteria.length > 0) {
    if (gaps.length === 0) {
      corroboration = 'contradicted';
      flags.push(
        'the deliverable addresses every criterion the buyer named; the claim is not corroborated by the text',
      );
    } else if (gaps.some((gap) => gap.missing.some((term) => claimTerms.has(term)))) {
      corroboration = 'grounded';
    } else if (admittedClaimed.length > 0) {
      corroboration = 'grounded';
      flags.push(
        `the complaint is corroborated by the artifact's own record of what it omitted: ${admittedClaimed.join(', ')}`,
      );
    } else {
      flags.push('the claim does not point at the criteria the deliverable under-delivers');
    }
  }

  const signals: RuleSignals = {
    criteria,
    coverage,
    artifactsDeclared,
    artifactsVerifiable,
    evidenceStrength,
    admitted,
    integrity: { termsHashMatches, deliverableHashMatches },
    corroboration,
    weakest,
  };

  // ---- the band: objective signals in, a defensible range out ----
  // Unscored coverage (no text at all) is the neutral 50%: the arbiter has
  // nothing to read, so it does not pretend to know which way the split should go.
  let center = Math.round(10_000 * (coverage ?? 0.5));
  if (corroboration === 'grounded') center -= CORROBORATION_NUDGE_BPS;
  if (corroboration === 'contradicted') center += CORROBORATION_NUDGE_BPS;
  if (!deliverableHashMatches) center += CORROBORATION_NUDGE_BPS;

  const bounded = clamp(center, 0, 10_000);
  const verified = deliverableHashMatches && coverage !== null && evidenceStrength === 1;
  const halfWidth = verified ? BAND_HALF_WIDTH_BPS : UNVERIFIED_BAND_HALF_WIDTH_BPS;

  const band: RuleBand = {
    center: bounded,
    lowBps: clamp(bounded - halfWidth, 0, 10_000),
    highBps: clamp(bounded + halfWidth, 0, 10_000),
  };

  return { signals, band, blocking, flags };
}

export const formatBps = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

/// Deterministic prose for the no-model path. Built from the same numbers the band
/// came from, so the written rationale cannot claim more than the signals show.
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
    'Ruled by the deterministic rule arbiter: no language model was configured, so the ruling is a function of the evidence text alone and can be re-derived by anyone holding the same files.',
  );

  if (signals.criteria.length > 0) {
    const detail = signals.criteria
      .map((c) => `${JSON.stringify(c.criterion)} ${c.score.toFixed(2)}`)
      .join(', ');
    lines.push(
      `The delivered artifact covers ${signals.criteria.filter((c) => c.score >= GAP_THRESHOLD).length} of ${signals.criteria.length} acceptance criteria, mean term coverage ${(signals.coverage ?? 0).toFixed(2)} (${detail}).`,
    );
  } else {
    lines.push('No acceptance criterion could be scored against the delivered text.');
  }

  if (signals.weakest && signals.weakest.missing.length > 0) {
    lines.push(
      `The weakest criterion is ${JSON.stringify(signals.weakest.criterion)} at ${signals.weakest.score.toFixed(2)}; its missing terms are ${signals.weakest.missing.join(', ')}.`,
    );
  }

  lines.push(
    signals.artifactsDeclared === 0
      ? 'The bundle declares no separate artifacts; the claim rests on the deliverable itself.'
      : `${signals.artifactsVerifiable} of ${signals.artifactsDeclared} declared artifacts verify against their own content hashes.`,
  );

  if (signals.admitted.length > 0) {
    lines.push(
      `The artifact raises ${signals.admitted.join(', ')} only to say they are not delivered; those terms are read as a gap, not counted as coverage.`,
    );
  }

  const corroborationText = {
    grounded:
      'The claim names terms the deliverable under-delivers, so the complaint is corroborated by the artifact itself.',
    contradicted:
      'The deliverable addresses every criterion the claim names, so the complaint is not corroborated by the artifact.',
    unknown:
      'The claim does not point at the criteria the deliverable under-delivers, so the complaint is treated as ungrounded rather than false.',
  }[signals.corroboration];
  lines.push(corroborationText);

  lines.push(
    signals.integrity.deliverableHashMatches
      ? 'Integrity: the delivered artifact hashes to the hash committed on chain, and the terms hash matches the job.'
      : 'Integrity: the delivered artifact does not hash to the hash committed on chain, so the artifact before the arbiter is not verifiably the one delivered.',
  );

  const clampText =
    clampedFrom !== undefined
      ? ` The ruling ${chosenBps} bps is the objective centre; the requested ${clampedFrom} bps fell outside the band and was clamped.`
      : '';
  lines.push(
    `Objective band ${band.lowBps}-${band.highBps} bps; ruling ${chosenBps} bps of the disputed remainder after the arbitration fee, i.e. ${formatBps(chosenBps)} to the seller of ${JSON.stringify(terms.title)} (job ${jobId}).${clampText}`,
  );

  return lines.join(' ');
}
