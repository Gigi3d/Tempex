import type { RuleBand } from './rules.js';

/// The guardrail on its own: pure functions with no network, keys or model
/// clients, so a browser can run the exact code that bounds every ruling.

export const clamp = (value: number, low: number, high: number): number =>
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

/// Narrows the rule band to the range the parties' final offers allow. The escrow
/// rejects any award outside the offers, so a band reaching past them would only
/// let the judge propose something that cannot settle. When the two ranges do
/// not meet, the band collapses to the offer edge nearest the evidence.
export function withinOffers(
  band: RuleBand,
  offers: { lowBps: number; highBps: number },
): RuleBand {
  const lowBps = clamp(band.lowBps, offers.lowBps, offers.highBps);
  const highBps = clamp(band.highBps, offers.lowBps, offers.highBps);
  return { lowBps, highBps, center: clamp(band.center, lowBps, highBps) };
}

export { analyze, composeRuleRationale, formatBps } from './rules.js';
export type { CriterionResult, RuleAnalysis, RuleBand, RuleSignals } from './rules.js';
export { checkProblem, runCheck } from './checks.js';
export type { CheckResult as CriterionCheckResult } from './checks.js';
