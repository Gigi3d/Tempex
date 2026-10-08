'use client';

import { useEffect, useState } from 'react';

import { STAGE_LABEL, shortHash, stageTone, until, utc } from '@/lib/format';
import type { AgentKey, Signer } from '@/lib/types';

import { KeyGlyph, ROLE_TONE } from '../agents/kit';

/// Pieces every dashboard view shares: who signed, how long is left, which stage.

export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function StageChip({ stage, responded }: { stage: string; responded?: boolean }) {
  const label = stage === 'disputed' && responded ? 'Answered' : (STAGE_LABEL[stage] ?? stage);
  const tone = stageTone(stage);
  return <span className={`chip ${tone === 'plain' ? '' : `chip-${tone}`}`}>{label}</span>;
}

export function SideChip({ side }: { side: 'buyer' | 'seller' | null }) {
  if (!side) return <span className="chip">observer</span>;
  return <span className={`chip ${side === 'buyer' ? 'chip-pip' : 'chip-bolt'}`}>{side === 'buyer' ? 'buying' : 'selling'}</span>;
}

/// A deadline as a live countdown, red inside the last day.
export function Countdown({ at, now, prefix }: { at: number | null; now: number; prefix?: string }) {
  if (at === null) return <span className="font-mono text-[12px] text-fg-3">no deadline</span>;
  const left = at - now;
  const tone = left <= 0 ? 'text-fg-3' : left <= 86_400 ? 'text-fail' : left <= 3 * 86_400 ? 'text-pip' : 'text-fg-2';
  return (
    <span className={`font-mono text-[12px] num ${tone}`} title={utc(at)}>
      {prefix ? `${prefix} ` : ''}
      {left <= 0 ? 'passed' : `${until(at, now)} left`}
    </span>
  );
}

/// Who signed a step: the owner's own passkey, one of its agents (named, with its
/// glyph), or a third party such as a keeper or the arbiter's relayer.
export function SignerBadge({ signer, me, agents, compact = false }: { signer: Signer | null; me: string | null; agents: Map<string, AgentKey>; compact?: boolean }) {
  if (!signer) return <span className="font-mono text-[11px] text-fg-3">reading signature…</span>;
  const mine = me !== null && signer.account.toLowerCase() === me.toLowerCase();
  if (mine && signer.kind === 'access-key' && signer.keyId) {
    const agent = agents.get(signer.keyId.toLowerCase());
    return (
      <span className="inline-flex min-w-0 items-center gap-2" title={`Signed by access key ${signer.keyId}`}>
        <KeyGlyph keyId={signer.keyId} role={agent?.role ?? null} size={compact ? 18 : 22} />
        <span className="min-w-0 truncate text-[13px]">
          <span className="text-fg">{agent?.name ?? shortHash(signer.keyId, 6, 4)}</span>
          {!compact ? <span className={`ml-1.5 label ${agent?.role ? ROLE_TONE[agent.role].text : ''}`}>agent</span> : null}
        </span>
      </span>
    );
  }
  if (mine) {
    return (
      <span className="inline-flex items-center gap-2" title={`Signed by the account's own key (${signer.signatureType})`}>
        <span className="grid h-[22px] w-[22px] place-items-center border border-ref-dim bg-ink-2 font-mono text-[8.5px] text-ref" aria-hidden>
          YOU
        </span>
        {!compact ? <span className="text-[13px] text-fg-2">you · {signer.signatureType === 'webAuthn' ? 'passkey' : signer.signatureType}</span> : null}
      </span>
    );
  }
  if (signer.kind === 'access-key' && signer.keyId) {
    return (
      <span className="inline-flex min-w-0 items-center gap-2" title={`Access key ${signer.keyId}, acting for ${signer.account}`}>
        <KeyGlyph keyId={signer.keyId} role={null} size={compact ? 18 : 22} />
        {!compact ? (
          <span className="truncate text-[13px] text-fg-2">
            agent of <span className="font-mono text-[12px]">{shortHash(signer.account)}</span>
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2" title={`Signed by ${signer.account}`}>
      <span className="grid h-[22px] w-[22px] place-items-center border border-line-2 bg-ink-2 font-mono text-[9px] text-fg-3" aria-hidden>
        ↗
      </span>
      {!compact ? <span className="font-mono text-[12px] text-fg-3">{shortHash(signer.account)}</span> : null}
    </span>
  );
}

/// The "an agent did this" marker: a thin rail in the agent's role color.
export function AgentRail({ role }: { role: AgentKey['role'] }) {
  const fill = ROLE_TONE[role ?? 'both'].fill;
  return <span aria-hidden className="absolute inset-y-0 left-0 w-[2px]" style={{ background: fill }} />;
}

export function BusyLine({ busy, error }: { busy: string | null; error: string | null }) {
  return (
    <>
      {busy ? (
        <p aria-live="polite" className="label anim-pulse text-ref">
          {busy}…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="border border-fail-dim px-4 py-3 font-mono text-[12.5px] text-fail">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 border border-dashed border-line-2 bg-ink-2 px-6 py-8">
      <p className="text-[16px]">{title}</p>
      {children ? <div className="text-[14px] text-fg-3">{children}</div> : null}
    </div>
  );
}
