import { NextResponse } from 'next/server';

import { postBlueprint } from '@/lib/beacon';

const ACTIONS = new Set([
  'create-and-fund',
  'approve',
  'deliver',
  'accept',
  'auto-accept',
  'dispute',
  'respond',
  'resolve',
  'refund-expired',
  'settle-lapsed',
  'create-milestones',
  'list-arbiter',
  'delist-arbiter',
  'withdraw',
]);

/// Forwards a blueprint request to the beacon. The beacon encodes calldata; it
/// never signs, and neither does this route.
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: `Unknown action "${action}". Pick one of: ${[...ACTIONS].join(', ')}.` }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'The parameters must be a JSON object.' }, { status: 400 });
  }
  try {
    return NextResponse.json(await postBlueprint(action, body));
  } catch (error) {
    return NextResponse.json({ error: `The beacon did not answer (${(error as Error).message}).` }, { status: 502 });
  }
}
