// A hire link carries the whole offer. It must round-trip exactly, and anything
// malformed or oversized must read as no offer rather than a half-filled form.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agentCommand, decodeOffer, encodeOffer, type Offer } from '../lib/offer.js';

const offer: Offer = {
  v: 1,
  seller: '0x7798Af822DE1D5F0c0340895B07d804019E7ca64',
  title: 'Translate a README into Spanish',
  spec: 'Markdown in, Markdown out. Keep code blocks untouched; ñ, é and “quotes” included.',
  criteria: [
    { text: 'Every heading is translated', kind: 'unchecked', value: '', weight: 2 },
    { text: 'Written in Spanish', kind: 'language', value: 'es', weight: 1 },
  ],
  amount: '12.5',
  deliverySeconds: 3 * 86_400,
  reviewSeconds: 86_400,
};

describe('hire links', () => {
  it('round-trip exactly, Unicode included, and are URL-safe', () => {
    const encoded = encodeOffer(offer);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeOffer(encoded), offer);
  });

  it('read anything malformed as no offer', () => {
    assert.equal(decodeOffer('not-base64!'), null);
    assert.equal(decodeOffer(encodeOffer({ ...offer, seller: 'me' as never })), null);
    assert.equal(decodeOffer(encodeOffer({ ...offer, amount: '-1' })), null);
    assert.equal(decodeOffer(encodeOffer({ ...offer, criteria: [] })), null);
    assert.equal(decodeOffer('A'.repeat(7_000)), null);
  });

  it('clamp windows and weights instead of trusting them', () => {
    const odd = decodeOffer(encodeOffer({ ...offer, deliverySeconds: 5, criteria: [{ ...offer.criteria[0]!, weight: 99 }] }))!;
    assert.equal(odd.deliverySeconds, 3 * 86_400);
    assert.equal(odd.criteria[0]!.weight, 10);
  });

  it('give an agent a command that cannot be broken out of by a quote', () => {
    const tricky = agentCommand({ ...offer, title: "it's done'; rm -rf / '" });
    assert.ok(tricky.includes(`--title 'it'\\''s done'\\''; rm -rf / '\\'''`));
  });
});
