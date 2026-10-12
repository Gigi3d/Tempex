import { clampToBand, formatBps } from '@tempex/arbiter';

import { predictScenario, type Prediction } from './predict.js';
import { SCENARIOS, type Scenario } from './scenarios.js';

/// One scripted award proposal, and what the guardrail did to it.
export type DrillProposal = {
  requested: number;
  bps: number;
  clamped: boolean;
  /// Which side of the band the request came from, in words.
  reading: string;
};

export type DrillRow = {
  id: string;
  title: string;
  band: [number, number];
  center: number;
  proposals: DrillProposal[];
  /// Invariant violations, not expectation mismatches: these say the guardrail
  /// itself is broken.
  problems: string[];
};

export type DrillReport = {
  ok: boolean;
  rows: DrillRow[];
};

function reading(requested: number, low: number, high: number): string {
  if (requested < low) {
    return `below the band — the proposal leans to the buyer; the floor holds it to ${low} bps`;
  }
  if (requested > high) {
    return `above the band — the proposal leans to the seller; the ceiling holds it to ${high} bps`;
  }
  return 'inside the band — passes through unclamped';
}

/// Runs the corpus's scripted award proposals through the real guardrail.
///
/// The claim being tested is that the arbiter is bounded, not merely automated:
/// an arbiter that is mistaken, bribed or simply wrong can move the ruling
/// inside the band the evidence justifies and no further. The invariant that
/// keeps the band from becoming a rubber stamp is the third one below — a request
/// already inside passes through with `clamped: false`. A clamp that fires on
/// every input is not a guardrail, it is a replacement for the arbiter.
export function drill(run: (scenario: Scenario) => Prediction = (s) => predictScenario(s)): DrillReport {
  const rows: DrillRow[] = [];

  for (const scenario of SCENARIOS) {
    const prediction = run(scenario);
    const [low, high] = prediction.band;
    const band = { center: prediction.center, lowBps: low, highBps: high };
    const problems: string[] = [];
    const proposals: DrillProposal[] = [];

    for (const requested of scenario.drill) {
      const { bps, clamped } = clampToBand(requested, band);
      proposals.push({ requested, bps, clamped, reading: reading(requested, low, high) });

      if (bps < low || bps > high) {
        problems.push(`clamp(${requested}) = ${bps}, outside the band ${low}-${high}`);
      }
      if (clamped !== (bps !== requested)) {
        problems.push(`clamp(${requested}) reports clamped=${clamped} but returned ${bps}`);
      }
      if (requested < low && bps !== low) {
        problems.push(`clamp(${requested}) = ${bps}, expected the floor ${low}`);
      }
      if (requested > high && bps !== high) {
        problems.push(`clamp(${requested}) = ${bps}, expected the ceiling ${high}`);
      }
      if (requested >= low && requested <= high && clamped) {
        problems.push(`clamp(${requested}) clamped a proposal that was already inside the band`);
      }
    }

    rows.push({
      id: scenario.id,
      title: scenario.title,
      band: prediction.band,
      center: prediction.center,
      proposals,
      problems,
    });
  }

  return { ok: rows.every((row) => row.problems.length === 0), rows };
}

export function renderDrill(report: DrillReport): string {
  const out: string[] = [];
  for (const row of report.rows) {
    out.push(`${row.problems.length === 0 ? 'PASS' : 'FAIL'}  ${row.id} — ${row.title}`);
    out.push(
      `      band ${row.band[0]}-${row.band[1]} bps; the rule engine signs the centre, ${row.center} bps (${formatBps(row.center)})`,
    );
    for (const p of row.proposals) {
      const arrow = p.clamped ? `${String(p.requested).padStart(5)} → ${String(p.bps).padStart(5)}` : `${String(p.bps).padStart(5)}   ·  `;
      out.push(`        ${arrow} bps  ${p.reading}`);
    }
    for (const problem of row.problems) out.push(`      VIOLATION ${problem}`);
  }
  out.push('');
  out.push(
    report.ok
      ? `the guardrail held on all ${report.rows.length} scenarios: no proposal escaped its band`
      : 'the guardrail is broken: see the violations above',
  );
  return `${out.join('\n')}\n`;
}
