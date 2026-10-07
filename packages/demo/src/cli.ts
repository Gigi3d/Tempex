import { formatBps } from '@tempex/arbiter';
import { CHAIN_ID } from '@tempex/sdk';

import { drill, renderDrill } from './drill.js';
import { caseHashes, predictAll, renderPredictions, ARBITRATION_FEE_BPS } from './predict.js';
import { runDemo, type DemoResult } from './runner.js';
import { DEFAULT_SCENARIO, SCENARIOS, scenarioById, type ScenarioId } from './scenarios.js';
import { DEMO_STAGES, STAGE_META, type DemoStage } from './transcript.js';

type FlagValue = string | boolean;

class UsageError extends Error {
  override readonly name = 'UsageError';
}

/// Stdout carries the artifact; stderr carries progress. `run` streams its
/// transcript to stderr so `--json` on stdout stays parseable.
const out = (line: string = ''): void => {
  process.stdout.write(`${line}\n`);
};
const trace = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

function parseFlags(argv: string[]): { command: string; flags: Record<string, FlagValue> } {
  const [command = '', ...rest] = argv;
  const flags: Record<string, FlagValue> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token}`);
    const equals = token.indexOf('=');
    if (equals !== -1) {
      flags[token.slice(2, equals).toLowerCase()] = token.slice(equals + 1);
      continue;
    }
    const name = token.slice(2).toLowerCase();
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return { command, flags };
}

function stringFlag(flags: Record<string, FlagValue>, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new UsageError(`--${name} requires a value`);
  return value;
}

function boolFlag(flags: Record<string, FlagValue>, name: string): boolean {
  const value = flags[name];
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new UsageError(`--${name} is a switch; got ${value}`);
}

function scenarioFlag(flags: Record<string, FlagValue>): ScenarioId {
  const raw = stringFlag(flags, 'scenario');
  if (raw === undefined) return DEFAULT_SCENARIO;
  return scenarioById(raw).id;
}

function stageFlag(flags: Record<string, FlagValue>, name: string): DemoStage | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  const stage = DEMO_STAGES.find((candidate) => candidate === raw);
  if (stage === undefined) {
    throw new UsageError(`--${name} must be one of ${DEMO_STAGES.join(', ')} (got ${raw})`);
  }
  return stage;
}

function engineFlag(flags: Record<string, FlagValue>): 'auto' | 'rules' | 'llm' {
  const value = stringFlag(flags, 'engine');
  if (value === undefined) return 'auto';
  if (value !== 'auto' && value !== 'rules' && value !== 'llm') {
    throw new UsageError(`--engine must be auto, rules or llm (got ${value})`);
  }
  return value;
}

// ------------------------------------------------------------------- commands

function help(): void {
  out('tempex demo — an agentic arbitration and settlement layer, on Tempo Moderato');
  out('');
  out('  run       drive a dispute end to end against the live chain');
  out('  predict   run the rule engine over the corpus offline; no keys, no network');
  out('  drill     push scripted judge proposals through the band guardrail');
  out('  stages    the demo spine, in order, and what each stage proves');
  out('  scenarios the dispute corpus: what each case delivers and what it should rule');
  out('');
  out('run flags');
  out('  --scenario <id>   case to stage (default underdelivered)');
  out('  --from <stage>    first stage to run (default case)');
  out('  --upto <stage>    last stage to run (default settle)');
  out('  --sponsored       route every write through the hosted fee payer');
  out('  --listed-arbiter  judge with the arbiter key as a listed market arbiter, not the house arbiter');
  out('  --engine <e>      auto | rules | llm (default auto)');
  out('  --force           re-run stages this session already recorded');
  out('  --fresh           discard the recorded session and start over');
  out('  --session <name>  session file name (default: the scenario id)');
  out('  --json            print the receipt to stdout instead of the transcript');
  out('');
  out(`stages: ${DEMO_STAGES.join(' → ')}`);
}

function stages(): void {
  out(`the demo spine — ${DEMO_STAGES.length} stages, each one a transaction or a check`);
  out('');
  for (const [index, stage] of DEMO_STAGES.entries()) {
    const meta = STAGE_META[stage];
    out(`${String(index + 1).padStart(2)}. ${stage.padEnd(10)}${meta.title}`);
    out(`    ${meta.point}`);
  }
}

function scenarios(): void {
  out(`the corpus — ${SCENARIOS.length} disputes; the rule engine has to land inside every band`);
  out('');
  for (const scenario of SCENARIOS) {
    const { expect } = scenario;
    const marking = scenario.live ? 'live' : 'offline';
    out(`${scenario.id}  [${marking}]  ${scenario.title}`);
    out(`    ${scenario.premise}`);
    out(`    ${scenario.amount} alphaUSD delivered against ${scenario.criteria.length} criteria`);
    out(
      `    must rule: ${Object.entries(expect.credits).map(([id, c]) => `${id} ${c === null ? 'open' : c.toFixed(2)}`).join(', ')}; ` +
        `band ${expect.band[0]}-${expect.band[1]} bps around ${expect.center} (${formatBps(expect.center)})`,
    );
    out('');
  }
  out(
    `the live run asserts these numbers against the chain; predict asserts them against the engine alone.`,
  );
}

function predict(flags: Record<string, FlagValue>): number {
  const predictions = predictAll();
  const withHashes = boolFlag(flags, 'hashes');
  out('');
  out(`tempex rules engine · arbitration fee assumed at ${ARBITRATION_FEE_BPS} bps · chain ${CHAIN_ID}`);
  out('');
  process.stdout.write(renderPredictions(predictions));
  if (withHashes) {
    out('');
    out('case hashes as the offline run pins them (job 0, placeholder parties):');
    for (const scenario of SCENARIOS) {
      const hashes = caseHashes(scenario);
      out(`${scenario.id}`);
      out(`    terms       ${hashes.termsHash}`);
      out(`    deliverable ${hashes.deliverableHash}`);
      out(`    bundle      ${hashes.disputeHash}`);
    }
  }
  const failed = predictions.filter((entry) => !entry.ok);
  if (!boolFlag(flags, 'json')) return failed.length === 0 ? 0 : 3;

  out('');
  out(
    JSON.stringify(
      {
        tempex: 'corpus-prediction/1',
        arbitrationFeeBps: ARBITRATION_FEE_BPS,
        ok: failed.length === 0,
        predictions: predictions.map((entry) => ({
          ...entry,
          money: {
            amount: entry.money.amount.toString(),
            arbitrationFee: entry.money.arbitrationFee.toString(),
            sellerAmount: entry.money.sellerAmount.toString(),
            buyerAmount: entry.money.buyerAmount.toString(),
          },
        })),
      },
      null,
      2,
    ),
  );
  return failed.length === 0 ? 0 : 3;
}

function drillGuardrail(): number {
  const report = drill();
  out('');
  out('the guardrail — what a judge is allowed to propose, and what survives');
  out('');
  process.stdout.write(renderDrill(report));
  return report.ok ? 0 : 3;
}

function reportRun(result: DemoResult, asJson: boolean): number {
  if (!asJson) {
    trace('');
    trace(
      result.ok
        ? `demo ok — ${result.ran.length} stage(s) ran, ${result.skipped.length} skipped`
        : `demo FAILED — ${result.failures.length} problem(s)`,
    );
    return result.ok ? 0 : 3;
  }

  out(JSON.stringify(result.receipt, null, 2));
  return result.ok ? 0 : 3;
}

async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseFlags(argv);

  if (command === '' || command === 'help' || boolFlag(flags, 'help')) {
    help();
    return 0;
  }
  if (command === 'stages') {
    stages();
    return 0;
  }
  if (command === 'scenarios') {
    scenarios();
    return 0;
  }
  if (command === 'predict') return predict(flags);
  if (command === 'drill') return drillGuardrail();

  if (command === 'run') {
    const asJson = boolFlag(flags, 'json');
    const scenario = scenarioFlag(flags);
    const result = await runDemo({
      scenario: scenarioById(scenario),
      from: stageFlag(flags, 'from'),
      upto: stageFlag(flags, 'upto'),
      sponsored: boolFlag(flags, 'sponsored'),
      force: boolFlag(flags, 'force'),
      fresh: boolFlag(flags, 'fresh'),
      listedArbiter: boolFlag(flags, 'listed-arbiter'),
      session: stringFlag(flags, 'session'),
      engine: engineFlag(flags),
      ...(asJson ? {} : { write: (line) => trace(line) }),
    });
    return reportRun(result, asJson);
  }

  throw new UsageError(`unknown command: ${command}`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      trace(`usage: ${error.message}`);
      trace('run `tempex demo help` for the flag list');
      process.exitCode = 1;
      return;
    }
    trace(error instanceof Error ? `error: ${error.message}` : `error: ${String(error)}`);
    if (error instanceof Error && error.stack !== undefined) trace(error.stack);
    process.exitCode = 1;
  });
