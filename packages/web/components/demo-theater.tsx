'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type { Adjudication } from '@/lib/snapshot';
import type { JobRecord, Sourced } from '@/lib/types';

import { Bolt, Pip, Ref } from './characters';
import { ClampPlayground } from './clamp-playground';

type Act = { id: string; title: string; seconds: number; notes: string };

export const ACTS: Act[] = [
  { id: 'deal', title: 'The deal', seconds: 30, notes: 'Pip pays 25 αUSD for a French checkout locale. The money sits in the escrow, not with us. Bolt delivers. Here is the brief and what arrived.' },
  { id: 'dispute', title: 'The dispute', seconds: 30, notes: 'Pip disputes and pins its evidence on chain with a 5% bond. Bolt answers inside its 7-day window. Hashes, not promises.' },
  { id: 'ruling', title: 'The ruling', seconds: 60, notes: 'Code checks what it can: 9 of 10 weight, 4.25 credited. One unit has no check and splits at the midpoint. That gives the band, the offers narrow it, and the award lands inside both. No judge.' },
  { id: 'cage', title: 'Test the bounds', seconds: 45, notes: 'Hand them the slider: play a corrupt arbiter. Let them try to cheat. The guardrail clamps it, and the contract reverts anything outside the offers. Two cages.' },
  { id: 'receipt', title: 'The receipt', seconds: 15, notes: 'Every ruling is a URL a stranger can verify. Scan it. It is on the explorer right now.' },
];

export type TheaterData = {
  job: JobRecord;
  adjudication: Adjudication;
  brief: string;
  title: string;
  claim: string;
  response: string;
  deliverable: string;
  scorecard: ReactNode;
  gauge: ReactNode;
  receipt: ReactNode;
  qr: string;
  proofUrl: string;
  drill: number[];
};

function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`panel p-6 ${className}`}>{children}</div>;
}

export function DemoTheater(data: TheaterData) {
  const [act, setAct] = useState(0);
  const [replay, setReplay] = useState(0);
  const [notes, setNotes] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState<{ on: boolean; jobId: string; job?: JobRecord; error?: string; failures: number }>({ on: false, jobId: '', failures: 0 });
  const stage = useRef<HTMLDivElement>(null);

  const go = useCallback((next: number) => {
    setAct(Math.max(0, Math.min(ACTS.length - 1, next)));
    setReplay((n) => n + 1);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (window.location.hash === '#cage') go(3);
  }, [go]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault();
        go(act + 1);
      } else if (event.key === 'ArrowLeft') go(act - 1);
      else if (event.key === 'r' || event.key === 'R') setReplay((n) => n + 1);
      else if (event.key === 'n' || event.key === 'N') setNotes((v) => !v);
      else if (event.key === 'l' || event.key === 'L') setLive((l) => ({ ...l, on: !l.on }));
      else if (event.key === 'f' || event.key === 'F') void stage.current?.requestFullscreen?.().catch(() => undefined);
      else if (/^[1-5]$/.test(event.key)) go(Number(event.key) - 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, go]);

  // Live mode: follow a run the presenter started from the CLI. No keys here.
  useEffect(() => {
    if (!live.on || !/^\d+$/.test(live.jobId)) return;
    let stopped = false;
    async function poll() {
      try {
        const response = await fetch(`/api/jobs/${live.jobId}`, { cache: 'no-store' });
        const body = (await response.json()) as Sourced<JobRecord> & { error?: string };
        if (stopped) return;
        if (!response.ok) setLive((l) => ({ ...l, error: body.error, failures: l.failures + 1 }));
        else setLive((l) => ({ ...l, job: body.data, error: undefined, failures: 0 }));
      } catch {
        if (!stopped) setLive((l) => ({ ...l, error: 'The beacon did not answer.', failures: l.failures + 1 }));
      }
    }
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [live.on, live.jobId]);

  const budget = ACTS.slice(0, act + 1).reduce((sum, a) => sum + a.seconds, 0);
  const a = data.adjudication;
  const j = data.job;

  return (
    <div ref={stage} className="bg-ink">
      {/* Act rail */}
      <div className="grid grid-cols-5 gap-1" role="tablist" aria-label="Acts">
        {ACTS.map((item, index) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={index === act}
            onClick={() => go(index)}
            className={`border-t-2 pt-2 text-left font-mono text-[10.5px] uppercase tracking-[0.12em] transition-colors ${
              index === act ? 'border-ref text-ref' : index < act ? 'border-line-2 text-fg-2' : 'border-line text-fg-3'
            }`}
          >
            {index + 1} · {item.title}
          </button>
        ))}
      </div>

      {live.on ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 border border-pip-dim bg-pip/5 px-4 py-3 text-[13px]">
          <span className="font-mono text-pip">LIVE</span>
          <span className="text-fg-2">Following a real run on Moderato. Real transactions take minutes.</span>
          <label htmlFor="live-job" className="sr-only">
            Job id
          </label>
          <input
            id="live-job"
            value={live.jobId}
            onChange={(event) => setLive((l) => ({ ...l, jobId: event.target.value.trim(), job: undefined }))}
            placeholder="job id"
            className="w-24 border hairline bg-ink-2 px-2 py-1 font-mono"
          />
          {live.job ? <span className="font-mono text-fg">stage: {live.job.stage}</span> : null}
          {live.error ? <span className="text-fail">{live.error}</span> : null}
          {live.failures >= 2 ? (
            <button type="button" className="chip chip-ref" onClick={() => setLive({ on: false, jobId: '', failures: 0 })}>
              Back to replay
            </button>
          ) : null}
        </div>
      ) : null}

      <div key={`${act}-${replay}`} className="anim-fade mt-8 min-h-[560px]">
        {act === 0 ? (
          <div className="flex flex-col gap-8">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="label text-pip">Act 1 · The deal</p>
                <h2 className="display mt-3 text-[clamp(36px,4.6vw,64px)]">Pip hires Bolt for 25 αUSD.</h2>
              </div>
              <div className="flex items-end gap-2">
                <Pip id="d1-pip" size={120} mood="happy" />
                <Bolt id="d1-bolt" size={120} mood="happy" />
              </div>
            </div>
            <div className="grid gap-px border hairline bg-line lg:grid-cols-2">
              <div className="flex flex-col gap-3 bg-ink-2 p-6">
                <p className="label">The brief · {data.title}</p>
                <p className="text-[16px] leading-relaxed text-fg-2">{data.brief}</p>
                <div className="mt-auto flex flex-wrap gap-2 pt-4">
                  <span className="chip chip-pip">25.00 αUSD locked in escrow</span>
                  <span className="chip">review window {Math.round(j.reviewWindow / 60)} min</span>
                </div>
              </div>
              <div className="flex min-w-0 flex-col gap-3 bg-ink-2 p-6">
                <p className="label text-bolt">What Bolt delivered · fr-FR.json</p>
                <pre className="code max-h-[300px] overflow-auto text-[12px]">{data.deliverable}</pre>
              </div>
            </div>
          </div>
        ) : null}

        {act === 1 ? (
          <div className="flex flex-col gap-8">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="label text-pip">Act 2 · The dispute</p>
                <h2 className="display mt-3 text-[clamp(36px,4.6vw,64px)]">Both sides pin evidence. Hashes, not promises.</h2>
              </div>
              <div className="flex items-end gap-2">
                <Pip id="d2-pip" size={110} mood="angry" />
                <Bolt id="d2-bolt" size={110} mood="sad" />
              </div>
            </div>
            <div className="grid gap-px border hairline bg-line lg:grid-cols-2">
              <div className="flex flex-col gap-4 bg-ink-2 p-6">
                <p className="label text-pip">Pip’s claim · bond 1.25 αUSD · offers {j.dispute?.buyerOfferBps} bps</p>
                <p className="text-[18px] leading-relaxed">“{data.claim}”</p>
                {j.dispute ? (
                  <a className="mt-auto font-mono text-[12px] text-fg-3 hover:text-ref" href={`https://explore.testnet.tempo.xyz/tx/${j.dispute.tx}`} target="_blank" rel="noreferrer">
                    disputeHash {j.dispute.disputeHash.slice(0, 14)}… · tx {j.dispute.tx.slice(0, 10)}… ↗
                  </a>
                ) : null}
              </div>
              <div className="flex flex-col gap-4 bg-ink-2 p-6">
                <p className="label text-bolt">Bolt’s response · asks {j.response?.sellerAskBps} bps</p>
                <p className="text-[18px] leading-relaxed">“{data.response}”</p>
                {j.response ? (
                  <a className="mt-auto font-mono text-[12px] text-fg-3 hover:text-ref" href={`https://explore.testnet.tempo.xyz/tx/${j.response.tx}`} target="_blank" rel="noreferrer">
                    responseHash {j.response.responseHash.slice(0, 14)}… · tx {j.response.tx.slice(0, 10)}… ↗
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {act === 2 ? (
          <div className="flex flex-col gap-8">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="label text-ref">Act 3 · The ruling</p>
                <h2 className="display mt-3 text-[clamp(36px,4.6vw,64px)]">Code credits {a.signals.earnedWeight} of {a.signals.totalWeight}.</h2>
                <p className="lede mt-3">The rule settles inside the band. The parties’ offers narrow it again.</p>
              </div>
              <Ref id="d3-ref" size={120} mood="listening" />
            </div>
            <Panel>{data.scorecard}</Panel>
            <Panel>{data.gauge}</Panel>
          </div>
        ) : null}

        {act === 3 ? (
          <div id="cage" className="flex flex-col gap-8">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="label text-ref">Act 4 · Test the bounds</p>
                <h2 className="display mt-3 text-[clamp(36px,4.6vw,64px)]">Propose any award. Try to break it.</h2>
              </div>
              <Ref id="d4-ref" size={110} mood="wink" />
            </div>
            <Panel>
              <ClampPlayground
                band={{ lowBps: a.band.lowBps, highBps: a.band.highBps }}
                offers={a.offers}
                amountUnits={a.money.amount}
                arbitrationFeeBps={a.money.arbitrationFeeBps}
                presets={data.drill}
                signedBps={a.ruling.sellerAwardBps}
                initial={10_000}
              />
            </Panel>
          </div>
        ) : null}

        {act === 4 ? (
          <div className="flex flex-col gap-8">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="label text-ref">Act 5 · The receipt</p>
                <h2 className="display mt-3 text-[clamp(36px,4.6vw,64px)]">Any stranger can verify this.</h2>
              </div>
              <div className="flex items-end gap-1">
                <Pip id="d5-pip" size={84} mood="beaming" />
                <Ref id="d5-ref" size={84} mood="happy" />
                <Bolt id="d5-bolt" size={84} mood="beaming" />
              </div>
            </div>
            <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
              {data.receipt}
              <div className="panel flex flex-col items-center justify-center gap-4 p-8 text-center">
                <div className="h-44 w-44" dangerouslySetInnerHTML={{ __html: data.qr }} role="img" aria-label={`QR code for ${data.proofUrl}`} />
                <p className="font-mono text-[13px] text-fg-2 break-all">{data.proofUrl}</p>
                <a className="btn btn-primary" href={data.proofUrl}>
                  Open the receipt
                </a>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Presenter bar */}
      <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t hairline pt-4">
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-fg-3">
          {[
            ['→', 'next'],
            ['←', 'back'],
            ['R', 'replay'],
            ['N', 'notes'],
            ['L', 'live'],
            ['F', 'full screen'],
          ].map(([key, label]) => (
            <span key={key} className="inline-flex items-center gap-1.5">
              <kbd className="border border-line-2 border-b-2 bg-panel-2 px-1.5 font-mono text-[11px] text-fg">{key}</kbd>
              {label}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className={`font-mono text-[13px] num ${elapsed > budget ? 'text-pip' : 'text-fg-2'}`}>
            {String(Math.floor(elapsed / 60)).padStart(1, '0')}:{String(elapsed % 60).padStart(2, '0')} / {Math.floor(budget / 60)}:{String(budget % 60).padStart(2, '0')}
          </span>
          <span className="chip">{live.on ? 'LIVE' : `REPLAY · job ${j.jobId} snapshot`}</span>
          <button type="button" className="btn" onClick={() => go(act - 1)} disabled={act === 0}>
            ← Back
          </button>
          <button type="button" className="btn btn-primary" onClick={() => go(act + 1)} disabled={act === ACTS.length - 1}>
            Next →
          </button>
        </div>
      </div>
      {notes ? (
        <div className="mt-4 border border-ref-dim bg-ref/5 px-4 py-3 text-[14px] text-fg-2" aria-live="polite">
          <span className="label text-ref">Presenter notes · {ACTS[act]!.seconds}s</span>
          <p className="mt-1">{ACTS[act]!.notes}</p>
        </div>
      ) : null}
    </div>
  );
}
