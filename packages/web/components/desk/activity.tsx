'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { shortHash, txUrl } from '@/lib/format';
import type { ActivityEntry, AgentKey, InspectedTx } from '@/lib/types';
import { STEP_LABEL } from '@/lib/workflow';

import { JsonView } from '../json-view';
import { AgentRail, SignerBadge } from './shared';

/// A transaction as the beacon decoded it, loaded when first shown and cached
/// for the page: mined transactions never change.
const txCache = new Map<string, Promise<InspectedTx>>();

export function loadTx(hash: string): Promise<InspectedTx> {
  const key = hash.toLowerCase();
  let pending = txCache.get(key);
  if (!pending) {
    pending = fetch(`/api/tx/${hash}`, { cache: 'force-cache' }).then(async (response) => {
      const body = (await response.json()) as InspectedTx & { message?: string };
      if (!response.ok) throw new Error(body.message ?? `the beacon answered ${response.status}`);
      return body;
    });
    pending.catch(() => txCache.delete(key));
    txCache.set(key, pending);
  }
  return pending;
}

/// The decoded transaction behind a step, as an expandable JSON record: what the
/// signer called, with which arguments, what the chain emitted, who paid the fee.
/// Where an agent signed, what it called is the point: its signer and its calls,
/// arguments included, open on arrival.
export const AGENT_FOCUS = ['signer', 'calls', 'calls.*', 'calls.*.args'];

export function TxJson({ hash, depth = 1, label, focus }: { hash: string; depth?: number; label?: string; focus?: string[] }) {
  const [tx, setTx] = useState<InspectedTx | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadTx(hash).then(
      (value) => live && setTx(value),
      (caught: Error) => live && setError(caught.message),
    );
    return () => {
      live = false;
    };
  }, [hash]);
  if (error) return <p className="font-mono text-[11.5px] text-fail">{error}</p>;
  if (!tx) return <p className="label anim-pulse">Decoding {shortHash(hash)}…</p>;
  const calls = tx.calls.map((call) => call.function ?? call.selector).join(' → ');
  // Who and what first; the receipt detail after.
  const { signer, calls: decoded, events, ...rest } = tx;
  return <JsonView value={{ signer, calls: decoded, ...rest, events }} label={label ?? 'transaction'} depth={depth} caption={calls} {...(focus ? { focus } : {})} />;
}

/// Steps on the account, newest first. A step an agent signed carries its rail
/// and opens its decoded transaction by default: where an agent acted on your
/// behalf, the record of exactly what it signed is the first thing you see.
export function ActivityFeed({
  entries,
  me,
  agents,
  limit = 12,
  agentOpen = true,
  emptyText = 'Nothing yet.',
  compact = false,
}: {
  entries: ActivityEntry[];
  me: string;
  agents: Map<string, AgentKey>;
  limit?: number;
  agentOpen?: boolean;
  emptyText?: string;
  /// Inside one agent's card: the signer is that agent, so the row drops it.
  compact?: boolean;
}) {
  const [shown, setShown] = useState(limit);
  // created and funded share a transaction; show the pair as one line.
  const merged = mergeSameTx(entries);
  if (merged.length === 0) return <p className="text-[14px] text-fg-3">{emptyText}</p>;
  return (
    <div className="flex flex-col">
      <ol className="flex flex-col border hairline">
        {merged.slice(0, shown).map((entry) => (
          <ActivityRow key={`${entry.tx}-${entry.steps.join('+')}`} entry={entry} me={me} agents={agents} compact={compact} open={agentOpen && entry.signer?.kind === 'access-key' && entry.self} />
        ))}
      </ol>
      {merged.length > shown ? (
        <button type="button" className="btn mt-3 self-start" onClick={() => setShown(shown + limit)}>
          Show {Math.min(limit, merged.length - shown)} more
        </button>
      ) : null}
    </div>
  );
}

type Merged = ActivityEntry & { steps: ActivityEntry['step'][] };

function mergeSameTx(entries: ActivityEntry[]): Merged[] {
  const out: Merged[] = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (last && last.tx === entry.tx && last.jobId === entry.jobId) last.steps.push(entry.step);
    else out.push({ ...entry, steps: [entry.step] });
  }
  return out;
}

function ActivityRow({ entry, me, agents, open, compact }: { entry: Merged; me: string; agents: Map<string, AgentKey>; open: boolean; compact: boolean }) {
  const [expanded, setExpanded] = useState(open);
  const agent = entry.signer?.keyId ? agents.get(entry.signer.keyId.toLowerCase()) : undefined;
  const byAgent = entry.self && entry.signer?.kind === 'access-key';
  return (
    <li className={`relative flex min-w-0 flex-col gap-3 overflow-hidden border-b hairline px-4 py-3.5 last:border-b-0 ${byAgent ? 'bg-panel' : 'bg-ink-2'}`}>
      {byAgent ? <AgentRail role={agent?.role ?? null} /> : null}
      {compact ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <span className="flex-1 text-[14px]">{entry.steps.map((step) => STEP_LABEL[step] ?? step).join(' + ')}</span>
            {entry.jobId ? (
              <Link className="link font-mono text-[12px]" href={`/dashboard/jobs/${entry.jobId}`}>
                #{entry.jobId}
              </Link>
            ) : null}
            <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className={`chip cursor-pointer hover:border-ref-dim hover:text-ref ${expanded ? 'chip-ref' : ''}`}>
              {expanded ? '−' : '+'} {'{ }'}
            </button>
          </div>
          <span className="font-mono text-[11px] text-fg-3">
            {entry.timestamp ? new Date(entry.timestamp * 1000).toLocaleString() : `block ${entry.block}`} ·{' '}
            <a className="link" href={txUrl(entry.tx)} target="_blank" rel="noreferrer">
              {shortHash(entry.tx, 6, 4)} ↗
            </a>
          </span>
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="w-full shrink-0 text-[14px] sm:w-[170px]">{entry.steps.map((step) => STEP_LABEL[step] ?? step).join(' + ')}</span>
        {entry.jobId ? (
          <Link className="link font-mono text-[12.5px]" href={`/dashboard/jobs/${entry.jobId}`}>
            job #{entry.jobId}
          </Link>
        ) : (
          <span className="font-mono text-[12.5px] text-fg-3">account</span>
        )}
        <span className="min-w-0 flex-1">
          <SignerBadge signer={entry.signer} me={me} agents={agents} />
        </span>
        <span className="font-mono text-[11.5px] text-fg-3" title={entry.timestamp ? new Date(entry.timestamp * 1000).toISOString() : undefined}>
          {entry.timestamp ? new Date(entry.timestamp * 1000).toLocaleString() : `block ${entry.block}`}
        </span>
        <a className="link font-mono text-[11.5px] text-fg-3" href={txUrl(entry.tx)} target="_blank" rel="noreferrer">
          {shortHash(entry.tx, 6, 4)} ↗
        </a>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className={`chip cursor-pointer transition-colors hover:border-ref-dim hover:text-ref ${expanded ? 'chip-ref' : ''}`}
        >
          {expanded ? '−' : '+'} {'{ }'}
        </button>
      </div>
      )}
      {expanded ? <TxJson hash={entry.tx} label={byAgent ? `signed by ${agent?.name ?? 'agent key'}` : 'transaction'} {...(byAgent ? { focus: AGENT_FOCUS } : {})} /> : null}
    </li>
  );
}
