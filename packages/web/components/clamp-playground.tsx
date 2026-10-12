'use client';

import { useMemo, useState } from 'react';

import { clampToBand, withinOffers } from '@tempex/arbiter/guardrail';
import { disputeSettlement } from '@tempex/sdk/browser';

import { amount } from '@/lib/format';

const MIN = -2000;
const MAX = 12_000;
const LEFT = 16;
const RIGHT = 704;
const x = (bps: number) => LEFT + ((Math.max(MIN, Math.min(MAX, bps)) - MIN) / (MAX - MIN)) * (RIGHT - LEFT);

export type ClampPlaygroundProps = {
  band: { lowBps: number; highBps: number };
  offers: { lowBps: number; highBps: number };
  amountUnits: string;
  arbitrationFeeBps: number;
  /// The scripted award proposals from the corpus drill, plus the signed award.
  presets: number[];
  signedBps?: number;
  initial?: number;
};

/// Play a corrupt arbiter with the slider. Whatever it proposes runs through the real
/// clampToBand and withinOffers, and the payout through the real disputeSettlement.
export function ClampPlayground({ band, offers, amountUnits, arbitrationFeeBps, presets, signedBps, initial }: ClampPlaygroundProps) {
  const effective = useMemo(() => withinOffers({ ...band, center: (band.lowBps + band.highBps) / 2 }, offers), [band, offers]);
  const [requested, setRequested] = useState(initial ?? effective.lowBps);
  const { bps, clamped } = clampToBand(requested, effective);
  const outsideOffers = requested < offers.lowBps || requested > offers.highBps;
  const money = disputeSettlement({ amount: BigInt(amountUnits), arbitrationFeeBps, sellerAwardBps: bps });
  const [tries, setTries] = useState(0);

  const set = (value: number) => {
    setRequested(value);
    setTries((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-5">
      <svg viewBox="0 0 720 112" className="w-full" role="img" aria-label={`Proposed ${requested} bps; settles at ${bps} bps`}>
        {[MIN, 0, 5000, 10_000, MAX].map((tick) => (
          <g key={tick}>
            <line x1={x(tick)} x2={x(tick)} y1={10} y2={82} stroke={tick === 0 || tick === 10_000 ? '#303034' : '#1f1f22'} />
            <text x={x(tick)} y={100} textAnchor={tick === MIN ? 'start' : tick === MAX ? 'end' : 'middle'} fontFamily="Geist Mono, monospace" fontSize="10.5" fill="#7d7d78">
              {tick === MAX ? '12000 bps' : tick}
            </text>
          </g>
        ))}
        <rect x={LEFT} y={40} width={RIGHT - LEFT} height={16} fill="#18181a" />
        <rect x={x(offers.lowBps)} y={33} width={x(offers.highBps) - x(offers.lowBps)} height={30} fill="none" stroke="#f7c548" strokeDasharray="5 4" strokeWidth={1.5} />
        <rect x={x(effective.lowBps)} y={40} width={Math.max(2, x(effective.highBps) - x(effective.lowBps))} height={16} fill="#4be3a6" />
        <line x1={x(requested)} x2={x(requested)} y1={14} y2={78} stroke="#f1f1ee" strokeDasharray="3 3" strokeWidth={1.5} />
        <circle cx={x(requested)} cy={14} r={5} fill="#f1f1ee" />
        <line x1={x(bps)} x2={x(bps)} y1={28} y2={68} stroke="#f1f1ee" strokeWidth={3} />
      </svg>

      <div>
        <label htmlFor="clamp-range" className="label">
          A corrupt arbiter proposes
        </label>
        <input
          id="clamp-range"
          type="range"
          min={MIN}
          max={MAX}
          step={50}
          value={Math.max(MIN, Math.min(MAX, requested))}
          onChange={(event) => set(Number(event.target.value))}
          className="mt-3 w-full accent-[#4be3a6]"
          aria-valuetext={`${requested} bps`}
        />
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Scripted award proposals from the corpus">
          {presets.map((preset) => (
            <button key={preset} type="button" onClick={() => set(preset)} className="chip hover:border-ref hover:text-fg">
              {preset}
              {preset === signedBps ? ' · signed' : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-px border hairline bg-line [grid-template-columns:repeat(auto-fit,minmax(128px,1fr))]">
        {[
          ['proposed', `${requested}`],
          ['effective band', `${effective.lowBps}–${effective.highBps}`],
          ['settles at', `${bps}`],
          ['seller gets', amount(money.sellerAmount, 'ledger')],
          ['buyer gets', amount(money.buyerAmount, 'ledger')],
        ].map(([label, value]) => (
          <div key={label} className="bg-ink-2 p-3">
            <p className="label">{label}</p>
            <p className={`mt-1 font-mono text-[18px] num ${label === 'settles at' ? 'text-ref' : ''}`}>{value}</p>
          </div>
        ))}
      </div>

      <div aria-live="polite" className={`relative border px-4 py-3 font-mono text-[13px] ${clamped ? 'border-pip-dim text-pip' : 'border-ref-dim text-ref'}`}>
        {clamped ? (
          <>
            <span key={tries} className="anim-stamp mr-3 inline-block border-2 border-pip px-2 text-[11px] font-bold tracking-[0.14em]">
              CLAMPED
            </span>
            Pulled to {bps} bps. The guardrail held.
            {outsideOffers ? ` The contract would also revert a verdict at ${requested}: it is outside both parties’ offers (${offers.lowBps}–${offers.highBps}).` : ''}
          </>
        ) : (
          <>✓ Inside the band. The ruling stands as proposed.</>
        )}
      </div>
    </div>
  );
}
