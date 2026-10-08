'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { AGENT_PERIODS, tokenAmount, type AgentPeriod, type AgentRole } from '@tempex/sdk/browser';

import { amount, shortHash, txUrl } from '@/lib/format';
import * as owner from '@/lib/owner';
import type { AgentPairing } from '@/lib/types';

import { JsonDisclosure } from '../json-view';
import { CAN, CANNOT, KeyGlyph, ROLE_TONE } from './kit';
import { OwnerBar } from './owner-bar';
import { useOwner } from './use-owner';

const PERIOD_OF: Record<number, AgentPeriod> = { 0: 'none', 86_400: 'day', 604_800: 'week', 2_592_000: 'month' };

/// The owner's side of a pairing. Shows exactly what the agent asked for, lets the
/// owner grant less (never more), and authorizes the key in one passkey prompt,
/// bound to the request's witness so the approval answers this request only.
export function PairApproval({ code, protocol, chainId }: { code: string; protocol: owner.Protocol; chainId: number }) {
  const o = useOwner(protocol);
  const [pairing, setPairing] = useState<AgentPairing | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [budget, setBudget] = useState('');
  const [days, setDays] = useState(30);
  const [role, setRole] = useState<AgentRole>('buyer');
  const [done, setDone] = useState<{ tx: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const response = await fetch(`/api/agents/pair/${encodeURIComponent(code)}`, { cache: 'no-store' });
    const body = (await response.json()) as AgentPairing & { message?: string };
    if (!response.ok) {
      setMissing(body.message ?? 'This pairing does not exist or has expired.');
      return;
    }
    setPairing((previous) => {
      if (!previous) {
        setBudget(body.request.limit === '0' ? '0' : (Number(body.request.limit) / 1e6).toString());
        setDays(body.request.days);
        setRole(body.request.role);
      }
      return body;
    });
  }, [code]);

  useEffect(() => {
    void load();
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [load]);

  if (missing) {
    return (
      <div className="panel flex flex-col gap-4 p-8">
        <p className="label text-fail">Pairing {code}</p>
        <p className="text-[16px]">{missing}</p>
        <p className="text-[14px] text-fg-3">Ask the agent&rsquo;s operator to run `tempex-agent pair` again for a fresh code.</p>
        <Link className="btn self-start" href="/agents">
          Agent console
        </Link>
      </div>
    );
  }
  if (!pairing) return <div className="panel grid min-h-[320px] place-items-center"><p className="label anim-pulse">Reading the request…</p></div>;

  const r = pairing.request;
  const requested = BigInt(r.limit);
  const wrongNetwork = r.chainId !== chainId || r.escrow.toLowerCase() !== protocol.escrow.toLowerCase();
  const secondsLeft = Math.max(0, Math.floor((pairing.expiresAt - now) / 1000));
  const grantUnits = role === 'seller' ? 0n : /^\d+(\.\d{1,6})?$/.test(budget) ? tokenAmount(budget) : -1n;
  const overAsk = grantUnits > requested;
  const roleOptions: AgentRole[] = r.role === 'both' ? ['both', 'buyer', 'seller'] : [r.role];
  const valid = grantUnits >= 0n && !overAsk && days >= 1 && days <= r.days && !wrongNetwork;

  if (done || pairing.status === 'approved') {
    const tx = done?.tx ?? pairing.approval?.tx ?? '';
    return (
      <div className="panel flex flex-col gap-5 p-8" aria-live="polite">
        <div className="flex items-center gap-4">
          <KeyGlyph keyId={r.keyId} role={role} size={56} />
          <div>
            <p className="label text-ref">Approved</p>
            <h2 className="h2 mt-1">{r.name} is live.</h2>
          </div>
        </div>
        <p className="max-w-[64ch] text-[15px] text-fg-2">The agent sees the approval within seconds, checks it on chain itself, and starts acting for your account inside the limits you set.</p>
        {tx ? (
          <a className="link font-mono text-[12px] text-fg-3" href={txUrl(tx)} target="_blank" rel="noreferrer">
            authorization {shortHash(tx, 10, 6)} ↗
          </a>
        ) : null}
        <Link className="btn btn-ref self-start" href="/agents">
          Manage your agents
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-6">
        <section className="panel flex flex-col gap-5 p-6">
          <div className="flex items-start gap-4">
            <KeyGlyph keyId={r.keyId} role={r.role} size={64} />
            <div className="flex flex-col gap-1">
              <p className="label">Pairing {pairing.code} · {pairing.status === 'expired' ? 'expired' : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')} left`}</p>
              <h2 className="h2">{r.name} wants to act for your account.</h2>
              <p className="font-mono text-[12px] text-fg-3">key {r.keyId}</p>
            </div>
          </div>
          <dl className="grid gap-px border hairline bg-line text-[13px] sm:grid-cols-3">
            {[
              ['role', ROLE_TONE[r.role].label],
              ['budget asked', requested === 0n ? 'no spending' : `${amount(requested)} αUSD${r.period ? ` / ${PERIOD_OF[r.period]}` : ' total'}`],
              ['lifetime asked', `${r.days} days`],
            ].map(([k, v]) => (
              <div key={k} className="bg-ink-2 p-3">
                <dt className="label">{k}</dt>
                <dd className="mt-1 font-mono">{v}</dd>
              </div>
            ))}
          </dl>
          {wrongNetwork ? (
            <p role="alert" className="border border-fail-dim px-4 py-3 text-[13px] text-fail">
              This request is for a different network or escrow than this site serves. Do not approve it here.
            </p>
          ) : null}
          <JsonDisclosure value={r} label="signed pairing request" summaryText="signed request" depth={1} />
          <p className="border border-pip-dim px-4 py-3 text-[13px] leading-relaxed text-pip">
            Only approve if you started this agent yourself. The request is signed by the agent&rsquo;s own key, whose private half never leaves the agent; approving lets that key act for your account within the limits below until it expires or you revoke it.
          </p>
        </section>

        <OwnerBar owner={o} />

        {o.session && pairing.status === 'pending' ? (
          <section className="panel flex flex-col gap-5 p-6">
            <p className="label text-ref">Grant</p>
            {roleOptions.length > 1 ? (
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Role">
                {roleOptions.map((value) => (
                  <button key={value} type="button" role="radio" aria-checked={role === value} onClick={() => setRole(value)} className={`chip ${role === value ? 'chip-ref' : ''}`}>
                    {ROLE_TONE[value].label}
                  </button>
                ))}
              </div>
            ) : null}
            {role !== 'seller' ? (
              <label className="flex flex-col gap-2">
                <span className="label">Budget {r.period ? `per ${PERIOD_OF[r.period]}` : 'in total'} (αUSD, at most {amount(requested)})</span>
                <input value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" className="panel-sunk px-4 py-3 font-mono text-[15px]" />
                {overAsk ? <span className="text-[12px] text-fail">You can grant less than the agent asked for, never more.</span> : null}
              </label>
            ) : null}
            <label className="flex flex-col gap-2">
              <span className="label">Expires in {days} days (at most {r.days})</span>
              <input type="range" min={1} max={r.days} value={days} onChange={(event) => setDays(Number(event.target.value))} className="accent-[#4be3a6]" />
            </label>
            <button
              type="button"
              className="btn btn-ref self-start"
              disabled={!valid || !!o.busy}
              onClick={async () => {
                const session = o.session!;
                const tx = await o.run('Waiting for your passkey', () =>
                  owner.authorizeAgent(session, protocol, {
                    keyId: r.keyId,
                    role,
                    limit: grantUnits,
                    period: PERIOD_OF[r.period] ?? 'none',
                    days,
                    witness: r.witness,
                  }),
                );
                if (!tx) return;
                await o.run('Recording the approval', async () => {
                  const response = await fetch(`/api/agents/pair/${encodeURIComponent(code)}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ tx, limit: grantUnits.toString() }),
                  });
                  if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message ?? 'the beacon refused the confirmation');
                });
                setDone({ tx });
                void load();
              }}
            >
              Approve with passkey
            </button>
          </section>
        ) : null}
        {o.busy ? <p aria-live="polite" className="label anim-pulse text-ref">{o.busy}…</p> : null}
        {o.error ? <p role="alert" className="border border-fail-dim px-4 py-3 font-mono text-[12px] text-fail">{o.error}</p> : null}
      </div>

      <aside className="panel-sunk flex h-fit flex-col gap-4 p-5 lg:sticky lg:top-20">
        <p className="label text-ref">If you approve, it can</p>
        <ul className="flex flex-col gap-1.5 text-[13px] text-fg-2">
          {CAN[role].map((line) => (
            <li key={line}>✓ {line}</li>
          ))}
        </ul>
        <p className="label text-fail">It can never</p>
        <ul className="flex flex-col gap-1.5 text-[13px] text-fg-3">
          {CANNOT.map((line) => (
            <li key={line}>✕ {line}</li>
          ))}
        </ul>
        <p className="font-mono text-[11px] leading-relaxed text-fg-3">
          Enforced by Tempo&rsquo;s account keychain. The approval carries witness {shortHash(r.witness, 6, 4)}, so it answers this request and no other.
        </p>
        <p className="font-mono text-[11px] text-fg-3">Budget periods: {Object.keys(AGENT_PERIODS).join(', ')}.</p>
      </aside>
    </div>
  );
}
