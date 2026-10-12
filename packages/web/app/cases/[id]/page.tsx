import Link from 'next/link';
import { notFound } from 'next/navigation';

import { tokenAmount } from '@tempex/sdk/browser';

import { ClampPlayground } from '@/components/clamp-playground';
import { RulingGauge } from '@/components/gauge';
import { CriterionScorecard } from '@/components/scorecard';
import { ArrowUpRight, Chip, Eyebrow, Notice } from '@/components/ui';
import { CASE_NOTES, caseById, criteriaWithChecks, liveJobFor } from '@/lib/cases';
import { snapshot } from '@/lib/snapshot';

export function generateStaticParams() {
  return snapshot.corpus.map((entry) => ({ id: entry.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const entry = caseById((await params).id);
  return entry ? { title: entry.title, description: entry.premise } : {};
}

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entry = caseById(id);
  if (!entry) notFound();
  const p = entry.prediction;
  const live = liveJobFor(entry.id);
  const offers =
    entry.offers.buyerOfferBps !== null && entry.offers.sellerAskBps !== null
      ? { lowBps: Math.min(entry.offers.buyerOfferBps, entry.offers.sellerAskBps), highBps: Math.max(entry.offers.buyerOfferBps, entry.offers.sellerAskBps) }
      : { lowBps: 0, highBps: 10_000 };
  const amountUnits = tokenAmount(String(entry.terms['amount'] ?? '25')).toString();

  return (
    <div className="wrap pt-14">
      <Link href="/cases" className="label hover:text-fg">
        ← All cases
      </Link>
      <div className="mt-6 flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Chip>{entry.id}</Chip>
          {p.ok ? <Chip tone="ref">✓ the build reproduced this band</Chip> : <Chip tone="fail">✕ prediction drifted</Chip>}
          {live ? (
            <Link href={`/proof/${live}`}>
              <Chip tone="bolt">live as job {live} ↗</Chip>
            </Link>
          ) : null}
        </div>
        <h1 className="display text-[clamp(36px,5vw,64px)]">{entry.title}</h1>
        <p className="lede">{entry.premise}</p>
        <p className="text-[15px] text-fg-2">{CASE_NOTES[entry.id]?.twist}</p>
      </div>

      <section className="mt-12 grid gap-px border hairline bg-line lg:grid-cols-2">
        <div className="flex flex-col gap-3 bg-ink-2 p-6">
          <Eyebrow tone="pip">Pip · the buyer’s claim</Eyebrow>
          <p className="text-[15px] leading-relaxed text-fg-2">{entry.claim}</p>
          <p className="label mt-4">The brief</p>
          <p className="text-[14px] text-fg-2">{String(entry.terms['deliverableSpec'] ?? '')}</p>
        </div>
        <div className="flex min-w-0 flex-col gap-3 bg-ink-2 p-6">
          <Eyebrow tone="bolt">Bolt · what was delivered</Eyebrow>
          <pre className="code max-h-[340px] overflow-auto text-[12px]">{entry.deliverable ?? '(nothing was delivered)'}</pre>
          {entry.response?.statement ? (
            <>
              <p className="label mt-2">Bolt’s response</p>
              <p className="text-[14px] text-fg-2">{entry.response.statement}</p>
            </>
          ) : null}
        </div>
      </section>

      <section className="mt-14 flex flex-col gap-6">
        <Eyebrow tone="ref">Ref · the scorecard</Eyebrow>
        <CriterionScorecard
          rows={criteriaWithChecks(entry)}
          totals={{ total: p.totalWeight, checked: p.totalWeight - p.openWeight, earned: p.earnedWeight, open: p.openWeight }}
        />
      </section>

      <section className="mt-14 panel p-6">
        <Eyebrow>The band</Eyebrow>
        <div className="mt-4">
          <RulingGauge ruleBand={{ lowBps: p.band[0], highBps: p.band[1] }} offers={offers} awardBps={p.rulingBps} />
        </div>
        <p className="mt-2 text-[14px] text-fg-2">
          The settlement rule signs the band’s centre: checks pay what they verified, unchecked weight splits at the midpoint, and
          the offers hold the result inside the effective band.
        </p>
      </section>

      <section className="mt-14 grid gap-8 lg:grid-cols-[1fr_1.2fr]">
        <div className="flex flex-col gap-4">
          <Eyebrow>The drill</Eyebrow>
          <p className="text-[15px] text-fg-2">Scripted award proposals from the corpus, run through the real clampToBand at build time: whatever any arbiter proposed, this is what could settle. The offers narrow the band again on chain.</p>
          <div className="overflow-x-auto border hairline">
            <table className="table">
              <thead>
                <tr>
                  <th>Proposed</th>
                  <th>Band clamps to</th>
                  <th>Guardrail</th>
                </tr>
              </thead>
              <tbody>
                {entry.drill.map((row) => (
                  <tr key={row.requested}>
                    <td className="font-mono num">{row.requested}</td>
                    <td className="font-mono num text-ref">{row.bps}</td>
                    <td>{row.clamped ? <Chip tone="pip">clamped</Chip> : <Chip tone="ref">stands</Chip>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel p-6">
          <Eyebrow>Try it yourself</Eyebrow>
          <div className="mt-4">
            <ClampPlayground
              band={{ lowBps: p.band[0], highBps: p.band[1] }}
              offers={offers}
              amountUnits={amountUnits}
              arbitrationFeeBps={200}
              presets={entry.drill.map((row) => row.requested)}
              initial={entry.drill[0]?.requested}
            />
          </div>
        </div>
      </section>

      {entry.id === 'echo' ? (
        <div className="mt-10">
          <Notice>
            Pasting the criteria back earns what nothing earns: the checks read the deliverable’s structure, not its vocabulary.
          </Notice>
        </div>
      ) : null}

      <div className="mt-12 flex flex-wrap gap-3">
        {live ? (
          <Link href={`/proof/${live}`} className="btn btn-primary">
            Open the live receipt <ArrowUpRight />
          </Link>
        ) : null}
        <Link href="/play" className="btn">
          Run this dispute yourself
        </Link>
      </div>
    </div>
  );
}
