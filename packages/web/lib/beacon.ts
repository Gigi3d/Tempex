import 'server-only';

import { snapshot } from './snapshot';
import type { Arbiters, JobRecord, JobsList, Proof, Quote, Ready, Reputation, RouteInfo, Sourced, Stats } from './types';

/// The beacon is read-only from here: no keys, no writes. Every loader tries the
/// live beacon first, then falls back to the baked snapshot, and says which one
/// the page is showing. Nothing is ever invented to fill a gap.
const BEACON_URL = process.env['TEMPEX_BEACON_URL'];
const TIMEOUT_MS = 2_500;

export function beaconUrl(): string | null {
  return BEACON_URL ?? null;
}

export class NotFound extends Error {
  constructor(public readonly hint: string) {
    super(hint);
  }
}

async function live<T>(path: string, revalidate: number | false): Promise<T> {
  if (!BEACON_URL) throw new Error('TEMPEX_BEACON_URL is not set');
  const response = await fetch(`${BEACON_URL}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    next: revalidate === false ? { revalidate: false } : { revalidate },
    headers: { accept: 'application/json' },
  });
  if (response.status === 404) {
    const body = (await response.json().catch(() => ({}))) as { hint?: string; message?: string };
    throw new NotFound(body.hint ?? body.message ?? `${path} was not found`);
  }
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

async function sourced<T>(path: string, revalidate: number | false, fallback: () => T | undefined): Promise<Sourced<T>> {
  try {
    const data = await live<T>(path, revalidate);
    return { data, source: 'live', asOf: new Date().toISOString() };
  } catch (error) {
    // A live 404 is an answer, not an outage: the job really does not exist.
    if (error instanceof NotFound) throw error;
    const baked = fallback();
    if (baked === undefined) throw new NotFound('The beacon did not answer and the snapshot has no copy of this.');
    return { data: baked, source: 'snapshot', asOf: snapshot.beaconAt ?? snapshot.bakedAt };
  }
}

const baked = snapshot.beacon;

export const getStats = (): Promise<Sourced<Stats>> => sourced('/stats', 30, () => baked?.stats);
export const getJobs = (): Promise<Sourced<JobsList>> => sourced('/jobs', 15, () => baked?.jobs);
export const getJobsFor = (address: string): Promise<Sourced<JobsList>> =>
  sourced(`/jobs?address=${encodeURIComponent(address)}`, 15, () =>
    baked?.jobs
      ? { ...baked.jobs, jobs: baked.jobs.jobs.filter((job) => [job.buyer, job.seller].some((party) => party.toLowerCase() === address.toLowerCase())) }
      : undefined,
  );
export const getJob = (id: string): Promise<Sourced<JobRecord>> => sourced(`/jobs/${encodeURIComponent(id)}`, 15, () => baked?.detail[id]);
export const getProof = (id: string): Promise<Sourced<Proof>> => sourced(`/proof/${encodeURIComponent(id)}`, 60, () => baked?.proofs[id]);
export const getArbiters = (): Promise<Sourced<Arbiters>> => sourced('/arbiters', 60, () => baked?.arbiters);
export const getReputation = (address: string): Promise<Sourced<Reputation>> =>
  sourced(`/reputation/${encodeURIComponent(address)}`, 60, () => baked?.reputation[address.toLowerCase()]);
export const getQuote = (role: 'seller' | 'buyer'): Promise<Sourced<Quote>> => sourced(`/quote?role=${role}`, 300, () => baked?.quote[role]);
export const getRoutes = (): Promise<Sourced<RouteInfo[]>> =>
  sourced('/.well-known/tempex.json', 300, () => baked?.manifest).then((result) => ({
    ...result,
    data: (result.data as unknown as { routes: RouteInfo[] }).routes,
  }));
export const getManifest = (): Promise<Sourced<Record<string, unknown>>> =>
  sourced('/.well-known/tempex.json', 300, () => baked?.manifest as Record<string, unknown> | undefined);
export const getAgentCard = (): Promise<Sourced<Record<string, unknown>>> =>
  sourced('/.well-known/agent.json', 300, () => baked?.agent);

/// Never cached and never baked: whether an address can trade is a now-question.
export async function getReady(address: string, role: 'seller' | 'buyer'): Promise<Ready> {
  return live<Ready>(`/ready?role=${role}&address=${encodeURIComponent(address)}`, false);
}

/// Encoded calldata for one intent. The beacon builds it; nothing here signs it.
export async function postBlueprint(action: string, body: unknown): Promise<unknown> {
  if (!BEACON_URL) throw new Error('The beacon is not configured, so calldata cannot be built here.');
  const response = await fetch(`${BEACON_URL}/blueprint/${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    cache: 'no-store',
  });
  return response.json();
}
