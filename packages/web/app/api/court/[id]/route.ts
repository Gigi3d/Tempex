import { courtUrl } from '@/lib/court';

export const dynamic = 'force-dynamic';

/// Hands a browser's evidence case to the arbiter's court. The court checks it
/// against the chain before it rules, so this route forwards and adds nothing.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,12}$/.test(id)) return Response.json({ error: 'bad_request', message: 'job id must be a number' }, { status: 400 });
  const url = courtUrl();
  if (!url) return Response.json({ error: 'no_court', message: 'No referee is connected to this site. Set TEMPEX_COURT_URL to a running `pnpm court`.' }, { status: 503 });
  const body = await request.text();
  if (body.length > 256 * 1024) return Response.json({ error: 'bad_request', message: 'the evidence is larger than 256 KiB' }, { status: 413 });
  try {
    const response = await fetch(`${url}/rule/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(90_000),
    });
    return new Response(await response.text(), { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: 'court_unreachable', message: (error as Error).message }, { status: 502 });
  }
}
