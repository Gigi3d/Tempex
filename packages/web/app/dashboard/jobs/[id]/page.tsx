import { notFound } from 'next/navigation';

import { WorkspaceLoader } from '@/components/desk/loaders';
import { getJob, NotFound } from '@/lib/beacon';
import { tableConfig } from '@/lib/court';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Job ${id} · Dashboard` };
}

export default async function JobWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,12}$/.test(id)) notFound();
  let job;
  try {
    job = (await getJob(id)).data;
  } catch (error) {
    if (error instanceof NotFound) notFound();
    throw error;
  }
  const table = await tableConfig();
  return (
    <div className="wrap pt-10 pb-24">
      <WorkspaceLoader jobId={id} initial={job} protocol={{ escrow: table.escrow as `0x${string}`, token: table.token as `0x${string}` }} />
    </div>
  );
}
