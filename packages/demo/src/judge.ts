import {
  SYSTEM_PROMPT,
  analyze,
  buildJudgePrompt,
  clampToBand,
  judgePanel,
  llmConfigFromEnv,
  panelAward,
  type LlmConfig,
  type PanelVerdict,
} from '@tempex/arbiter';

import { PREDICT_PARTIES } from './predict.js';
import { SCENARIOS, caseFor, jobFor, type Scenario } from './scenarios.js';

/// What the judge adds, case by case.
///
/// The rule engine decides every criterion code can check and leaves the rest at
/// the neutral midpoint. The judge panel scores those open criteria from quotes
/// it must find in the delivered work, and the guardrail clamps its proposal into
/// the band the facts allow. This runs both over the corpus and shows where the
/// judge moved the award, by how much, and on what evidence: the difference
/// between "a referee that splits the difference" and one that reads the work.

export type JudgeComparison = {
  id: string;
  title: string;
  band: [number, number];
  /// The rule engine's ruling: the band's centre.
  rulesBps: number;
  /// The panel's proposal before the guardrail, and the award after it.
  proposedBps: number | null;
  judgedBps: number | null;
  clamped: boolean;
  /// judged - rules; positive moves money to the seller
  movedBps: number | null;
  openCriteria: { id: string; text: string; score: number | null; quotes: string[] }[];
  rationale: string | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  note: string | null;
};

const SUBMITTED_AT = '2026-01-01T00:00:00.000Z';

export async function judgeScenario(
  scenario: Scenario,
  config: LlmConfig,
  completeFn?: Parameters<typeof judgePanel>[0]['completeFn'],
): Promise<JudgeComparison> {
  const jobId = 0;
  const evidenceCase = caseFor(scenario, { jobId, parties: PREDICT_PARTIES, submittedAt: SUBMITTED_AT });
  const job = jobFor(scenario, { jobId, evidenceCase });
  const analysis = analyze({ jobId, job, terms: evidenceCase.terms, bundle: evidenceCase.bundle });
  const { signals, band } = analysis;
  const open = signals.criteria.filter((c) => c.kind !== 'check');
  const base = {
    id: scenario.id,
    title: scenario.title,
    band: [band.lowBps, band.highBps] as [number, number],
    rulesBps: band.center,
  };
  if (open.length === 0) {
    return { ...base, proposedBps: null, judgedBps: null, clamped: false, movedBps: null, openCriteria: [], rationale: null, model: null, usage: null, note: 'every criterion is decided by a check; there is nothing to judge' };
  }

  const user = buildJudgePrompt({ jobId, job, terms: evidenceCase.terms, bundle: evidenceCase.bundle, signals, band });
  const panel: PanelVerdict = await judgePanel({
    config,
    system: SYSTEM_PROMPT,
    user,
    openIds: open.map((c) => c.id),
    deliverable: signals.deliverableText,
    ...(completeFn ? { completeFn } : {}),
  });
  const proposedBps = panelAward(signals, panel);
  const { bps: judgedBps, clamped } = clampToBand(proposedBps, band);
  const failed = panel.members.filter((m) => m.scores === null);
  return {
    ...base,
    proposedBps,
    judgedBps,
    clamped,
    movedBps: judgedBps - band.center,
    openCriteria: open.map((c) => {
      const scored = panel.criteria.find((p) => p.id === c.id);
      const quotes = panel.members.flatMap((m) => m.scores?.find((s) => s.id === c.id)?.verifiedQuotes ?? []).slice(0, 2);
      return { id: c.id, text: c.text, score: scored?.score ?? null, quotes };
    }),
    rationale: panel.members.find((m) => m.scores !== null)?.rationale ?? null,
    model: panel.label,
    usage: panel.usage,
    note: failed.length > 0 ? `${failed.length} of ${panel.members.length} judges failed: ${failed[0]!.error}` : null,
  };
}

/// Every corpus case through the real panel. Refuses without a judge configured:
/// a comparison against a missing judge would only restate the rule engine.
export async function judgeCorpus(env: NodeJS.ProcessEnv = process.env): Promise<{ model: string; comparisons: JudgeComparison[] }> {
  const config = llmConfigFromEnv(env);
  if (!config) throw new Error('no judge configured: set OPENAI_API_KEY (and optionally TEMPEX_JUDGE_MODELS) to run the panel');
  const comparisons: JudgeComparison[] = [];
  for (const scenario of SCENARIOS) comparisons.push(await judgeScenario(scenario, config));
  return { model: config.models.join(', ') || 'default', comparisons };
}

const pct = (bps: number | null): string => (bps === null ? '—' : `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`);

export function renderComparisons(comparisons: JudgeComparison[]): string {
  const lines: string[] = [];
  lines.push('case            band         rules   judge   moved   ');
  lines.push('──────────────  ───────────  ──────  ──────  ──────');
  for (const c of comparisons) {
    const moved = c.movedBps === null ? '—' : `${c.movedBps > 0 ? '+' : ''}${(c.movedBps / 100).toFixed(1)}`;
    lines.push(
      `${c.id.padEnd(14)}  ${`${pct(c.band[0])}–${pct(c.band[1])}`.padEnd(11)}  ${pct(c.rulesBps).padStart(6)}  ${pct(c.judgedBps).padStart(6)}  ${moved.padStart(6)}${c.clamped ? '  (clamped)' : ''}`,
    );
  }
  for (const c of comparisons) {
    lines.push('');
    lines.push(`${c.id} · ${c.title}`);
    if (c.note) lines.push(`  ${c.note}`);
    for (const open of c.openCriteria) {
      lines.push(`  ${open.id} ${open.score === null ? 'unscored' : open.score.toFixed(2)} · ${open.text}`);
      for (const quote of open.quotes) lines.push(`      “${quote.slice(0, 100)}”`);
    }
    if (c.rationale) lines.push(`  judge: ${c.rationale.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  return `${lines.join('\n')}\n`;
}
