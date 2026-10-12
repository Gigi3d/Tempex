// The court's HTTP door, without a chain: a stub client answers the one read
// adjudicate makes before it refuses. What matters is that the door never rules
// on a case the chain does not back, and says why.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { TempexClient } from '@tempex/sdk';

import { startCourt } from '../src/court.js';
import { HONEST_WORK, caseFor } from './helpers.js';

const ARBITER = '0x3425173FAB110f780482af62Bf603b9A7D023905';
const OTHER = '0x92F3D653399fC151d58A927B9e1A33D50EdCC4A8';
const fixture = caseFor({ delivered: HONEST_WORK });

const stub = {
  address: ARBITER,
  addresses: { escrow: '0x001c8C3391E591C9CBDFdFE4227e585b86041157', token: '0x20C0000000000000000000000000000000000001' },
  // The job names a different arbiter, so adjudicate must refuse before signing.
  job: async () => ({ ...fixture.job, arbiter: OTHER }),
} as unknown as TempexClient;

let court: ReturnType<typeof startCourt>;
const port = 18_788 + Math.floor(Math.random() * 500);
const url = (path: string) => `http://127.0.0.1:${port}${path}`;
const post = (path: string, body: unknown, origin?: string) =>
  fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('court', () => {
  before(async () => {
    court = startCourt({
      client: stub,
      port,
      host: '127.0.0.1',
      origins: ['https://tempex.example'],
      evidenceDir: mkdtempSync(join(tmpdir(), 'court-')),
      sponsored: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  after(() => court.close());

  it('reports which key it rules with', async () => {
    const response = await fetch(url('/health'));
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual({ ok: body['ok'], arbiter: body['arbiter'], escrow: body['escrow'], sponsored: body['sponsored'] }, { ok: true, arbiter: ARBITER, escrow: stub.addresses.escrow, sponsored: true });
    assert.equal(body['engine'], 'rules');
    assert.equal(body['rulings'], 0);
  });

  it('answers unknown routes with 404', async () => {
    assert.equal((await fetch(url('/rule/abc'), { method: 'POST' })).status, 404);
    assert.equal((await fetch(url('/rule/1'))).status, 404);
  });

  it('rejects a body that is not an evidence case', async () => {
    assert.equal((await post('/rule/1', '{not json')).status, 400);
    assert.equal((await post('/rule/1', { terms: {} })).status, 400);
  });

  it('rejects a case whose files disagree with each other before reading the chain', async () => {
    const response = await post('/rule/1', { terms: fixture.terms, bundle: { ...fixture.bundle, termsHash: `0x${'1'.repeat(64)}` } });
    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: string; problems: string[] };
    assert.equal(body.error, 'inconsistent_case');
    assert.ok(body.problems.length > 0);
  });

  it('refuses, with reasons, a job assigned to another arbiter', async () => {
    const response = await post('/rule/1', { terms: fixture.terms, bundle: fixture.bundle });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string; reasons: string[] };
    assert.equal(body.error, 'refused');
    assert.match(body.reasons.join(' '), /assigned to arbiter/);
  });

  it('allows only listed browser origins', async () => {
    const allowed = await post('/rule/1', '{', 'https://tempex.example');
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://tempex.example');
    const denied = await post('/rule/1', '{', 'https://evil.example');
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });
});
