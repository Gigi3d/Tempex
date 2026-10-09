import 'server-only';

import { beaconUrl } from './beacon';

/// Server-side passthrough to the beacon's agent desk. The browser talks to this
/// site only; inputs are shape-checked here before anything is forwarded.
export async function beaconAgents(path: string, init?: RequestInit): Promise<Response> {
  const base = beaconUrl();
  if (!base) return Response.json({ error: 'no_beacon', message: 'This site has no beacon configured (TEMPEX_BEACON_URL).' }, { status: 503 });
  try {
    const response = await fetch(`${base}${path}`, { ...init, cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (error) {
    return Response.json({ error: 'beacon_unreachable', message: (error as Error).message }, { status: 502 });
  }
}

/// The same passthrough, for the dashboard's routes.
export const beaconPass = beaconAgents;

export const PAIR_CODE = /^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/;
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const HASH = /^0x[0-9a-fA-F]{64}$/;
