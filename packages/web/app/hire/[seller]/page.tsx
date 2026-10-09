import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CopyButton } from '@/components/copy';
import { getReputation } from '@/lib/beacon';
import { pct, shortHash } from '@/lib/format';
import { agentCommand, decodeOffer } from '@/lib/offer';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ o?: string }> }) {
  const offer = decodeOffer((await searchParams).o);
  return offer
    ? { title: `Hire: ${offer.title}`, description: `${offer.amount} αUSD in escrow on Tempo, paid when the work is accepted.` }
    : { title: 'Hire link' };
}

const span = (seconds: number) => (seconds % 86_400 === 0 ? `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}` : `${Math.round(seconds / 3_600)} hours`);

/// A seller's offer, opened from its link. Nothing here is stored or signed: the
/// buyer reviews it, then opens the job in the dashboard with the offer prefilled.
export default async function HirePage({ params, searchParams }: { params: Promise<{ seller: string }>; searchParams: Promise<{ o?: string }> }) {
  const { seller } = await params;
  const raw = (await searchParams).o;
  const offer = decodeOffer(raw);
  if (!offer || offer.seller.toLowerCase() !== seller.toLowerCase()) notFound();
  const record = await getReputation(offer.seller).catch(() => null);
  const rep = record?.data;
  const command = agentCommand(offer);

  return (
    <div className="wrap pt-10 pb-24">
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-8">
          <div className="flex flex-col gap-4">
            <p className="label text-bolt">Offer · {shortHash(offer.seller, 8, 6)}</p>
            <h1 className="display text-[clamp(36px,4.6vw,64px)]">{offer.title}</h1>
            <p className="lede whitespace-pre-wrap">{offer.spec}</p>
          </div>

          <section className="panel flex flex-col gap-4 p-6">
            <p className="label">What counts as done</p>
            <ol className="flex flex-col gap-px border hairline bg-line">
              {offer.criteria.map((criterion, index) => (
                <li key={index} className="flex items-start gap-4 bg-ink-2 px-4 py-3">
                  <span className="font-mono text-[11px] text-fg-3">c{index + 1}</span>
                  <span className="flex-1 text-[14px]">{criterion.text}</span>
                  <span className={`chip ${criterion.kind === 'judgement' ? '' : 'chip-ref'}`}>
                    {criterion.kind === 'judgement' ? 'judgement' : `check · ${criterion.kind}${criterion.value ? ` ${criterion.value}` : ''}`}
                  </span>
                </li>
              ))}
            </ol>
            <p className="text-[12.5px] text-fg-3">A checked criterion is decided by code. A judgement criterion goes to the referee only if you dispute, and its ruling cannot leave the range your offer and the seller&rsquo;s ask allow.</p>
          </section>

          <section className="panel-sunk flex flex-col gap-3 p-6">
            <p className="label text-ref">For an agent</p>
            <p className="text-[13.5px] text-fg-2">An agent with a Tempex key opens this job from the command line, with its terms filed, inside the budget its owner set:</p>
            <pre className="code whitespace-pre-wrap text-[12px]">{command}</pre>
            {offer.criteria.some((c) => c.kind !== 'judgement') ? (
              <p className="text-[12px] text-fg-3">From the command line every criterion is a judgement criterion. To keep the checks, pass the terms as JSON with <span className="font-mono">--terms-file</span>.</p>
            ) : null}
            <CopyButton value={command} label="Copy the agent command">
              <span className="btn px-3 py-1.5 text-[12px]">Copy command</span>
            </CopyButton>
          </section>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-20">
          <section className="panel flex flex-col gap-4 p-6">
            <p className="label text-ref">Hire</p>
            <p className="font-mono text-[34px] font-light num">{offer.amount} <span className="text-[16px] text-fg-3">αUSD</span></p>
            <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-[13.5px]">
              <dt className="text-fg-2">Delivered within</dt>
              <dd className="font-mono">{span(offer.deliverySeconds)}</dd>
              <dt className="text-fg-2">You review within</dt>
              <dd className="font-mono">{span(offer.reviewSeconds)}</dd>
              <dt className="text-fg-2">Held until</dt>
              <dd className="font-mono">you accept</dd>
            </dl>
            <Link className="btn btn-ref justify-center" href={`/dashboard/new?o=${raw}`}>
              Review and fund with passkey
            </Link>
            <p className="text-[12px] leading-relaxed text-fg-3">The money sits in the Tempex escrow on Tempo, not with the seller. Nothing is delivered by the deadline: you take it back. You dispute: a bounded referee rules.</p>
          </section>
          <section className="panel-sunk flex flex-col gap-2 p-5 text-[13px]">
            <p className="label">Seller&rsquo;s record</p>
            {rep ? (
              <>
                <p className="font-mono">
                  score <span className="text-ref">{rep.score}</span> · {rep.band}
                </p>
                <p className="text-fg-3">
                  {rep.asSeller.jobs} jobs as seller · {rep.asSeller.accepted} accepted · {rep.asSeller.disputed} disputed{rep.asSeller.avgAwardBps !== null ? ` · ${pct(rep.asSeller.avgAwardBps)} average award` : ''}
                </p>
              </>
            ) : (
              <p className="text-fg-3">No settled jobs yet. Escrow is what protects you here.</p>
            )}
            <Link className="link w-fit font-mono text-[12px]" href={`/reputation/${offer.seller}`}>
              full record ↗
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
