'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import { amount, shortHash } from '@/lib/format';
import * as desk from '@/lib/desk';
import type { Protocol } from '@/lib/owner';
import type { JobRecord } from '@/lib/types';
import { exposure, inbox, outlook, sideOf, type InboxItem } from '@/lib/workflow';

import { OwnerBar } from '../agents/owner-bar';
import { useOwner } from '../agents/use-owner';
import { ActivityFeed } from './activity';
import { BusyLine, Countdown, Empty, SideChip, SignerBadge, StageChip, useNow } from './shared';
import { useDesk } from './use-desk';

type Filter = 'open' | 'buying' | 'selling' | 'closed' | 'all';
const CLOSED = new Set(['accepted', 'resolved', 'refunded', 'cancelled', 'lapsed']);

/// The owner's home: what needs them, what is on the line, every job on both
/// sides, and what their agents did, each step attributed to the key that signed.
export function Dashboard({ protocol }: { protocol: Protocol }) {
  const o = useOwner(protocol);
  const d = useDesk(o.session);
  const now = useNow(1_000);
  const me = o.session?.address ?? null;
  const items = useMemo(() => (d.jobs && me ? inbox(d.jobs, me, now) : []), [d.jobs, me, now]);
  const money = useMemo(() => (d.jobs && me ? exposure(d.jobs, me) : null), [d.jobs, me]);
  const live = d.agentList.filter((agent) => !agent.revoked && !agent.expired).length;
  useInboxSignals(items);

  return (
    <div className="flex flex-col gap-10">
      <OwnerBar owner={o} />
      <BusyLine busy={o.busy} error={o.error ?? d.error} />

      {!o.session ? (
        o.ready ? <Intro /> : null
      ) : (
        <>
          <section className="grid gap-px border hairline bg-line sm:grid-cols-2 lg:grid-cols-5" aria-label="Your money">
            <Tile label="wallet" value={o.balance === null ? '…' : amount(o.balance)} sub="αUSD on your account" />
            <Tile
              label="escrow credit"
              value={d.credit === null ? '…' : amount(d.credit)}
              sub={d.credit && d.credit > 0n ? 'yours to withdraw' : 'settled payouts land here'}
              action={
                d.credit && d.credit > 0n ? (
                  <button
                    type="button"
                    className="btn btn-ref mt-3 px-3 py-1.5 text-[12px]"
                    disabled={!!o.busy}
                    onClick={async () => {
                      await o.run('Withdrawing your credit', () => desk.withdraw(o.session!));
                      await Promise.all([d.refresh(), o.refreshBalance()]);
                    }}
                  >
                    Withdraw
                  </button>
                ) : null
              }
            />
            <Tile label="on the line" value={money ? amount(money.buying) : '…'} sub="escrowed on jobs you are buying" tone="pip" />
            <Tile label="incoming" value={money ? amount(money.selling) : '…'} sub="escrowed on jobs you are selling" tone="bolt" />
            <Tile label="agents" value={`${live}`} sub={<Link className="link" href="/agents">{d.agentList.length ? `${live} live of ${d.agentList.length} · manage` : 'add one'}</Link>} />
          </section>

          <section className="flex flex-col gap-4" aria-labelledby="inbox-title">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="label text-ref">Inbox</p>
                <h2 id="inbox-title" className="h2 mt-2">
                  {d.jobs === null ? 'Reading your jobs…' : items.length === 0 ? 'Nothing needs you.' : `${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} you.`}
                </h2>
              </div>
              <div className="flex flex-wrap gap-3">
                <NotifyToggle />
                <Link className="btn" href="/dashboard/offer">
                  Get hired
                </Link>
                <Link className="btn btn-ref" href="/dashboard/new">
                  Open a job
                </Link>
              </div>
            </div>
            {items.length > 0 ? (
              <ol className="grid gap-px border hairline bg-line">
                {items.map((item) => (
                  <InboxRow key={`${item.job.jobId}-${item.move.id}`} item={item} now={now} title={d.titles.get(item.job.jobId)} />
                ))}
              </ol>
            ) : d.jobs !== null ? (
              <p className="text-[14px] text-fg-3">Deliveries to review, disputes to answer and payouts to collect show up here, soonest deadline first.</p>
            ) : null}
          </section>

          <JobsTable jobs={d.jobs} me={me!} now={now} titles={d.titles} signers={d.signers} agents={d.agents} />

          <section className="flex flex-col gap-4" aria-labelledby="activity-title">
            <div>
              <p className="label">Activity</p>
              <h2 id="activity-title" className="h2 mt-2">
                What you and your agents signed.
              </h2>
              <p className="mt-2 max-w-[70ch] text-[14px] text-fg-3">
                Read from each transaction&rsquo;s Tempo signature, not from anything an agent reported. Steps an agent signed open with the exact calls it made.
              </p>
            </div>
            <ActivityFeed entries={d.activity?.entries ?? []} me={me!} agents={d.agents} limit={8} emptyText={d.activity ? 'No steps yet.' : 'Reading signatures…'} />
          </section>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone, action }: { label: string; value: React.ReactNode; sub: React.ReactNode; tone?: 'pip' | 'bolt'; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col bg-panel p-5">
      <p className={`label ${tone === 'pip' ? 'text-pip' : tone === 'bolt' ? 'text-bolt' : ''}`}>{label}</p>
      <p className="mt-2 font-mono text-[26px] font-light num tracking-tight">{value}</p>
      <p className="mt-1 text-[12.5px] text-fg-3">{sub}</p>
      {action}
    </div>
  );
}

function InboxRow({ item, now, title }: { item: InboxItem; now: number; title: string | undefined }) {
  const tone = item.move.tone;
  return (
    <li>
      <Link href={`/dashboard/jobs/${item.job.jobId}#move`} className="group flex flex-col gap-3 bg-panel px-5 py-4 transition-colors hover:bg-panel-2 md:flex-row md:items-center md:gap-6">
        <span className={`h-2 w-2 shrink-0 ${item.urgent ? 'anim-pulse bg-fail' : tone === 'ref' ? 'bg-ref' : tone === 'bolt' ? 'bg-bolt' : tone === 'fail' ? 'bg-fail' : 'bg-pip'}`} aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[16px] text-fg">{item.move.title}</span>
          <span className="truncate text-[13px] text-fg-3">
            <span className="font-mono">#{item.job.jobId}</span> · {title ?? 'untitled job'} · {amount(item.job.amount)} αUSD
          </span>
        </span>
        <SideChip side={item.side} />
        <span className="w-[130px] md:text-right">{item.move.deadline ? <Countdown at={item.move.deadline} now={now} /> : <span className="font-mono text-[12px] text-ref">ready now</span>}</span>
        <span className="font-mono text-[12px] text-fg-3 transition-colors group-hover:text-ref" aria-hidden>
          open →
        </span>
      </Link>
    </li>
  );
}

function JobsTable({
  jobs,
  me,
  now,
  titles,
  signers,
  agents,
}: {
  jobs: JobRecord[] | null;
  me: string;
  now: number;
  titles: Map<string, string>;
  signers: ReturnType<typeof useDesk>['signers'];
  agents: ReturnType<typeof useDesk>['agents'];
}) {
  const [filter, setFilter] = useState<Filter>('open');
  const counts = useMemo(() => {
    const list = jobs ?? [];
    return {
      open: list.filter((job) => !CLOSED.has(job.stage)).length,
      buying: list.filter((job) => sideOf(job, me) === 'buyer').length,
      selling: list.filter((job) => sideOf(job, me) === 'seller').length,
      closed: list.filter((job) => CLOSED.has(job.stage)).length,
      all: list.length,
    };
  }, [jobs, me]);
  const shown = (jobs ?? []).filter((job) =>
    filter === 'open' ? !CLOSED.has(job.stage) : filter === 'closed' ? CLOSED.has(job.stage) : filter === 'buying' ? sideOf(job, me) === 'buyer' : filter === 'selling' ? sideOf(job, me) === 'seller' : true,
  );

  return (
    <section className="flex flex-col gap-4" aria-labelledby="jobs-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Jobs</p>
          <h2 id="jobs-title" className="h2 mt-2">
            Both sides of every deal.
          </h2>
        </div>
        <div role="tablist" aria-label="Filter jobs" className="flex flex-wrap gap-px">
          {(['open', 'buying', 'selling', 'closed', 'all'] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} className="tab" onClick={() => setFilter(value)}>
              {value} <span className="text-fg-3">{counts[value]}</span>
            </button>
          ))}
        </div>
      </div>
      {jobs === null ? (
        <div className="panel grid min-h-[160px] place-items-center">
          <p className="label anim-pulse">Reading the index…</p>
        </div>
      ) : shown.length === 0 ? (
        <Empty title={filter === 'open' ? 'No open jobs.' : `No ${filter} jobs.`}>
          {counts.all === 0 ? (
            <>
              Open one yourself, or <Link className="link" href="/agents">give an agent a key</Link> and let it open them for you.
            </>
          ) : null}
        </Empty>
      ) : (
        <div className="overflow-x-auto border hairline">
          <table className="table min-w-[860px]">
            <thead>
              <tr>
                <th>Job</th>
                <th>Side</th>
                <th>Counterparty</th>
                <th>Stage</th>
                <th>Next</th>
                <th>Opened by</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((job) => {
                const view = outlook(job, me, now);
                const side = view.side;
                const counterparty = side === 'buyer' ? job.seller : job.buyer;
                const opener = job.created?.tx ? signers.get(job.created.tx.toLowerCase()) ?? null : null;
                const mine = view.moves.filter((move) => move.forYou);
                return (
                  <tr key={job.jobId} className="cursor-pointer" onClick={() => (window.location.href = `/dashboard/jobs/${job.jobId}`)}>
                    <td>
                      <Link className="flex flex-col" href={`/dashboard/jobs/${job.jobId}`} onClick={(event) => event.stopPropagation()}>
                        <span className="font-mono text-[12.5px] text-fg-3">#{job.jobId}</span>
                        <span className="max-w-[260px] truncate text-[14px]">{titles.get(job.jobId) ?? <span className="text-fg-3">untitled</span>}</span>
                      </Link>
                    </td>
                    <td>
                      <SideChip side={side} />
                    </td>
                    <td className="font-mono text-[12px] text-fg-2">{shortHash(counterparty)}</td>
                    <td>
                      <StageChip stage={job.stage} responded={!!job.response} />
                    </td>
                    <td className="text-[13px]">
                      {mine.length > 0 ? (
                        <span className="text-ref">{mine[0]!.title}</span>
                      ) : view.waiting ? (
                        <span className="text-fg-3">{view.waiting.title.replace(/^Waiting for /, 'waiting: ')}</span>
                      ) : view.closed ? (
                        <span className="text-fg-3">closed</span>
                      ) : (
                        <span className="text-fg-3">—</span>
                      )}
                      {view.nextDeadline && !view.closed ? (
                        <span className="block">
                          <Countdown at={view.nextDeadline} now={now} />
                        </span>
                      ) : null}
                    </td>
                    <td>{side === 'buyer' ? <SignerBadge signer={opener} me={me} agents={agents} compact /> : <span className="font-mono text-[11px] text-fg-3">counterparty</span>}</td>
                    <td className="text-right font-mono num">{amount(job.amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/// The tab title carries the inbox count, and, when the owner allows it, the
/// browser announces anything new that lands while the dashboard is open.
function useInboxSignals(items: InboxItem[]) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const base = 'Dashboard · Tempex';
    document.title = items.length ? `(${items.length}) ${base}` : base;
    const keys = new Set(items.map((item) => `${item.job.jobId}:${item.move.id}`));
    if (seen.current === null) {
      seen.current = keys;
      return;
    }
    const fresh = items.filter((item) => !seen.current!.has(`${item.job.jobId}:${item.move.id}`));
    seen.current = keys;
    if (fresh.length === 0 || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !notifyOn()) return;
    for (const item of fresh.slice(0, 3)) {
      new Notification(`Tempex · job #${item.job.jobId}`, { body: item.move.title, tag: `tempex-${item.job.jobId}-${item.move.id}` });
    }
  }, [items]);
}

const NOTIFY = 'tempex.dashboard.notify';
function notifyOn(): boolean {
  try {
    return localStorage.getItem(NOTIFY) === '1';
  } catch {
    return false;
  }
}

function NotifyToggle() {
  const [state, setState] = useState<'unsupported' | 'off' | 'on' | 'blocked'>('off');
  useEffect(() => {
    if (typeof Notification === 'undefined') setState('unsupported');
    else if (Notification.permission === 'denied') setState('blocked');
    else setState(Notification.permission === 'granted' && notifyOn() ? 'on' : 'off');
  }, []);
  if (state === 'unsupported') return null;
  return (
    <button
      type="button"
      className={`btn ${state === 'on' ? 'border-ref-dim text-ref' : ''}`}
      disabled={state === 'blocked'}
      title={state === 'blocked' ? 'Notifications are blocked for this site in your browser settings' : 'Alerts while this tab is open'}
      onClick={async () => {
        if (state === 'on') {
          try {
            localStorage.removeItem(NOTIFY);
          } catch {
            // nothing stored
          }
          setState('off');
          return;
        }
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          try {
            localStorage.setItem(NOTIFY, '1');
          } catch {
            // the toggle lasts for this visit
          }
          setState('on');
        } else setState(permission === 'denied' ? 'blocked' : 'off');
      }}
    >
      {state === 'on' ? '● Alerts on' : state === 'blocked' ? 'Alerts blocked' : 'Alert me here'}
    </button>
  );
}

function Intro() {
  const steps = [
    { n: '01', title: 'Open a job', body: 'Write the terms, name a seller and fund it. One passkey prompt approves, creates and escrows in a single Tempo transaction, with fees sponsored.' },
    { n: '02', title: 'Work both sides', body: 'Deliver, review, accept or dispute, from the same account. Every deadline the escrow enforces shows here as a countdown.' },
    { n: '03', title: 'Watch your agents', body: 'Steps your agents sign show up beside yours, named and attributed from the transaction signature, with the exact calls they made.' },
  ];
  return (
    <section className="grid gap-px border hairline bg-line md:grid-cols-3">
      {steps.map((step) => (
        <div key={step.n} className="flex flex-col gap-3 bg-panel p-6">
          <span className="font-mono text-[12px] text-ref">{step.n}</span>
          <h3 className="text-[18px]">{step.title}</h3>
          <p className="text-[14px] leading-relaxed text-fg-2">{step.body}</p>
        </div>
      ))}
    </section>
  );
}
