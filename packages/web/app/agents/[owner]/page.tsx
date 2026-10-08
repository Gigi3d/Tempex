import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AuthorizedLink, BudgetMeter, KeyGlyph, ROLE_TONE, StatusChip, expiryText } from '@/components/agents/kit';
import { beaconUrl, getJobsFor } from '@/lib/beacon';
import { addressUrl, amount, shortHash } from '@/lib/format';
import type { AgentKey } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ owner: string }> }) {
  const { owner } = await params;
  return { title: `Agents of ${shortHash(owner)}`, description: 'The agents this account has authorized on Tempo, read from the keychain.' };
}

async function agentsOf(owner: string): Promise<AgentKey[] | null> {
  const base = beaconUrl();
  if (!base) return null;
  try {
    const response = await fetch(`${base}/agents/${owner}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    return ((await response.json()) as { agents: AgentKey[] }).agents;
  } catch {
    return null;
  }
}

/// Anyone can see which agents an account runs, what they may spend and what they
/// have spent: all of it is public keychain state. Names come from pairings.
export default async function OwnerProfile({ params }: { params: Promise<{ owner: string }> }) {
  const { owner } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) notFound();
  const [agents, jobs] = await Promise.all([agentsOf(owner), getJobsFor(owner).catch(() => null)]);
  const list = jobs?.data.jobs ?? [];
  return (
    <div className="wrap flex flex-col gap-10 pt-10 pb-24">
      <div className="flex flex-col gap-3">
        <p className="label text-ref">Owner account</p>
        <h1 className="display text-[clamp(32px,4vw,56px)] font-mono">{shortHash(owner, 10, 8)}</h1>
        <a className="link font-mono text-[12px] text-fg-3" href={addressUrl(owner)} target="_blank" rel="noreferrer">
          {owner} ↗
        </a>
      </div>

      <section className="flex flex-col gap-4">
        <p className="label">Agents</p>
        {agents === null ? (
          <p className="text-[14px] text-fg-3">The beacon is unreachable, so the keychain could not be read just now.</p>
        ) : agents.length === 0 ? (
          <p className="text-[14px] text-fg-3">This account has authorized no agent keys.</p>
        ) : (
          <div className="grid gap-px border hairline bg-line md:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <article key={agent.keyId} className={`flex flex-col gap-4 bg-panel p-5 ${agent.revoked || agent.expired ? 'opacity-55' : ''}`}>
                <header className="flex items-start gap-3">
                  <KeyGlyph keyId={agent.keyId} role={agent.role} />
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[16px]">{agent.name ?? 'Unnamed key'}</h2>
                      <StatusChip agent={agent} />
                    </div>
                    <p className={`label ${agent.role ? ROLE_TONE[agent.role].text : ''}`}>{agent.role ? ROLE_TONE[agent.role].label : 'role unknown'}</p>
                    <p className="font-mono text-[11px] text-fg-3">key {shortHash(agent.keyId, 8, 6)} · {expiryText(agent.expiry, undefined, agent.revoked)}</p>
                  </div>
                </header>
                <BudgetMeter remaining={agent.remaining} limit={agent.limit} period={agent.period} periodEnd={agent.periodEnd} />
                <AuthorizedLink tx={agent.authorized.tx} />
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <p className="label">Jobs on Tempex</p>
        {list.length === 0 ? (
          <p className="text-[14px] text-fg-3">No jobs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table min-w-[560px]">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>As</th>
                  <th>Stage</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {list.map((job) => (
                  <tr key={job.jobId}>
                    <td>
                      <Link className="link font-mono" href={`/explorer/${job.jobId}`}>
                        #{job.jobId}
                      </Link>
                    </td>
                    <td className="font-mono text-[12px]">{job.buyer.toLowerCase() === owner.toLowerCase() ? 'buyer' : 'seller'}</td>
                    <td className="font-mono text-[12px]">{job.stage}</td>
                    <td className="text-right font-mono num">{amount(job.amount, 'ledger')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
