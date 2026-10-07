// The browser builds the same evidence the CLI does, and the numbers the site
// shows are the numbers the contract paid. Both are checked against the baked
// snapshot, so a drift between the web app and the protocol fails here.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyze, clampToBand, withinOffers } from '@tempex/arbiter/guardrail';
import { caseIntegrity, disputeHashOf, disputeSettlement, hashCanonical, hashText, responseHashOf, type Job } from '@tempex/sdk/browser';

import snapshotJson from '../data/snapshot.json' with { type: 'json' };
import { bundleFor, responseFor, termsFor } from '../lib/play.js';
import type { Snapshot } from '../lib/snapshot.js';

const snapshot = snapshotJson as unknown as Snapshot;
const BUYER = '0xf99FD25FB54616cDfe031EC4689DAB97491e0998';
const SELLER = '0x004b406EE42669816c1d218834068f49950579A9';
const ZERO = `0x${'0'.repeat(64)}` as const;

describe('the receipt on /demo', () => {
  const a = snapshot.receipt.adjudication;

  it('pays what disputeSettlement computes', () => {
    const money = disputeSettlement({ amount: BigInt(a.money.amount), arbitrationFeeBps: a.money.arbitrationFeeBps, sellerAwardBps: a.ruling.sellerAwardBps });
    assert.equal(money.sellerAmount.toString(), a.money.sellerAmount);
    assert.equal(money.buyerAmount.toString(), a.money.buyerAmount);
  });

  it('signed inside the band the offers narrowed', () => {
    const bounded = withinOffers(a.band, a.offers);
    assert.deepEqual({ low: bounded.lowBps, high: bounded.highBps }, { low: a.boundedBand.lowBps, high: a.boundedBand.highBps });
    assert.equal(clampToBand(a.ruling.sellerAwardBps, bounded).clamped, false);
  });
});

describe('evidence built by /play', () => {
  for (const scenario of snapshot.corpus) {
    it(`${scenario.id}: is self-consistent and reproduces the predicted band`, () => {
      const content = scenario.deliverable ?? '';
      const terms = termsFor(scenario, BUYER, SELLER);
      const bundle = bundleFor({ jobId: 9n, terms, content, claim: scenario.claim, scenario });
      const draft = { terms, bundle };
      const response = responseFor({ jobId: 9n, disputeHash: disputeHashOf(draft), statement: 'as delivered', content });
      const evidenceCase = { ...draft, response };
      assert.deepEqual(caseIntegrity(evidenceCase), []);

      const job: Job = {
        buyer: BUYER,
        seller: SELLER,
        amount: 25_000_000n,
        deliveryDeadline: 0,
        reviewWindow: 3_600,
        deliveredAt: 1,
        state: 'Disputed',
        termsHash: hashCanonical(terms),
        deliverableHash: hashText(content),
        disputeHash: disputeHashOf(draft),
        verdictHash: ZERO,
        disputedAt: 1,
        respondedAt: 2,
        responseHash: responseHashOf(response),
        arbiter: SELLER,
        platformFeeBps: 50,
        arbitrationFeeBps: 200,
        protocolCutBps: 10_000,
        buyerOfferBps: scenario.offers.buyerOfferBps ?? 0,
        sellerAskBps: scenario.offers.sellerAskBps ?? 10_000,
      };
      const analysis = analyze({ jobId: 9, job, terms, bundle, response, fetched: { uri: 'data:', text: content } });
      assert.deepEqual(analysis.blocking, []);
      assert.deepEqual([analysis.band.lowBps, analysis.band.highBps], scenario.prediction.band);
    });
  }
});
