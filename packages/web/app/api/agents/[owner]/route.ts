import { ADDRESS, beaconAgents } from '@/lib/agents-api';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ owner: string }> }) {
  const { owner } = await params;
  if (!ADDRESS.test(owner)) return Response.json({ error: 'bad_request', message: 'not an address' }, { status: 400 });
  return beaconAgents(`/agents/${owner}`);
}
