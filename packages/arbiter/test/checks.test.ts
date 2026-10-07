import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkProblem, runCheck } from '../src/checks.js';

const DOC = JSON.stringify({
  strings: { 'a/b': 'slash key', nested: { title: 'Bonjour', body: '' } },
  list: [1, 2, 3],
  prices: { total: '12,50 €', fee: '$4.00' },
  prose: 'Votre commande est confirmée. Merci de votre confiance, elle sera expédiée sous deux jours ouvrés.',
});

describe('jsonKeys', () => {
  it('gives fractional credit by share of keys present, by dotted path', () => {
    const r = runCheck({ type: 'jsonKeys', at: '/strings', keys: ['nested.title', 'nested.missing'] }, DOC);
    assert.equal(r.credit, 0.5);
    assert.match(r.evidence, /missing nested\.missing/);
  });
  it('treats an empty string as missing unless nonEmpty is false', () => {
    assert.equal(runCheck({ type: 'jsonKeys', at: '/strings', keys: ['nested.body'] }, DOC).credit, 0);
    assert.equal(runCheck({ type: 'jsonKeys', at: '/strings', keys: ['nested.body'], nonEmpty: false }, DOC).credit, 1);
  });
  it('follows RFC 6901 escapes in the pointer', () => {
    assert.equal(runCheck({ type: 'jsonKeys', at: '/strings', keys: ['a/b'] }, DOC).credit, 1);
    assert.equal(runCheck({ type: 'json', at: '/strings/a~1b' }, DOC).credit, 1);
  });
  it('fails, rather than throws, on a deliverable that is not JSON', () => {
    const r = runCheck({ type: 'jsonKeys', keys: ['x'] }, 'plain text');
    assert.equal(r.credit, 0);
    assert.match(r.evidence, /not JSON/);
  });
});

describe('json', () => {
  it('validates against an agreed JSON Schema', () => {
    const schema = { type: 'object', required: ['total'], properties: { total: { type: 'string' } } };
    assert.equal(runCheck({ type: 'json', at: '/prices', schema }, DOC).credit, 1);
    assert.equal(runCheck({ type: 'json', at: '/list', schema }, DOC).credit, 0);
  });
});

describe('count', () => {
  it('counts items, and gives partial credit below the minimum', () => {
    assert.equal(runCheck({ type: 'count', at: '/list', unit: 'items', min: 3 }, DOC).credit, 1);
    assert.equal(runCheck({ type: 'count', at: '/list', unit: 'items', min: 6 }, DOC).credit, 0.5);
  });
  it('gives nothing above the maximum', () => {
    assert.equal(runCheck({ type: 'count', at: '/list', unit: 'items', max: 2 }, DOC).credit, 0);
  });
  it('counts words of the whole deliverable when no pointer is given', () => {
    assert.equal(runCheck({ type: 'count', unit: 'words', min: 2, max: 2 }, 'two words').credit, 1);
  });
});

describe('language', () => {
  it('detects the language of the selected text', () => {
    assert.equal(runCheck({ type: 'language', at: '/prose', is: 'fr' }, DOC).credit, 1);
    assert.equal(runCheck({ type: 'language', at: '/prose', is: 'en' }, DOC).credit, 0);
  });
  it('refuses to guess on too little text', () => {
    const r = runCheck({ type: 'language', at: '/strings/nested/title', is: 'fr' }, DOC);
    assert.equal(r.credit, 0);
    assert.match(r.evidence, /characters of text/);
  });
  it('does not read short English UI text as a rare neighbour', () => {
    const ui = JSON.stringify({ s: ['Your cart', 'Checkout', 'Pay now', 'Shipping address', 'Thank you for your order'] });
    assert.equal(runCheck({ type: 'language', at: '/s', is: 'en' }, ui).credit, 1);
  });
});

describe('regex', () => {
  it('gives credit by share of matching values, filtered by a key glob', () => {
    assert.equal(runCheck({ type: 'regex', at: '/prices', pattern: '^\\d+,\\d{2} €$' }, DOC).credit, 0.5);
    assert.equal(runCheck({ type: 'regex', at: '/prices', keys: 'tot*', pattern: '^\\d+,\\d{2} €$' }, DOC).credit, 1);
  });
  it('rejects flags that change matching semantics across calls', () => {
    assert.equal(runCheck({ type: 'regex', pattern: 'x', flags: 'g' }, 'x').credit, 0);
    assert.notEqual(checkProblem({ type: 'regex', pattern: 'x', flags: 'g' }), null);
  });
});

describe('contains', () => {
  it('needs every literal, case-insensitively by default', () => {
    assert.equal(runCheck({ type: 'contains', at: '/prose', all: ['COMMANDE', 'confiance'] }, DOC).credit, 1);
    assert.equal(runCheck({ type: 'contains', at: '/prose', all: ['COMMANDE'], caseSensitive: true }, DOC).credit, 0);
  });
});

describe('checkProblem', () => {
  it('names what is wrong with a check, or returns null', () => {
    assert.equal(checkProblem({ type: 'jsonKeys', at: '/x', keys: ['a'] }), null);
    assert.match(checkProblem({ type: 'jsonKeys', at: 'x', keys: ['a'] })!, /pointer/);
    assert.match(checkProblem({ type: 'count', unit: 'pages' })!, /unit/);
    assert.match(checkProblem({ type: 'count', unit: 'words', min: 5, max: 1 })!, /above/);
    assert.match(checkProblem({ type: 'language', is: 'french' })!, /ISO/);
    assert.match(checkProblem({ type: 'json', schema: { type: 'nope' } })!, /schema/i);
    assert.match(checkProblem({ type: 'telepathy' })!, /unknown/);
  });
});
