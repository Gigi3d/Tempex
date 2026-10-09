'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { DISPUTE_BOND_BPS, normalizeCriteria, type EvidenceBundle, type JobTerms, type SellerResponse } from '@tempex/sdk/browser';

import * as desk from '@/lib/desk';
import { amount, pct, shortHash, txUrl, utc } from '@/lib/format';
import type { Protocol } from '@/lib/owner';
import type { Ruling } from '@/lib/play';
import type { AgentKey, JobRecord, Signer, StoredDoc } from '@/lib/types';
import { outlook, reviewDeadline, responseDeadline, type Move } from '@/lib/workflow';

import { OwnerBar } from '../agents/owner-bar';
import { useOwner, type OwnerState } from '../agents/use-owner';
import { StateMachine } from '../job-view';
import { JsonView } from '../json-view';
import { AGENT_FOCUS, TxJson, loadTx } from './activity';
import { AgentRail, BusyLine, Countdown, SideChip, SignerBadge, StageChip, useNow } from './shared';
import { useDesk } from './use-desk';

type Papers = {
  terms: StoredDoc<JobTerms> | null | undefined;
  work: string | null | undefined;
  evidence: StoredDoc<EvidenceBundle> | null | undefined;
  response: StoredDoc<SellerResponse> | null | undefined;
};

/// One job, worked from either side. The left column is the record (the terms
/// and work behind its hashes, and every step with the key that signed it); the
/// right column is the move the escrow accepts from you right now.
export function JobWorkspace({ jobId, protocol, initial }: { jobId: string; protocol: Protocol; initial: JobRecord | null }) {
  // A link shared the moment a job opens can arrive before the beacon's index
  // has seen it; keep looking for a while instead of answering "no such job".
  const [found, setFound] = useState<JobRecord | null>(initial);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (found) return;
    const timer = setTimeout(async () => {
      const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' }).catch(() => null);
      if (response?.ok) setFound(((await response.json()) as { data: JobRecord }).data);
      else setTries((n) => n + 1);
    }, 3_000);
    return () => clearTimeout(timer);
  }, [found, jobId, tries]);
  if (found) return <Workspace jobId={jobId} protocol={protocol} initial={found} />;
  return (
    <div className="panel flex min-h-[320px] flex-col items-center justify-center gap-4 p-8 text-center">
      {tries < 20 ? (
        <>
          <p className="label anim-pulse text-ref">Looking for job #{jobId}…</p>
          <p className="max-w-[48ch] text-[14px] text-fg-3">A job that just opened takes a few seconds to reach the index. This page opens it as soon as it does.</p>
        </>
      ) : (
        <>
          <p className="label text-fail">No job #{jobId}</p>
          <p className="max-w-[48ch] text-[14px] text-fg-3">The escrow&rsquo;s index has no job with this number. Check the link with whoever sent it.</p>
          <Link className="btn" href="/dashboard">
            Dashboard
          </Link>
        </>
      )}
    </div>
  );
}

function Workspace({ jobId, protocol, initial }: { jobId: string; protocol: Protocol; initial: JobRecord }) {
  const o = useOwner(protocol);
  const d = useDesk(o.session);
  const now = useNow(1_000);
  const [job, setJob] = useState<JobRecord>(initial);
  const [papers, setPapers] = useState<Papers>({ terms: undefined, work: undefined, evidence: undefined, response: undefined });
  const [ruling, setRuling] = useState<Ruling | null>(null);
  const [paperRev, setPaperRev] = useState(0);

  const reload = useCallback(async () => {
    const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
    if (response.ok) setJob(((await response.json()) as { data: JobRecord }).data);
  }, [jobId]);

  useEffect(() => {
    const timer = setInterval(() => void reload(), 8_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The papers behind each hash, each re-hashed here before it is shown.
  useEffect(() => {
    let live = true;
    const settle = <T,>(promise: Promise<T>) => promise.catch(() => null);
    void Promise.all([
      settle(desk.readDoc<JobTerms>(job.termsHash, 'terms')),
      settle(desk.readDeliverable(job)),
      settle(desk.readDoc<EvidenceBundle>(job.dispute?.disputeHash, 'evidence')),
      settle(desk.readDoc<SellerResponse>(job.response?.responseHash, 'response')),
    ]).then(([terms, work, evidence, response]) => {
      if (live) setPapers({ terms, work, evidence, response });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.termsHash, job.delivered?.deliverableHash, job.delivered?.uri, job.dispute?.disputeHash, job.response?.responseHash, paperRev]);

  const me = o.session?.address ?? null;
  const view = outlook(job, me, now);
  const after = async () => {
    await reload();
    // the index catches up within a scan; look again shortly after
    setTimeout(() => void reload(), 3_000);
    await Promise.all([d.refresh(), o.refreshBalance()]);
  };

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <Link href="/dashboard" className="label w-fit hover:text-fg">
          ← Dashboard
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-[14px] text-fg-3">job #{job.jobId}</span>
          <StageChip stage={job.stage} responded={!!job.response} />
          {view.side ? <SideChip side={view.side} /> : null}
          {job.milestone ? <span className="chip">milestone {job.milestone.index + 1} of {job.milestone.count}</span> : null}
        </div>
        <h1 className="display text-[clamp(32px,4.4vw,60px)]">{papers.terms?.doc.title ?? (papers.terms === undefined ? ' ' : `Job #${job.jobId}`)}</h1>
        <StateMachine job={job} />
      </header>

      <OwnerBar owner={o} faucet />
      <BusyLine busy={o.busy} error={o.error} />

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-8">
          <TermsCard job={job} terms={papers.terms} side={view.side} owner={o} onAttached={() => {
              setPapers((p) => ({ ...p, terms: undefined }));
              setPaperRev((n) => n + 1);
            }} reload={reload} />
          {job.delivered ? <WorkCard job={job} work={papers.work} /> : null}
          {job.dispute ? <DisputeCard job={job} evidence={papers.evidence} response={papers.response} ruling={ruling} /> : null}
          <Trail job={job} me={me} agents={d.agents} signers={d.signers} />
        </div>

        <aside id="move" className="flex flex-col gap-4 lg:sticky lg:top-20">
          <MovePanel job={job} view={view} now={now} owner={o} papers={papers} onDone={after} onRuling={setRuling} />
          <MoneyPanel job={job} />
          {d.credit && d.credit > 0n ? (
            <div className="panel flex items-center justify-between gap-4 p-5">
              <div>
                <p className="label text-ref">Escrow credit</p>
                <p className="mt-1 font-mono text-[18px] num">{amount(d.credit)} αUSD</p>
              </div>
              <button type="button" className="btn btn-ref" disabled={!!o.busy} onClick={async () => { await o.run('Withdrawing your credit', () => desk.withdraw(o.session!)); await after(); }}>
                Withdraw
              </button>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- papers

function Verified({ ok, what }: { ok: boolean; what: string }) {
  return ok ? (
    <span className="chip chip-ref" title={`Re-hashed in this browser: it matches the ${what} committed on chain`}>
      ✓ matches {what}
    </span>
  ) : (
    <span className="chip chip-pip">not on file</span>
  );
}

function TermsCard({ job, terms, side, owner, onAttached, reload }: { job: JobRecord; terms: Papers['terms']; side: 'buyer' | 'seller' | null; owner: OwnerState; onAttached: () => void; reload: () => Promise<void> }) {
  const [mode, setMode] = useState<'read' | 'json'>('read');
  const [attach, setAttach] = useState('');
  return (
    <section className="panel flex flex-col gap-5 p-6" aria-labelledby="terms-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <p id="terms-title" className="label">Terms</p>
          {terms !== undefined ? <Verified ok={!!terms} what="termsHash" /> : null}
        </div>
        {terms ? (
          <div className="flex gap-px">
            <button type="button" className="tab" aria-selected={mode === 'read'} onClick={() => setMode('read')}>read</button>
            <button type="button" className="tab" aria-selected={mode === 'json'} onClick={() => setMode('json')}>json</button>
          </div>
        ) : null}
      </div>
      {terms === undefined ? (
        <p className="label anim-pulse">Reading the terms…</p>
      ) : terms === null ? (
        <div className="flex flex-col gap-4">
          <p className="max-w-[64ch] text-[14px] text-fg-2">
            The chain holds only this job&rsquo;s terms hash <span className="font-mono text-[12px]">{shortHash(job.termsHash, 10, 6)}</span>. The document behind it was never filed here, so neither side can read it and an arbiter could not rule on it.
            {side ? ' If you have it, paste it below: it is accepted only if it hashes to the commitment.' : ''}
          </p>
          {side ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={async (event) => {
                event.preventDefault();
                const done = await owner.run('Checking and filing the terms', () => desk.attachTerms(job, attach));
                if (done !== undefined) {
                  setAttach('');
                  onAttached();
                  await reload();
                }
              }}
            >
              <textarea value={attach} onChange={(event) => setAttach(event.target.value)} rows={5} placeholder='{"title": "…", "deliverableSpec": "…", …}' className="panel-sunk px-4 py-3 font-mono text-[12px]" />
              <button type="submit" className="btn self-start" disabled={!attach.trim() || !!owner.busy}>
                Attach terms
              </button>
            </form>
          ) : null}
        </div>
      ) : mode === 'json' ? (
        <JsonView value={terms.doc} label="terms" depth={3} caption={shortHash(terms.hash, 10, 6)} />
      ) : (
        <div className="flex flex-col gap-5">
          <p className="max-w-[72ch] whitespace-pre-wrap text-[15px] leading-relaxed text-fg-2">{terms.doc.deliverableSpec}</p>
          <div className="flex flex-col gap-2">
            <p className="label">Acceptance criteria</p>
            <ol className="flex flex-col gap-px border hairline bg-line">
              {safeCriteria(terms.doc).map((criterion) => (
                <li key={criterion.id} className="flex items-start gap-4 bg-ink-2 px-4 py-3">
                  <span className="font-mono text-[11px] text-fg-3">{criterion.id}</span>
                  <span className="flex-1 text-[14px]">{criterion.text}</span>
                  <span className={`chip ${criterion.check ? 'chip-ref' : ''}`} title={criterion.check ? 'Decided exactly by code' : 'Left to the judge, bounded by the offers'}>
                    {criterion.check ? `check · ${criterion.check.type}` : 'judgement'}
                  </span>
                  {criterion.weight !== 1 ? <span className="font-mono text-[11px] text-fg-3">×{criterion.weight}</span> : null}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}

function safeCriteria(terms: JobTerms) {
  try {
    return normalizeCriteria(terms.acceptanceCriteria);
  } catch {
    return terms.acceptanceCriteria.map((criterion, index) => ({ id: `c${index + 1}`, text: typeof criterion === 'string' ? criterion : criterion.text, weight: 1, check: undefined }));
  }
}

function WorkCard({ job, work }: { job: JobRecord; work: Papers['work'] }) {
  const delivered = job.delivered!;
  const hosted = delivered.uri && !delivered.uri.startsWith('data:');
  return (
    <section className="panel flex flex-col gap-4 p-6" aria-labelledby="work-title">
      <div className="flex flex-wrap items-center gap-3">
        <p id="work-title" className="label text-bolt">Delivered work</p>
        {work !== undefined ? <Verified ok={work !== null} what="deliverableHash" /> : null}
        <span className="font-mono text-[11.5px] text-fg-3">{utc(delivered.deliveredAt)}</span>
      </div>
      {work === undefined ? (
        <p className="label anim-pulse">Reading the work…</p>
      ) : work === null ? (
        <p className="text-[14px] text-fg-2">
          The seller committed <span className="font-mono text-[12px]">{shortHash(delivered.deliverableHash, 10, 6)}</span>
          {delivered.uri ? <> and pointed at <span className="break-all font-mono text-[12px]">{delivered.uri.slice(0, 120)}</span></> : null}, but no copy that hashes to it is on file here.
        </p>
      ) : (
        <pre className="code max-h-[420px] overflow-auto whitespace-pre-wrap text-[13px]">{work}</pre>
      )}
      {hosted ? (
        <a className="link w-fit font-mono text-[11.5px] text-fg-3" href={delivered.uri} target="_blank" rel="noreferrer">
          hosted copy ↗
        </a>
      ) : delivered.uri ? (
        <p className="font-mono text-[11.5px] text-fg-3">rode in the delivery transaction as a data URI</p>
      ) : null}
    </section>
  );
}

function DisputeCard({ job, evidence, response, ruling }: { job: JobRecord; evidence: Papers['evidence']; response: Papers['response']; ruling: Ruling | null }) {
  const dispute = job.dispute!;
  const verdict = job.verdict;
  return (
    <section className="panel flex flex-col gap-5 p-6" aria-labelledby="dispute-title">
      <p id="dispute-title" className="label text-pip">Dispute</p>
      <div className="grid gap-px border hairline bg-line md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3 bg-ink-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="label text-pip">buyer · offers {pct(dispute.buyerOfferBps)}</span>
            {evidence !== undefined ? <Verified ok={!!evidence} what="disputeHash" /> : null}
          </div>
          <p className="whitespace-pre-wrap text-[14px] text-fg-2">{evidence?.doc.claim ?? (evidence === null ? 'The buyer’s evidence is not on file here.' : '…')}</p>
          {evidence ? <JsonView value={evidence.doc} label="evidence bundle" depth={1} maxHeight={260} /> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-3 bg-ink-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="label text-bolt">seller{job.response ? ` · asks ${pct(job.response.sellerAskBps)}` : ''}</span>
            {job.response && response !== undefined ? <Verified ok={!!response} what="responseHash" /> : null}
          </div>
          <p className="whitespace-pre-wrap text-[14px] text-fg-2">
            {job.response ? (response?.doc.statement ?? (response === null ? 'The seller’s answer is not on file here.' : '…')) : 'No answer yet.'}
          </p>
          {response ? <JsonView value={response.doc} label="seller response" depth={1} maxHeight={260} /> : null}
        </div>
      </div>
      {verdict || ruling ? (
        <div className="flex flex-col gap-3 border border-ref-dim p-4">
          <p className="label text-ref">Verdict</p>
          <p className="font-mono text-[22px] num">
            {pct(verdict?.sellerAwardBps ?? ruling!.sellerAwardBps)} <span className="text-[13px] text-fg-3">to the seller</span>
          </p>
          {ruling ? (
            <p className={`w-fit font-mono text-[11.5px] ${ruling.engine === 'llm' ? 'text-ref' : 'text-fg-3'}`}>
              {ruling.engine === 'llm' ? `judged by ${ruling.model}, inside the band` : 'decided by the rule engine alone: no model was configured, so judgement criteria stood at the neutral midpoint'}
            </p>
          ) : null}
          {ruling ? <p className="max-w-[72ch] whitespace-pre-wrap text-[14px] text-fg-2">{ruling.rationale}</p> : null}
          {verdict ? (
            <p className="font-mono text-[12px] text-fg-3">
              seller {amount(verdict.sellerAmount)} · buyer {amount(verdict.buyerAmount)} · arbitration {amount(verdict.arbitrationFee)} αUSD
            </p>
          ) : null}
          {ruling ? <JsonView value={ruling} label="ruling" depth={1} maxHeight={280} /> : null}
        </div>
      ) : null}
    </section>
  );
}

// --------------------------------------------------------------------- trail

const TRAIL: { key: keyof JobRecord; label: string }[] = [
  { key: 'created', label: 'Opened' },
  { key: 'funded', label: 'Funded' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'dispute', label: 'Disputed' },
  { key: 'response', label: 'Answered' },
  { key: 'verdict', label: 'Ruled' },
  { key: 'refund', label: 'Refunded' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'lapsed', label: 'Settled on default split' },
];

function Trail({ job, me, agents, signers }: { job: JobRecord; me: string | null; agents: Map<string, AgentKey>; signers: Map<string, Signer> }) {
  const steps = TRAIL.map((step) => ({ ...step, ref: job[step.key] as { tx?: string; block?: number } | undefined })).filter((step) => step.ref?.tx);
  const groups: { labels: string[]; tx: string; block: number }[] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last.tx === step.ref!.tx) last.labels.push(step.label);
    else groups.push({ labels: [step.label], tx: step.ref!.tx!, block: step.ref!.block ?? 0 });
  }
  return (
    <section className="flex flex-col gap-4" aria-labelledby="trail-title">
      <div>
        <p id="trail-title" className="label">Trail</p>
        <p className="mt-1 text-[13px] text-fg-3">Every step, the key that signed it, and the decoded transaction. Steps an agent signed open by default.</p>
      </div>
      <ol className="flex flex-col border hairline">
        {groups.map((group) => (
          <TrailRow key={group.tx} group={group} me={me} agents={agents} known={signers.get(group.tx.toLowerCase()) ?? null} />
        ))}
      </ol>
    </section>
  );
}

function TrailRow({ group, me, agents, known }: { group: { labels: string[]; tx: string; block: number }; me: string | null; agents: Map<string, AgentKey>; known: Signer | null }) {
  const [signer, setSigner] = useState<Signer | null>(known);
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (known) {
      setSigner(known);
      return;
    }
    let live = true;
    void loadTx(group.tx).then((tx) => live && setSigner(tx.signer), () => undefined);
    return () => {
      live = false;
    };
  }, [group.tx, known]);
  const byAgent = signer?.kind === 'access-key';
  const agent = signer?.keyId ? agents.get(signer.keyId.toLowerCase()) : undefined;
  const expanded = open ?? byAgent;
  return (
    <li className={`relative flex min-w-0 flex-col gap-3 overflow-hidden border-b hairline px-4 py-3.5 last:border-b-0 ${byAgent ? 'bg-panel' : 'bg-ink-2'}`}>
      {byAgent ? <AgentRail role={agent?.role ?? null} /> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="w-full shrink-0 text-[14px] sm:w-[150px]">{group.labels.join(' + ')}</span>
        <span className="min-w-0 flex-1">
          <SignerBadge signer={signer} me={me} agents={agents} />
        </span>
        <span className="font-mono text-[11.5px] text-fg-3">block {group.block}</span>
        <a className="link font-mono text-[11.5px] text-fg-3" href={txUrl(group.tx)} target="_blank" rel="noreferrer">
          {shortHash(group.tx, 6, 4)} ↗
        </a>
        <button type="button" aria-expanded={expanded} onClick={() => setOpen(!expanded)} className={`chip cursor-pointer hover:border-ref-dim hover:text-ref ${expanded ? 'chip-ref' : ''}`}>
          {expanded ? '−' : '+'} {'{ }'}
        </button>
      </div>
      {expanded ? <TxJson hash={group.tx} label={byAgent ? `signed by ${agent?.name ?? 'an agent key'}` : 'transaction'} {...(byAgent ? { focus: AGENT_FOCUS } : {})} /> : null}
    </li>
  );
}

// ---------------------------------------------------------------------- money

function MoneyPanel({ job }: { job: JobRecord }) {
  const fee = job.terms ? (BigInt(job.amount) * BigInt(job.terms.platformFeeBps)) / 10_000n : null;
  const rows: [string, React.ReactNode][] = [
    ['escrowed', `${amount(job.amount)} αUSD`],
    ['platform fee', job.terms ? `${pct(job.terms.platformFeeBps)} · ${amount(fee!)} on accept` : '—'],
    ['arbitration', job.terms ? `${pct(job.terms.arbitrationFeeBps)}${job.terms.arbitrationFeeFloor && job.terms.arbitrationFeeFloor !== '0' ? `, at least ${amount(job.terms.arbitrationFeeFloor)}` : ''}, only if ruled` : '—'],
    ['dispute bond', `${pct(DISPUTE_BOND_BPS)} · ${amount((BigInt(job.amount) * BigInt(DISPUTE_BOND_BPS)) / 10_000n)}`],
    ['delivery by', utc(job.deliveryDeadline)],
    ['review window', `${Math.round(job.reviewWindow / 3600)} h after delivery`],
  ];
  return (
    <section className="panel-sunk flex flex-col gap-3 p-5">
      <p className="label">Money and time</p>
      <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="label self-center">{k}</dt>
            <dd className="font-mono text-[12px] text-fg-2">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t hairline pt-3 font-mono text-[11.5px] text-fg-3">
        <Link className="link" href={`/reputation/${job.buyer}`}>buyer {shortHash(job.buyer)}</Link>
        <Link className="link" href={`/reputation/${job.seller}`}>seller {shortHash(job.seller)}</Link>
        {job.terms ? <span>arbiter {shortHash(job.terms.arbiter)}</span> : null}
        <Link className="link" href={`/explorer/${job.jobId}`}>public record</Link>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------- moves

function MovePanel({
  job,
  view,
  now,
  owner,
  papers,
  onDone,
  onRuling,
}: {
  job: JobRecord;
  view: ReturnType<typeof outlook>;
  now: number;
  owner: OwnerState;
  papers: Papers;
  onDone: () => Promise<void>;
  onRuling: (ruling: Ruling) => void;
}) {
  const [active, setActive] = useState<Move['id'] | null>(null);
  const moves = view.moves;
  useEffect(() => {
    if (active && !moves.some((move) => move.id === active)) setActive(null);
  }, [active, moves]);

  if (view.closed) return <Outcome job={job} />;
  if (!owner.session) {
    return (
      <section className="panel flex flex-col gap-3 p-6">
        <p className="label">Your move</p>
        <p className="text-[14px] text-fg-2">Sign in as the buyer or the seller to act on this job.</p>
      </section>
    );
  }
  if (!view.side) {
    return (
      <section className="panel flex flex-col gap-3 p-6">
        <p className="label">Observer</p>
        <p className="text-[14px] text-fg-2">This account is neither the buyer nor the seller. Keeper moves anyone may call still show below.</p>
        {moves.map((move) => (
          <SimpleMove key={move.id} move={move} job={job} owner={owner} onDone={onDone} />
        ))}
      </section>
    );
  }

  const run = async (label: string, action: () => Promise<unknown>) => {
    const result = await owner.run(label, action);
    if (result !== undefined) await onDone();
    return result;
  };

  return (
    <section className="panel flex flex-col gap-5 p-6" aria-labelledby="move-title">
      <div className="flex items-center justify-between gap-3">
        <p id="move-title" className="label text-ref">Your move</p>
        {view.nextDeadline ? <Countdown at={view.nextDeadline} now={now} /> : null}
      </div>
      {moves.length === 0 && view.waiting ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-[19px]">{view.waiting.title}</h3>
          <p className="text-[14px] leading-relaxed text-fg-2">{view.waiting.detail}</p>
          {view.waiting.until ? <p className="font-mono text-[12px] text-fg-3">until {utc(view.waiting.until)}</p> : null}
        </div>
      ) : null}

      {moves.map((move) => {
        if (move.id === 'deliver') return <DeliverForm key={move.id} move={move} job={job} owner={owner} run={run} />;
        if (move.id === 'dispute') {
          return active === 'dispute' ? (
            <DisputeForm key={move.id} job={job} owner={owner} run={run} onCancel={() => setActive(null)} hasTerms={!!papers.terms} />
          ) : (
            <button key={move.id} type="button" className="btn justify-center text-fail" disabled={!!owner.busy} onClick={() => setActive('dispute')}>
              Dispute…
            </button>
          );
        }
        if (move.id === 'respond') return <RespondForm key={move.id} move={move} job={job} owner={owner} run={run} />;
        if (move.id === 'requestRuling') return <RulingMove key={move.id} move={move} job={job} owner={owner} papers={papers} onDone={onDone} onRuling={onRuling} />;
        if (move.id === 'accept') {
          const fee = job.terms ? (BigInt(job.amount) * BigInt(job.terms.platformFeeBps)) / 10_000n : 0n;
          return (
            <div key={move.id} className="flex flex-col gap-3">
              <h3 className="text-[19px]">Review the delivery</h3>
              <p className="text-[14px] text-fg-2">
                Accepting pays the seller <span className="font-mono num text-fg">{amount(BigInt(job.amount) - fee)} αUSD</span> and closes the job. Review closes {reviewDeadline(job) ? utc(reviewDeadline(job)!) : ''}; after that the seller can collect without you.
              </p>
              <button type="button" className="btn btn-ref justify-center" disabled={!!owner.busy} onClick={() => void run('Accepting with your passkey', () => desk.accept(owner.session!, job))}>
                Accept and pay
              </button>
            </div>
          );
        }
        return <SimpleMove key={move.id} move={move} job={job} owner={owner} onDone={onDone} />;
      })}
    </section>
  );
}

const SIMPLE: Partial<Record<Move['id'], { label: string; busy: string; act: (s: NonNullable<OwnerState['session']>, j: JobRecord) => Promise<unknown>; className: string }>> = {
  fund: { label: 'Fund with passkey', busy: 'Funding', act: desk.fund, className: 'btn-ref' },
  cancel: { label: 'Cancel the job', busy: 'Cancelling', act: desk.cancel, className: 'text-fail' },
  autoAccept: { label: 'Settle as accepted', busy: 'Settling', act: desk.autoAccept, className: 'btn-ref' },
  refundExpired: { label: 'Refund the buyer', busy: 'Refunding', act: desk.refundExpired, className: 'btn-ref' },
  settleLapsed: { label: 'Settle on the default split', busy: 'Settling', act: desk.settleLapsed, className: 'btn-ref' },
};

function SimpleMove({ move, job, owner, onDone }: { move: Move; job: JobRecord; owner: OwnerState; onDone: () => Promise<void> }) {
  const spec = SIMPLE[move.id];
  if (!spec) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[17px]">{move.title}</h3>
      <p className="text-[13.5px] leading-relaxed text-fg-2">{move.detail}</p>
      <button
        type="button"
        className={`btn justify-center ${spec.className}`}
        disabled={!!owner.busy || !owner.session}
        onClick={async () => {
          const result = await owner.run(`${spec.busy} with your passkey`, () => spec.act(owner.session!, job));
          if (result !== undefined) await onDone();
        }}
      >
        {move.id === 'refundExpired' && move.forYou ? 'Take my money back' : move.id === 'autoAccept' && move.forYou ? 'Collect payment' : spec.label}
      </button>
    </div>
  );
}

type Run = (label: string, action: () => Promise<unknown>) => Promise<unknown>;

function DeliverForm({ move, job, owner, run }: { move: Move; job: JobRecord; owner: OwnerState; run: Run }) {
  const [content, setContent] = useState('');
  const bytes = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const inline = Math.ceil((bytes * 4) / 3) + 40 <= 2_048;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (content.trim()) void run('Delivering with your passkey', () => desk.deliver(owner.session!, job, content));
      }}
    >
      <h3 className="text-[19px]">Deliver the work</h3>
      <p className="text-[13.5px] text-fg-2">{move.detail}</p>
      <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={10} placeholder="Paste the work itself: text, Markdown, JSON…" className="panel-sunk px-4 py-3 font-mono text-[12.5px]" />
      <p className="font-mono text-[11px] text-fg-3">
        {bytes.toLocaleString()} bytes · {content ? (inline ? 'rides in the transaction itself' : 'filed in the document store, linked from the transaction') : 'committed by keccak256 hash'}
      </p>
      <button type="submit" className="btn btn-ref justify-center" disabled={!content.trim() || !!owner.busy}>
        Deliver with passkey
      </button>
    </form>
  );
}

function OfferSlider({ label, value, onChange, tone, help }: { label: string; value: number; onChange: (bps: number) => void; tone: 'pip' | 'bolt'; help: string }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="flex items-baseline justify-between">
        <span className={`label ${tone === 'pip' ? 'text-pip' : 'text-bolt'}`}>{label}</span>
        <span className="font-mono text-[15px] num">{pct(value)}</span>
      </span>
      <input type="range" min={0} max={10_000} step={250} value={value} onChange={(event) => onChange(Number(event.target.value))} className={tone === 'pip' ? 'accent-[#f7c548]' : 'accent-[#6aa8ff]'} />
      <span className="text-[12px] text-fg-3">{help}</span>
    </label>
  );
}

function DisputeForm({ job, owner, run, onCancel, hasTerms }: { job: JobRecord; owner: OwnerState; run: Run; onCancel: () => void; hasTerms: boolean }) {
  const [claim, setClaim] = useState('');
  const [offer, setOffer] = useState(0);
  const [note, setNote] = useState('');
  const bond = (BigInt(job.amount) * BigInt(DISPUTE_BOND_BPS)) / 10_000n;
  return (
    <form
      className="flex flex-col gap-4 border border-fail-dim p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!claim.trim()) return;
        void run('Filing evidence and disputing with your passkey', () =>
          desk.dispute(owner.session!, job, { claim, offerBps: offer, artifacts: note.trim() ? [{ kind: 'text', label: 'buyer note', content: note.trim() }] : [] }),
        );
      }}
    >
      <h3 className="text-[19px] text-fail">Open a dispute</h3>
      {!hasTerms ? <p className="text-[13px] text-pip">The terms are not on file. Attach them on the left first: without them the arbiter cannot rule.</p> : null}
      <label className="flex flex-col gap-2">
        <span className="label">What is wrong</span>
        <textarea value={claim} onChange={(event) => setClaim(event.target.value)} rows={5} placeholder="Which criteria the delivery misses, and how." className="panel-sunk px-4 py-3 text-[14px]" />
      </label>
      <label className="flex flex-col gap-2">
        <span className="label">Supporting note (optional)</span>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="Logs, a corrected excerpt, a link…" className="panel-sunk px-4 py-3 font-mono text-[12px]" />
      </label>
      <OfferSlider label="Your final offer to the seller" value={offer} onChange={setOffer} tone="pip" help="The least the seller has earned in your view. The arbiter cannot award below the lower of this and the seller's ask." />
      <p className="font-mono text-[11.5px] text-fg-3">bond {amount(bond)} αUSD, posted now in the same transaction · returned to whoever the ruling favors</p>
      <div className="flex gap-3">
        <button type="submit" className="btn flex-1 justify-center border-fail-dim text-fail" disabled={!claim.trim() || !hasTerms || !!owner.busy}>
          Dispute with passkey
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Back
        </button>
      </div>
    </form>
  );
}

function RespondForm({ move, job, owner, run }: { move: Move; job: JobRecord; owner: OwnerState; run: Run }) {
  const [statement, setStatement] = useState('');
  const [ask, setAsk] = useState(10_000);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (statement.trim()) void run('Filing your answer with your passkey', () => desk.respond(owner.session!, job, { statement, askBps: ask, artifacts: [] }));
      }}
    >
      <h3 className="text-[19px]">Answer the dispute</h3>
      <p className="text-[13.5px] text-fg-2">{move.detail}</p>
      <label className="flex flex-col gap-2">
        <span className="label">Your statement</span>
        <textarea value={statement} onChange={(event) => setStatement(event.target.value)} rows={6} placeholder="How the delivery meets each criterion." className="panel-sunk px-4 py-3 text-[14px]" />
      </label>
      <OfferSlider label="Your final ask" value={ask} onChange={setAsk} tone="bolt" help="The least you will accept. The arbiter's award cannot go above the higher of this and the buyer's offer." />
      <p className="font-mono text-[11.5px] text-fg-3">
        window closes {responseDeadline(job) ? utc(responseDeadline(job)!) : ''} · your copy of the work goes with it
      </p>
      <button type="submit" className="btn btn-ref justify-center" disabled={!statement.trim() || !!owner.busy}>
        Answer with passkey
      </button>
    </form>
  );
}

function RulingMove({ move, job, owner, papers, onDone, onRuling }: { move: Move; job: JobRecord; owner: OwnerState; papers: Papers; onDone: () => Promise<void>; onRuling: (r: Ruling) => void }) {
  const parts: [string, boolean | undefined][] = [
    ['terms', papers.terms === undefined ? undefined : !!papers.terms],
    ['buyer evidence', papers.evidence === undefined ? undefined : !!papers.evidence],
    ['seller answer', !job.response ? undefined : papers.response === undefined ? undefined : !!papers.response],
  ];
  const ready = !!papers.terms && !!papers.evidence;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[19px]">{move.title}</h3>
      <p className="text-[13.5px] text-fg-2">{move.detail}</p>
      <ul className="flex flex-col gap-1 font-mono text-[12px]">
        {parts.map(([label, ok]) => (
          <li key={label} className={ok ? 'text-ref' : ok === false ? 'text-fail' : 'text-fg-3'}>
            {ok ? '✓' : ok === false ? '✕' : '·'} {label}
            {label === 'seller answer' && !job.response ? ' (none; the window closed)' : ''}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-ref justify-center"
        disabled={!ready || !!owner.busy}
        onClick={async () => {
          const ruling = await owner.run('The arbiter is reading the case', () => desk.requestRuling(job));
          if (ruling) {
            onRuling(ruling);
            await onDone();
          }
        }}
      >
        Send the case to the arbiter
      </button>
      <p className="text-[12px] text-fg-3">The arbiter rules inside the band both offers allow and relays its signed verdict on chain. Nothing here can change the award.</p>
    </div>
  );
}

function Outcome({ job }: { job: JobRecord }) {
  const lines: [string, string][] =
    job.stage === 'accepted'
      ? [['seller paid', job.accepted?.sellerAmount ? `${amount(job.accepted.sellerAmount)} αUSD` : 'the amount, less the platform fee']]
      : job.stage === 'resolved' && job.verdict
        ? [
            ['seller', `${amount(job.verdict.sellerAmount)} αUSD`],
            ['buyer', `${amount(job.verdict.buyerAmount)} αUSD`],
            ['arbitration', `${amount(job.verdict.arbitrationFee)} αUSD`],
          ]
        : job.stage === 'refunded'
          ? [['buyer refunded', `${amount(job.refund?.amount ?? job.amount)} αUSD`]]
          : job.stage === 'lapsed' && job.lapsed
            ? [
                ['seller', `${amount(job.lapsed.sellerAmount ?? '0')} αUSD`],
                ['buyer', `${amount(job.lapsed.buyerAmount ?? '0')} αUSD`],
              ]
            : [['outcome', 'cancelled before funding']];
  return (
    <section className="panel flex flex-col gap-4 border-ref-dim p-6">
      <p className="label text-ref">Closed</p>
      <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-[14px]">
        {lines.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="label self-center">{k}</dt>
            <dd className="font-mono num">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[12.5px] text-fg-3">Payouts become escrow credit; withdraw it from the dashboard or here.</p>
    </section>
  );
}
