/// Bakes everything the site can show without a network into data/snapshot.json:
/// the beacon's read routes (when a beacon answers), the latest demo receipt and
/// its evidence files, and the scenario corpus with its predictions and drill.
///
/// The snapshot is the fallback, never the source of truth. Pages read the live
/// beacon first and show "snapshot from <date>" whenever they fall back to this.
///
///   TEMPEX_BEACON_URL=http://127.0.0.1:8787 pnpm --filter @tempex/web bake
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { SCENARIOS, caseFor, drill, predictScenario, PREDICT_PARTIES } from '@tempex/demo';

const repo = resolve(import.meta.dirname, '../../..');
const out = resolve(import.meta.dirname, '../data/snapshot.json');
const beacon = process.env['TEMPEX_BEACON_URL'] ?? 'http://127.0.0.1:8787';

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${beacon}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

function previous(): Record<string, unknown> {
  return existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>) : {};
}

async function bakeBeacon(): Promise<Record<string, unknown> | null> {
  try {
    const stats = (await get('/stats')) as { jobs: { total: number } };
    const jobs = (await get('/jobs')) as { jobs: { jobId: string; buyer: string; seller: string }[] };
    const detail: Record<string, unknown> = {};
    const proofs: Record<string, unknown> = {};
    for (const job of jobs.jobs) {
      detail[job.jobId] = await get(`/jobs/${job.jobId}`);
      proofs[job.jobId] = await get(`/proof/${job.jobId}`);
    }
    const addresses = [...new Set(jobs.jobs.flatMap((job) => [job.buyer, job.seller]))];
    const arbiters = (await get('/arbiters')) as {
      house: { arbiter: string };
      listed: { arbiter: string }[];
    };
    for (const listing of [arbiters.house, ...arbiters.listed]) addresses.push(listing.arbiter);
    const reputation: Record<string, unknown> = {};
    for (const address of [...new Set(addresses)]) {
      reputation[address.toLowerCase()] = await get(`/reputation/${address}`);
    }
    return {
      url: beacon,
      stats,
      jobs,
      detail,
      proofs,
      arbiters,
      reputation,
      quote: { seller: await get('/quote?role=seller'), buyer: await get('/quote?role=buyer') },
      onboard: { seller: await get('/onboard?role=seller'), buyer: await get('/onboard?role=buyer') },
      policy: await get('/policy'),
      manifest: await get('/.well-known/tempex.json'),
      agent: await get('/.well-known/agent.json'),
      health: await get('/health'),
    };
  } catch (error) {
    console.warn(`beacon at ${beacon} unavailable (${(error as Error).message}); keeping the last baked beacon data`);
    return null;
  }
}

/// The newest full demo receipt that passed every expectation.
function latestReceipt(): Record<string, unknown> {
  const runs = resolve(repo, 'runs');
  const files = readdirSync(runs)
    .filter((name) => /^demo-underdelivered-\d{4}-.*\.json$/.test(name))
    .sort()
    .reverse();
  for (const name of files) {
    const receipt = JSON.parse(readFileSync(resolve(runs, name), 'utf8')) as {
      ok: boolean;
      adjudication?: unknown;
      session?: { jobId?: number };
    };
    if (receipt.ok && receipt.adjudication !== undefined) {
      const jobId = receipt.session?.jobId;
      const evidence = (kind: string): unknown => {
        const path = resolve(repo, 'evidence', `job-${jobId}.${kind}.json`);
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
      };
      const { transcript: _transcript, ...rest } = receipt as Record<string, unknown>;
      return {
        file: `runs/${name}`,
        ...rest,
        evidence: { terms: evidence('terms'), bundle: evidence('evidence'), response: evidence('response') },
      };
    }
  }
  throw new Error('no passing demo receipt with an adjudication under runs/');
}

function bakeCorpus(): unknown[] {
  const report = drill();
  return SCENARIOS.map((scenario) => {
    const prediction = predictScenario(scenario);
    const evidenceCase = caseFor(scenario, { jobId: 0, parties: PREDICT_PARTIES, submittedAt: new Date(0).toISOString() });
    const row = report.rows.find((r) => r.id === scenario.id);
    return {
      id: scenario.id,
      title: scenario.title,
      premise: scenario.premise,
      expect: scenario.expect,
      offers: { buyerOfferBps: scenario.buyerOfferBps ?? null, sellerAskBps: scenario.sellerAskBps ?? null },
      prediction,
      drill: row?.proposals ?? [],
      terms: evidenceCase.terms,
      claim: evidenceCase.bundle.claim,
      deliverable: evidenceCase.bundle.deliverable?.content ?? null,
      response: evidenceCase.response ?? null,
      // What /play needs to stage the same dispute from a browser.
      artifacts: evidenceCase.bundle.artifacts,
      sellerStatement: scenario.sellerStatement ?? null,
      deliveryDeadlineSeconds: scenario.deliveryDeadlineSeconds,
      reviewWindowSeconds: scenario.reviewWindowSeconds,
    };
  });
}

const prior = previous();
const beaconData = (await bakeBeacon()) ?? (prior['beacon'] as Record<string, unknown> | undefined) ?? null;
const snapshot = {
  bakedAt: new Date().toISOString(),
  beaconAt: beaconData !== null ? ((beaconData['stats'] as { generatedAt?: string })?.generatedAt ?? null) : null,
  beacon: beaconData,
  receipt: latestReceipt(),
  corpus: bakeCorpus(),
};

mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify(snapshot, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`);
console.log(`wrote ${out}`);
console.log(`  beacon: ${beaconData === null ? 'none' : `${(beaconData['jobs'] as { count: number }).count} jobs from ${String(beaconData['url'])}`}`);
console.log(`  receipt: ${(snapshot.receipt as { file: string }).file}`);
console.log(`  corpus: ${snapshot.corpus.length} scenarios`);
