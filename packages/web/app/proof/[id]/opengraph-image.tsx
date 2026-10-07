import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ImageResponse } from 'next/og';

import { getProof } from '@/lib/beacon';
import { snapshot } from '@/lib/snapshot';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'A Tempex ruling, settled on Tempo';

const fonts = join(process.cwd(), 'app/fonts');

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [light, medium, mark, mono] = await Promise.all([
    readFile(join(fonts, 'Geist-Light.ttf')),
    readFile(join(fonts, 'Geist-Medium.ttf')),
    readFile(join(fonts, 'Geist-ExtraBoldItalic.ttf')),
    readFile(join(fonts, 'GeistMono-Medium.ttf')),
  ]);
  let award: number | null = null;
  try {
    award = (await getProof(id)).data.job.verdict?.sellerAwardBps ?? null;
  } catch {
    award = null;
  }
  const adjudication = String(snapshot.receipt.session.jobId) === id ? snapshot.receipt.adjudication : null;
  const engine = adjudication ? (adjudication.engine === 'rules' ? `rules engine · ${adjudication.model}` : `judge panel · ${adjudication.model}`) : 'signed arbiter';
  const band = adjudication?.boundedBand;
  const scale = (bps: number) => Math.round((bps / 10_000) * 1040);

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0c0c0d', color: '#f1f1ee', padding: 72, fontFamily: 'Geist' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 40, height: 40, background: '#4be3a6', color: '#0c0c0d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Geist Mark', fontSize: 30 }}>X</div>
            <div style={{ fontFamily: 'Geist Mark', fontSize: 34, letterSpacing: -1 }}>TEMPEX</div>
          </div>
          <div style={{ fontFamily: 'Geist Mono', fontSize: 20, color: '#7d7d78', border: '1px solid #303034', padding: '6px 14px' }}>{`receipt · job ${id} · chain 42431`}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 70 }}>
          <div style={{ fontSize: 34, color: '#b3b3ae', fontWeight: 300 }}>{award !== null ? 'Tempex ruled this agent dispute:' : 'This dispute has no ruling yet.'}</div>
          {award !== null ? <div style={{ fontSize: 104, fontWeight: 300, letterSpacing: -4, marginTop: 6 }}>{`${(award / 100).toFixed(1)}% to the seller.`}</div> : null}
        </div>
        <div style={{ display: 'flex', position: 'relative', width: 1040, height: 26, background: '#18181a', marginTop: 40 }}>
          {band ? <div style={{ position: 'absolute', left: scale(band.lowBps), width: Math.max(4, scale(band.highBps - band.lowBps)), top: 0, height: 26, background: '#4be3a6' }} /> : null}
          {award !== null ? <div style={{ position: 'absolute', left: scale(award) - 2, width: 4, top: -10, height: 46, background: '#f1f1ee' }} /> : null}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto', fontFamily: 'Geist Mono', fontSize: 22, color: '#7d7d78' }}>
          <div style={{ display: 'flex' }}>{`${engine} · settled on Tempo`}</div>
          <div style={{ display: 'flex', color: '#4be3a6' }}>Verify it yourself →</div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Geist', data: light, weight: 300, style: 'normal' },
        { name: 'Geist', data: medium, weight: 500, style: 'normal' },
        { name: 'Geist Mark', data: mark, weight: 800, style: 'italic' },
        { name: 'Geist Mono', data: mono, weight: 500, style: 'normal' },
      ],
    },
  );
}
