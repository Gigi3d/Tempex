import Link from 'next/link';
import { notFound } from 'next/navigation';

import { RulingGauge } from '@/components/gauge';
import { Deliverable, JobFacts, PayoutPreview, StateMachine } from '@/components/job-view';
import { StageTimeline } from '@/components/timeline';
import { ArrowUpRight, Eyebrow, SourceChip } from '@/components/ui';
import { getJob, NotFound } from '@/lib/beacon';
import { snapshot } from '@/lib/snapshot';

export const revalidate = 15;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Job ${id}` };
}

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  let result;
  try {
    result = await getJob(id);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    throw error;
  }
  const job = result.data;
  const isReceipt = String(snapshot.receipt.session.jobId) === job.jobId;
  const band = isReceipt ? snapshot.receipt.adjudication.band : null;
  const offers =
    job.dispute && job.response
      ? { lowBps: Math.min(job.dispute.buyerOfferBps, job.response.sellerAskBps), highBps: Math.max(job.dispute.buyerOfferBps, job.response.sellerAskBps) }
      : job.dispute
        ? { lowBps: job.dispute.buyerOfferBps, highBps: 10_000 }
        : null;

  return (
    <div className="wrap pt-14">
      <Link href="/explorer" className="label hover:text-fg">
        ← All jobs
      </Link>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-3">
          <Eyebrow>Job</Eyebrow>
          <h1 className="display font-mono text-[clamp(44px,6vw,80px)]">#{job.jobId}</h1>
          <StateMachine job={job} />
        </div>
        <div className="flex flex-col items-end gap-3">
          <SourceChip source={result.source} asOf={result.asOf} />
          {job.verdict ? (
            <Link href={`/proof/${job.jobId}`} className="btn btn-primary">
              Open the receipt <ArrowUpRight />
            </Link>
          ) : null}
        </div>
      </div>

      <section className="mt-10">
        <StageTimeline job={job} />
      </section>

      <section className="mt-12 grid gap-10 lg:grid-cols-[1fr_1fr]">
        <div className="flex flex-col gap-4">
          <Eyebrow>The deal</Eyebrow>
          <JobFacts job={job} />
        </div>
        <Deliverable job={job} />
      </section>

      {job.dispute ? (
        <section className="mt-12 panel p-6">
          <Eyebrow>Bounds</Eyebrow>
          <div className="mt-4">
            <RulingGauge ruleBand={band ? { lowBps: band.lowBps, highBps: band.highBps } : null} offers={offers} awardBps={job.verdict?.sellerAwardBps} />
          </div>
          {!band ? <p className="mt-2 text-[13px] text-fg-3">The rule band lives in the arbiter’s evidence; it is shown for jobs whose receipt is published.</p> : null}
        </section>
      ) : null}

      {job.dispute ? (
        <section className="mt-12">
          <PayoutPreview job={job} />
        </section>
      ) : null}
    </div>
  );
}
