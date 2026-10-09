// The dashboard offers a move only when the escrow would accept it from that
// party at that moment. These cases walk each stage across its deadlines.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JobRecord } from '../lib/types.js';
import { ARBITRATION_WINDOW, SELLER_RESPONSE_WINDOW, exposure, inbox, outlook } from '../lib/workflow.js';

const BUYER = '0x0CB56973B78647F13E594810d519bCb432e3a33C';
const SELLER = '0x7798Af822DE1D5F0c0340895B07d804019E7ca64';
const T = 1_800_000_000;
const tx = { block: 1, tx: `0x${'1'.repeat(64)}` as const };

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: '9', buyer: BUYER, seller: SELLER, amount: '25000000', termsHash: `0x${'a'.repeat(64)}`,
    deliveryDeadline: T + 86_400, reviewWindow: 3_600, stage: 'funded', created: tx, funded: { ...tx, amount: '25000000' },
    ...overrides,
  };
}

const ids = (j: JobRecord, who: string, now: number) => outlook(j, who, now).moves.map((move) => move.id);

describe('funded', () => {
  it('asks the seller to deliver before the deadline, and the buyer to wait', () => {
    assert.deepEqual(ids(job(), SELLER, T), ['deliver']);
    assert.deepEqual(ids(job(), BUYER, T), []);
    assert.match(outlook(job(), BUYER, T).waiting!.title, /delivery/);
  });

  it('lets the buyer reclaim once the deadline passes, and nobody deliver', () => {
    assert.deepEqual(ids(job(), BUYER, T + 86_401), ['refundExpired']);
    assert.deepEqual(ids(job(), SELLER, T + 86_401), ['refundExpired']);
    assert.equal(outlook(job(), SELLER, T + 86_401).moves[0]!.forYou, false, 'a refund is not the seller’s to chase');
  });
});

describe('delivered', () => {
  const delivered = job({ stage: 'delivered', delivered: { ...tx, deliverableHash: `0x${'b'.repeat(64)}`, deliveredAt: T, reviewDeadline: T + 3_600 } });

  it('gives the buyer accept and dispute inside the review window', () => {
    assert.deepEqual(ids(delivered, BUYER, T + 10), ['accept', 'dispute']);
    assert.deepEqual(ids(delivered, SELLER, T + 10), []);
  });

  it('lets the seller collect once the window closes without a dispute', () => {
    assert.deepEqual(ids(delivered, SELLER, T + 3_601), ['autoAccept']);
    assert.ok(!ids(delivered, BUYER, T + 3_601).includes('dispute'), 'the escrow refuses a late dispute');
  });
});

describe('disputed', () => {
  const disputed = job({ stage: 'disputed', delivered: { ...tx, deliverableHash: `0x${'b'.repeat(64)}`, deliveredAt: T, reviewDeadline: T + 3_600 }, dispute: { ...tx, disputeHash: `0x${'c'.repeat(64)}`, disputedAt: T + 100, buyerOfferBps: 2_000 } });

  it('asks the seller to answer, and offers no ruling until it does or its window shuts', () => {
    assert.deepEqual(ids(disputed, SELLER, T + 200), ['respond']);
    assert.deepEqual(ids(disputed, BUYER, T + 200), []);
  });

  it('opens the ruling as soon as the seller answers', () => {
    const answered = { ...disputed, response: { ...tx, responseHash: `0x${'d'.repeat(64)}` as const, respondedAt: T + 500, sellerAskBps: 9_000 } };
    assert.deepEqual(ids(answered, BUYER, T + 501), ['requestRuling']);
    assert.deepEqual(ids(answered, SELLER, T + 501), ['requestRuling']);
    assert.deepEqual(ids(answered, BUYER, T + 500 + ARBITRATION_WINDOW + 1), ['settleLapsed']);
  });

  it('opens the ruling when a silent seller’s window closes', () => {
    const shut = T + 100 + SELLER_RESPONSE_WINDOW + 1;
    assert.deepEqual(ids(disputed, BUYER, shut), ['requestRuling']);
    assert.deepEqual(ids(disputed, SELLER, shut), ['requestRuling'], 'too late to respond');
  });
});

describe('the inbox', () => {
  it('orders by deadline and flags what is due within a day', () => {
    const soon = job({ jobId: '1', deliveryDeadline: T + 3_000 });
    const later = job({ jobId: '2', deliveryDeadline: T + 5 * 86_400 });
    const items = inbox([later, soon], SELLER, T);
    assert.deepEqual(items.map((item) => item.job.jobId), ['1', '2']);
    assert.deepEqual(items.map((item) => item.urgent), [true, false]);
  });

  it('leaves out jobs that are closed or not this address’s', () => {
    assert.equal(inbox([job({ stage: 'accepted' })], SELLER, T).length, 0);
    assert.equal(inbox([job()], '0x0000000000000000000000000000000000000001', T).length, 0);
  });

  it('sums what is on the line per side', () => {
    assert.deepEqual(exposure([job(), job({ stage: 'resolved' })], BUYER), { buying: 25_000_000n, selling: 0n, open: 1 });
  });
});
