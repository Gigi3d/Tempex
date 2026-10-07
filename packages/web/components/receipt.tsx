import { disputeSettlement } from '@tempex/sdk/browser';

import { amount } from '@/lib/format';
import type { Adjudication } from '@/lib/snapshot';
import type { JobRecord } from '@/lib/types';

import { CopyButton } from './copy';
import { Hash } from './ui';

/// The ruling as a receipt. Money lines come from the chain's VerdictResolved
/// event; the bond split is recomputed with the SDK's mirror of the contract,
/// and must agree with what the chain paid.
export function ReceiptCard({ job, adjudication, beaconUrl }: { job: JobRecord; adjudication?: Adjudication | null; beaconUrl: string | null }) {
  const verdict = job.verdict;
  if (!verdict || !job.terms) return null;
  const settlement = disputeSettlement({
    amount: BigInt(job.amount),
    arbitrationFeeBps: job.terms.arbitrationFeeBps,
    sellerAwardBps: verdict.sellerAwardBps,
  });
  const agrees =
    settlement.sellerAmount.toString() === verdict.sellerAmount && settlement.buyerAmount.toString() === verdict.buyerAmount;
  const engine = adjudication?.engine === 'rules' ? 'rules engine' : adjudication?.engine ? `judge panel · ${adjudication.model}` : null;
  const base = beaconUrl ?? 'https://<beacon>';
  const curl = `curl -s ${base}/proof/${job.jobId} | jq '.job.verdict'`;

  return (
    <div className="panel-sunk relative border-dashed p-5 font-mono text-[12.5px] leading-[1.9]">
      <span className="anim-stamp absolute right-5 top-4 border-2 border-ref px-2 py-0.5 text-[11px] font-bold tracking-[0.14em] text-ref">
        SETTLED ON CHAIN
      </span>
      <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-4 pr-28 max-sm:grid-cols-1 max-sm:pr-0">
        <dt className="text-fg-3">job</dt>
        <dd>{job.jobId}</dd>
        <dt className="text-fg-3">termsHash</dt>
        <dd><Hash value={job.termsHash} head={10} tail={6} /></dd>
        {job.delivered ? (
          <>
            <dt className="text-fg-3">deliverableHash</dt>
            <dd><Hash value={job.delivered.deliverableHash} head={10} tail={6} /></dd>
          </>
        ) : null}
        {job.dispute ? (
          <>
            <dt className="text-fg-3">disputeHash</dt>
            <dd><Hash value={job.dispute.disputeHash} head={10} tail={6} /></dd>
          </>
        ) : null}
        <dt className="text-fg-3">verdict digest</dt>
        <dd><Hash value={verdict.verdictDigest} head={10} tail={6} /></dd>
        <dt className="text-fg-3">signed by</dt>
        <dd>
          <Hash value={job.terms.arbiter} kind="address" />
          {engine ? <span className="ml-2 text-fg-3">· {engine}</span> : null}
        </dd>
        {adjudication ? (
          <>
            <dt className="text-fg-3">signature</dt>
            <dd className={adjudication.recovered.toLowerCase() === adjudication.registeredArbiter.toLowerCase() ? 'text-ref' : 'text-fail'}>
              {adjudication.recovered.toLowerCase() === adjudication.registeredArbiter.toLowerCase()
                ? '✓ recovers to the registered arbiter'
                : '✕ does not recover to the registered arbiter. Do not rely on this ruling.'}
            </dd>
          </>
        ) : null}
        <dt className="text-fg-3">award</dt>
        <dd className="text-ref">{verdict.sellerAwardBps} bps</dd>
        <dt className="text-fg-3">relayed in</dt>
        <dd><Hash value={verdict.tx} kind="tx" head={10} tail={6} /></dd>
      </dl>
      <div className="perforation my-4" />
      <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-4 max-sm:grid-cols-1">
        <dt className="text-fg-3">escrowed</dt>
        <dd className="num">{amount(job.amount, 'ledger')} αUSD</dd>
        <dt className="text-fg-3">to seller</dt>
        <dd className="num text-bolt">
          {amount(verdict.sellerAmount, 'ledger')} αUSD
          <span className="text-fg-3"> · incl. {amount(settlement.bondToSeller, 'ledger')} of the bond</span>
        </dd>
        <dt className="text-fg-3">to buyer</dt>
        <dd className="num text-pip">{amount(verdict.buyerAmount, 'ledger')} αUSD</dd>
        <dt className="text-fg-3">arbitration fee</dt>
        <dd className="num">
          {amount(verdict.arbitrationFee, 'ledger')} αUSD <span className="text-fg-3">· {job.terms.arbitrationFeeBps} bps, loser pays</span>
        </dd>
        <dt className="text-fg-3">dispute bond</dt>
        <dd className="num">{amount(settlement.bond, 'ledger')} αUSD <span className="text-fg-3">· 5%</span></dd>
        <dt className="text-fg-3">math check</dt>
        <dd className={agrees ? 'text-ref' : 'text-fail'}>
          {agrees ? '✓ the SDK’s disputeSettlement reproduces these payouts' : '✕ payouts differ from disputeSettlement'}
        </dd>
      </dl>
      <div className="mt-5 flex items-start justify-between gap-3 border hairline bg-ink px-4 py-3">
        <code className="min-w-0 overflow-x-auto whitespace-pre text-[12px] text-fg-2">
          <span className="text-fg-3"># Verify it yourself</span>
          {'\n'}
          {curl}
        </code>
        <CopyButton value={curl} label="Copy the verify command" />
      </div>
    </div>
  );
}
