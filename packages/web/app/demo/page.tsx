import QRCode from 'qrcode';

import { DemoTheater } from '@/components/demo-theater';
import { RulingGauge } from '@/components/gauge';
import { ReceiptCard } from '@/components/receipt';
import { CriterionScorecard } from '@/components/scorecard';
import { beaconUrl } from '@/lib/beacon';
import { snapshot } from '@/lib/snapshot';

export const metadata = { title: 'Demo Theater', description: 'A real dispute on Tempo, ruled and settled, in three minutes.' };

function site(): string {
  return process.env['NEXT_PUBLIC_SITE_URL'] ?? (process.env['VERCEL_PROJECT_PRODUCTION_URL'] ? `https://${process.env['VERCEL_PROJECT_PRODUCTION_URL']}` : 'http://localhost:3000');
}

/// Replay mode runs entirely on the baked snapshot, so the demo survives venue wifi.
export default async function DemoPage() {
  const receipt = snapshot.receipt;
  const jobId = String(receipt.session.jobId);
  const job = snapshot.beacon?.detail[jobId];
  if (!job) throw new Error(`The snapshot has no job ${jobId}; run pnpm --filter @tempex/web bake with the beacon up.`);
  const a = receipt.adjudication;
  const proofUrl = `${site()}/proof/${jobId}`;
  const qr = await QRCode.toString(proofUrl, { type: 'svg', margin: 0, color: { dark: '#f1f1ee', light: '#00000000' } });
  const drill = snapshot.corpus.find((entry) => entry.id === receipt.scenario)?.drill.map((row) => row.requested) ?? [];

  return (
    <div className="wrap pt-10">
      <div className="mb-8 flex flex-wrap items-baseline justify-between gap-4">
        <p className="label">Tempex Court · Demo Theater</p>
        <p className="text-[13px] text-fg-3">A real dispute, job {jobId} on Moderato, replayed from its receipt. Works offline.</p>
      </div>
      <DemoTheater
        job={job}
        adjudication={a}
        title={receipt.title}
        brief={String(receipt.evidence.terms.deliverableSpec ?? '')}
        claim={String(receipt.evidence.bundle.claim ?? '')}
        response={String(receipt.evidence.response.statement ?? '')}
        deliverable={String(receipt.evidence.bundle.deliverable?.content ?? a.signals.deliverableText ?? '')}
        scorecard={
          <CriterionScorecard
            animate
            rows={a.signals.criteria}
            totals={{ total: a.signals.totalWeight, checked: a.signals.checkedWeight, earned: a.signals.earnedWeight, open: a.signals.openWeight }}
          />
        }
        gauge={<RulingGauge ruleBand={{ lowBps: a.band.lowBps, highBps: a.band.highBps }} offers={a.offers} awardBps={a.ruling.sellerAwardBps} />}
        receipt={<ReceiptCard job={job} adjudication={a} beaconUrl={beaconUrl()} />}
        qr={qr}
        proofUrl={proofUrl}
        drill={[...new Set([...drill, a.ruling.sellerAwardBps])].sort((x, y) => x - y)}
      />
    </div>
  );
}
