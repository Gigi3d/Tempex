import { beaconPass } from '@/lib/agents-api';

export const dynamic = 'force-dynamic';

/// Files a job document with the beacon's store. The store computes the hash
/// itself and the browser checks it, so this route only bounds the size.
export async function POST(request: Request) {
  const body = await request.text();
  if (body.length > 200 * 1024) return Response.json({ error: 'payload_too_large', message: 'documents are capped at 128 KiB' }, { status: 413 });
  return beaconPass('/docs', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}
