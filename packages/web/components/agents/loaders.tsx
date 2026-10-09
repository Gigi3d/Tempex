'use client';

import dynamic from 'next/dynamic';

import type { Protocol } from '@/lib/owner';

/// Passkeys, the keychain client and local labels are browser-only, so these
/// render on the client, after the page shell paints.
const Loading = () => (
  <div className="panel grid min-h-[280px] place-items-center">
    <p className="label anim-pulse">Opening the keychain…</p>
  </div>
);

const Console = dynamic(() => import('./console').then((m) => m.AgentConsole), { ssr: false, loading: Loading });
const Approval = dynamic(() => import('./pair-approval').then((m) => m.PairApproval), { ssr: false, loading: Loading });

export function ConsoleLoader(props: { protocol: Protocol }) {
  return <Console {...props} />;
}

export function ApprovalLoader(props: { code: string; protocol: Protocol; chainId: number }) {
  return <Approval {...props} />;
}
