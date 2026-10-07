import {
  CHAIN_ID,
  SPONSOR_URL,
  TempexClient,
  accountFor,
  addressesFromEnv,
  caseIntegrity,
  explorerAddress,
  explorerTx,
  formatToken,
  loadEnv,
  privateKeyFor,
  readCase,
} from '@tempex/sdk';

import {
  RefusalError,
  adjudicate,
  type AdjudicationEngine,
  type AdjudicationResult,
} from './adjudicate.js';
import { formatBps } from './rules.js';
import { evidenceDir, jsonText, receiptPath, repoRoot, runsDir, writeJson } from './store.js';
import { verifyArbiter } from './verify.js';
import { watchDisputes } from './watch.js';

type FlagValue = string | boolean;

class UsageError extends Error {
  override readonly name = 'UsageError';
}

const out = (line: string = ''): void => {
  process.stdout.write(`${line}\n`);
};
/// Progress goes to stderr so `--json` leaves stdout parseable.
const trace = (line: string): void => {
  process.stderr.write(`  ${line}\n`);
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

function numberFlag(flags: Record<string, FlagValue>, name: string): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`--${name} must be a positive number (got ${raw})`);
  }
  return parsed;
}

function engineFlag(flags: Record<string, FlagValue>): AdjudicationEngine {
  const value = stringFlag(flags, 'engine');
  if (value === undefined) return 'auto';
  if (value !== 'auto' && value !== 'rules' && value !== 'llm') {
    throw new UsageError(`--engine must be auto, rules or llm (got ${value})`);
  }
  return value;
}

/// One identity, one client: the arbiter's own key, from the gitignored .env.
function arbiterClient(sponsored: boolean): TempexClient {
  loadEnv(repoRoot());
  return new TempexClient({
    account: accountFor(privateKeyFor('arbiter')),
    addresses: addressesFromEnv(),
    ...(sponsored ? { sponsorUrl: SPONSOR_URL } : {}),
  });
}

const LABEL_WIDTH = 14;

function row(label: string, value: string): void {
  out(`${label.padEnd(LABEL_WIDTH)}${value}`);
}

function wrap(text: string, width = 92): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line.length === 0) line = word;
    else if (`${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else line += ` ${word}`;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function printResult(result: AdjudicationResult, receipt: string | null): void {
  const { ruling, money, band } = result;

  out('');
  row('job', `${result.jobId} — disputed, ${formatToken(money.amount)} escrowed`);
  row(
    'band',
    `${band.lowBps}-${band.highBps} bps (centre ${band.center}) — checks earned ` +
      `${result.signals.earnedWeight.toFixed(2)} of ${result.signals.checkedWeight}, ` +
      `${result.signals.openWeight} of ${result.signals.totalWeight} weight left to judgement`,
  );
  row(
    'engine',
    result.engine === 'llm'
      ? `${result.model}${result.requestedBps !== undefined ? ` proposed ${result.requestedBps} bps` : ''}`
      : `${result.model} (no model in the loop)`,
  );
  if (result.clamped && result.requestedBps !== undefined) {
    row('clamped', `${result.requestedBps} bps -> ${ruling.sellerAwardBps} bps, into the band`);
  }
  row(
    'ruling',
    `${formatBps(ruling.sellerAwardBps)} to the seller — seller ${formatToken(money.sellerAmount)}, ` +
      `buyer ${formatToken(money.buyerAmount)}, arbitration fee ${formatToken(money.arbitrationFee)} ` +
      `(${formatBps(money.arbitrationFeeBps)})`,
  );
  wrap(ruling.rationale).forEach((line, index) => row(index === 0 ? 'rationale' : '', line));
  row('evidence', `${result.evidenceHash} (the hash pinned at dispute time)`);
  row('rationale', `${ruling.rationaleHash} (committed by the signature, text kept off chain)`);
  row(
    'digest',
    `${result.digest} ${result.certified ? 'certified by the deployed escrow' : 'NOT CERTIFIED'}`,
  );
  row('signature', result.signature);
  row('signer', `${result.recovered} vs escrow.arbiter() ${result.registeredArbiter}`);
  if (result.relay) {
    row('settled', `${result.relay.hash}`);
    row('', explorerTx(result.relay.hash));
  }
  for (const note of result.notes) row('note', note);
  for (const flag of result.flags) row('flag', flag);
  if (receipt !== null) row('receipt', receipt);
  out('');
}

function receiptFor(
  result: AdjudicationResult,
  client: TempexClient,
  command: string,
): Record<string, unknown> {
  return {
    tempex: 'adjudication-receipt/1',
    command,
    at: new Date().toISOString(),
    chainId: CHAIN_ID,
    escrow: client.addresses.escrow,
    escrowExplorer: explorerAddress(client.addresses.escrow),
    ...(result.relay ? { relayExplorer: explorerTx(result.relay.hash) } : {}),
    ...result,
  };
}

async function cmdAdjudicate(flags: Record<string, FlagValue>): Promise<number> {
  const jobRaw = stringFlag(flags, 'job');
  if (jobRaw === undefined) throw new UsageError('adjudicate requires --job <id>');
  const jobId = BigInt(jobRaw);
  const dryRun = flags['dry'] === true;
  const relay = flags['relay'] === true;
  const sponsored = flags['sponsored'] === true;
  const asJson = flags['json'] === true;
  if (dryRun && relay) throw new UsageError('--dry and --relay contradict each other');

  const client = arbiterClient(sponsored);
  const evidenceCase = readCase(evidenceDir(), jobId);
  const problems = caseIntegrity(evidenceCase);
  if (problems.length > 0) {
    out(`refusing to rule on job ${jobId}: the evidence case is inconsistent`);
    for (const problem of problems) out(`  - ${problem}`);
    return 2;
  }

  const result = await adjudicate({
    client,
    jobId,
    evidenceCase,
    engine: engineFlag(flags),
    ttlSeconds: numberFlag(flags, 'ttl'),
    dryRun,
    relay,
    writeOptions: sponsored ? { sponsored } : {},
    log: asJson ? undefined : trace,
  });

  const receipt =
    flags['no-receipt'] === true
      ? null
      : writeJson(receiptPath(result.jobId), receiptFor(result, client, 'adjudicate'));

  if (asJson) process.stdout.write(jsonText(receiptFor(result, client, 'adjudicate')));
  else printResult(result, receipt);
  return 0;
}

async function cmdWatch(flags: Record<string, FlagValue>): Promise<number> {
  const once = flags['once'] === true;
  const poll = flags['poll'] === true;
  const sponsored = flags['sponsored'] === true;
  const relay = flags['no-relay'] !== true;
  const fromRaw = stringFlag(flags, 'from');

  const client = arbiterClient(sponsored);
  const stamp = (): string => new Date().toISOString().slice(11, 19);

  row('arbiter', client.address);
  row('escrow', client.addresses.escrow);
  row('evidence', evidenceDir());
  row(
    'mode',
    `${once ? 'catch-up scan, then exit' : poll ? 'http polling' : 'websocket'} · ` +
      `rulings are ${relay ? 'signed and relayed' : 'signed only'}`,
  );
  if (relay && sponsored) row('fees', `sponsored via ${SPONSOR_URL}`);
  out('');

  const handle = await watchDisputes({
    client,
    evidenceDir: evidenceDir(),
    runsDir: runsDir(),
    engine: engineFlag(flags),
    ttlSeconds: numberFlag(flags, 'ttl'),
    fromBlock: fromRaw === undefined ? undefined : BigInt(fromRaw),
    relay,
    poll,
    once,
    writeOptions: sponsored ? { sponsored } : {},
    log: (line) => out(`[${stamp()}] ${line}`),
    onRuling: (result) => {
      const path = writeJson(receiptPath(result.jobId), receiptFor(result, client, 'watch'));
      printResult(result, path);
    },
  });

  if (once) {
    const failures = handle.failures();
    out('');
    row(
      'catch-up',
      `${handle.settled().length} ruled, ${handle.pending().length} awaiting evidence, ` +
        `${Object.keys(failures).length} failed`,
    );
    for (const [jobId, why] of Object.entries(failures)) row(`job ${jobId}`, why);
    return Object.keys(failures).length === 0 ? 0 : 3;
  }

  process.on('SIGINT', () => {
    handle.stop();
    out('');
    row('stopped', `${handle.settled().length} ruled, ${handle.pending().length} pending`);
    process.exit(0);
  });

  await new Promise<void>(() => {});
  return 0;
}

async function cmdVerify(flags: Record<string, FlagValue>): Promise<number> {
  const client = arbiterClient(false);
  row('signer', client.address);
  row('escrow', client.addresses.escrow);
  out('');

  const report = await verifyArbiter({ client });
  for (const entry of report.checks) {
    out(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}`);
    out(`      ${entry.detail}`);
  }
  out('');
  out(
    report.passed
      ? 'all checks passed: the escrow accepts this key\'s verdicts'
      : 'CHECKS FAILED: do not relay verdicts from this arbiter',
  );
  if (flags['json'] === true) process.stdout.write(jsonText(report));
  return report.passed ? 0 : 3;
}

/// Puts this arbiter on the market: buyers can then name it for a job with
/// createJobWithArbiter, and it earns its fee minus the protocol's cut.
async function cmdList(flags: Record<string, FlagValue>): Promise<number> {
  const sponsored = flags['sponsored'] === true;
  const client = arbiterClient(sponsored);
  row('arbiter', client.address);
  row('escrow', client.addresses.escrow);

  if (flags['delist'] === true) {
    const receipt = await client.delistArbiter({ sponsored });
    row('delisted', explorerTx(receipt.transactionHash));
    out('new jobs can no longer name this arbiter; jobs it already judges are unaffected');
    return 0;
  }

  const feeBps = numberFlag(flags, 'fee');
  if (feeBps === undefined || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1_000) {
    out('list needs --fee <bps>, an integer from 0 to 1000 (the escrow\'s arbitration fee cap)');
    return 1;
  }
  const metadataURI = stringFlag(flags, 'uri') ?? '';
  const receipt = await client.listArbiter(feeBps, metadataURI, { sponsored });
  const listing = await client.arbiterListing(client.address);
  row('listed', explorerTx(receipt.transactionHash));
  row('fee', `${listing.feeBps} bps of each disputed job it rules, minus the protocol cut`);
  row('profile', listing.metadataURI || '(none — set --uri so buyers can see your model and rules)');
  out('');
  out('run `watch` with this key to rule on the jobs that name it');
  return 0;
}

function usage(): void {
  out('Tempex arbiter — evidence in, signed verdict out.');
  out('');
  out('  adjudicate --job <id> [--dry] [--relay] [--engine auto|rules|llm] [--ttl <s>] [--sponsored] [--json] [--no-receipt]');
  out('  watch [--once] [--poll] [--from <block>] [--engine auto|rules|llm] [--ttl <s>] [--no-relay] [--sponsored]');
  out('  verify [--json]');
  out('  list --fee <bps> [--uri <url>] [--sponsored] | list --delist');
  out('');
  out('  adjudicate   rule on one dispute; --dry skips the on-chain state gate, --relay settles it');
  out('  watch        rule on every dispute as it is raised; --once scans history and exits');
  out('  verify       prove this key\'s verdicts against the deployed escrow — no dispute needed');
  out('  list         offer this key as an arbiter buyers can choose, at its own fee');
  out('');
  out('OPENAI_API_KEY activates the LLM judge; without one the deterministic rule engine rules.');
}

async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseFlags(argv);
  switch (command) {
    case 'adjudicate':
      return cmdAdjudicate(flags);
    case 'watch':
      return cmdWatch(flags);
    case 'verify':
      return cmdVerify(flags);
    case 'list':
      return cmdList(flags);
    case '':
    case 'help':
      usage();
      return 0;
    default:
      out(`unknown command: ${command}`);
      usage();
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof RefusalError) {
      out('refused to rule:');
      for (const reason of error.reasons) out(`  - ${reason}`);
      out('no signature was produced.');
      process.exitCode = 2;
      return;
    }
    if (error instanceof UsageError) {
      out(error.message);
      usage();
      process.exitCode = 1;
      return;
    }
    out(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  });
