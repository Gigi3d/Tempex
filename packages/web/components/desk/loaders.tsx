'use client';

import dynamic from 'next/dynamic';

import type { Protocol } from '@/lib/owner';
import type { JobRecord } from '@/lib/types';

import type { NewJobContext } from './new-job';

/// Passkeys, the owner's client and the browser's own checks are browser-only,
/// so the dashboard renders on the client after the page shell paints.
const Loading = ({ label }: { label: string }) => (
  <div className="panel grid min-h-[320px] place-items-center">
    <p className="label anim-pulse">{label}</p>
  </div>
);

const DashboardView = dynamic(() => import('./dashboard').then((m) => m.Dashboard), { ssr: false, loading: () => <Loading label="Opening your dashboard…" /> });
const WorkspaceView = dynamic(() => import('./job-workspace').then((m) => m.JobWorkspace), { ssr: false, loading: () => <Loading label="Opening the job…" /> });
const NewJobView = dynamic(() => import('./new-job').then((m) => m.NewJob), { ssr: false, loading: () => <Loading label="Preparing the form…" /> });

export function DashboardLoader(props: { protocol: Protocol }) {
  return <DashboardView {...props} />;
}

export function WorkspaceLoader(props: { jobId: string; protocol: Protocol; initial: JobRecord | null }) {
  return <WorkspaceView {...props} />;
}

export function NewJobLoader(props: { context: NewJobContext; mode?: 'job' | 'offer' }) {
  return <NewJobView {...props} />;
}
