import { notFound } from 'next/navigation';

import { CHAIN_ID } from '@tempex/sdk/browser';

import { ApprovalLoader } from '@/components/agents/loaders';
import { tableConfig } from '@/lib/court';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Approve an agent', description: 'Review what an agent asks for and approve it with your passkey.', robots: { index: false } };

export default async function PairPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!/^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/.test(code)) notFound();
  const table = await tableConfig();
  return (
    <div className="wrap pt-10 pb-24">
      <p className="label mb-6 text-ref">Approve an agent</p>
      <ApprovalLoader code={code.toUpperCase()} chainId={CHAIN_ID} protocol={{ escrow: table.escrow as `0x${string}`, token: table.token as `0x${string}` }} />
    </div>
  );
}
