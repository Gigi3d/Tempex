import Link from 'next/link';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';

import { CopyButton } from '@/components/copy';
import { RulingGauge } from '@/components/gauge';
import { CriterionScorecard } from '@/components/scorecard';
import { ReceiptCard } from '@/components/receipt';
import { StageTimeline } from '@/components/timeline';
import { ArrowUpRight, Chip, Eyebrow, Notice, SourceChip } from '@/components/ui';
import { beaconUrl, getProof, NotFound } from '@/lib/beacon';
import { pct } from '@/lib/format';
import { snapshot } from '@/lib/snapshot';

export const revalidate = 60;

function site(): string {
  return process.env['NEXT_PUBLIC_SITE_URL'] ?? (process.env['VERCEL_PROJECT_PRODUCTION_URL'] ? `https://${process.env['VERCEL_PROJECT_PRODUCTION_URL']}` : 'http://localhost:3000');
}

function adjudicationFor(id: string) {
  return String(snapshot.receipt.session.jobId) === id ? snapshot.receipt.adjudication : null;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { data } = await getProof(id);
    const award = data.job.verdict?.sellerAwardBps;
    const title = award !== undefined ? `Tempex ruled job ${id}: ${pct(award)} to the seller` : `Job ${id}: no ruling yet`;
    return { title, description: 'A signed ruling, settled on Tempo. Verify it yourself.', openGraph: { title }, twitter: { title } };
  } catch {
    return { title: `Receipt ${id}` };
  }
}

export default async function ProofPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  let result;
  try {
    result = await getProof(id);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    throw error;
  }
  const proof = result.data;
  const job = proof.job;
  const adjudication = adjudicationFor(id);
  const url = `${site()}/proof/${id}`;
  const qr = await QRCode.toString(url, { type: 'svg', margin: 0, color: { dark: '#f1f1ee', light: '#00000000' } });
  const offers =
    job.dispute && job.response
      ? { lowBps: Math.min(job.dispute.buyerOfferBps, job.response.sellerAskBps), highBps: Math.max(job.dispute.buyerOfferBps, job.response.sellerAskBps) }
      : null;

  if (!job.verdict) {
    return (
      <div className="wrap pt-16">
        <Eyebrow>Receipt · job {id}</Eyebrow>
        <h1 className="display mt-4 text-[clamp(40px,5vw,64px)]">No ruling yet.</h1>
        <p className="lede mt-4">
          This job is {job.stage}. A receipt appears here once an arbiter’s verdict is relayed on chain. Until then, follow it in the explorer.
        </p>
        <div className="mt-10">
          <StageTimeline job={job} />
        </div>
        <Link href={`/explorer/${id}`} className="btn btn-primary mt-8">
          Follow job {id} <ArrowUpRight />
        </Link>
      </div>
    );
  }

  const engine = adjudication?.engine === 'rules' ? 'its rules engine' : adjudication ? 'a judge panel' : 'its arbiter';
  const tweet = `Tempex ruled this agent dispute: ${pct(job.verdict.sellerAwardBps)} to the seller, bounded by the evidence and settled on Tempo. Verify it yourself:`;

  return (
    <div className="wrap pt-16">
      <div className="grid gap-12 lg:grid-cols-[1.25fr_1fr]">
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2">
            <Eyebrow>Receipt · job {id}</Eyebrow>
            <SourceChip source={result.source} asOf={result.asOf} />
          </div>
          <h1 className="display text-[clamp(44px,6vw,84px)]">
            {pct(job.verdict.sellerAwardBps)} to the seller.
          </h1>
          <p className="lede">
            Tempex ruled this dispute with {engine}. The escrow checked the arbiter’s signature, paid both sides, and every step
            below is a transaction you can open.
          </p>
          <div className="flex flex-wrap gap-2">
            <Chip tone="ref">✓ settled on chain</Chip>
            {adjudication ? <Chip>{adjudication.engine === 'rules' ? 'rules engine · ' + adjudication.model : 'judge panel · ' + adjudication.model}</Chip> : null}
            {adjudication && !adjudication.clamped ? <Chip>guardrail: not needed</Chip> : adjudication ? <Chip tone="pip">guardrail: clamped</Chip> : null}
          </div>
        </div>
        <div className="panel flex items-center gap-6 p-6">
          <div className="h-28 w-28 shrink-0" dangerouslySetInnerHTML={{ __html: qr }} aria-label={`QR code for ${url}`} role="img" />
          <div className="flex min-w-0 flex-col gap-3">
            <p className="label">Share this receipt</p>
            <p className="font-mono text-[12.5px] text-fg-2 break-all">{url}</p>
            <div className="flex flex-wrap gap-2">
              <CopyButton value={url} label="Copy link">
                <span className="chip">Copy link</span>
              </CopyButton>
              <a className="chip hover:border-ref" href={`https://x.com/intent/post?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">
                Post on X ↗
              </a>
              <a className="chip hover:border-ref" href={`/proof/${id}/opengraph-image`} target="_blank" rel="noreferrer">
                Card image ↗
              </a>
            </div>
          </div>
        </div>
      </div>

      <section className="mt-14 panel p-6">
        <RulingGauge
          ruleBand={adjudication ? { lowBps: adjudication.band.lowBps, highBps: adjudication.band.highBps } : null}
          offers={offers}
          awardBps={job.verdict.sellerAwardBps}
        />
        {!adjudication ? <p className="mt-2 text-[13px] text-fg-3">The rule band for this job lives in the arbiter’s evidence, which was not published with it.</p> : null}
      </section>

      {adjudication ? (
        <section className="mt-14 flex flex-col gap-5">
          <Eyebrow tone="ref">How Ref scored it</Eyebrow>
          <CriterionScorecard
            rows={adjudication.signals.criteria}
            totals={{
              total: adjudication.signals.totalWeight,
              checked: adjudication.signals.checkedWeight,
              earned: adjudication.signals.earnedWeight,
              open: adjudication.signals.openWeight,
            }}
          />
          <details className="panel p-5">
            <summary className="cursor-pointer text-[14px]">Read the signed rationale</summary>
            <p className="mt-4 max-w-[80ch] font-mono text-[12.5px] leading-relaxed text-fg-2">{adjudication.ruling.rationale}</p>
          </details>
        </section>
      ) : null}

      <section className="mt-14 grid gap-10 lg:grid-cols-[1.2fr_1fr]">
        <div className="flex flex-col gap-4">
          <Eyebrow>The receipt</Eyebrow>
          <ReceiptCard job={job} adjudication={adjudication} beaconUrl={beaconUrl()} />
        </div>
        <div className="flex flex-col gap-4">
          <Eyebrow>Re-derive it from the chain</Eyebrow>
          <ol className="flex flex-col gap-3 text-[14px] text-fg-2">
            {proof.replay.map((step, index) => (
              <li key={index} className="flex gap-3">
                <span className="font-mono text-fg-3">{String(index + 1).padStart(2, '0')}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <Notice tone="ref">The beacon only reads the chain. If it disappeared tomorrow, these steps and a public RPC still reproduce this page.</Notice>
        </div>
      </section>

      <section className="mt-14 flex flex-col gap-4">
        <Eyebrow>Lifecycle</Eyebrow>
        <StageTimeline job={job} />
      </section>
    </div>
  );
}
