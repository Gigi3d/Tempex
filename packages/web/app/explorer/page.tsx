import Link from 'next/link';

import { RulingGauge } from '@/components/gauge';
import { Chip, Hash, SectionHead, SourceChip } from '@/components/ui';
import { getJobs } from '@/lib/beacon';
import { amount, STAGE_LABEL, stageTone, until } from '@/lib/format';
import type { JobRecord } from '@/lib/types';

export const revalidate = 15;
export const metadata = { title: 'Job explorer', description: 'Every job the Tempex escrow has seen, folded from chain events.' };

function nextDeadline(job: JobRecord): string {
  const now = Date.now() / 1000;
  if (job.stage === 'funded') return `delivery ${until(job.deliveryDeadline, now)}`;
  if (job.stage === 'delivered' && job.delivered) return `review ${until(job.delivered.reviewDeadline, now)}`;
  if (job.stage === 'disputed' && job.dispute) return `response ${until(job.dispute.responseDeadline, now)}`;
  return '—';
}

export default async function Explorer({ searchParams }: { searchParams: Promise<{ stage?: string }> }) {
  const { stage } = await searchParams;
  const result = await getJobs();
  const all = result.data.jobs;
  const jobs = stage ? all.filter((job) => job.stage === stage) : all;
  const stages = [...new Set(all.map((job) => job.stage))];

  return (
    <div className="wrap pt-16">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <SectionHead eyebrow="Job explorer" title="Every job the escrow has seen.">
          Folded from escrow events by the beacon. Every row links to its transactions on the Tempo explorer.
        </SectionHead>
        <SourceChip source={result.source} asOf={result.asOf} />
      </div>
      <nav aria-label="Filter by stage" className="mt-10 flex flex-wrap gap-2">
        <Link href="/explorer" className={`tab ${!stage ? 'text-fg' : ''}`} aria-current={!stage ? 'page' : undefined}>
          All {all.length}
        </Link>
        {stages.map((s) => (
          <Link key={s} href={`/explorer?stage=${s}`} className="tab" aria-current={stage === s ? 'page' : undefined} aria-selected={stage === s}>
            {STAGE_LABEL[s] ?? s} {all.filter((job) => job.stage === s).length}
          </Link>
        ))}
      </nav>
      <div className="mt-4 overflow-x-auto border hairline">
        <table className="table min-w-[920px]">
          <thead>
            <tr>
              <th>Job</th>
              <th>Buyer → seller</th>
              <th className="text-right">Amount</th>
              <th>Stage</th>
              <th>Arbiter</th>
              <th>Ruling</th>
              <th>Next deadline</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.jobId}>
                <td>
                  <Link href={`/explorer/${job.jobId}`} className="font-mono text-[15px] hover:text-ref">
                    #{job.jobId}
                  </Link>
                </td>
                <td>
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Hash value={job.buyer} kind="address" />
                    <span className="text-fg-3">→</span>
                    <Hash value={job.seller} kind="address" />
                  </span>
                </td>
                <td className="text-right font-mono num">{amount(job.amount)}</td>
                <td>
                  <Chip tone={stageTone(job.stage)}>{STAGE_LABEL[job.stage] ?? job.stage}</Chip>
                </td>
                <td>{job.terms ? <Hash value={job.terms.arbiter} kind="address" /> : <span className="text-fg-3">—</span>}</td>
                <td className="min-w-[180px]">
                  {job.verdict ? (
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-ref num">{job.verdict.sellerAwardBps}</span>
                      <RulingGauge size="compact" awardBps={job.verdict.sellerAwardBps} ruleBand={null} offers={job.dispute && job.response ? { lowBps: Math.min(job.dispute.buyerOfferBps, job.response.sellerAskBps), highBps: Math.max(job.dispute.buyerOfferBps, job.response.sellerAskBps) } : null} />
                    </div>
                  ) : (
                    <span className="text-fg-3">—</span>
                  )}
                </td>
                <td className="font-mono text-[12.5px] text-fg-2">{nextDeadline(job)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {jobs.length === 0 ? <p className="p-6 text-[14px] text-fg-3">No jobs in this stage yet.</p> : null}
      </div>
    </div>
  );
}
