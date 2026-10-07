import { txUrl, utc } from '@/lib/format';
import type { JobRecord } from '@/lib/types';

type Step = { key: string; label: string; done: boolean; tx?: string; when?: string; note?: string };

/// The lifecycle as the chain recorded it. A step is done when its event exists;
/// the first missing step is "current" and pulses.
export function stepsFor(job: JobRecord): Step[] {
  const steps: Step[] = [
    { key: 'created', label: 'Open', done: Boolean(job.created), tx: job.created?.tx, note: 'terms locked' },
    { key: 'funded', label: 'Fund', done: Boolean(job.funded), tx: job.funded?.tx, note: 'money in escrow' },
    {
      key: 'delivered',
      label: 'Deliver',
      done: Boolean(job.delivered),
      tx: job.delivered?.tx,
      when: job.delivered ? utc(job.delivered.deliveredAt) : undefined,
      note: 'work fingerprinted',
    },
  ];
  if (job.accepted) {
    steps.push({ key: 'accepted', label: 'Accept', done: true, tx: job.accepted.tx, note: 'buyer paid out' });
    return steps;
  }
  steps.push(
    {
      key: 'dispute',
      label: 'Dispute',
      done: Boolean(job.dispute),
      tx: job.dispute?.tx,
      when: job.dispute ? utc(job.dispute.disputedAt) : undefined,
      note: job.dispute ? `buyer offers ${job.dispute.buyerOfferBps} bps` : '5% bond',
    },
    {
      key: 'response',
      label: 'Respond',
      done: Boolean(job.response),
      tx: job.response?.tx,
      when: job.response ? utc(job.response.respondedAt) : undefined,
      note: job.response ? `seller asks ${job.response.sellerAskBps} bps` : '7-day window',
    },
    {
      key: 'verdict',
      label: 'Rule',
      done: Boolean(job.verdict || job.lapsed),
      tx: job.verdict?.tx ?? job.lapsed?.tx,
      note: job.verdict ? `award ${job.verdict.sellerAwardBps} bps` : job.lapsed ? 'lapsed: midpoint' : 'signed, then relayed',
    },
  );
  return steps;
}

export function StageTimeline({ job }: { job: JobRecord }) {
  const steps = stepsFor(job);
  const current = steps.findIndex((step) => !step.done);
  const terminal = ['refunded', 'cancelled'].includes(job.stage);
  return (
    <ol className="grid gap-px overflow-hidden border hairline bg-line sm:grid-cols-3 lg:grid-cols-6" aria-label="Job lifecycle">
      {steps.map((step, index) => {
        const isCurrent = index === current && !terminal;
        return (
          <li key={step.key} className="flex flex-col gap-2 bg-ink-2 p-4">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={`inline-block h-3 w-3 ${step.done ? 'bg-ref' : isCurrent ? 'border border-ref anim-pulse' : 'border border-line-2'}`}
              />
              <span className="label text-fg-2">
                {String(index + 1).padStart(2, '0')} · {step.label}
              </span>
            </div>
            <p className="text-[13px] text-fg-2">{step.note}</p>
            {step.tx ? (
              <a href={txUrl(step.tx)} target="_blank" rel="noreferrer" className="font-mono text-[11.5px] text-fg-3 hover:text-ref">
                {step.tx.slice(0, 8)}…{step.tx.slice(-4)} ↗
              </a>
            ) : (
              <span className="font-mono text-[11.5px] text-fg-3">{step.done ? '' : isCurrent ? 'next' : 'pending'}</span>
            )}
            {step.when ? <span className="font-mono text-[11px] text-fg-3">{step.when}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
