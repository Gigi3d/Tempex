import { ADDRESS, beaconPass } from '@/lib/agents-api';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!ADDRESS.test(address)) return Response.json({ error: 'bad_request', message: 'not an address' }, { status: 400 });
  return beaconPass(`/reputation/${address}`);
}
