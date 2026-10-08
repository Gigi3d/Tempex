import { ADDRESS, beaconPass } from '@/lib/agents-api';

export const dynamic = 'force-dynamic';

/// An address's jobs, as both buyer and seller, fresh from the beacon's index.
export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get('address') ?? '';
  if (!ADDRESS.test(address)) return Response.json({ error: 'bad_request', message: 'pass ?address=0x…' }, { status: 400 });
  return beaconPass(`/jobs?address=${address}&limit=500`);
}
