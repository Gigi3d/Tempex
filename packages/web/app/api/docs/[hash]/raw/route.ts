import { hashText } from '@tempex/sdk/browser';

import { HASH, beaconPass } from '@/lib/agents-api';

export const dynamic = 'force-dynamic';

/// A delivered piece of work as plain text, for a delivery too long to ride in
/// its transaction. The seller's on-chain URI points here; the arbiter fetches it
/// and checks the bytes against the hash the seller committed. Served inert:
/// text only, never sniffed, sandboxed, so nothing in it can run on this origin.
export async function GET(_request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!HASH.test(hash)) return new Response('not a document hash', { status: 400 });
  const response = await beaconPass(`/docs/${hash}`);
  if (!response.ok) return new Response('no deliverable is filed under that hash', { status: response.status });
  const stored = (await response.json()) as { kind?: string; doc?: unknown };
  if (stored.kind !== 'deliverable' || typeof stored.doc !== 'string' || hashText(stored.doc).toLowerCase() !== hash.toLowerCase()) {
    return new Response('no deliverable is filed under that hash', { status: 404 });
  }
  return new Response(stored.doc, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
