import { HASH, beaconPass } from '@/lib/agents-api';

export const dynamic = 'force-dynamic';

/// One transaction decoded by the beacon: calls, events, fee payer, and the key
/// that signed it.
export async function GET(_request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!HASH.test(hash)) return Response.json({ error: 'bad_request', message: 'a transaction is addressed by its 32-byte hash' }, { status: 400 });
  return beaconPass(`/tx/${hash}`);
}
