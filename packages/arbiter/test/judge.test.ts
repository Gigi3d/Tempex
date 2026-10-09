// The judge against a fake OpenAI endpoint: the real fetch path, request
// shapes per model family, usage accounting, and what adjudicate does when the
// panel is cached or unavailable. No key and no network needed.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { accountFor, type TempexClient } from '@tempex/sdk';
import { generatePrivateKey } from 'viem/accounts';

import { adjudicate } from '../src/adjudicate.js';
import { acceptsTemperature, complete, judgePanel, LlmError, type LlmConfig } from '../src/llm.js';
import { filePanelCache } from '../src/store.js';
import { HONEST_WORK, caseFor } from './helpers.js';

type Seen = { model: string; temperature?: number; json: boolean };
const seen: Seen[] = [];
/// How the fake endpoint treats each request, by model name.
let behaviour: (body: Record<string, unknown>) => { status: number; body: unknown } = () => ok(0.8);

function ok(score: number) {
  return {
    status: 200,
    body: {
      choices: [{ message: { content: JSON.stringify({ criteria: [{ id: 'tone', score, quotes: ['Votre panier'] }], rationale: 'reads naturally' }) } }],
      usage: { prompt_tokens: 1200, completion_tokens: 400 },
    },
  };
}

let server: Server;
let baseUrl = '';
const config = (models: string[], panelSize = 3): LlmConfig => ({ apiKey: 'test', baseUrl, models, panelSize, timeoutMs: 2_000 });

before(async () => {
  server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    seen.push({
      model: String(body['model']),
      ...(typeof body['temperature'] === 'number' ? { temperature: body['temperature'] } : {}),
      json: body['response_format'] !== undefined,
    });
    const reply = behaviour(body);
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen.length = 0;
  behaviour = () => ok(0.8);
});

const ask = (model: string) => complete(config([model]), { model, system: 's', user: 'u', temperature: 0.7 });

describe('request shape per model family', () => {
  it('knows which models take a temperature', () => {
    for (const model of ['gpt-4o-mini', 'gpt-4.1', 'openai/gpt-4o']) assert.equal(acceptsTemperature(model), true, model);
    for (const model of ['gpt-5', 'gpt-5-mini', 'o3', 'o4-mini', 'openai/gpt-5']) assert.equal(acceptsTemperature(model), false, model);
  });

  it('sends temperature and JSON mode to a chat model, and reads the usage', async () => {
    const reply = await ask('gpt-4o-mini');
    assert.deepEqual(seen, [{ model: 'gpt-4o-mini', temperature: 0.7, json: true }]);
    assert.deepEqual(reply.usage, { inputTokens: 1200, outputTokens: 400 });
  });

  it('never sends temperature to a reasoning model', async () => {
    await ask('gpt-5-mini');
    assert.deepEqual(seen, [{ model: 'gpt-5-mini', json: true }]);
  });

  it('drops temperature, and only temperature, when an unknown model rejects it', async () => {
    behaviour = (body) =>
      body['temperature'] !== undefined
        ? { status: 400, body: { error: { message: "Unsupported value: 'temperature' does not support 0.7 with this model." } } }
        : ok(0.8);
    await ask('house-reasoner');
    assert.deepEqual(seen, [
      { model: 'house-reasoner', temperature: 0.7, json: true },
      { model: 'house-reasoner', json: true },
    ]);
  });

  it('drops JSON mode when the endpoint rejects the request for another reason', async () => {
    behaviour = (body) => (body['response_format'] ? { status: 400, body: { error: { message: 'response_format not supported' } } } : ok(0.8));
    await ask('gpt-4o-mini');
    assert.deepEqual(seen.map((s) => s.json), [true, false]);
  });

  it('does not retry a bad key', async () => {
    behaviour = () => ({ status: 401, body: { error: { message: 'Incorrect API key' } } });
    await assert.rejects(ask('gpt-4o-mini'), (error: unknown) => error instanceof LlmError && error.status === 401);
    assert.equal(seen.length, 1);
  });
});

describe('the panel over HTTP', () => {
  it('sums every judge’s tokens', async () => {
    const panel = await judgePanel({ config: config(['gpt-4o-mini']), system: 's', user: 'u', openIds: ['tone'], deliverable: HONEST_WORK });
    assert.deepEqual(panel.usage, { inputTokens: 3600, outputTokens: 1200 });
    assert.equal(panel.criteria[0]!.score, 0.8);
  });
});

describe('adjudicate with a judge', () => {
  const fixture = caseFor({ delivered: HONEST_WORK });
  const account = accountFor(generatePrivateKey());
  const client = {
    address: account.address,
    account,
    addresses: { escrow: '0x001c8C3391E591C9CBDFdFE4227e585b86041157', token: '0x20C0000000000000000000000000000000000001' },
    job: async () => ({ ...fixture.job, arbiter: account.address }),
    evidenceClosedAt: async () => 1,
    deliverableURI: async () => '',
    verdictEncoding: async () => ({ local: '0x', onChain: '0x', matches: true }),
    arbitrationFee: async () => 500_000n,
    viem: { readContract: async ({ functionName }: { functionName: string }) => (functionName === 'arbiter' ? account.address : 200) },
  } as unknown as TempexClient;
  const run = (llm: LlmConfig, cacheDir?: string) =>
    adjudicate({
      client,
      jobId: 1n,
      evidenceCase: { terms: fixture.terms, bundle: fixture.bundle },
      dryRun: true,
      llm,
      ...(cacheDir ? { panelCache: filePanelCache(cacheDir) } : {}),
    });

  it('records the panel and its token usage on the result', async () => {
    const result = await run(config(['gpt-4o-mini']));
    assert.equal(result.engine, 'llm');
    assert.deepEqual(result.panel?.usage, { inputTokens: 3600, outputTokens: 1200 });
    assert.equal(result.panelFallback, undefined);
  });

  it('reuses paid-for scores on a retry with the same inputs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'panels-'));
    const first = await run(config(['gpt-4o-mini']), dir);
    assert.equal(seen.length, 3);
    behaviour = () => ok(0.1); // a fresh panel would now score differently
    const second = await run(config(['gpt-4o-mini']), dir);
    assert.equal(seen.length, 3, 'the panel was not asked again');
    assert.equal(second.ruling.sellerAwardBps, first.ruling.sellerAwardBps);
    assert.match(second.notes.join(' '), /reused/);
  });

  it('asks again when the panel itself changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'panels-'));
    await run(config(['gpt-4o-mini']), dir);
    await run(config(['gpt-4o-mini'], 5), dir);
    assert.equal(seen.length, 3 + 5);
  });

  it('says so, loudly, when the panel cannot rule', async () => {
    behaviour = () => ({ status: 401, body: { error: { message: 'Incorrect API key' } } });
    const result = await run(config(['gpt-4o-mini']));
    assert.equal(result.engine, 'rules');
    assert.match(result.panelFallback ?? '', /401/);
    assert.ok(result.flags.some((flag) => flag.startsWith('judge panel unavailable')));
  });

  it('refuses instead of falling back when the judge is required', async () => {
    behaviour = () => ({ status: 401, body: { error: { message: 'Incorrect API key' } } });
    await assert.rejects(
      adjudicate({ client, jobId: 1n, evidenceCase: { terms: fixture.terms, bundle: fixture.bundle }, dryRun: true, llm: config(['gpt-4o-mini']), engine: 'llm' }),
      /every judge on the panel failed/,
    );
  });
});
