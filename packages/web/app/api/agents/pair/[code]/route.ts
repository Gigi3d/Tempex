import { PAIR_CODE, beaconAgents } from '@/lib/agents-api';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!PAIR_CODE.test(code)) return Response.json({ error: 'bad_request', message: 'not a pairing code' }, { status: 400 });
  return beaconAgents(`/agents/pair/${encodeURIComponent(code)}`);
}

/// The owner's browser reports its authorization transaction. The beacon checks it
/// on chain; nothing the browser claims is taken on trust.
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!PAIR_CODE.test(code)) return Response.json({ error: 'bad_request', message: 'not a pairing code' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { tx?: unknown; limit?: unknown; role?: unknown } | null;
  if (!body || typeof body.tx !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.tx)) {
    return Response.json({ error: 'bad_request', message: 'body must carry the authorization transaction as "tx"' }, { status: 400 });
  }
  const limit = typeof body.limit === 'string' && /^\d{1,30}$/.test(body.limit) ? body.limit : undefined;
  const role = body.role === 'buyer' || body.role === 'seller' || body.role === 'both' ? body.role : undefined;
  return beaconAgents(`/agents/pair/${encodeURIComponent(code)}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: body.tx, ...(limit ? { limit } : {}), ...(role ? { role } : {}) }),
  });
}
