import type { Address } from 'viem';

import { explorerAddress } from '@tempex/sdk';

import {
  BLUEPRINT_ACTIONS,
  Beacon,
  BeaconError,
  beaconConfigFromEnv,
  serialize,
  startBeaconServer,
  type BlueprintAction,
  type DiscoveryFilter,
  type JobStage,
  type RegistryRole,
  type Role,
} from './index.js';

const STAGES: JobStage[] = [
  'created',
  'funded',
  'delivered',
  'accepted',
  'disputed',
  'resolved',
  'refunded',
  'cancelled',
];

const ROLES: Role[] = ['seller', 'buyer'];
const REGISTRY_ROLES: RegistryRole[] = ['seller', 'buyer', 'arbiter', 'relay'];

type FlagValue = string | boolean;

class UsageError extends Error {
  override readonly name = 'UsageError';
}

/// Answers are JSON on stdout because the intended reader is an agent; the human
/// running it gets progress on stderr so the two never interleave.
const out = (value: unknown): void => {
  process.stdout.write(`${serialize(value)}\n`);
};

const trace = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Record<string, FlagValue> } {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
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
  return { command, positional, flags };
}

function string(flags: Record<string, FlagValue>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new UsageError(`--${name} requires a value`);
    return value;
  }
  return undefined;
}

function integer(flags: Record<string, FlagValue>, ...names: string[]): number | undefined {
  const raw = string(flags, ...names);
  if (raw === undefined) return undefined;
  const name = names[0] ?? 'value';
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`--${name} must be a non-negative integer (got ${raw})`);
  }
  return parsed;
}

function oneOf<T>(value: string | undefined, allowed: readonly T[], label: string): T {
  if (value === undefined) throw new UsageError(`${label} is required: one of ${allowed.join(', ')}`);
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new UsageError(`${label} must be one of ${allowed.join(', ')} (got ${value})`);
  return match;
}

function role(flags: Record<string, FlagValue>): Role {
  return oneOf(string(flags, 'role'), ROLES, '--role');
}

function checkedAddress(value: string, label: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new UsageError(`${label} must be a 20-byte address (got ${value})`);
  }
  return value as Address;
}

/// Accepts either `--address 0x…` or a bare positional, because both are how
/// people actually type it.
function target(flags: Record<string, FlagValue>, positional: string[], label: string): Address {
  const raw = string(flags, 'address', 'id', 'job') ?? positional[0];
  if (raw === undefined) throw new UsageError(`${label} is required`);
  return checkedAddress(raw, label);
}

function jobId(flags: Record<string, FlagValue>, positional: string[]): bigint {
  const raw = string(flags, 'job', 'id') ?? positional[0];
  if (raw === undefined) throw new UsageError('a job id is required, e.g. `job 3` or `--job 3`');
  if (!/^\d+$/.test(raw)) throw new UsageError(`job ids are decimal integers (got ${raw})`);
  return BigInt(raw);
}

function json(flags: Record<string, FlagValue>, name: string): Record<string, unknown> {
  const raw = string(flags, name);
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`--${name} must be a JSON object (got ${raw})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`--${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/// Opens the beacon and says what it found, so a human watching a terminal knows
/// the numbers about to be printed are folded from the chain and not from a cache.
async function open(): Promise<Beacon> {
  const config = beaconConfigFromEnv();
  trace(`reading ${config.network} (chain ${config.chainId}) via ${config.rpcUrl}`);
  const beacon = await Beacon.open(config);
  const view = beacon.view;
  trace(
    `indexed ${view.eventCount} events into ${view.jobs.length} jobs, ` +
      `blocks ${view.fromBlock}..${view.toBlock}`,
  );
  trace(`escrow ${config.escrow} ${explorerAddress(config.escrow)}`);
  return beacon;
}

async function cmdServe(flags: Record<string, FlagValue>): Promise<number> {
  const beacon = await open();
  const listen = string(flags, 'listen');
  const port = integer(flags, 'port');
  const interval = integer(flags, 'interval');
  const server = await startBeaconServer(beacon, {
    ...(listen === undefined ? {} : { listen }),
    ...(port === undefined ? {} : { port }),
    ...(interval === undefined ? {} : { syncIntervalMs: interval }),
  });

  trace('');
  trace(`\x1b[1m${beacon.config.name}\x1b[0m v${beacon.config.version} listening on ${server.listen}:${server.port}`);
  trace(`  manifest      ${server.url}/.well-known/tempex.json`);
  trace(`  agent card    ${server.url}/.well-known/agent.json`);
  trace(`  evidence      ${server.url}/stats`);
  trace(`  onboarding    ${server.url}/onboard?role=seller`);
  trace(`  discovery     ${server.url}/discover${beacon.gate.enabled ? ' (paid: send ?quote=1 first)' : ' (free: no treasury configured)'}`);
  trace(`  index refresh every ${Math.round((interval ?? 15_000) / 1000)}s; keys held: none`);
  trace('');
  trace('ctrl-c to stop');

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await server.close();
  trace('closed.');
  return 0;
}

async function cmdJobs(flags: Record<string, FlagValue>): Promise<number> {
  const beacon = await open();
  const stage = string(flags, 'stage');
  const address = string(flags, 'address');
  const jobs = beacon.jobs({
    ...(stage === undefined ? {} : { stage: oneOf(stage, STAGES, '--stage') }),
    ...(address === undefined ? {} : { address: checkedAddress(address, '--address') }),
    limit: integer(flags, 'limit') ?? 25,
  });
  out({
    count: jobs.length,
    indexed: beacon.view.jobs.length,
    order: 'newest first',
    jobs,
  });
  return 0;
}

async function cmdJob(flags: Record<string, FlagValue>, positional: string[], proof: boolean): Promise<number> {
  const beacon = await open();
  const id = jobId(flags, positional);
  const found = proof ? beacon.proof(id) : beacon.job(id);
  if (found === null || found === undefined) {
    trace(`no job ${id} in the index: the escrow has seen ${beacon.view.jobs.length} jobs, ids ${describeIds(beacon)}`);
    return 2;
  }
  out(found);
  return 0;
}

function describeIds(beacon: Beacon): string {
  const ids = beacon.view.jobs.map((job) => job.jobId.toString());
  if (ids.length === 0) return '(none yet)';
  return ids.length <= 12 ? ids.join(', ') : `${ids.slice(0, 12).join(', ')}, … +${ids.length - 12} more`;
}

async function cmdBlueprint(flags: Record<string, FlagValue>): Promise<number> {
  const beacon = await open();
  const raw = string(flags, 'action');
  const action = oneOf(raw, BLUEPRINT_ACTIONS, '--action') as BlueprintAction;
  const sponsored = flags['unsponsored'] !== true;
  const blueprint = await beacon.blueprintFor(action, json(flags, 'params'), { sponsored });
  out(blueprint);
  return 0;
}

async function cmdDiscover(flags: Record<string, FlagValue>): Promise<number> {
  const beacon = await open();
  const wanted = string(flags, 'role');
  const minScore = integer(flags, 'min-score', 'minscore');
  const filter: DiscoveryFilter = {
    ...(string(flags, 'capability') === undefined ? {} : { capability: string(flags, 'capability') }),
    ...(wanted === undefined ? {} : { role: oneOf(wanted, REGISTRY_ROLES, '--role') }),
    ...(minScore === undefined ? {} : { minScore }),
    limit: integer(flags, 'limit') ?? 25,
  };
  const listings = beacon.discover(filter);
  out({
    resource: '/discover',
    filter,
    count: listings.length,
    rankedBy: 'derived on-chain reputation, then settled jobs, then registration age — never by payment',
    payment: beacon.gate.enabled
      ? { enabled: true, note: 'over HTTP this route answers 402 until a quote is paid; the CLI reads the same index directly' }
      : { enabled: false, note: 'no treasury configured, so discovery is free on this beacon' },
    listings,
  });
  return 0;
}

type Command = {
  run: (flags: Record<string, FlagValue>, positional: string[]) => Promise<number>;
  usage: string;
  about: string;
};

/// Most commands are one read and one document. This keeps them to a single line
/// and guarantees the exit code is a number rather than whatever `out` returned.
function simple(
  read: (beacon: Beacon, flags: Record<string, FlagValue>, positional: string[]) => unknown | Promise<unknown>,
): Command['run'] {
  return async (flags, positional) => {
    out(await read(await open(), flags, positional));
    return 0;
  };
}

const COMMANDS: Record<string, Command> = {
  serve: {
    run: cmdServe,
    usage: 'serve [--listen <host>] [--port <n>] [--interval <ms>]',
    about: 'run the HTTP beacon: manifest, evidence, onboarding and the 402 discovery gate',
  },
  manifest: {
    run: simple((beacon) => beacon.manifest()),
    usage: 'manifest',
    about: 'the document an agent reads first: identity, protocol state, costs, tools, verification recipe',
  },
  card: {
    run: simple((beacon) => beacon.card()),
    usage: 'card',
    about: 'A2A-style agent card: skills, modes, endpoint, and the custody statement',
  },
  health: {
    run: simple((beacon) => beacon.health()),
    usage: 'health',
    about: 'liveness plus how far the index has caught up to the head of the chain',
  },
  stats: {
    run: simple((beacon) => beacon.stats()),
    usage: 'stats',
    about: 'whole-network evidence: jobs by stage, money moved, verdict bounds, measured arbitration latency',
  },
  policies: {
    run: simple((beacon) => ({ policies: beacon.policies() })),
    usage: 'policies',
    about: 'deal-policy templates the arbiter actually implements: deadlines, review windows, verdict bands',
  },
  jobs: {
    run: cmdJobs,
    usage: 'jobs [--stage <stage>] [--address <a>] [--limit <n>]',
    about: 'every job the escrow has ever seen, folded from events',
  },
  job: {
    run: (flags, positional) => cmdJob(flags, positional, false),
    usage: 'job <id>',
    about: 'one job, with the block and transaction behind each state change',
  },
  proof: {
    run: (flags, positional) => cmdJob(flags, positional, true),
    usage: 'proof <id>',
    about: 'the receipts for one job plus the exact calls needed to re-derive them',
  },
  reputation: {
    run: simple((beacon, flags, positional) => beacon.reputation(target(flags, positional, '--address'))),
    usage: 'reputation <address>',
    about: 'an itemised, recomputable reputation score for any address',
  },
  onboard: {
    run: simple((beacon, flags) => beacon.onboarding(role(flags), string(flags, 'amount'), string(flags, 'policy'))),
    usage: 'onboard --role seller|buyer [--amount <n>] [--policy <id>]',
    about: 'what it takes to start trading, per role, with the zero-balance claim stated and justified',
  },
  ready: {
    run: simple((beacon, flags, positional) =>
      beacon.ready(target(flags, positional, '--address'), role(flags), string(flags, 'amount')),
    ),
    usage: 'ready <address> --role seller|buyer [--amount <n>]',
    about: 'can this address trade right now? nonce, balance, allowance and escrow credit, read live',
  },
  quote: {
    run: simple((beacon, flags) => beacon.quoteFor(role(flags), string(flags, 'amount'))),
    usage: 'quote --role seller|buyer [--amount <n>]',
    about: 'all-in cost of a job, line by line, with the fee measured from a real receipt',
  },
  blueprint: {
    run: cmdBlueprint,
    usage: `blueprint --action <${BLUEPRINT_ACTIONS.join('|')}> [--params <json>] [--unsponsored]`,
    about: 'encoded calldata for one intent; the beacon builds it, you sign it',
  },
  discover: {
    run: cmdDiscover,
    usage: 'discover [--capability <c>] [--role <r>] [--min-score <n>] [--limit <n>]',
    about: 'registered agents matching a capability, ranked by on-chain reputation',
  },
  challenge: {
    run: simple((beacon, flags, positional) => beacon.challenge(target(flags, positional, '--address'))),
    usage: 'challenge <address>',
    about: 'a registration challenge bound to this beacon, this escrow and an expiry',
  },
  registry: {
    run: simple((beacon) => beacon.exportRegistry()),
    usage: 'registry',
    about: 'the signed registry file, portable to any other beacon',
  },
};

function usage(): void {
  trace('Tempex Beacon — the read-only front door to Tempex arbitration. Holds no keys.');
  trace('');
  for (const command of Object.values(COMMANDS)) {
    trace(`  ${command.usage}`);
    trace(`      ${command.about}`);
  }
  trace('');
  trace('Every answer is JSON on stdout and folded from chain events; progress goes to stderr.');
  trace(`Over HTTP the same surface is served by \`serve\`, where /discover answers 402 until paid.`);
}

async function main(argv: string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  if (command === '' || command === 'help' || flags['help'] === true) {
    usage();
    return command === '' ? 1 : 0;
  }
  const found = COMMANDS[command];
  if (found === undefined) {
    trace(`unknown command: ${command}`);
    trace('');
    usage();
    return 1;
  }
  return found.run(flags, positional);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      trace(error.message);
      trace('');
      usage();
      process.exitCode = 1;
      return;
    }
    if (error instanceof BeaconError) {
      /// The same body an agent would get over HTTP, so the CLI is not a second,
      /// gentler interface with different failure modes.
      process.stdout.write(
        `${serialize({ error: 'rejected', status: error.status, message: error.message, ...(error.hint ? { hint: error.hint } : {}) })}\n`,
      );
      process.exitCode = error.status >= 500 ? 3 : 2;
      return;
    }
    trace(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 3;
  });
