'use client';

import { useMemo } from 'react';

import type { ActivityEntry, AgentKey } from '@/lib/types';

import { ActivityFeed } from './activity';

/// The public profile's feed: same rows as the owner's dashboard, built from data
/// the server already read.
export function PublicActivity({ entries, owner, agents }: { entries: ActivityEntry[]; owner: string; agents: AgentKey[] }) {
  const map = useMemo(() => new Map(agents.map((agent) => [agent.keyId.toLowerCase(), agent])), [agents]);
  return <ActivityFeed entries={entries} me={owner} agents={map} limit={10} emptyText="No steps on Tempex yet." />;
}
