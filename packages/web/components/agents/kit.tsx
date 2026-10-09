import type { AgentRole } from '@tempex/sdk/browser';

import { amount, shortHash, txUrl } from '@/lib/format';
import type { AgentKey } from '@/lib/types';

/// Shared pieces of the agent wallet pages. Pure: no hooks, so the public profile
/// renders them on the server and the console in the browser.

export const ROLE_TONE: Record<AgentRole, { text: string; fill: string; label: string }> = {
  buyer: { text: 'text-pip', fill: '#f7c548', label: 'buyer' },
  seller: { text: 'text-bolt', fill: '#6aa8ff', label: 'seller' },
  both: { text: 'text-ref', fill: '#4be3a6', label: 'buyer + seller' },
};

/// What each role's key may do, in plain words. Mirrors agentScopes in the SDK.
export const CAN: Record<AgentRole, string[]> = {
  buyer: ['open and fund jobs', 'accept deliveries', 'open disputes (posts a 5% bond)', 'raise the escrow\'s allowance, which is what its budget meters', 'withdraw credit to your account'],
  seller: ['deliver work', 'answer disputes', 'withdraw earnings to your account'],
  both: ['open, fund and accept jobs', 'deliver work and answer disputes', 'open disputes (posts a 5% bond)', 'raise the escrow\'s allowance, which is what its budget meters', 'withdraw to your account'],
};
export const CANNOT = ['send αUSD anywhere but the Tempex escrow', 'call any other contract', 'spend past its budget', 'outlive its expiry', 'survive a revoke'];

/// A deterministic glyph from the key id: every agent gets a recognizable face of
/// its own, so a list of keys reads as a list of agents.
export function KeyGlyph({ keyId, role, size = 44 }: { keyId: string; role: AgentRole | null; size?: number }) {
  const bits = BigInt(keyId);
  const fill = ROLE_TONE[role ?? 'both'].fill;
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      if ((bits >> BigInt(y * 3 + x)) & 1n) {
        cells.push({ x, y });
        if (x < 2) cells.push({ x: 4 - x, y });
      }
    }
  }
  return (
    <svg width={size} height={size} viewBox="-1 -1 7 7" role="img" aria-label={`glyph of ${keyId}`} className="shrink-0">
      <rect x="-1" y="-1" width="7" height="7" fill="#111113" stroke="#303034" strokeWidth="0.15" />
      {cells.map((cell) => (
        <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width="0.92" height="0.92" fill={fill} opacity={0.9} />
      ))}
    </svg>
  );
}

export function StatusChip({ agent }: { agent: Pick<AgentKey, 'revoked' | 'expired'> }) {
  if (agent.revoked) return <span className="chip chip-fail">revoked</span>;
  if (agent.expired) return <span className="chip chip-pip">expired</span>;
  return (
    <span className="chip chip-ref">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ref" aria-hidden /> live
    </span>
  );
}

const PERIOD_NAME: Record<number, string> = { 0: '', 86_400: 'day', 604_800: 'week', 2_592_000: 'month' };

/// Budget left against the budget granted. The keychain enforces `remaining`;
/// the total is what the owner granted, known when it was granted here.
export function BudgetMeter({ remaining, limit, period, periodEnd }: { remaining: string | null; limit: string | null; period: number | null; periodEnd: number | null }) {
  if (remaining === null) return <p className="font-mono text-[12px] text-fg-3">no budget to spend</p>;
  const left = BigInt(remaining);
  const total = limit && BigInt(limit) > 0n ? BigInt(limit) : null;
  const share = total ? Number((left * 1000n) / total) / 10 : null;
  const per = period ? PERIOD_NAME[period] : '';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between font-mono text-[12px]">
        <span className="text-fg">{amount(left)} αUSD left</span>
        <span className="text-fg-3">{total ? `of ${amount(total)}${per ? ` / ${per}` : ''}` : per ? `per ${per}` : ''}</span>
      </div>
      <div className="h-1.5 w-full bg-panel-2" aria-hidden>
        <div className="h-1.5 bg-ref transition-[width] duration-700" style={{ width: `${Math.max(0, Math.min(100, share ?? 100))}%` }} />
      </div>
      {periodEnd ? <p className="font-mono text-[11px] text-fg-3">resets {new Date(periodEnd * 1000).toLocaleString()}</p> : null}
    </div>
  );
}

export function expiryText(expiry: number, now = Date.now() / 1000, revoked = false): string {
  // Tempo zeroes a revoked key's expiry; it is not "never expires".
  if (revoked) return 'revoked';
  if (!expiry) return 'never expires';
  const left = expiry - now;
  if (left <= 0) return `expired ${new Date(expiry * 1000).toLocaleDateString()}`;
  const days = Math.floor(left / 86_400);
  const hours = Math.floor((left % 86_400) / 3_600);
  return days > 0 ? `${days}d ${hours}h left` : `${hours}h ${Math.floor((left % 3_600) / 60)}m left`;
}

export function AuthorizedLink({ tx }: { tx: string }) {
  return (
    <a className="link font-mono text-[11px] text-fg-3" href={txUrl(tx)} target="_blank" rel="noreferrer">
      authorized {shortHash(tx, 8, 4)} ↗
    </a>
  );
}
