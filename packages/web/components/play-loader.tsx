'use client';

import dynamic from 'next/dynamic';

import type { Table } from '@/lib/play';
import type { CorpusCase } from '@/lib/snapshot';

/// The deal engine carries viem's Tempo module and the arbiter's rule engine, so
/// it loads after the page paints. It also reads browser-only facts (passkey
/// support, saved sessions), which is why it never renders on the server.
const PlayTable = dynamic(() => import('./play-table').then((module) => module.PlayTable), {
  ssr: false,
  loading: () => (
    <div className="panel grid min-h-[420px] place-items-center">
      <p className="label anim-pulse">Setting the table…</p>
    </div>
  ),
});

export function PlayLoader(props: { table: Table; scenarios: CorpusCase[] }) {
  return <PlayTable {...props} />;
}
