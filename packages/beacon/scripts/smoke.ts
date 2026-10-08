#!/usr/bin/env tsx
/// Live beacon smoke test against the deployed Moderato escrow.
///
/// Proves seven things, in order, and prints the evidence for each:
///   1. the index is a fold of real events — its job count equals the escrow's own
///      `jobCount()`, and `nextJobId()` is exactly `jobCount() + 1`
///   2. the manifest quotes the chain rather than constants: the fee caps, the
///      withdrawal memo and the verdictDigest selector are recomputed here, from
///      first principles, and compared against what the beacon serves
///   3. reputation is arithmetic any third party can redo: score == clamp(sum(factors))
///   4. every free GET route answers 200 with `cache-control: no-store` and an index
///      head, and the blueprint routes return calldata whose fee treatment matches
///      what the caller asked for
///   5. the 402 gate rejects unpaid, malformed, unmined and mis-memo'd payments
///      without moving one unit of the treasury balance
///   6. registration is a personal_sign round trip that stays verifiable offline,
///      and a signature from the wrong key is refused
///   7. none of it spent anything, and none of it wrote beacon state into the repo
///
/// The run persists itself to `runs/beacon-smoke-<stamp>.json` — same directory and
/// stamp format as the demo receipts, so a stranger can re-check a live run without
/// having been in the room for it.
///
/// Run: pnpm smoke

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { keccak256, pad, toBytes, toFunctionSelector, toHex } from 'viem';
import type { Address, Hex } from 'viem';

import { accountFor, addressFor, hashCanonical, privateKeyFor, tip20Abi } from '@tempex/sdk';

import {
  Beacon,
  ROUTES,
  TOOLS,
  beaconConfigFromEnv,
  escrowConfig,
  paymentMemo,
  startBeaconServer,
  verifyEntry,
  type BeaconConfig,
  type BeaconServer,
  type RegistryEntry,
} from '../src/index.js';

let checks = 0;

/// Everything the run prints, captured so it can be persisted as a receipt at the end.
/// Seeded with step 0 because the configuration lines are printed before any `step()`.
type StepRecord = { n: number; title: string; passed: string[]; evidence: Record<string, string> };

const steps: StepRecord[] = [{ n: 0, title: 'configuration', passed: [], evidence: {} }];

function current(): StepRecord {
  return steps[steps.length - 1]!;
}

/// Held at module scope so a failure anywhere in the run can still tear the beacon
/// down. An open HTTP server keeps the event loop alive, which would turn a failed
/// assertion into a hang instead of an exit code.
let running: BeaconServer | null = null;
let scratchDir: string | null = null;

async function teardown(): Promise<void> {
  await running?.close().catch(() => undefined);
  running = null;
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = null;
  }
}

function step(n: number, text: string): void {
  steps.push({ n, title: text, passed: [], evidence: {} });
  console.log(`\n\x1b[1m[${n}]\x1b[0m ${text}`);
}

function pass(text: string): void {
  current().passed.push(text);
  console.log(`    \x1b[32mPASS\x1b[0m  ${text}`);
}

function info(label: string, value: string): void {
  current().evidence[label] = value;
  console.log(`          ${label.padEnd(22)} ${value}`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  checks += 1;
}

/// The registry bakes `config.host` into every challenge message and the manifest
/// advertises it, so the port has to be known before the beacon is opened. Probe one,
/// hand it back, and bind to it.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const bound = probe.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  if (port === 0) throw new Error('could not reserve a free port');
  return port;
}

type Body = Record<string, unknown>;

type Reply = { status: number; headers: Headers; body: Body };

async function call(url: string, init?: RequestInit): Promise<Reply> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: Body = {};
  if (text.length > 0) {
    const parsed: unknown = JSON.parse(text);
    body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Body) : { value: parsed };
  }
  return { status: response.status, headers: response.headers, body };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return call(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/// Reads a nested field out of a response body, so an assertion names the JSON path an
/// agent would read rather than a chain of casts.
function at<T>(body: Body, path: string): T {
  let cursor: unknown = body;
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) throw new Error(`response has no "${path}"`);
    cursor = (cursor as Body)[part];
  }
  if (cursor === undefined || cursor === null) throw new Error(`response has no "${path}"`);
  return cursor as T;
}

function reason(reply: Reply): string {
  return String(reply.body['reason'] ?? reply.body['message'] ?? '');
}

async function balanceOf(beacon: Beacon, who: Address): Promise<bigint> {
  return beacon.reader.readContract({
    address: beacon.config.token,
    abi: tip20Abi,
    functionName: 'balanceOf',
    args: [who],
  }) as Promise<bigint>;
}

/// The address with the most closed jobs: reputation is only interesting when it has
/// something to fold, so the smoke test scores a participant rather than a bystander.
function mostActive(beacon: Beacon, addresses: readonly Address[]): Address {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))] as Address[];
  const ranked = unique
    .map((address) => ({ address, settled: beacon.reputation(address).counters.settled }))
    .sort((left, right) => right.settled - left.settled);
  const best = ranked[0];
  if (!best) throw new Error('the index holds no jobs, so there is nobody to score');
  return best.address as Address;
}

async function main(): Promise<void> {
  console.log('\x1b[1mTempex Beacon smoke test\x1b[0m');

  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  const repoRegistry = join(repo, '.beacon', 'registry.json');
  const repoRegistryBefore = existsSync(repoRegistry) ? statSync(repoRegistry).mtimeMs : null;

  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'tempex-beacon-'));
  scratchDir = dataDir;
  const config: BeaconConfig = {
    ...beaconConfigFromEnv(repo),
    listen: '127.0.0.1',
    port,
    host: `http://127.0.0.1:${port}`,
    dataDir,
    registryFile: join(dataDir, 'registry.json'),
  };

  info('network', `${config.network} (chainId ${config.chainId})`);
  info('rpc', config.rpcUrl);
  info('escrow', config.escrow);
  info('payment token', config.token);
  info('treasury', config.treasury ?? '(none — discovery would be free)');
  info('index from block', config.indexFromBlock.toString());
  info('fee payer', config.sponsorUrl ?? '(none)');
  info('state dir', dataDir);

  // ------------------------------------------------------------- 1. the index
  step(1, 'Cold start: rebuild the index from eth_getLogs and agree with the escrow');

  const beacon = await Beacon.open(config);
  const view = beacon.view;
  const live = await escrowConfig(beacon.reader, config.escrow);

  assert(view.eventCount > 0, `the scan read escrow events (got ${view.eventCount})`);
  pass(`indexed ${view.eventCount} events into ${view.jobs.length} jobs, blocks ${view.fromBlock}..${view.toBlock}`);

  assert(
    view.jobs.length === Number(live.jobCount),
    `indexed jobs (${view.jobs.length}) equals on-chain jobCount() (${live.jobCount})`,
  );
  assert(live.nextJobId === live.jobCount + 1n, `nextJobId() ${live.nextJobId} == jobCount() + 1`);
  pass(`index agrees with the contract: jobCount()=${live.jobCount}, nextJobId()=${live.nextJobId}`);

  const newest = view.jobs[view.jobs.length - 1];
  if (!newest) throw new Error('the index holds no jobs; run packages/demo first');
  const stages = new Map<string, number>();
  for (const job of view.jobs) stages.set(job.stage, (stages.get(job.stage) ?? 0) + 1);
  info('stages', [...stages.entries()].map(([stage, count]) => `${stage}=${count}`).join('  '));
  info('withdrawals', String(view.withdrawals.length));
  info('newest job', `#${newest.jobId} ${newest.stage} created in block ${newest.created.block}`);

  const seller = mostActive(beacon, view.jobs.map((job) => job.seller));
  const buyer = mostActive(beacon, view.jobs.map((job) => job.buyer));
  info('scored seller', seller);
  info('scored buyer', buyer);

  // ----------------------------------------------------------- 2. the manifest
  step(2, 'The manifest quotes the chain, and every claim in it is recomputable here');

  const manifest = await beacon.manifest();
  assert(manifest.schema === 'tempex/1', `manifest schema is tempex/1, got ${manifest.schema}`);
  assert(manifest.protocol.escrow === config.escrow, 'manifest names the deployed escrow');
  assert(manifest.protocol.arbiter === live.arbiter, 'manifest arbiter == live arbiter()');
  assert(manifest.protocol.treasury === live.treasury, 'manifest treasury == live treasury()');
  assert(manifest.protocol.owner === live.owner, 'manifest owner == live owner()');
  pass('governance in the manifest equals arbiter(), treasury() and owner() read just now');

  assert(
    manifest.protocol.fees.caps.platformBps === live.maxPlatformFeeBps,
    `platform cap ${manifest.protocol.fees.caps.platformBps} == MAX_PLATFORM_FEE_BPS() ${live.maxPlatformFeeBps}`,
  );
  assert(
    manifest.protocol.fees.caps.arbitrationBps === live.maxArbitrationFeeBps,
    `arbitration cap ${manifest.protocol.fees.caps.arbitrationBps} == MAX_ARBITRATION_FEE_BPS() ${live.maxArbitrationFeeBps}`,
  );
  assert(
    manifest.protocol.fees.platformBps <= live.maxPlatformFeeBps &&
      manifest.protocol.fees.arbitrationBps <= live.maxArbitrationFeeBps,
    'the live fee schedule sits inside its own caps',
  );
  assert(
    manifest.protocol.fees.denominator === live.bpsDenominator && live.bpsDenominator === 10_000,
    'bps denominator is 10000 on both sides',
  );
  pass(`fees ${manifest.protocol.fees.platformBps}/${manifest.protocol.fees.arbitrationBps} bps, caps ${live.maxPlatformFeeBps}/${live.maxArbitrationFeeBps}`);

  /// Recomputed from the source of truth, not copied from the beacon: the contract
  /// stores `bytes32("tempex.withdraw")`, which is UTF-8 right-padded and *not* a hash.
  /// viem's `pad` defaults to left for hex, so the direction has to be said out loud.
  const withdrawMemo = pad(toHex(toBytes('tempex.withdraw')), { size: 32, dir: 'right' });
  assert(
    manifest.protocol.custody.withdrawalMemo === withdrawMemo && live.withdrawMemo === withdrawMemo,
    'the withdrawal memo served by the beacon equals bytes32("tempex.withdraw") recomputed here',
  );
  pass(`withdrawal memo ${withdrawMemo.slice(0, 20)}… == bytes32("tempex.withdraw")`);

  const verdictSelector = toFunctionSelector('verdictDigest((uint256,uint16,bytes32,bytes32,uint64,uint64))');
  assert(
    manifest.verification.selectors['verdictDigest'] === verdictSelector,
    'the published verdictDigest selector equals keccak of the signature recomputed here',
  );
  pass(`verdictDigest selector ${verdictSelector}`);

  assert(manifest.protocol.custody.beaconHoldsKeys === false, 'manifest states the beacon holds no keys');
  // An upgradeable escrow must say so, name the key that can upgrade it, and
  // admit that key could move principal; a v2 escrow must say none of that.
  const custody = manifest.protocol.custody;
  assert(custody.escrowIsUpgradeable === (custody.implementation !== null), 'manifest states upgradeability exactly when it names an implementation');
  assert(custody.ownerCanTakeJobPrincipal === custody.escrowIsUpgradeable, 'manifest admits the upgrade key could take principal');
  assert(!custody.escrowIsUpgradeable || custody.upgradeKey === manifest.protocol.owner, 'manifest names the owner as the upgrade key');
  pass('custody claims are stated, and the owner powers list is published next to them');

  assert(
    manifest.costs.onboarding.units === '0' && manifest.costs.registration.units === '0',
    'onboarding and registration are both priced at exactly zero',
  );
  assert(manifest.identity.sponsorUrl !== null, 'a hosted fee payer is configured, so zero-balance onboarding is real');
  assert(manifest.costs.transactionFee.measuredOn !== null, 'the quoted transaction fee points at a real receipt');
  info('measured fee', `${manifest.costs.transactionFee.unsponsored?.value ?? '?'} alphaUSD on ${manifest.costs.transactionFee.measuredOn}`);
  pass('onboarding costs 0 and the transaction fee is measured from a mined transaction, not estimated');

  assert(manifest.claims.length > 0, 'the manifest makes claims');
  assert(
    manifest.claims.every((claim) => claim.check.trim().length > 0 && claim.claim.trim().length > 0),
    'every claim carries a check an agent can run itself',
  );
  pass(`${manifest.claims.length} claims, each with a verification recipe`);

  assert(manifest.routes.length === ROUTES.length, 'manifest route table == the table the router compiles');
  assert(manifest.tools.length === TOOLS.length, 'manifest tool list == the exported tool descriptors');
  assert(
    Object.keys(manifest.endpoints).length === ROUTES.filter((route) => route.method === 'GET').length,
    'every GET route has an absolute endpoint in the manifest',
  );
  assert(
    manifest.routes.filter((route) => route.paid).map((route) => route.path).join(',') === '/discover',
    'exactly one route is paid, and it is discovery',
  );
  pass(`${manifest.routes.length} routes, ${manifest.tools.length} tools, ${manifest.routes.filter((r) => r.paid).length} paid`);

  assert(Number(manifest.index.lagBlocks) <= 200, `index lag ${manifest.index.lagBlocks} blocks is within 200 of head`);
  info('index', `head ${manifest.index.head}, lag ${manifest.index.lagBlocks}, storage "${manifest.index.storage}"`);

  const card = await beacon.card();
  assert(card['protocol'] === manifest.schema, 'the agent card names the same protocol as the manifest');
  assert(at<boolean>(card as Body, 'capabilities.custody') === false, 'the agent card states custody: false');
  pass('agent card agrees with the manifest');

  // ------------------------------------------------- 3. reputation and stats
  step(3, 'Reputation and network stats are arithmetic, recomputed here from the factors');

  const reputation = beacon.reputation(seller);
  const factorSum = reputation.factors.reduce((total, factor) => total + factor.points, 0);
  const expectedScore = Math.max(0, Math.min(1000, factorSum));
  assert(
    reputation.score === expectedScore,
    `score ${reputation.score} == clamp(sum(factors) = ${factorSum}, 0, 1000)`,
  );
  assert(reputation.factors.length > 0, 'the score is itemised into factors');
  assert(reputation.recipe.length > 0, 'the score ships a recipe for recomputing it');
  assert(
    reputation.proofJobIds.every((jobId) => /^\d+$/.test(jobId)),
    'the score names the job ids it was derived from',
  );
  assert(
    reputation.blockRange.from === view.fromBlock.toString() && reputation.blockRange.to === view.toBlock.toString(),
    'the score states the exact block range it was computed over',
  );
  pass(`${seller} scores ${reputation.score} (${reputation.band}) from ${reputation.factors.length} factors`);
  for (const factor of reputation.factors) {
    info(`${factor.points >= 0 ? '+' : ''}${factor.points} ${factor.label}`, factor.detail);
  }

  const stats = await beacon.stats();
  assert(stats.jobs.total === view.jobs.length, `stats job total ${stats.jobs.total} == indexed jobs ${view.jobs.length}`);
  assert(stats.events === view.eventCount, 'stats event count == the fold it came from');
  assert(stats.arbitration.bounded, 'every verdict ever paid out is inside 0-10000 bps');
  assert(stats.proofs.length > 0, 'stats carry receipts, not just numbers');
  assert(
    stats.proofs.every((proof) => proof.block > 0 && proof.tx.startsWith('0x')),
    'every proof names a block and a transaction hash',
  );
  pass(`${stats.jobs.total} jobs, ${stats.jobs.accepted} accepted, ${stats.jobs.resolved} resolved by verdict, settlement rate ${(stats.jobs.settlementRate * 100).toFixed(0)}%`);
  info('money', `escrowed ${stats.money.escrowed.value}, paid to sellers ${stats.money.paidToSellers.value}, still in escrow ${stats.money.stillInEscrow.value}`);
  info('arbitration', `${stats.arbitration.verdicts} verdict(s), bounded=${String(stats.arbitration.bounded)}, ${stats.arbitration.timings.length} timed`);
  info('proofs', `${stats.proofs.length} receipts, e.g. ${stats.proofs[0]?.tx ?? 'none'}`);

  // --------------------------------------------------------- 4. HTTP surface
  step(4, 'Serve it: every documented free route answers, and errors teach the fix');

  const server = await startBeaconServer(beacon, { listen: '127.0.0.1', port, syncIntervalMs: 60_000 });
  running = server;
  assert(server.port === port, `the server bound the port the manifest advertises (${server.port} == ${port})`);
  assert(server.url === config.host, `advertised url ${server.url} == config.host ${config.host}`);
  info('listening', server.url);

  const jobId = newest.jobId.toString();
  const query: Record<string, string> = {
    '/jobs': '?limit=5',
    '/onboard': '?role=seller',
    '/ready': `?role=seller&address=${seller}`,
    '/quote': '?role=buyer&amount=25',
  };
  // A pairing exists only while an agent is waiting for its owner, so its route
  // is checked for a clean 404 below rather than walked with a made-up code.
  // The document store files under the hash it computes; the routes below then
  // read that document back and decode the job's opening transaction.
  const smokeTerms = { title: 'smoke', deliverableSpec: 'smoke check of the document store', acceptanceCriteria: ['exists'], amount: '1', buyer: seller, seller };
  const filed = await post(`${server.url}/docs`, { kind: 'terms', doc: smokeTerms });
  assert(filed.status === 201 || filed.status === 200, `POST /docs answered 201, got ${filed.status}: ${reason(filed)}`);
  const docHash = at<string>(filed.body, 'hash');
  assert(docHash === hashCanonical(smokeTerms), 'the store files a document under its own canonical hash, not one the caller names');
  pass(`POST /docs -> ${filed.status}: filed under ${docHash.slice(0, 18)}…, the hash it computed itself`);
  const forged = await post(`${server.url}/docs`, { kind: 'terms', doc: { ...smokeTerms, buyer: 'nobody' } });
  assert(forged.status === 400, 'a malformed document is refused');
  const opened = await call(`${server.url}/jobs/${jobId}`);
  const openTx = at<string>(opened.body, 'created.tx');

  const freeGets = ROUTES.filter((route) => route.method === 'GET' && !route.paid && route.path !== '/agents/pair/:code');
  for (const route of freeGets) {
    const path = route.path
      .replace(/:jobId/g, jobId)
      .replace(/:address/g, seller)
      .replace(/:owner/g, seller)
      .replace(/^\/docs\/:hash$/, `/docs/${docHash}`)
      .replace(/^\/tx\/:hash$/, `/tx/${openTx}`);
    const reply = await call(`${server.url}${path}${query[path] ?? ''}`);
    assert(reply.status === 200, `${route.method} ${path} answered 200, got ${reply.status}: ${reason(reply)}`);
    assert(
      reply.headers.get('cache-control') === 'no-store',
      `${path} is never cached (a cached claim about the chain is a stale claim)`,
    );
    assert(
      (reply.headers.get('content-type') ?? '').startsWith('application/json'),
      `${path} serves JSON`,
    );
    assert(/^\d+$/.test(reply.headers.get('x-tempex-index-head') ?? ''), `${path} reports the index head it answered from`);
    console.log(`    \x1b[32m200\x1b[0m   GET ${path}${query[path] ?? ''}`);
  }
  pass(`${freeGets.length} free GET routes answer from the same route table the manifest publishes`);

  const inspected = await call(`${server.url}/tx/${openTx}`);
  const signerKind = at<string>(inspected.body, 'signer.kind');
  assert(signerKind === 'root' || signerKind === 'access-key', 'GET /tx/:hash names the kind of key that signed');
  assert((at<unknown[]>(inspected.body, 'calls') ?? []).length > 0, 'GET /tx/:hash decodes the calls');
  pass(`GET /tx/:hash -> job ${jobId} was opened by ${signerKind === 'access-key' ? 'an agent' : 'the account'}'s own key, its calls decoded`);
  const activity = await call(`${server.url}/activity/${seller}`);
  assert(Array.isArray(at<unknown[]>(activity.body, 'entries')), 'GET /activity/:address lists steps');
  pass(`GET /activity/:address -> ${at<number>(activity.body, 'count')} step(s) for ${seller}, each with its signer`);

  const noPairing = await call(`${server.url}/agents/pair/ZZZZ-ZZZZ`);
  assert(noPairing.status === 404, `GET /agents/pair/<unknown> answered 404, got ${noPairing.status}`);
  pass('GET /agents/pair/<unknown> -> 404: a pairing exists only while an agent waits for its owner');
  const agentsOfSeller = await call(`${server.url}/agents/${seller}`);
  const agentsBody = agentsOfSeller.body as { owner?: string; agents?: unknown[] };
  assert(Array.isArray(agentsBody.agents) && agentsBody.owner?.toLowerCase() === seller.toLowerCase(), 'GET /agents/:owner lists the keys an owner authorized, read from the keychain');
  pass(`GET /agents/:owner -> ${agentsBody.agents?.length ?? 0} key(s) for ${seller}`);

  const withdraw = await post(`${server.url}/blueprint/withdraw`, {});
  assert(withdraw.status === 200, `POST /blueprint/withdraw answered 200, got ${withdraw.status}: ${reason(withdraw)}`);
  assert(at<boolean>(withdraw.body, 'fee.sponsored') === true, 'the sponsored blueprint says so');
  assert(at<string>(withdraw.body, 'fee.payer') === 'fee-payer', 'the sponsored blueprint names the fee payer, not the caller');
  const withdrawCalls = at<{ to: Address; data: Hex }[]>(withdraw.body, 'calls');
  assert(withdrawCalls.length === 1 && withdrawCalls[0]!.to === config.escrow, 'withdraw is one call to the escrow');
  assert(
    at<{ function: string }[]>(withdraw.body, 'decoded')[0]!.function === 'withdraw',
    'the decoded call is withdraw()',
  );
  pass(`POST /blueprint/withdraw -> ${withdrawCalls.length} call, fee paid by ${at<string>(withdraw.body, 'fee.payer')}`);

  const unsponsored = await post(`${server.url}/blueprint/withdraw`, { sponsored: false });
  assert(unsponsored.status === 200, 'the unsponsored variant is served too');
  assert(at<boolean>(unsponsored.body, 'fee.sponsored') === false, 'sponsored:false is honoured');
  assert(at<string>(unsponsored.body, 'fee.payer') === 'caller', 'an agent that pays its own fee gets calldata that says so');
  pass('POST /blueprint/withdraw {"sponsored":false} -> fee.payer=caller');

  const accept = await post(`${server.url}/blueprint/accept`, { jobId });
  assert(accept.status === 200, `accept blueprint for job ${jobId} answered 200, got ${accept.status}`);
  assert(
    at<{ args: Record<string, string> }[]>(accept.body, 'decoded')[0]!.args['jobId'] === jobId,
    'the encoded accept() carries the job id that was asked for',
  );
  pass(`POST /blueprint/accept {jobId:${jobId}} -> decoded args match`);

  const deal = await post(`${server.url}/blueprint/create-and-fund`, {
    buyer: addressFor('buyer'),
    seller: addressFor('seller'),
    amount: '25',
    terms: 'Summarise the Tempex whitepaper into ten bullets an agent can act on.',
    policy: 'standard',
  });
  assert(deal.status === 200, `create-and-fund answered 200, got ${deal.status}: ${reason(deal)}`);
  const dealFunctions = at<{ function: string; contract: string }[]>(deal.body, 'decoded').map((call_) => call_.function);
  assert(dealFunctions.includes('createJob'), 'the deal blueprint contains createJob');
  assert(dealFunctions.includes('fund'), 'the deal blueprint contains fund');
  assert(
    at<{ to: Address }[]>(deal.body, 'calls').every((entry) => entry.to === config.escrow || entry.to === config.token),
    'every call in the deal targets the escrow or the payment token and nothing else',
  );
  pass(`POST /blueprint/create-and-fund -> ${dealFunctions.join(' + ')} in one Tempo transaction`);

  const unknownAction = await post(`${server.url}/blueprint/nope`, {});
  assert(unknownAction.status === 404, `an unknown blueprint action is a 404, got ${unknownAction.status}`);
  assert(
    String(unknownAction.body['hint'] ?? '').includes('create-and-fund'),
    'the 404 lists the actions that do exist',
  );
  pass('POST /blueprint/nope -> 404 with the valid action list in the hint');

  const badResolve = await post(`${server.url}/blueprint/resolve`, { jobId });
  assert(badResolve.status === 400, `resolve without a verdict is a 400, got ${badResolve.status}`);
  assert(
    String(badResolve.body['hint'] ?? '').includes('sellerAwardBps'),
    'the 400 hands back the exact verdict shape instead of making the caller guess',
  );
  pass('POST /blueprint/resolve {jobId} -> 400 whose hint is a working request body');

  const notJson = await post(`${server.url}/registry`, 'this is not json');
  assert(notJson.status === 400, `a non-JSON body is a 400, got ${notJson.status}`);
  assert(String(notJson.body['message']) === 'body must be a JSON object', 'the 400 says what was wrong with the body');
  pass('POST /registry with a non-JSON body -> 400 "body must be a JSON object"');

  const unknownPath = await call(`${server.url}/nope`);
  assert(unknownPath.status === 404, `an unknown path is a 404, got ${unknownPath.status}`);
  assert(
    String(unknownPath.body['hint'] ?? '').includes('/.well-known/tempex.json'),
    'the 404 points at the document that lists every route',
  );
  pass('GET /nope -> 404 pointing at the manifest');

  const wrongMethod = await call(`${server.url}/registry/challenge`);
  assert(wrongMethod.status === 405, `GET on a POST-only path is a 405, got ${wrongMethod.status}`);
  assert(wrongMethod.body['allow'] === 'POST', 'the 405 names the method that is allowed');
  pass('GET /registry/challenge -> 405 with allow: POST');

  const preflight = await call(`${server.url}/stats`, { method: 'OPTIONS' });
  assert(preflight.status === 204, `a CORS preflight is a 204, got ${preflight.status}`);
  assert(preflight.headers.get('access-control-allow-origin') === '*', 'any origin may call the beacon');
  assert(
    (preflight.headers.get('access-control-allow-headers') ?? '').includes('x-payment'),
    'the preflight allows the payment headers an agent needs',
  );
  pass('OPTIONS /stats -> 204 with CORS and the payment headers allowed');

  // ---------------------------------------------------------- 5. the 402 gate
  step(5, 'Discovery is priced: refuse every way of not paying, and spend nothing');

  const treasury = config.treasury;
  if (!treasury) throw new Error('no treasury configured, so the gate cannot be exercised');
  assert(beacon.gate.enabled, `the gate is on: price ${beacon.gate.price.value} to ${treasury}`);

  const balanceBefore = await balanceOf(beacon, treasury);
  info('treasury balance', `${balanceBefore.toString()} units before`);

  const cold = await call(`${server.url}/discover`);
  assert(cold.status === 402, `an unpaid discovery query is a 402, got ${cold.status}`);
  assert(
    cold.headers.get('x-payment-required') === 'tempo-tx',
    'the 402 carries x-payment-required: tempo-tx so a generic agent can route it',
  );
  assert(at<string>(cold.body, 'error') === 'payment_required', 'the 402 body is named payment_required');
  assert(at<Address>(cold.body, 'requirement.payTo') === treasury, 'the 402 says exactly where the money goes');
  assert(
    at<string>(cold.body, 'requirement.amount.units') === beacon.gate.price.units,
    'the 402 states the price in units, not in prose',
  );
  assert(at<string>(cold.body, 'requirement.accepts') === 'tempo-tx:<transactionHash>', 'the 402 states the header it accepts');
  assert(at<string>(cold.body, 'requirement.quote.endpoint') === '/discover?quote=1', 'the 402 points at the free quote endpoint');
  pass(`GET /discover -> 402 ${beacon.gate.price.value} alphaUSD, requirement body included`);
  info('reason', reason(cold));

  const quoted = await call(`${server.url}/discover?quote=1`);
  assert(quoted.status === 200, `a quote is free, got ${quoted.status}`);
  const quoteId = at<string>(quoted.body, 'id');
  assert(/^0x[0-9a-fA-F]{32}$/.test(quoteId), `the quote id is 16 random bytes, got ${quoteId}`);
  const expectedMemo = keccak256(toBytes(`tempex-beacon:/discover:${quoteId.toLowerCase()}`));
  assert(at<Hex>(quoted.body, 'memo') === paymentMemo('/discover', quoteId), 'the memo equals paymentMemo()');
  assert(
    at<Hex>(quoted.body, 'memo') === expectedMemo,
    'the memo equals keccak256("tempex-beacon:/discover:<id>") recomputed here',
  );
  assert(at<string>(quoted.body, 'pay.decoded.function') === 'transferWithMemo', 'the quote encodes transferWithMemo');
  assert(at<string>(quoted.body, 'pay.decoded.args.to') === treasury, 'the encoded transfer pays the treasury');
  assert(at<string>(quoted.body, 'pay.decoded.args.memo') === expectedMemo, 'the encoded transfer carries the binding memo');
  assert(at<boolean>(quoted.body, 'pay.fee.sponsored') === true, 'the payer needs no gas token to pay the gate');
  assert(
    Date.parse(at<string>(quoted.body, 'expiresAt')) > Date.parse(at<string>(quoted.body, 'issuedAt')),
    'the quote expires',
  );
  pass(`GET /discover?quote=1 -> free quote ${quoteId}, memo ${expectedMemo.slice(0, 18)}…`);
  info('pay with', `${at<string>(quoted.body, 'pay.decoded.args.amount')} units to ${treasury}`);

  const malformed = await call(`${server.url}/discover`, { headers: { 'x-payment': 'bitcoin:please' } });
  assert(malformed.status === 400, `a malformed payment header is a 400, got ${malformed.status}`);
  assert(reason(malformed).startsWith('malformed x-payment'), 'the 400 says the header was malformed');
  pass('GET /discover with x-payment: bitcoin:please -> 400');

  const noQuote = await call(`${server.url}/discover`, {
    headers: { 'x-payment': `tempo-tx:${'0x'.padEnd(66, '1')}` },
  });
  assert(noQuote.status === 400, `a payment with no quote id is a 400, got ${noQuote.status}`);
  assert(reason(noQuote).includes('x-payment-quote'), 'the 400 names the missing header');
  pass('GET /discover with a tx but no x-payment-quote -> 400');

  const unmined = await call(`${server.url}/discover`, {
    headers: { 'x-payment': `tempo-tx:${'0x'.padEnd(66, 'a')}`, 'x-payment-quote': quoteId },
  });
  assert(unmined.status === 402, `an unmined hash is a 402, got ${unmined.status}`);
  assert(reason(unmined).startsWith('no receipt for'), 'the 402 says the hash has no receipt');
  pass('GET /discover with a hash that never mined -> 402 "no receipt"');

  const realTx = newest.created.tx;
  const wrongMemo = await call(`${server.url}/discover`, {
    headers: { 'x-payment': `tempo-tx:${realTx}`, 'x-payment-quote': quoteId },
  });
  assert(wrongMemo.status === 402, `a real transaction that did not pay this quote is a 402, got ${wrongMemo.status}`);
  assert(reason(wrongMemo).includes('contains no TransferWithMemo'), 'the 402 explains that the memo is what binds the payment');
  pass(`GET /discover paid with a real receipt ${realTx.slice(0, 14)}… -> 402, the memo does not match`);
  info('proves', 'the gate really fetched and decoded that receipt; it did not take the hash on faith');

  const balanceAfter = await balanceOf(beacon, treasury);
  assert(balanceAfter === balanceBefore, `the treasury balance is unchanged (${balanceBefore} -> ${balanceAfter})`);
  assert(beacon.gate.size === 0, 'no payment was recorded as spent');
  assert(beacon.gate.history(5).length === 0, 'the settlement history is empty');
  const paymentsFile = join(dataDir, 'payments.json');
  assert(!existsSync(paymentsFile), 'payments.json was never written, because nothing settled');
  pass('five refusals, zero units moved, zero state written');

  // ------------------------------------------------------- 6. signed registry
  step(6, 'Registration is a signature: challenge, sign, list, re-verify offline');

  const signer = accountFor(privateKeyFor('seller'));
  const registered = addressFor('seller');
  assert(
    signer.address.toLowerCase() === registered.toLowerCase(),
    'the key derived from the environment controls the address the environment names',
  );
  info('signer', registered);

  const issued = await post(`${server.url}/registry/challenge`, { address: registered });
  assert(issued.status === 200, `POST /registry/challenge answered 200, got ${issued.status}: ${reason(issued)}`);
  const challenge = at<string>(issued.body, 'challenge');
  const message = at<string>(issued.body, 'message');
  assert(/^0x[0-9a-fA-F]{32}$/.test(challenge), `the challenge is 16 random bytes, got ${challenge}`);
  assert(message.includes(challenge), 'the signed message embeds the challenge');
  assert(message.includes(config.host), 'the signed message binds this beacon host');
  assert(message.includes(config.escrow), 'the signed message binds this escrow');
  assert(message.includes(registered.toLowerCase()) || message.includes(registered), 'the signed message binds the address');
  assert(Date.parse(at<string>(issued.body, 'expiresAt')) > Date.now(), 'the challenge expires in the future');
  pass(`POST /registry/challenge -> ${challenge}, expires ${at<string>(issued.body, 'expiresAt')}`);

  const signature = await signer.signMessage({ message });
  assert(/^0x[0-9a-fA-F]{130}$/.test(signature), 'personal_sign produced 65 bytes');

  const listing = await post(`${server.url}/registry`, {
    entry: {
      address: registered,
      name: 'Tempex Smoke Seller',
      agent: 'tempex-beacon/smoke-1',
      role: 'seller',
      capabilities: ['summarise legal text', 'translation', 'tempex-smoke'],
      endpoint: `${config.host}/agent`,
    },
    challenge,
    issuedAt: at<string>(issued.body, 'issuedAt'),
    expiresAt: at<string>(issued.body, 'expiresAt'),
    signature,
  });
  assert(listing.status === 201, `POST /registry answered 201, got ${listing.status}: ${reason(listing)}`);
  assert(at<boolean>(listing.body, 'registered') === true, 'the registration reports itself as registered');
  assert(at<Address>(listing.body, 'entry.accepts.escrow') === config.escrow, 'the listing is bound to this escrow');
  assert(at<string>(listing.body, 'entry.accepts.arbitration') === 'tempex-arbiter/1', 'the listing accepts the Tempex referee');
  assert(at<string>(listing.body, 'entry.policy.templateId') === 'standard', 'the default policy template was applied');
  assert(
    at<Address[]>(listing.body, 'entry.payment.tokens').some((token) => token.toLowerCase() === config.token.toLowerCase()),
    'the listing is payable in the escrow token by default',
  );
  pass('POST /registry -> 201, defaults filled from the beacon config');

  const exported = await call(`${server.url}/registry`);
  assert(exported.status === 200, 'GET /registry serves the signed file');
  const entries = at<RegistryEntry[]>(exported.body, 'entries');
  assert(entries.length === 1, `the registry holds the one registration, got ${entries.length}`);
  const entry = entries[0]!;
  assert(await verifyEntry(entry), 'the listing re-verifies from its own signature, offline');
  assert(
    !(await verifyEntry({ ...entry, address: addressFor('buyer') })),
    'the same signature does not verify for a different address',
  );
  assert(existsSync(config.registryFile), 'the portable registry file was written to the isolated data dir');
  pass('verifyEntry(entry) is true, and false the moment the address changes');
  info('honest limit', 'the signature binds host, escrow, address and expiry — not the name or capabilities');
  info('unforgeable part', `reputation: score ${beacon.reputation(registered).score} (${beacon.reputation(registered).band})`);

  const found = beacon.discover({ capability: 'tempex-smoke' });
  assert(found.length === 1, `discovery finds the listing by capability, got ${found.length}`);
  const top = found[0]!;
  assert(top.rank === 1, 'the listing is ranked, not merely listed');
  assert(
    top.reputation.score === beacon.reputation(registered).score,
    'the rank carries the same score the reputation engine derives',
  );
  assert(top.address.toLowerCase() === registered.toLowerCase(), 'discovery returns the registered address');
  pass(`discover(capability=tempex-smoke) -> rank ${top.rank}, score ${top.reputation.score}, band ${top.reputation.band}`);

  const replay = await post(`${server.url}/registry`, {
    entry: { address: registered, name: 'Replay', agent: 'tempex/replay', role: 'seller', capabilities: ['x'] },
    challenge,
    issuedAt: at<string>(issued.body, 'issuedAt'),
    expiresAt: at<string>(issued.body, 'expiresAt'),
    signature,
  });
  assert(replay.status === 400, `replaying a used challenge is a 400, got ${replay.status}`);
  assert(reason(replay).includes('unknown or already-used challenge'), 'the refusal says the challenge was consumed');
  pass('replaying the same challenge and signature -> 400');

  const stolen = await post(`${server.url}/registry/challenge`, { address: registered });
  assert(stolen.status === 200, 'a fresh challenge can be issued');
  const wrongSignature = await accountFor(privateKeyFor('buyer')).signMessage({
    message: at<string>(stolen.body, 'message'),
  });
  const wrongSigner = await post(`${server.url}/registry`, {
    entry: { address: registered, name: 'Impostor', agent: 'tempex/impostor', role: 'seller', capabilities: ['x'] },
    challenge: at<string>(stolen.body, 'challenge'),
    issuedAt: at<string>(stolen.body, 'issuedAt'),
    expiresAt: at<string>(stolen.body, 'expiresAt'),
    signature: wrongSignature,
  });
  assert(wrongSigner.status === 400, `a signature from the wrong key is a 400, got ${wrongSigner.status}`);
  assert(reason(wrongSigner).includes('signature recovers to'), 'the refusal names the address it recovered instead');
  pass('a challenge signed by a different key -> 400 "signature recovers to ..."');

  // ------------------------------------------------------------- 7. teardown
  step(7, 'Clean up, and prove the run left nothing behind');

  await teardown();
  assert(!existsSync(dataDir), 'the isolated data dir is gone');
  const repoRegistryAfter = existsSync(repoRegistry) ? statSync(repoRegistry).mtimeMs : null;
  assert(
    repoRegistryAfter === repoRegistryBefore,
    'the repo .beacon/registry.json was not created or modified by this run',
  );
  const finalBalance = await balanceOf(beacon, treasury);
  assert(finalBalance === balanceBefore, `the treasury balance is still ${balanceBefore} units`);
  pass('server closed, temp state removed, no beacon state written to the repo, no funds moved');

  /// Written last, after every assertion, so a receipt only ever exists for a run that
  /// passed end to end. A partial receipt would be worse than none.
  const receipt = {
    kind: 'tempex/beacon-smoke/1',
    generatedAt: new Date().toISOString(),
    result: 'ok',
    checks,
    network: config.network,
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    escrow: config.escrow,
    explorer: `${config.explorerUrl}/address/${config.escrow}`,
    paymentToken: config.token,
    treasury,
    spent: { units: '0', note: 'every paid path was refused, quoted, or free; nothing settled' },
    treasuryBalance: { before: String(balanceBefore), after: String(finalBalance) },
    index: {
      events: view.eventCount,
      jobs: view.jobs.length,
      jobCount: String(live.jobCount),
      nextJobId: String(live.nextJobId),
      fromBlock: String(view.fromBlock),
      headBlock: String(view.toBlock),
      withdrawals: view.withdrawals.length,
    },
    routes: {
      total: ROUTES.length,
      freeGet: freeGets.length,
      paid: ROUTES.filter((route) => route.paid).length,
    },
    steps: steps.map(({ n, title, passed, evidence }) => ({ n, title, passed, evidence })),
  };

  const runsDir = join(repo, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const stamp = receipt.generatedAt.replace(/[:.]/g, '-');
  const receiptPath = join(runsDir, `beacon-smoke-${stamp}.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  console.log(`\n\x1b[1mbeacon smoke ok\x1b[0m — ${checks} assertions against ${config.network}`);
  info('escrow', config.escrow);
  info('jobs indexed', `${view.jobs.length} of ${live.jobCount}`);
  info('free routes', String(freeGets.length));
  info('paid routes', '1 (/discover, 402 settled on-chain in the payment token)');
  info('spent', '0');
  info('receipt', receiptPath);
}

main().catch(async (error: unknown) => {
  await teardown();
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  console.error(`\n\x1b[31mfailed\x1b[0m ${detail}`);
  process.exitCode = 1;
});
