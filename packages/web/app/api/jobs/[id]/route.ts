import { NextResponse } from 'next/server';

import { getJob, NotFound } from '@/lib/beacon';

export const dynamic = 'force-dynamic';

/// Live mode polls this to follow a run the presenter started from the CLI.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'A job id is a whole number.' }, { status: 400 });
  try {
    const result = await getJob(id);
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof NotFound) return NextResponse.json({ error: error.hint }, { status: 404 });
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
