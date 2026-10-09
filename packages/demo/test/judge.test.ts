// The judge comparison is only worth reading if it measures the real pipeline.
// A scripted panel stands in for the model here: what is under test is that its
// scores flow through the same award arithmetic and guardrail the court uses.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { judgeScenario } from '../src/judge.js';
import { SCENARIOS } from '../src/scenarios.js';

const config = { apiKey: 'test', baseUrl: 'http://unused', models: ['scripted'], panelSize: 1, timeoutMs: 1000 } as never;

function scripted(score: number) {
  return async (_config: unknown, request: { user: string }) => {
    const ids = [...request.user.matchAll(/\b(c\d+)\b/g)].map((m) => m[1]!);
    const open = [...new Set(ids)];
    return { content: JSON.stringify({ criteria: open.map((id) => ({ id, score, quotes: [] })), rationale: 'scripted' }), usage: { inputTokens: 10, outputTokens: 5 } };
  };
}

describe('judge comparison', () => {
  it('keeps every judged award inside the band the facts allow', async () => {
    for (const scenario of SCENARIOS) {
      for (const score of [0, 1]) {
        const result = await judgeScenario(scenario, config, scripted(score) as never);
        if (result.judgedBps === null) continue;
        assert.ok(result.judgedBps >= result.band[0] && result.judgedBps <= result.band[1], `${scenario.id} at ${score}: ${result.judgedBps} outside ${result.band}`);
        assert.equal(result.movedBps, result.judgedBps - result.rulesBps);
      }
    }
  });

  it('a credit-claiming score without a verified quote cannot move the award up', async () => {
    const scenario = SCENARIOS.find((s) => s.id === 'underdelivered')!;
    const neutral = await judgeScenario(scenario, config, scripted(0.5) as never);
    const greedy = await judgeScenario(scenario, config, scripted(1) as never);
    assert.ok(greedy.judgedBps! <= neutral.judgedBps! + 1, 'unquoted full marks are discarded by the evidence rule');
  });
});
