import { withinOffers } from '@tempex/arbiter/guardrail';

type Range = { lowBps: number; highBps: number };

export type RulingGaugeProps = {
  /// What the evidence justifies: the rule band.
  ruleBand?: Range | null;
  /// What the parties offered: awardBounds(job). Omit when there was no dispute.
  offers?: Range | null;
  /// The award the arbiter signed. Omit while pending.
  awardBps?: number | null;
  size?: 'full' | 'compact';
  animate?: boolean;
};

const W = 720;
const LEFT = 128;
const RIGHT = 704;
const x = (bps: number): number => LEFT + (Math.max(0, Math.min(10_000, bps)) / 10_000) * (RIGHT - LEFT);

/// The whole protocol in one picture: evidence bounds the judge, the parties'
/// final offers bound it harder, and the ruling lands inside both.
export function RulingGauge({ ruleBand, offers, awardBps, size = 'full', animate = true }: RulingGaugeProps) {
  const effective = ruleBand && offers ? withinOffers({ ...ruleBand, center: (ruleBand.lowBps + ruleBand.highBps) / 2 }, offers) : ruleBand ?? null;
  const summary = [
    ruleBand ? `rule band ${ruleBand.lowBps} to ${ruleBand.highBps} bps` : 'no rule band yet',
    offers ? `final offers ${offers.lowBps} to ${offers.highBps}` : 'no dispute, full range',
    effective ? `effective band ${effective.lowBps} to ${effective.highBps}` : null,
    awardBps != null ? `award ${awardBps} bps` : 'awaiting a ruling',
  ]
    .filter(Boolean)
    .join(', ');

  if (size === 'compact') {
    return (
      <svg viewBox="0 0 240 28" className="w-full max-w-[240px]" role="img" aria-label={summary}>
        <rect x="0" y="10" width="240" height="8" fill="#1b1b1e" />
        {effective ? <rect x={(effective.lowBps / 10_000) * 240} y="10" width={Math.max(2, ((effective.highBps - effective.lowBps) / 10_000) * 240)} height="8" fill="#4be3a6" /> : null}
        {awardBps != null ? <rect x={(awardBps / 10_000) * 240 - 1} y="3" width="2" height="22" fill="#f1f1ee" /> : null}
      </svg>
    );
  }

  const rows: { label: string; y: number; range: Range | null | undefined; kind: 'band' | 'offers' | 'effective' }[] = [
    { label: 'rule band', y: 30, range: ruleBand, kind: 'band' },
    { label: 'final offers', y: 70, range: offers, kind: 'offers' },
    { label: 'effective band', y: 110, range: effective, kind: 'effective' },
  ];
  const anim = (delay: number) => (animate ? { className: 'anim-grow', style: { animationDelay: `${delay}ms`, transformBox: 'fill-box' as const } } : {});

  return (
    <figure className="w-full">
      <svg viewBox={`0 0 ${W} 200`} className="w-full" role="img" aria-label={summary}>
        {[0, 2500, 5000, 7500, 10_000].map((tick) => (
          <g key={tick}>
            <line x1={x(tick)} x2={x(tick)} y1={16} y2={160} stroke="#242427" />
            <text x={x(tick)} y={184} textAnchor={tick === 10_000 ? 'end' : tick === 0 ? 'start' : 'middle'} fontFamily="Geist Mono, monospace" fontSize="11" fill="#7d7d78">
              {tick === 10_000 ? '10000 bps' : tick}
            </text>
          </g>
        ))}
        {rows.map((row, i) => (
          <g key={row.label}>
            <text x={0} y={row.y + 11} fontFamily="Geist Mono, monospace" fontSize="11" fill="#7d7d78" letterSpacing="0.06em">
              {row.label.toUpperCase()}
            </text>
            <rect x={LEFT} y={row.y} width={RIGHT - LEFT} height={14} fill="#18181a" />
            {row.range ? (
              row.kind === 'offers' ? (
                <rect {...anim(i * 220)} x={x(row.range.lowBps)} y={row.y - 3} width={Math.max(2, x(row.range.highBps) - x(row.range.lowBps))} height={20} fill="none" stroke="#f7c548" strokeWidth={1.5} strokeDasharray="5 4" />
              ) : (
                <rect {...anim(i * 220)} x={x(row.range.lowBps)} y={row.y} width={Math.max(2, x(row.range.highBps) - x(row.range.lowBps))} height={14} fill={row.kind === 'effective' ? '#4be3a6' : '#1d4a39'} />
              )
            ) : (
              <text x={LEFT + 8} y={row.y + 11} fontFamily="Geist Mono, monospace" fontSize="10.5" fill="#55554f">
                {row.kind === 'offers' ? 'no dispute: full range 0–10000' : 'not derived yet'}
              </text>
            )}
            {row.range ? (
              <text x={Math.min(x(row.range.highBps) + 10, RIGHT - 70)} y={row.y + 11} fontFamily="Geist Mono, monospace" fontSize="11" fill="#b3b3ae">
                {row.range.lowBps}–{row.range.highBps}
              </text>
            ) : null}
          </g>
        ))}
        {awardBps != null ? (
          <g className={animate ? 'anim-drop' : undefined} style={animate ? { animationDelay: '700ms' } : undefined}>
            <line x1={x(awardBps)} x2={x(awardBps)} y1={20} y2={152} stroke="#f1f1ee" strokeWidth={2} />
            <path d={`M${x(awardBps) - 7} 140 L${x(awardBps) + 7} 140 L${x(awardBps)} 152 Z`} fill="#f1f1ee" />
            <text x={0} y={151} fontFamily="Geist Mono, monospace" fontSize="11" fill="#7d7d78" letterSpacing="0.06em">
              AWARD
            </text>
            <text x={Math.min(x(awardBps) + 12, RIGHT - 150)} y={151} fontFamily="Geist Mono, monospace" fontSize="12" fill="#f1f1ee">
              {awardBps} bps · {(awardBps / 100).toFixed(1)}% to seller
            </text>
          </g>
        ) : (
          <text x={0} y={151} fontFamily="Geist Mono, monospace" fontSize="11" fill="#7d7d78">
            AWARD · awaiting a ruling
          </text>
        )}
      </svg>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}
