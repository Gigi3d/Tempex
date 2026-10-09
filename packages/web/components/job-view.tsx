import { awardBounds, disputeSettlement, type Job } from '@tempex/sdk/browser';

import { amount, decodeDataUri, STAGE_LABEL, stageTone, utc } from '@/lib/format';
import type { JobRecord } from '@/lib/types';

import { Chip, Eyebrow, Hash } from './ui';

const MACHINE = ['created', 'funded', 'delivered', 'disputed', 'resolved'] as const;

/// The contract's state machine with this job's position lit.
export function StateMachine({ job }: { job: JobRecord }) {
  const position = job.stage === 'responded' ? 'disputed' : job.stage;
  const reached = MACHINE.indexOf(position as (typeof MACHINE)[number]);
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={`State: ${STAGE_LABEL[job.stage] ?? job.stage}`}>
      {MACHINE.map((state, index) => (
        <span key={state} className="flex items-center gap-2">
          <span className={`chip ${index === reached ? 'chip-ref' : index < reached ? '' : 'opacity-40'}`}>{STAGE_LABEL[state]}</span>
          {index < MACHINE.length - 1 ? <span className="text-fg-3">→</span> : null}
        </span>
      ))}
      {['accepted', 'refunded', 'cancelled', 'lapsed'].includes(job.stage) ? (
        <Chip tone={stageTone(job.stage)}>{STAGE_LABEL[job.stage]}</Chip>
      ) : null}
    </div>
  );
}

/// The facts table: parties, money, terms, windows.
export function JobFacts({ job }: { job: JobRecord }) {
  const rows: [string, React.ReactNode][] = [
    ['buyer', <Hash key="b" value={job.buyer} kind="address" head={10} tail={6} />],
    ['seller', <Hash key="s" value={job.seller} kind="address" head={10} tail={6} />],
    ['amount', <span key="a" className="font-mono num">{amount(job.amount, 'ledger')} αUSD</span>],
    ['termsHash', <Hash key="t" value={job.termsHash} head={10} tail={6} />],
    ['delivery by', <span key="d" className="font-mono">{utc(job.deliveryDeadline)}</span>],
    ['review window', <span key="r" className="font-mono">{Math.round(job.reviewWindow / 3600)} h</span>],
  ];
  if (job.terms) {
    rows.push(
      ['arbiter', <Hash key="ar" value={job.terms.arbiter} kind="address" head={10} tail={6} />],
      ['fees, locked', <span key="f" className="font-mono">{job.terms.platformFeeBps} bps platform · {job.terms.arbitrationFeeBps} bps arbitration · {job.terms.protocolCutBps / 100}% protocol cut</span>],
    );
  }
  return (
    <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-6 gap-y-3 text-[14px] max-sm:grid-cols-1">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="label self-center">{label}</dt>
          <dd className="min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/// What the escrow would pay at every award, using the SDK's mirror of
/// TempexEscrow.disputeSettlement. For a ruled job, the line it actually paid is lit.
export function PayoutPreview({ job }: { job: JobRecord }) {
  if (!job.terms || !job.dispute) return null;
  const sdkJob = {
    disputedAt: job.dispute.disputedAt,
    buyerOfferBps: job.dispute.buyerOfferBps,
    sellerAskBps: job.response?.sellerAskBps ?? 10_000,
  } as Job;
  const bounds = awardBounds(sdkJob);
  const points = [...new Set([bounds.lowBps, Math.round((bounds.lowBps + bounds.highBps) / 2), bounds.highBps, job.verdict?.sellerAwardBps].filter((v): v is number => v !== undefined))].sort((a, b) => a - b);
  return (
    <div className="flex flex-col gap-3">
      <Eyebrow>Payout at each award (disputeSettlement)</Eyebrow>
      <div className="overflow-x-auto border hairline">
        <table className="table min-w-[560px]">
          <thead>
            <tr>
              <th>Award</th>
              <th className="text-right">Seller</th>
              <th className="text-right">Buyer</th>
              <th className="text-right">Fee</th>
            </tr>
          </thead>
          <tbody>
            {points.map((award) => {
              const money = disputeSettlement({ amount: BigInt(job.amount), arbitrationFeeBps: job.terms!.arbitrationFeeBps, sellerAwardBps: award, arbitrationFeeFloor: BigInt(job.terms!.arbitrationFeeFloor ?? '0') });
              const paid = job.verdict?.sellerAwardBps === award;
              return (
                <tr key={award} className={paid ? 'bg-ref/5' : undefined}>
                  <td className="font-mono num">
                    {award} bps {paid ? <Chip tone="ref">paid</Chip> : award === bounds.lowBps ? <span className="text-fg-3">buyer’s offer</span> : award === bounds.highBps ? <span className="text-fg-3">seller’s ask</span> : null}
                  </td>
                  <td className="text-right font-mono num text-bolt">{amount(money.sellerAmount, 'ledger')}</td>
                  <td className="text-right font-mono num text-pip">{amount(money.buyerAmount, 'ledger')}</td>
                  <td className="text-right font-mono num">{amount(money.arbitrationFee, 'ledger')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Deliverable({ job }: { job: JobRecord }) {
  const text = decodeDataUri(job.delivered?.uri);
  if (!job.delivered) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Eyebrow tone="bolt">Delivered work</Eyebrow>
      {text !== null ? (
        <pre className="code max-h-[320px] overflow-auto text-[12px]">{text}</pre>
      ) : job.delivered.uri ? (
        <a className="link font-mono text-[13px] break-all" href={job.delivered.uri} target="_blank" rel="noreferrer">
          {job.delivered.uri}
        </a>
      ) : (
        <p className="text-[14px] text-fg-3">The seller pinned a hash without a location.</p>
      )}
      <p className="font-mono text-[11.5px] text-fg-3">deliverableHash {job.delivered.deliverableHash}</p>
    </div>
  );
}
