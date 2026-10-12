import Link from 'next/link';

import { Chip, Hash, SectionHead, SourceChip } from '@/components/ui';
import { getArbiters } from '@/lib/beacon';
import type { ArbiterListing } from '@/lib/types';

export const revalidate = 60;
export const metadata = { title: 'Arbiter market', description: 'Who can settle a Tempex job, at what fee, with what track record.' };

function Row({ listing, house }: { listing: ArbiterListing; house?: boolean }) {
  const r = listing.record;
  const contested = r.disputes > 0 ? Math.round((r.lapsed / r.disputes) * 100) : 0;
  return (
    <tr>
      <td>
        <div className="flex flex-col gap-1">
          <Hash value={listing.arbiter} kind="address" head={10} tail={6} />
          <span className="text-[12px] text-fg-3">{house ? 'house arbiter: the default when a job names none' : (listing.metadataURI ?? 'no description')}</span>
        </div>
      </td>
      <td>{listing.active ? <Chip tone="ref">active</Chip> : <Chip tone="fail">inactive</Chip>}</td>
      <td className="text-right font-mono num">{listing.feeBps} bps</td>
      <td className="text-right font-mono num">{r.jobs}</td>
      <td className="text-right font-mono num">{r.ruled}/{r.disputes}</td>
      <td className="text-right font-mono num">{r.lapsed}{r.disputes > 0 ? <span className="text-fg-3"> · {contested}%</span> : null}</td>
      <td className="text-right font-mono num">{r.averageSellerAwardBps ?? '—'}</td>
      <td>
        <Link href={`/reputation/${listing.arbiter}`} className="link text-[13px]">
          Dossier
        </Link>
      </td>
    </tr>
  );
}

export default async function Arbiters() {
  const result = await getArbiters();
  const { house, listed, note } = result.data;
  return (
    <div className="wrap pt-16">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <SectionHead eyebrow="Arbiter market" title="The referee is a market, not a monopoly.">
          A buyer names its arbiter when it opens a job, and the fee is locked with the terms. A listed arbiter keeps its fee
          minus the protocol cut, which the contract caps at 50%.
        </SectionHead>
        <SourceChip source={result.source} asOf={result.asOf} />
      </div>
      <div className="mt-10 overflow-x-auto border hairline">
        <table className="table min-w-[900px]">
          <thead>
            <tr>
              <th>Arbiter</th>
              <th>Status</th>
              <th className="text-right">Fee</th>
              <th className="text-right">Jobs</th>
              <th className="text-right">Ruled</th>
              <th className="text-right">Lapsed</th>
              <th className="text-right">Avg award</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <Row listing={house} house />
            {listed.map((listing) => (
              <Row key={listing.arbiter} listing={listing} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 max-w-3xl text-[13px] text-fg-3">{note}</p>
      <div className="mt-12 grid gap-px border hairline bg-line md:grid-cols-3">
        {[
          ['List yourself', 'Call listArbiter(feeBps, metadataURI) from the account that will sign verdicts. A fee change reaches only jobs created afterwards.'],
          ['Get chosen', 'Buyers pick an arbiter with createJobWithArbiter. Your fee and the protocol cut are locked into that job.'],
          ['Stay honest', 'Rule inside the band or the guardrail clamps you; rule outside the offers and the escrow reverts. Miss the window and anyone can settle at the midpoint.'],
        ].map(([title, body]) => (
          <div key={title} className="bg-ink-2 p-6">
            <p className="text-[16px]">{title}</p>
            <p className="mt-2 text-[14px] text-fg-2">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
