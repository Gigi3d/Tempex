// Properties the band must hold for any terms and any delivery, checked over
// reproducible pseudo-random inputs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Criterion } from '@tempex/sdk';

import { clampToBand, withinOffers } from '../src/adjudicate.js';
import { BRIEF, HONEST_WORK, analyzeCase, rng } from './helpers.js';

const CHECKS: Criterion[] = BRIEF.filter((c) => typeof c !== 'string' && c.check !== undefined);

function randomCriteria(next: () => number): Criterion[] {
  const count = 1 + Math.floor(next() * 6);
  return Array.from({ length: count }, (_, i): Criterion => {
    const weight = 1 + Math.floor(next() * 5);
    if (next() < 0.4) return { id: `j${i}`, text: `judgement ${i}`, weight };
    const template = CHECKS[Math.floor(next() * CHECKS.length)] as Exclude<Criterion, string>;
    return { ...template, id: `k${i}`, weight };
  });
}

describe('band invariants', () => {
  it('low ≤ centre ≤ high, inside 0..10000, for any terms and delivery', () => {
    const next = rng(42);
    const deliveries = [HONEST_WORK, 'nothing', '{}', JSON.stringify({ strings: { 'cart.title': 'x' } })];
    for (let round = 0; round < 400; round++) {
      const criteria = randomCriteria(next);
      const delivered = deliveries[Math.floor(next() * deliveries.length)]!;
      const { band, signals } = analyzeCase({ delivered, criteria });
      assert.ok(0 <= band.lowBps && band.lowBps <= band.center && band.center <= band.highBps && band.highBps <= 10_000,
        `round ${round}: ${JSON.stringify(band)}`);
      assert.ok(Math.abs(signals.earnedWeight + signals.openWeight + (signals.checkedWeight - signals.earnedWeight) - signals.totalWeight) < 1e-9);
    }
  });

  it('is the full range when every criterion is a judgement', () => {
    const a = analyzeCase({ delivered: HONEST_WORK, criteria: ['reads well', { text: 'is on brand', weight: 4 }] });
    assert.deepEqual([a.band.lowBps, a.band.highBps, a.band.center], [0, 10_000, 5_000]);
  });

  it('is a single point when every criterion is a check', () => {
    const a = analyzeCase({ delivered: HONEST_WORK, criteria: CHECKS });
    assert.equal(a.band.lowBps, a.band.highBps);
    assert.equal(a.band.lowBps, 10_000);
  });

  it('is width exactly the open share of the weight', () => {
    const a = analyzeCase({ delivered: HONEST_WORK });
    assert.equal(a.band.highBps - a.band.lowBps, Math.round((10_000 * a.signals.openWeight) / a.signals.totalWeight));
  });

  it('is deterministic: the same files give the same analysis', () => {
    assert.deepEqual(analyzeCase({ delivered: HONEST_WORK }), analyzeCase({ delivered: HONEST_WORK }));
  });
});

describe('who carries a defect', () => {
  it('a defective check in the terms is left open, not charged to the seller', () => {
    const a = analyzeCase({
      delivered: HONEST_WORK,
      criteria: [{ id: 'bad', text: 'broken pattern', weight: 1, check: { type: 'regex', pattern: '([' } }],
    });
    const bad = a.signals.criteria[0]!;
    assert.equal(bad.kind, 'open');
    assert.deepEqual([a.band.lowBps, a.band.highBps], [0, 10_000]);
    assert.ok(a.flags.some((f) => f.includes('cannot be applied')));
  });

  it('an unknown check type is left open', () => {
    const a = analyzeCase({
      delivered: HONEST_WORK,
      criteria: [{ id: 'x', text: 'mystery', weight: 1, check: { type: 'telepathy' } as never }],
    });
    assert.equal(a.signals.criteria[0]!.kind, 'open');
  });

  it('malformed weights block the ruling instead of skewing it', () => {
    const a = analyzeCase({ delivered: HONEST_WORK, criteria: [{ text: 'x', weight: -1 }] });
    assert.ok(a.blocking.some((b) => b.includes('weight')));
  });
});

describe('the guardrail around the band', () => {
  it('passes a proposal inside the band through unclamped, and clamps outside ones', () => {
    const band = { lowBps: 4_250, highBps: 5_250, center: 4_750 };
    assert.deepEqual(clampToBand(4_500, band), { bps: 4_500, clamped: false });
    assert.deepEqual(clampToBand(0, band), { bps: 4_250, clamped: true });
    assert.deepEqual(clampToBand(10_000, band), { bps: 5_250, clamped: true });
  });

  it('never leaves the parties\' offers, whatever the evidence says', () => {
    const next = rng(7);
    for (let i = 0; i < 300; i++) {
      const low = Math.floor(next() * 10_001);
      const high = low + Math.floor(next() * (10_001 - low));
      const offers = { lowBps: Math.floor(next() * 10_001), highBps: 0 };
      offers.highBps = offers.lowBps + Math.floor(next() * (10_001 - offers.lowBps));
      const band = withinOffers({ lowBps: low, highBps: high, center: Math.round((low + high) / 2) }, offers);
      assert.ok(offers.lowBps <= band.lowBps && band.highBps <= offers.highBps, JSON.stringify({ band, offers }));
      assert.ok(band.lowBps <= band.center && band.center <= band.highBps);
    }
  });
});
