import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Chip, Eyebrow, Hash, SourceChip } from '@/components/ui';
import { getReputation, NotFound } from '@/lib/beacon';

export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ addr: string }> }) {
  const { addr } = await params;
  return { title: `Reputation ${addr.slice(0, 8)}…` };
}

const BAND_TONE = { unproven: 'plain', active: 'bolt', settled: 'ref', trusted: 'ref', contested: 'fail' } as const;

export default async function ReputationPage({ params }: { params: Promise<{ addr: string }> }) {
  const { addr } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) notFound();
  let result;
  try {
    result = await getReputation(addr);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    throw error;
  }
  const r = result.data;
  return (
    <div className="wrap pt-16">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex flex-col gap-4">
          <Eyebrow>Reputation dossier</Eyebrow>
          <Hash value={r.address} kind="address" head={12} tail={10} />
          <div className="flex items-end gap-4">
            <p className="font-mono text-[88px] font-light leading-none tracking-tight num">{r.score}</p>
            <div className="mb-3 flex flex-col gap-2">
              <Chip tone={BAND_TONE[r.band]}>{r.band}</Chip>
              <span className="text-[13px] text-fg-3">out of 1000</span>
            </div>
          </div>
        </div>
        <SourceChip source={result.source} asOf={result.asOf} />
      </div>

      <section className="mt-12 grid gap-10 lg:grid-cols-[1.3fr_1fr]">
        <div className="flex flex-col gap-4">
          <Eyebrow>Every point, itemised</Eyebrow>
          <div className="border hairline">
            {r.factors.map((factor) => (
              <div key={factor.label} className="flex items-start justify-between gap-6 border-b hairline px-5 py-4 last:border-b-0">
                <div>
                  <p className="font-mono text-[13px]">{factor.label}</p>
                  <p className="mt-1 text-[13px] text-fg-3">{factor.detail}</p>
                </div>
                <p className={`font-mono text-[18px] num ${factor.points > 0 ? 'text-ref' : factor.points < 0 ? 'text-fail' : ''}`}>
                  {factor.points > 0 ? '+' : ''}
                  {factor.points}
                </p>
              </div>
            ))}
            <div className="flex justify-between bg-panel px-5 py-4 font-mono">
              <span>score (clamped sum)</span>
              <span className="num">{r.score}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-2 gap-px border hairline bg-line">
            <div className="bg-ink-2 p-5">
              <p className="label text-pip">As buyer</p>
              <p className="mt-2 font-mono text-[22px] num">{r.asBuyer.jobs} jobs</p>
              <p className="text-[12.5px] text-fg-3">{r.asBuyer.escrowed.value} escrowed · {r.asBuyer.disputed} disputed</p>
            </div>
            <div className="bg-ink-2 p-5">
              <p className="label text-bolt">As seller</p>
              <p className="mt-2 font-mono text-[22px] num">{r.asSeller.jobs} jobs</p>
              <p className="text-[12.5px] text-fg-3">{r.asSeller.earned.value} earned · avg award {r.asSeller.avgAwardBps ?? '—'}</p>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <Eyebrow>Recompute it yourself</Eyebrow>
            <ol className="flex flex-col gap-2 text-[14px] text-fg-2">
              {r.recipe.map((step, index) => (
                <li key={index} className="flex gap-3">
                  <span className="font-mono text-fg-3">{String(index + 1).padStart(2, '0')}</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
          <div className="flex flex-wrap gap-2">
            {r.proofJobIds.map((id) => (
              <Link key={id} href={`/explorer/${id}`} className="chip hover:border-ref">
                job {id}
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
