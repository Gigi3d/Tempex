import 'server-only';

import { TOKENS } from '@tempex/sdk/browser';

import { snapshot } from './snapshot';

/// The arbiter's HTTP court (`pnpm court`). The web app only proxies to it: the
/// arbiter key lives in that process, never in this one.
export function courtUrl(): string | null {
  const url = process.env['TEMPEX_COURT_URL'];
  return url ? url.replace(/\/$/, '') : null;
}

export type CourtHealth = { ok: boolean; arbiter: string; escrow: string; sponsored: boolean };

export async function getCourtHealth(): Promise<CourtHealth | null> {
  const url = courtUrl();
  if (!url) return null;
  try {
    const response = await fetch(`${url}/health`, { cache: 'no-store', signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return null;
    return (await response.json()) as CourtHealth;
  } catch {
    return null;
  }
}

/// Where a browser deal is struck: the escrow and token, and the arbiter the
/// buyer names for the job. With no court the job still opens on chain, naming
/// the listed demo arbiter, and waits for its watcher.
export async function tableConfig() {
  const court = await getCourtHealth();
  const listed = snapshot.beacon?.arbiters.listed.find((entry) => entry.active)?.arbiter ?? null;
  const escrow = court?.escrow ?? process.env['TEMPEX_ESCROW'] ?? String((snapshot.beacon?.health as { escrow?: string } | undefined)?.escrow ?? '');
  return {
    escrow,
    token: process.env['TEMPEX_TOKEN'] ?? TOKENS.alphaUsd,
    arbiter: court?.arbiter ?? listed,
    court: court !== null,
  };
}
