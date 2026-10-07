// The three failures found in the audit (C1, C2), kept as permanent tests. Each
// one was a ruling keyword scoring got badly wrong; each must stay fixed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashCanonical, hashText, type SellerResponse } from '@tempex/sdk';

import { BRIEF, HONEST_WORK, analyzeCase, caseFor, credit } from './helpers.js';

describe('audit case A: honest work in other words', () => {
  it('earns every check, however little its wording overlaps the criteria', () => {
    const a = analyzeCase({ delivered: HONEST_WORK });
    for (const id of ['keys', 'french', 'prices', 'dates', 'glossary']) {
      assert.equal(credit(a, id), 1, `${id} should be met by the delivered file`);
    }
    // Under keyword scoring this work was held to 0-19.5%.
    assert.deepEqual([a.band.lowBps, a.band.highBps], [9_000, 10_000]);
  });

  it('is judged on the work, not on any phrasing of it', () => {
    // Same content, reordered keys and extra fields: same result.
    const reworded = JSON.stringify({
      dates: { placed: '7 octobre 2026' },
      notes: 'Livré conformément au brief.',
      strings: {
        'email.subject': 'Merci ! Votre commande est confirmée',
        'checkout.submit': 'Valider la commande',
        'checkout.title': 'Paiement sécurisé',
        'cart.title': 'Votre panier',
      },
      prices: { shipping: '4,00 €', total: '12,50 €' },
    });
    assert.deepEqual(
      [analyzeCase({ delivered: reworded }).band.lowBps],
      [analyzeCase({ delivered: HONEST_WORK }).band.lowBps],
    );
  });
});

describe('audit case B: a fabricated copy under the real hash', () => {
  const FAKE = 'empty file';

  it('earns the buyer nothing: a copy that does not hash to the delivery is never checked', () => {
    const a = analyzeCase({ delivered: HONEST_WORK, buyerCopy: FAKE });
    assert.equal(a.signals.scoredCopy, 'unverified');
    assert.equal(a.signals.checkedWeight, 0, 'no check may run on unverified text');
    // Every criterion is open, not scored 0: the fake text cannot count against the seller.
    assert.deepEqual([a.band.lowBps, a.band.highBps], [0, 10_000]);
  });

  it("is overruled by the seller's verified copy", () => {
    const c = caseFor({ delivered: HONEST_WORK, buyerCopy: FAKE });
    const response: SellerResponse = {
      version: 1,
      jobId: 1,
      disputeHash: hashCanonical(c.bundle),
      statement: 'The delivered file is attached.',
      deliverable: { content: HONEST_WORK, contentHash: hashText(HONEST_WORK) },
      artifacts: [],
      submittedAt: '2026-01-02T00:00:00.000Z',
    };
    const a = analyzeCase({ delivered: HONEST_WORK, buyerCopy: FAKE, response });
    assert.equal(a.signals.scoredCopy, 'seller');
    assert.equal(a.band.lowBps, 9_000);
  });

  it('is overruled by the work fetched from the delivery URI', () => {
    const a = analyzeCase({ delivered: HONEST_WORK, buyerCopy: FAKE, fetched: { uri: 'ipfs://x', text: HONEST_WORK } });
    assert.equal(a.signals.scoredCopy, 'uri');
    assert.equal(a.band.lowBps, 9_000);
  });
});

describe('audit case C: the criteria pasted back as the delivery', () => {
  const criteriaText = BRIEF.map((c) => (typeof c === 'string' ? c : c.text));

  for (const [name, delivered] of [
    ['as prose', criteriaText.join(' ')],
    ['as a JSON list', JSON.stringify({ strings: criteriaText })],
    ['as JSON under the expected sections', JSON.stringify({
      strings: Object.fromEntries(criteriaText.map((t, i) => [`line${i}`, t])),
      prices: { total: criteriaText[2] },
      dates: { placed: criteriaText[3] },
    })],
  ] as const) {
    it(`earns no check credit ${name}`, () => {
      const a = analyzeCase({ delivered });
      assert.equal(a.signals.earnedWeight, 0, `earned ${a.signals.earnedWeight}: ${JSON.stringify(a.signals.criteria)}`);
      // Under keyword scoring this scored 100%. Now it equals delivering nothing.
      assert.deepEqual([a.band.lowBps, a.band.highBps], [0, 1_000]);
    });
  }
});
