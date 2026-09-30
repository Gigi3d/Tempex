import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Address } from 'viem';

import {
  BLUEPRINT_ACTIONS,
  Beacon,
  BeaconError,
  type BlueprintAction,
  type RefreshResult,
} from './beacon.js';
import { endpoint } from './config.js';
import type { JobStage } from './ledger.js';
import { ROUTES } from './manifest.js';
import type { Role } from './onboard.js';
import { PAYMENT_HEADER, PAYMENT_SCHEME, QUOTE_HEADER, type Settlement } from './payments.js';
import type { DiscoveryFilter, RegisterInput, RegistryEntry, RegistryRole } from './registry.js';

/// An agent's registration body is small, but a blueprint request can carry a whole
/// evidence bundle to hash. Capped anyway: an unbounded body is an unbounded memory
/// allocation on a service meant to run unattended.
const MAX_BODY_BYTES = 256 * 1024;

/// How often the index advances on its own, and how stale it may be before a request
/// waits for a catch-up scan instead of serving a lagging view.
const SYNC_INTERVAL_MS = 15_000;
const SYNC_STALE_MS = 4_000;

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': `content-type,${PAYMENT_HEADER},${QUOTE_HEADER}`,
  'access-control-expose-headers': `${PAYMENT_HEADER},${QUOTE_HEADER},x-payment-required,x-tempex-index-head,x-tempex-settled`,
  'access-control-max-age': '600',
};

const ERROR_NAMES: Record<number, string> = {
  400: 'bad_request',
  402: 'payment_required',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  500: 'internal_error',
};

type Ctx = {
  beacon: Beacon;
  url: URL;
  params: Record<string, string>;
  body: Record<string, unknown>;
  /// Present only on a paid route that was paid for: the receipt of the transfer that
  /// unlocked this response, which is the payer's proof it was charged once.
  settled: Settlement | null;
};

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

const HANDLERS: Record<string, Handler> = {
  'GET /': ({ beacon }) => ({
    name: beacon.config.name,
    tagline: 'The default referee for agent commerce. No humans required.',
    network: beacon.config.network,
    chainId: beacon.config.chainId,
    escrow: beacon.config.escrow,
    readFirst: {
      manifest: endpoint(beacon.config, '/.well-known/tempex.json'),
      agentCard: endpoint(beacon.config, '/.well-known/agent.json'),
    },
    custody: { keys: false, canSign: false, canMoveFunds: false },
    free: ROUTES.filter((route) => !route.paid && route.path !== '/').map((route) => `${route.method} ${route.path}`),
    paid: ROUTES.filter((route) => route.paid).map((route) => `${route.method} ${route.path}`),
    note: 'Everything an agent needs in order to decide whether to use this protocol is free. Only discovery queries are priced, and that price is a spam cost, not a subscription.',
  }),

  'GET /.well-known/tempex.json': ({ beacon }) => beacon.manifest(),
  'GET /.well-known/agent.json': ({ beacon }) => beacon.card(),
  'GET /health': ({ beacon }) => beacon.health(),
  'GET /stats': ({ beacon }) => beacon.stats(),

  'GET /jobs': ({ beacon, url }) => {
    const jobs = beacon.jobs({
      stage: text(url, 'stage') as JobStage | undefined,
      address: text(url, 'address') as Address | undefined,
      limit: integer(url, 'limit', 100),
    });
    return {
      count: jobs.length,
      indexed: beacon.view.jobs.length,
      order: 'newest first',
      jobs,
    };
  },

  'GET /jobs/:jobId': ({ beacon, params }) => {
    const jobId = jobNumber(params['jobId']);
    const job = beacon.job(jobId);
    if (!job) throw missingJob(jobId, beacon);
    return job;
  },

  'GET /proof/:jobId': ({ beacon, params }) => {
    const jobId = jobNumber(params['jobId']);
    const proof = beacon.proof(jobId);
    if (!proof) throw missingJob(jobId, beacon);
    return proof;
  },

  'GET /reputation/:address': ({ beacon, params }) => beacon.reputation(addr(params['address'], 'address')),

  'GET /policy': ({ beacon }) => ({
    policies: beacon.policies(),
    use: 'Pass {"policy":"<id>"} to POST /blueprint/create-and-fund, or read deliveryDeadlineSeconds and reviewWindowSeconds and set the timestamps yourself.',
  }),

  'GET /onboard': ({ beacon, url }) =>
    beacon.onboarding(role(url), text(url, 'amount') ?? undefined, text(url, 'policy') ?? undefined),

  'GET /ready': ({ beacon, url }) =>
    beacon.ready(addr(text(url, 'address'), 'address'), role(url), text(url, 'amount') ?? undefined),

  'GET /quote': ({ beacon, url }) => beacon.quoteFor(role(url), text(url, 'amount') ?? undefined),

  'POST /blueprint/:action': ({ beacon, params, body }) => {
    const action = params['action'] as BlueprintAction;
    if (!BLUEPRINT_ACTIONS.includes(action)) {
      throw new BeaconError(
        `unknown blueprint action "${String(params['action'])}"`,
        404,
        `expected one of ${BLUEPRINT_ACTIONS.join(', ')}`,
      );
    }
    const nested = body['params'];
    const args = { ...(isObject(nested) ? nested : {}), ...stripReserved(body) };
    return beacon.blueprintFor(action, args, {
      sponsored: body['sponsored'] === undefined ? undefined : body['sponsored'] === true,
    });
  },

  'GET /discover': ({ beacon, url, settled }) => {
    const filter: DiscoveryFilter = {
      capability: text(url, 'capability') ?? undefined,
      role: (text(url, 'role') ?? undefined) as RegistryRole | undefined,
      minScore: text(url, 'minScore') === null ? undefined : integer(url, 'minScore', 0),
      limit: integer(url, 'limit', 25),
    };
    const listings = beacon.discover(filter);
    return {
      resource: '/discover',
      filter,
      count: listings.length,
      rankedBy: 'derived on-chain reputation, then settled jobs, then registration age — never by payment',
      listings,
      settlement: settled,
    };
  },

  'POST /registry/challenge': ({ beacon, body }) => beacon.challenge(addr(body['address'], 'address')),

  'POST /registry': async ({ beacon, body }) => {
    const result = await beacon.register(registration(body, beacon));
    if (!result.ok) throw new BeaconError(result.reason, 400, ECHO_CHALLENGE);
    return { registered: true, entry: result.entry, portable: endpoint(beacon.config, '/registry') };
  },

  'GET /registry': ({ beacon }) => beacon.exportRegistry(),
};

/// Routes whose answers come from the event index, and so are only as good as the
/// last scan.
const LIVE = new Set([
  'GET /stats',
  'GET /jobs',
  'GET /jobs/:jobId',
  'GET /proof/:jobId',
  'GET /reputation/:address',
  'GET /discover',
  'GET /health',
]);

const COMPILED = ROUTES.map((route) => ({
  route,
  key: `${route.method} ${route.path}`,
  segments: route.path.split('/').filter((segment) => segment.length > 0),
}));

/// Checked at import time rather than at request time: a manifest that advertises a
/// route the server does not implement is worse than no manifest.
assertRoutesAgree();

function assertRoutesAgree(): void {
  const documented = new Set(COMPILED.map((entry) => entry.key));
  const implemented = new Set(Object.keys(HANDLERS));
  const unimplemented = [...documented].filter((key) => !implemented.has(key));
  const undocumented = [...implemented].filter((key) => !documented.has(key));
  if (unimplemented.length > 0 || undocumented.length > 0) {
    throw new Error(
      `beacon routes are out of sync with the manifest: unimplemented=[${unimplemented.join(', ')}] ` +
        `undocumented=[${undocumented.join(', ')}]`,
    );
  }
}

function match(method: string, path: string): { key: string; params: Record<string, string>; paid: boolean } | null {
  const parts = path.split('/').filter((part) => part.length > 0);
  for (const entry of COMPILED) {
    if (entry.route.method !== method || entry.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < parts.length; i += 1) {
      const segment = entry.segments[i]!;
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = decodeURIComponent(parts[i]!);
        continue;
      }
      if (segment !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { key: entry.key, params, paid: entry.route.paid };
  }
  return null;
}

export type ServerOptions = {
  /// Overrides the config, mainly so the smoke script can bind an ephemeral port.
  listen?: string;
  port?: number;
  syncIntervalMs?: number;
};

export type BeaconServer = {
  server: Server;
  listen: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

export async function startBeaconServer(beacon: Beacon, options: ServerOptions = {}): Promise<BeaconServer> {
  const listen = options.listen ?? beacon.config.listen;
  const port = options.port ?? beacon.config.port;

  /// `EscrowLedger.sync()` is not reentrant: two overlapping scans start from the same
  /// block and fold the same events twice, which double-counts withdrawals. Every path
  /// into it therefore shares one in-flight promise.
  let inFlight: Promise<RefreshResult> | null = null;
  let syncedAt = 0;
  let head = 0n;

  function sync(): Promise<RefreshResult> {
    if (!inFlight) {
      inFlight = beacon
        .refresh()
        .then((result) => {
          head = result.head;
          return result;
        })
        .finally(() => {
          inFlight = null;
          syncedAt = Date.now();
        });
    }
    return inFlight;
  }

  head = (await sync()).head;

  const timer = setInterval(() => {
    void sync().catch(() => undefined);
  }, options.syncIntervalMs ?? SYNC_INTERVAL_MS);
  timer.unref();

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => fail(res, 500, describe(error)));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, listen, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const bound = server.address();
  const actualPort = typeof bound === 'object' && bound !== null ? bound.port : port;
  const advertised = beacon.config.host.endsWith(`:${actualPort}`)
    ? beacon.config.host
    : `http://${listen === '0.0.0.0' ? '127.0.0.1' : listen}:${actualPort}`;

  return {
    server,
    listen,
    port: actualPort,
    url: advertised,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(timer);
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'content-length': '0' });
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    const route = match(method, url.pathname);

    if (!route) {
      const samePath = COMPILED.filter(
        (entry) => entry.segments.join('/') === url.pathname.split('/').filter((part) => part.length > 0).join('/'),
      );
      fail(res, samePath.length > 0 ? 405 : 404, `no ${method} route for ${url.pathname}`, {
        ...(samePath.length > 0 ? { allow: samePath.map((entry) => entry.route.method).join(',') } : {}),
        hint: `GET ${endpoint(beacon.config, '/.well-known/tempex.json')} lists every route this beacon serves.`,
      });
      return;
    }

    try {
      /// A quote is how an agent learns the price before it owes anything, so it is
      /// served on the paid route itself and never charged for.
      if (route.paid && url.searchParams.get('quote') === '1') {
        const quote = beacon.paymentQuote(url.pathname);
        send(res, 200, quote ?? beacon.paymentRequirement(url.pathname));
        return;
      }

      let settled: Settlement | null = null;
      if (route.paid) {
        const result = await beacon.settle(url.pathname, header(req, PAYMENT_HEADER), header(req, QUOTE_HEADER));
        if (!result.ok) {
          send(
            res,
            result.status,
            {
              error: ERROR_NAMES[result.status] ?? 'error',
              reason: result.reason,
              requirement: beacon.paymentRequirement(url.pathname),
            },
            result.status === 402 ? { 'x-payment-required': PAYMENT_SCHEME } : undefined,
          );
          return;
        }
        settled = result.settled;
      }

      if (LIVE.has(route.key) && (inFlight || Date.now() - syncedAt > SYNC_STALE_MS)) await sync();

      const body = await readBody(req);
      const payload = await HANDLERS[route.key]!({ beacon, url, params: route.params, body, settled });
      send(res, route.key === 'POST /registry' ? 201 : 200, payload, {
        'x-tempex-index-head': head.toString(),
        ...(settled?.tx ? { 'x-tempex-settled': settled.tx } : {}),
      });
    } catch (error) {
      if (error instanceof BeaconError) {
        fail(res, error.status, error.message, error.hint === undefined ? undefined : { hint: error.hint });
        return;
      }
      fail(res, 500, describe(error));
    }
  }
}

function send(res: ServerResponse, status: number, payload: unknown, extra?: Record<string, string>): void {
  const body = serialize(payload);
  res.writeHead(status, {
    ...CORS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    /// Never cached. A cached claim about the chain is a stale claim, and the point of
    /// the beacon is that its answers are current enough to act on.
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(body);
}

function fail(res: ServerResponse, status: number, message: string, extra?: Record<string, string>): void {
  send(res, status, {
    error: ERROR_NAMES[status] ?? 'error',
    message,
    ...extra,
    time: new Date().toISOString(),
  });
}

/// Bigints reach every serializer here — job ids, amounts, block numbers — and are
/// stringified rather than dropped, because an agent that cannot see the amount
/// cannot verify it.
export function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'OPTIONS') return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BeaconError(`request body exceeds ${MAX_BODY_BYTES} bytes`, 413);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isObject(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new BeaconError('body must be a JSON object', 400);
  }
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const ECHO_CHALLENGE =
  'Echo challenge, issuedAt, expiresAt and address back exactly as /registry/challenge returned them: they are inside the message you signed.';

function registration(body: Record<string, unknown>, beacon: Beacon): RegisterInput {
  const raw = isObject(body['entry']) ? body['entry'] : body;
  const address = addr(raw['address'], 'address');
  const challenge = requiredText(body['challenge'], 'challenge');
  const signature = requiredText(body['signature'], 'signature');
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new BeaconError(
      'signature must be 65 bytes, produced by personal_sign over the challenge message',
      400,
      ECHO_CHALLENGE,
    );
  }

  const role = requiredText(raw['role'], 'role') as RegistryRole;
  if (!['seller', 'buyer', 'arbiter', 'relay'].includes(role)) {
    throw new BeaconError(`role must be seller, buyer, arbiter or relay, got "${role}"`, 400);
  }

  const capabilities = Array.isArray(raw['capabilities'])
    ? (raw['capabilities'] as unknown[]).map((capability) => String(capability).trim()).filter((item) => item !== '')
    : [];
  if (capabilities.length === 0) {
    throw new BeaconError('capabilities must name at least one thing this agent can be hired for', 400);
  }

  const payment = isObject(raw['payment']) ? raw['payment'] : {};
  const policy = isObject(raw['policy']) ? raw['policy'] : {};
  const template = beacon.policies().find((item) => item.id === String(policy['templateId'] ?? 'standard'));
  const accepts = isObject(raw['accepts']) ? raw['accepts'] : {};

  const entry: Omit<RegistryEntry, 'registeredAt' | 'challenge' | 'message' | 'signature'> = {
    address,
    name: requiredText(raw['name'], 'name'),
    agent: requiredText(raw['agent'], 'agent'),
    role,
    capabilities,
    ...(typeof raw['endpoint'] === 'string' && raw['endpoint'].length > 0 ? { endpoint: raw['endpoint'] } : {}),
    payment: {
      tokens: Array.isArray(payment['tokens'])
        ? ((payment['tokens'] as unknown[]).map(String) as Address[])
        : [beacon.config.token],
      ...(typeof payment['minAmount'] === 'string' ? { minAmount: payment['minAmount'] } : {}),
      ...(typeof payment['maxAmount'] === 'string' ? { maxAmount: payment['maxAmount'] } : {}),
    },
    policy: {
      templateId: template?.id ?? 'standard',
      deliveryDeadlineSeconds: numberOr(policy['deliveryDeadlineSeconds'], template?.deliveryDeadlineSeconds ?? 3_600),
      reviewWindowSeconds: numberOr(policy['reviewWindowSeconds'], template?.reviewWindowSeconds ?? 3_600),
    },
    accepts: {
      arbitration: typeof accepts['arbitration'] === 'string' ? accepts['arbitration'] : 'tempex-arbiter/1',
      escrow: beacon.config.escrow,
      network: beacon.config.network,
    },
  };

  return {
    entry,
    challenge,
    issuedAt: requiredText(body['issuedAt'], 'issuedAt'),
    expiresAt: requiredText(body['expiresAt'], 'expiresAt'),
    signature: signature as RegisterInput['signature'],
  };
}

// ------------------------------------------------------------------- url parsing

function text(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value === null || value.trim() === '' ? null : value.trim();
}

function integer(url: URL, name: string, fallback: number): number {
  const raw = text(url, name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BeaconError(`${name} must be a non-negative integer, got "${raw}"`, 400);
  }
  return parsed;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function role(url: URL): Role {
  const value = text(url, 'role');
  if (value !== 'seller' && value !== 'buyer') {
    throw new BeaconError('role is required and must be "seller" or "buyer"', 400);
  }
  return value;
}

function addr(value: unknown, label: string): Address {
  const raw = requiredText(value, label);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new BeaconError(`${label} must be a 20-byte address, got "${raw}"`, 400);
  }
  return raw as Address;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new BeaconError(`${label} is required`, 400);
  return value.trim();
}

function jobNumber(value: string | undefined): bigint {
  const raw = value === undefined ? '' : value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new BeaconError(`jobId must be a decimal integer, got "${raw}"`, 400);
  }
  return BigInt(raw);
}

function missingJob(jobId: bigint, beacon: Beacon): BeaconError {
  const jobs = beacon.view.jobs;
  return new BeaconError(
    `job ${jobId} is not in the index`,
    404,
    jobs.length === 0
      ? `The escrow has emitted no job events since block ${beacon.config.indexFromBlock}: either nothing has happened, or the index start block is wrong.`
      : `The index holds ${jobs.length} job(s), ids ${jobs[0]?.jobId} to ${jobs[jobs.length - 1]?.jobId}.`,
  );
}

function stripReserved(body: Record<string, unknown>): Record<string, unknown> {
  const { params: _params, sponsored: _sponsored, ...rest } = body;
  return rest;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
