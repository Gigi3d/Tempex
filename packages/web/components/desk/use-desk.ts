'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { JobTerms } from '@tempex/sdk/browser';

import { readDoc } from '@/lib/desk';
import type { OwnerSession } from '@/lib/owner';
import type { Activity, AgentKey, JobRecord, Signer } from '@/lib/types';

/// Everything the dashboard knows about one owner, refreshed together: their jobs
/// on both sides, their agents, who signed each step, and their escrow credit.
/// Labels for agents made in this browser come from the console's local store.

const LABELS = 'tempex.owner.labels';
const POLL_MS = 12_000;

export type DeskData = {
  jobs: JobRecord[] | null;
  agents: Map<string, AgentKey>;
  agentList: AgentKey[];
  activity: Activity | null;
  /// tx hash (lowercase) → who signed it
  signers: Map<string, Signer>;
  credit: bigint | null;
  titles: Map<string, string>;
  error: string | null;
  refresh: () => Promise<void>;
};

const titleCache = new Map<string, string | null>();

export function useDesk(session: OwnerSession | null): DeskData {
  const [jobs, setJobs] = useState<JobRecord[] | null>(null);
  const [agentList, setAgentList] = useState<AgentKey[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [credit, setCredit] = useState<bigint | null>(null);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const address = session?.address ?? null;
  const live = useRef(true);

  const refresh = useCallback(async () => {
    if (!session || !address) return;
    try {
      const [jobsResponse, agentsResponse, activityResponse, owed] = await Promise.all([
        fetch(`/api/jobs?address=${address}`, { cache: 'no-store' }),
        fetch(`/api/agents/${address}`, { cache: 'no-store' }),
        fetch(`/api/activity/${address}`, { cache: 'no-store' }),
        session.tempex.credits().catch(() => null),
      ]);
      if (!live.current) return;
      if (!jobsResponse.ok) throw new Error(`the beacon answered ${jobsResponse.status} for your jobs`);
      setJobs(((await jobsResponse.json()) as { jobs: JobRecord[] }).jobs);
      if (agentsResponse.ok) setAgentList(withLabels(((await agentsResponse.json()) as { agents: AgentKey[] }).agents ?? []));
      if (activityResponse.ok) setActivity((await activityResponse.json()) as Activity);
      setCredit(owed);
      setError(null);
    } catch (caught) {
      if (live.current) setError((caught as Error).message);
    }
  }, [address, session]);

  useEffect(() => {
    live.current = true;
    setJobs(null);
    setActivity(null);
    if (!session) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [refresh, session]);

  // Titles come from each job's terms, read from the document store and checked
  // against the job's terms hash. Jobs opened elsewhere may have none on file.
  useEffect(() => {
    if (!jobs) return;
    let cancelled = false;
    const missing = jobs.filter((job) => !titleCache.has(job.termsHash.toLowerCase())).slice(0, 40);
    void Promise.all(
      missing.map(async (job) => {
        const key = job.termsHash.toLowerCase();
        try {
          const terms = await readDoc<JobTerms>(job.termsHash, 'terms');
          titleCache.set(key, terms?.doc.title ?? null);
        } catch {
          titleCache.set(key, null);
        }
      }),
    ).then(() => {
      if (cancelled) return;
      const next = new Map<string, string>();
      for (const job of jobs) {
        const title = titleCache.get(job.termsHash.toLowerCase());
        if (title) next.set(job.jobId, title);
      }
      setTitles(next);
    });
    return () => {
      cancelled = true;
    };
  }, [jobs]);

  const agents = useMemo(() => new Map(agentList.map((agent) => [agent.keyId.toLowerCase(), agent])), [agentList]);
  const signers = useMemo(() => {
    const map = new Map<string, Signer>();
    for (const entry of activity?.entries ?? []) if (entry.signer) map.set(entry.tx.toLowerCase(), entry.signer);
    return map;
  }, [activity]);

  return { jobs, agents, agentList, activity, signers, credit, titles, error, refresh };
}

function withLabels(agents: AgentKey[]): AgentKey[] {
  let labels: Record<string, { name: string; role: AgentKey['role']; limit: string; period: number }> = {};
  try {
    labels = JSON.parse(localStorage.getItem(LABELS) ?? '{}');
  } catch {
    labels = {};
  }
  return agents.map((agent) => {
    const label = labels[agent.keyId.toLowerCase()];
    return label && !agent.name ? { ...agent, name: label.name, role: label.role, limit: label.limit, period: label.period } : agent;
  });
}
