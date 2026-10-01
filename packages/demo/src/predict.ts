import { analyze, formatBps } from '@tempex/arbiter';
import { disputeSettlement, formatToken, hashCanonical, tokenAmount } from '@tempex/sdk';

import {
  SCENARIOS,
  caseFor,
  jobFor,
  type DemoParties,
  type Scenario,
  type ScenarioExpectation,
} from './scenarios.js';

/// The arbitration fee the deployed escrow charges, used here to turn a band into
/// money without a network call. Mirrors `arbitrationFeeBps` in
/// deployments/moderato.json; the live runner reads the escrow's own value and
/// reports a drift instead of quietly mispricing the demo.
export const ARBITRATION_FEE_BPS = 200;

/// Placeholder parties for the offline run. The analysis only hashes these into
/// the terms document and never reads them, so any two valid addresses work — and
/// fixed ones mean the predicted hashes are identical on every machine.
export const PREDICT_PARTIES: DemoParties = {
  buyer: '0x00000000000000000000000000000000000000B0',
  seller: '0x000000000000000000000000000000000000005e',
};

/// Fixed, because the bundle carries it and the bundle is hashed. A clock reading
/// would change the hash on every run and make the prediction unreproducible.
const PREDICT_SUBMITTED_AT = '2026-01-01T00:00:00.000Z';

/// One scenario's money, at the fee schedule above and the ruling the rule engine
/// would sign.
export type PredictedMoney = {
  amount: bigint;
  /// the buyer's dispute bond; seller and buyer amounts include its settlement
  bond: bigint;
  arbitrationFee: bigint;
  arbitrationFeeBps: number;
  sellerAmount: bigint;
  buyerAmount: bigint;
};

export type PredictedCriterion = {
  criterion: string;
  score: number;
  missing: string[];
};

export type Prediction = {
  id: string;
  title: string;
  premise: string;
  ok: boolean;
  /// Everything that came out differently from the corpus, in words.
  mismatches: string[];
  /// The analysis refused to rule at all, which no scenario should trigger.
  blocking: string[];
  coverage: number | null;
  corroboration: string;
  admitted: string[];
  center: number;
  band: [number, number];
  bandHalfWidth: number;
  criteria: PredictedCriterion[];
  weakest: string | null;
  evidenceStrength: number;
  /// The decision the rule engine would sign: the band's centre.
  rulingBps: number;
  money: PredictedMoney;
  expected: ScenarioExpectation;
};

/// Runs the real engine over a scenario with no keys, no chain and no clock.
///
/// This is not a mock of the pipeline: `caseFor` and `jobFor` build the terms,
/// bundle and job through the same hashers the live path uses, so every integrity
/// comparison inside `analyze` compares the values it will compare against the
/// live contract. A scenario whose prose drifts away from its stated expectation
/// fails here, before a stage is ever set up.
export function predictScenario(
  scenario: Scenario,
  parties: DemoParties = PREDICT_PARTIES,
): Prediction {
  const jobId = 0;
  const evidenceCase = caseFor(scenario, {
    jobId,
    parties,
    submittedAt: PREDICT_SUBMITTED_AT,
  });
  const analysis = analyze({
    jobId,
    job: jobFor(scenario, { jobId, evidenceCase }),
    terms: evidenceCase.terms,
    bundle: evidenceCase.bundle,
  });

  const { signals, band, blocking } = analysis;
  const expected = scenario.expect;
  const mismatches: string[] = [];

  const coverage = signals.coverage;
  if (coverage === null || Math.abs(coverage - expected.coverage) > 1e-9) {
    mismatches.push(
      `coverage ${coverage === null ? 'null' : coverage.toFixed(4)} != expected ${expected.coverage.toFixed(4)}`,
    );
  }
  if (signals.corroboration !== expected.corroboration) {
    mismatches.push(
      `claim ${signals.corroboration} != expected ${expected.corroboration}`,
    );
  }
  if (signals.admitted.join(',') !== expected.admitted.join(',')) {
    mismatches.push(
      `admitted [${signals.admitted.join(', ')}] != expected [${expected.admitted.join(', ')}]`,
    );
  }
  if (band.center !== expected.center) {
    mismatches.push(`centre ${band.center} bps != expected ${expected.center} bps`);
  }
  if (band.lowBps !== expected.band[0] || band.highBps !== expected.band[1]) {
    mismatches.push(
      `band ${band.lowBps}-${band.highBps} != expected ${expected.band[0]}-${expected.band[1]}`,
    );
  }

  const rulingBps = band.center;
  const amount = tokenAmount(scenario.amount);
  const settlement = disputeSettlement({
    amount,
    arbitrationFeeBps: ARBITRATION_FEE_BPS,
    sellerAwardBps: rulingBps,
  });

  return {
    id: scenario.id,
    title: scenario.title,
    premise: scenario.premise,
    ok: mismatches.length === 0 && blocking.length === 0,
    mismatches,
    blocking,
    coverage,
    corroboration: signals.corroboration,
    admitted: signals.admitted,
    center: band.center,
    band: [band.lowBps, band.highBps],
    bandHalfWidth: band.highBps - band.center,
    criteria: signals.criteria.map((c) => ({
      criterion: c.criterion,
      score: c.score,
      missing: c.missing,
    })),
    weakest: signals.weakest?.criterion ?? null,
    evidenceStrength: signals.evidenceStrength,
    rulingBps,
    money: {
      amount,
      bond: settlement.bond,
      arbitrationFee: settlement.arbitrationFee,
      arbitrationFeeBps: ARBITRATION_FEE_BPS,
      sellerAmount: settlement.sellerAmount,
      buyerAmount: settlement.buyerAmount,
    },
    expected,
  };
}

export function predictAll(parties: DemoParties = PREDICT_PARTIES): Prediction[] {
  return SCENARIOS.map((scenario) => predictScenario(scenario, parties));
}

/// The offline report, formatted for a terminal. Reads top to bottom as: what was
/// delivered, what the engine made of it, and what that is worth in money.
export function renderPredictions(predictions: readonly Prediction[]): string {
  const out: string[] = [];
  for (const p of predictions) {
    const coverage = p.coverage === null ? 'n/a' : p.coverage.toFixed(3);
    out.push(`${p.ok ? 'PASS' : 'FAIL'}  ${p.id} — ${p.title}`);
    out.push(
      `      coverage ${coverage} · claim ${p.corroboration} · evidence ${p.evidenceStrength.toFixed(2)} · ` +
        `band ${p.band[0]}-${p.band[1]} bps (±${p.bandHalfWidth})`,
    );
    out.push(
      `      ruling ${p.rulingBps} bps (${formatBps(p.rulingBps)} to the seller) of ${formatToken(p.money.amount)} ` +
        `→ seller ${formatToken(p.money.sellerAmount)}, buyer ${formatToken(p.money.buyerAmount)}, ` +
        `arbitration fee ${formatToken(p.money.arbitrationFee)}`,
    );
    if (p.admitted.length > 0) {
      out.push(`      admitted in the artifact's own words: ${p.admitted.join(', ')}`);
    }
    for (const c of p.criteria) {
      const missing = c.missing.length === 0 ? 'nothing missing' : `missing ${c.missing.join(', ')}`;
      out.push(`        ${c.score.toFixed(2)}  ${JSON.stringify(c.criterion)} — ${missing}`);
    }
    for (const problem of p.blocking) out.push(`      BLOCKED  ${problem}`);
    for (const mismatch of p.mismatches) out.push(`      MISMATCH ${mismatch}`);
  }
  const passed = predictions.filter((p) => p.ok).length;
  out.push('');
  out.push(
    passed === predictions.length
      ? `all ${predictions.length} scenarios reproduce their expected band`
      : `${predictions.length - passed} of ${predictions.length} scenarios do NOT match the corpus`,
  );
  return `${out.join('\n')}\n`;
}

/// The hash the offline run pins for a scenario. Printed by `predict --hashes` so
/// a reader can see that a run against the chain commits to the same bytes.
export function caseHashes(
  scenario: Scenario,
  parties: DemoParties = PREDICT_PARTIES,
): { termsHash: string; disputeHash: string; deliverableHash: string } {
  const evidenceCase = caseFor(scenario, {
    jobId: 0,
    parties,
    submittedAt: PREDICT_SUBMITTED_AT,
  });
  return {
    termsHash: hashCanonical(evidenceCase.terms),
    disputeHash: hashCanonical(evidenceCase.bundle),
    deliverableHash: evidenceCase.bundle.deliverable.contentHash,
  };
}
