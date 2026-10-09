'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AGENT_PERIODS, tokenAmount, type AgentPeriod, type AgentRole } from '@tempex/sdk/browser';

import { amount, shortHash, txUrl } from '@/lib/format';
import * as owner from '@/lib/owner';
import type { Activity, AgentKey } from '@/lib/types';

import { CopyButton } from '../copy';
import { ActivityFeed } from '../desk/activity';
import { JsonDisclosure } from '../json-view';
import { AuthorizedLink, BudgetMeter, CAN, CANNOT, KeyGlyph, ROLE_TONE, StatusChip, expiryText } from './kit';
import { OwnerBar } from './owner-bar';
import { useOwner } from './use-owner';

/// Labels for keys made in this browser: the chain knows a key's budget left and
/// expiry, not its name. Keys paired through the beacon carry their own.
const LABELS = 'tempex.owner.labels';
type Label = { name: string; role: AgentRole; limit: string; period: number };

function readLabels(): Record<string, Label> {
  try {
    return JSON.parse(localStorage.getItem(LABELS) ?? '{}');
  } catch {
    return {};
  }
}
function writeLabel(keyId: string, label: Label): void {
  try {
    localStorage.setItem(LABELS, JSON.stringify({ ...readLabels(), [keyId.toLowerCase()]: label }));
  } catch {
    // storage refused: the card shows the key id instead of a name
  }
}

export function AgentConsole({ protocol }: { protocol: owner.Protocol }) {
  const o = useOwner(protocol);
  const router = useRouter();
  const [agents, setAgents] = useState<AgentKey[] | null>(null);
  const [panel, setPanel] = useState<'none' | 'create' | 'pair'>('none');
  const [code, setCode] = useState('');
  const [reveal, setReveal] = useState<{ env: string; name: string } | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);

  const load = useCallback(async () => {
    if (!o.session) return;
    const response = await fetch(`/api/agents/${o.session.address}`, { cache: 'no-store' });
    const body = (await response.json()) as { agents?: AgentKey[]; message?: string };
    if (!response.ok) throw new Error(body.message ?? `the beacon answered ${response.status}`);
    const labels = readLabels();
    void fetch(`/api/activity/${o.session.address}`, { cache: 'no-store' })
      .then(async (r) => (r.ok ? ((await r.json()) as Activity) : null))
      .then((value) => value && setActivity(value), () => undefined);
    setAgents(
      (body.agents ?? []).map((agent) => {
        const label = labels[agent.keyId.toLowerCase()];
        return label && !agent.name ? { ...agent, name: label.name, role: label.role, limit: label.limit, period: label.period } : agent;
      }),
    );
  }, [o.session]);

  /// The beacon reads the keychain through a short cache; after a change, look
  /// again once it has expired so the card reflects the new state without a wait.
  const reload = useCallback(async () => {
    await load().catch(() => undefined);
    setTimeout(() => void load().catch(() => undefined), 5_000);
  }, [load]);

  useEffect(() => {
    if (!o.session) {
      setAgents(null);
      return;
    }
    void load().catch(() => setAgents([]));
    const timer = setInterval(() => void load().catch(() => undefined), 15_000);
    return () => clearInterval(timer);
  }, [load, o.session]);

  const live = agents?.filter((agent) => !agent.revoked && !agent.expired).length ?? 0;
  const agentMap = useMemo(() => new Map((agents ?? []).map((agent) => [agent.keyId.toLowerCase(), agent])), [agents]);

  return (
    <div className="flex flex-col gap-8">
      <OwnerBar owner={o} />

      {o.error ? (
        <p role="alert" className="border border-fail-dim px-4 py-3 font-mono text-[12.5px] text-fail">
          {o.error}
        </p>
      ) : null}
      {o.busy ? (
        <p aria-live="polite" className="label anim-pulse text-ref">
          {o.busy}…
        </p>
      ) : null}

      {reveal ? <RevealKey reveal={reveal} onDone={() => setReveal(null)} /> : null}

      {o.session ? (
        <section className="flex flex-col gap-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="label">Your agents</p>
              <h2 className="h2 mt-2">{agents === null ? 'Reading the keychain…' : agents.length === 0 ? 'No agents yet.' : `${live} live of ${agents.length}`}</h2>
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="button" className={`btn ${panel === 'pair' ? 'btn-primary' : ''}`} onClick={() => setPanel(panel === 'pair' ? 'none' : 'pair')}>
                Pair a running agent
              </button>
              <button type="button" className={`btn ${panel === 'create' ? 'btn-primary' : 'btn-ref'}`} onClick={() => setPanel(panel === 'create' ? 'none' : 'create')}>
                Create an agent key
              </button>
              <Link className="btn" href="/dashboard">
                Dashboard
              </Link>
              <Link className="btn" href={`/agents/${o.session.address}`}>
                Public profile ↗
              </Link>
            </div>
          </div>

          {panel === 'pair' ? (
            <form
              className="panel flex flex-col gap-4 p-5 md:flex-row md:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                if (/^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/.test(code.trim())) router.push(`/agents/pair/${code.trim().toUpperCase()}`);
              }}
            >
              <label className="flex flex-1 flex-col gap-2">
                <span className="label">Pairing code from the agent</span>
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="7K2Q-M9XD"
                  maxLength={9}
                  autoComplete="off"
                  className="panel-sunk px-4 py-3 font-mono text-[20px] uppercase tracking-[0.3em]"
                />
              </label>
              <p className="max-w-[40ch] text-[13px] text-fg-3">The agent prints it after `tempex-agent pair`. You will see exactly what it asks for before anything is signed.</p>
              <button type="submit" className="btn btn-primary">
                Review request
              </button>
            </form>
          ) : null}

          {panel === 'create' ? (
            <CreateAgent
              protocol={protocol}
              busy={!!o.busy}
              onCreate={async (draft) => {
                const session = o.session!;
                const result = await o.run('Authorizing the new key', async () => {
                  const key = owner.newAgentKey();
                  const tx = await owner.authorizeAgent(session, protocol, { keyId: key.keyId, role: draft.role, limit: draft.limit, period: draft.period, days: draft.days });
                  writeLabel(key.keyId, { name: draft.name, role: draft.role, limit: draft.limit.toString(), period: AGENT_PERIODS[draft.period] });
                  return { key, tx };
                });
                if (!result) return;
                setPanel('none');
                setReveal({
                  name: draft.name,
                  env: [
                    `# ${draft.name}: Tempex agent key, authorized by ${session.address}`,
                    `# Store this in your secret manager. Anyone holding it can act within the budget until you revoke it.`,
                    `TEMPEX_AGENT_PRIVATE_KEY=${result.key.privateKey}`,
                    `TEMPEX_AGENT_OWNER=${session.address}`,
                    `TEMPEX_AGENT_NAME=${draft.name}`,
                    `TEMPEX_AGENT_ROLE=${draft.role}`,
                  ].join('\n'),
                });
                await reload();
              }}
            />
          ) : null}

          {agents && agents.length > 0 ? (
            <div className="grid gap-px border hairline bg-line md:grid-cols-2">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.keyId}
                  agent={agent}
                  owner={o.session!.address}
                  agents={agentMap}
                  activity={activity}
                  busy={!!o.busy}
                  onRevoke={async () => {
                    if (!window.confirm(`Revoke ${agent.name ?? shortHash(agent.keyId)}? It stops working at once and cannot be restored.`)) return;
                    await o.run('Revoking the key', () => owner.revokeAgent(o.session!, agent.keyId));
                    await reload();
                  }}
                  onBudget={async (limit) => {
                    await o.run('Setting the budget', () => owner.setBudget(o.session!, protocol, agent.keyId, limit));
                    if (agent.name) writeLabel(agent.keyId, { name: agent.name, role: agent.role ?? 'both', limit: limit.toString(), period: agent.period ?? 0 });
                    await reload();
                  }}
                />
              ))}
              {agents.length % 2 === 1 ? (
                <button
                  type="button"
                  onClick={() => setPanel('create')}
                  className="hidden flex-col items-center justify-center gap-3 border-2 border-dashed border-line bg-ink-2 p-5 text-fg-3 transition-colors hover:border-ref-dim hover:text-ref md:flex"
                >
                  <span className="font-mono text-[28px] leading-none">+</span>
                  <span className="text-[14px]">Add another agent</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : (
        <HowItWorks />
      )}
    </div>
  );
}

type Draft = { name: string; role: AgentRole; limit: bigint; period: AgentPeriod; days: number };

function CreateAgent({ protocol, busy, onCreate }: { protocol: owner.Protocol; busy: boolean; onCreate: (draft: Draft) => Promise<void> }) {
  const [name, setName] = useState('translator-bot');
  const [role, setRole] = useState<AgentRole>('buyer');
  const [budget, setBudget] = useState('100');
  const [period, setPeriod] = useState<AgentPeriod>('week');
  const [days, setDays] = useState(30);
  const valid = name.trim().length > 0 && name.length <= 48 && (role === 'seller' || /^\d+(\.\d{1,6})?$/.test(budget));

  return (
    <form
      className="panel grid gap-6 p-6 lg:grid-cols-[1fr_320px]"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void onCreate({ name: name.trim(), role, limit: role === 'seller' ? 0n : tokenAmount(budget), period, days });
      }}
    >
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-2">
          <span className="label">Agent name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={48} className="panel-sunk px-4 py-3 text-[15px]" />
        </label>
        <div className="flex flex-col gap-2">
          <span className="label">Role</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Role">
            {(['buyer', 'seller', 'both'] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={role === value} onClick={() => setRole(value)} className={`chip ${role === value ? 'chip-ref' : ''}`}>
                {ROLE_TONE[value].label}
              </button>
            ))}
          </div>
        </div>
        {role !== 'seller' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-2">
              <span className="label">Budget (αUSD)</span>
              <input value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" className="panel-sunk px-4 py-3 font-mono text-[15px]" />
            </label>
            <label className="flex flex-col gap-2">
              <span className="label">Per</span>
              <select value={period} onChange={(event) => setPeriod(event.target.value as AgentPeriod)} className="panel-sunk px-4 py-3 text-[15px]">
                <option value="day">day</option>
                <option value="week">week</option>
                <option value="month">month</option>
                <option value="none">total, never resets</option>
              </select>
            </label>
          </div>
        ) : (
          <p className="text-[13px] text-fg-3">A seller key gets no spending budget: it delivers and answers, and its earnings land in your account.</p>
        )}
        <label className="flex flex-col gap-2">
          <span className="label">Expires in {days} days</span>
          <input type="range" min={1} max={90} value={days} onChange={(event) => setDays(Number(event.target.value))} className="accent-[#4be3a6]" />
        </label>
      </div>
      <aside className="panel-sunk flex flex-col gap-4 p-5">
        <p className="label text-ref">This key can</p>
        <ul className="flex flex-col gap-1.5 text-[13px] text-fg-2">
          {CAN[role].map((line) => (
            <li key={line}>✓ {line}</li>
          ))}
        </ul>
        <p className="label text-fail">and cannot</p>
        <ul className="flex flex-col gap-1.5 text-[13px] text-fg-3">
          {CANNOT.map((line) => (
            <li key={line}>✕ {line}</li>
          ))}
        </ul>
        <p className="font-mono text-[11px] text-fg-3">Enforced by Tempo&rsquo;s account keychain on {shortHash(protocol.escrow)}, not by this site.</p>
        <button type="submit" className="btn btn-ref justify-center" disabled={busy || !valid}>
          Authorize with passkey
        </button>
      </aside>
    </form>
  );
}

function RevealKey({ reveal, onDone }: { reveal: { env: string; name: string }; onDone: () => void }) {
  const href = useMemo(() => `data:text/plain;charset=utf-8,${encodeURIComponent(`${reveal.env}\n`)}`, [reveal.env]);
  return (
    <section className="panel flex flex-col gap-4 border-ref-dim p-6" aria-live="polite">
      <p className="label text-ref">{reveal.name} is live. Its key is shown once.</p>
      <p className="max-w-[70ch] text-[14px] text-fg-2">
        Put these lines in the agent&rsquo;s secret store. This page keeps no copy: once you close this panel the key exists only where you saved it. Lost it? Revoke the agent and create another.
      </p>
      <pre className="code overflow-x-auto whitespace-pre text-[12px]">{reveal.env}</pre>
      <div className="flex flex-wrap gap-3">
        <CopyButton value={reveal.env} label="Copy the agent's environment">
          <span className="btn">Copy</span>
        </CopyButton>
        <a className="btn" href={href} download={`${reveal.name}.env`}>
          Download .env
        </a>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          I&rsquo;ve stored it
        </button>
      </div>
    </section>
  );
}

function AgentCard({
  agent,
  owner: ownerAddress,
  agents,
  activity,
  busy,
  onRevoke,
  onBudget,
}: {
  agent: AgentKey;
  owner: string;
  agents: Map<string, AgentKey>;
  activity: Activity | null;
  busy: boolean;
  onRevoke: () => Promise<void>;
  onBudget: (limit: bigint) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const mine = (activity?.entries ?? []).filter((entry) => entry.self && entry.signer?.keyId?.toLowerCase() === agent.keyId.toLowerCase());
  const steps = activity ? (activity.byKey[agent.keyId] ?? Object.entries(activity.byKey).find(([key]) => key.toLowerCase() === agent.keyId.toLowerCase())?.[1] ?? 0) : null;
  const [value, setValue] = useState('');
  const dead = agent.revoked || agent.expired;
  return (
    <article className={`flex flex-col gap-4 bg-panel p-5 ${dead ? 'opacity-55' : ''}`}>
      <header className="flex items-start gap-4">
        <KeyGlyph keyId={agent.keyId} role={agent.role} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[17px]">{agent.name ?? 'Unnamed key'}</h3>
            <StatusChip agent={agent} />
          </div>
          <p className={`label ${agent.role ? ROLE_TONE[agent.role].text : ''}`}>{agent.role ? ROLE_TONE[agent.role].label : 'role unknown'}</p>
          <span className="flex items-center gap-2 font-mono text-[11.5px] text-fg-3">
            key {shortHash(agent.keyId, 8, 6)} <CopyButton value={agent.keyId} label="Copy key id" />
          </span>
        </div>
      </header>
      <BudgetMeter remaining={agent.remaining} limit={agent.limit} period={agent.period} periodEnd={agent.periodEnd} />
      <dl className="grid grid-cols-2 gap-3 font-mono text-[12px]">
        <div>
          <dt className="label">expiry</dt>
          <dd className="mt-1 text-fg-2">{expiryText(agent.expiry, undefined, agent.revoked)}</dd>
        </div>
        <div>
          <dt className="label">spent so far</dt>
          <dd className="mt-1 text-fg-2" title="Allowance raised to the escrow, as the keychain meters it">{amount(agent.spent)} αUSD</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={showActivity}
          onClick={() => setShowActivity(!showActivity)}
          className={`chip cursor-pointer transition-colors hover:border-ref-dim hover:text-ref ${showActivity ? 'chip-ref' : ''}`}
        >
          {showActivity ? '−' : '+'} activity {steps === null ? '…' : `· ${steps} step${steps === 1 ? '' : 's'}`}
        </button>
        <JsonDisclosure value={agent} label="keychain record" summaryText="keychain record" />
      </div>
      {showActivity ? (
        <ActivityFeed entries={mine} me={ownerAddress} agents={agents} limit={5} compact emptyText="This key has not signed anything on Tempex yet." />
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t hairline pt-4">
        {agent.revokedAt ? (
          <a className="link font-mono text-[11px] text-fail" href={txUrl(agent.revokedAt.tx)} target="_blank" rel="noreferrer">
            revoked {shortHash(agent.revokedAt.tx, 8, 4)} ↗
          </a>
        ) : (
          <AuthorizedLink tx={agent.authorized.tx} />
        )}
        {!dead ? (
          <div className="flex flex-wrap gap-2">
            {editing ? (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (/^\d+(\.\d{1,6})?$/.test(value)) void onBudget(tokenAmount(value)).then(() => setEditing(false));
                }}
              >
                <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="αUSD" inputMode="decimal" className="panel-sunk w-24 px-2 py-1.5 font-mono text-[12px]" />
                <button type="submit" className="btn px-3 py-1.5 text-[12px]" disabled={busy}>
                  Set
                </button>
              </form>
            ) : agent.role !== 'seller' ? (
              <button type="button" className="btn px-3 py-1.5 text-[12px]" disabled={busy} onClick={() => setEditing(true)}>
                Set budget
              </button>
            ) : null}
            <button type="button" className="btn px-3 py-1.5 text-[12px] text-fail" disabled={busy} onClick={() => void onRevoke()}>
              Revoke
            </button>
          </div>
        ) : null}
      </footer>
    </article>
  );
}

function HowItWorks() {
  const steps = [
    { n: '01', title: 'The agent asks', body: 'It makes its own key and sends a signed request: a name, a role and a budget. The private key never leaves the agent.' },
    { n: '02', title: 'You approve with your passkey', body: 'One prompt authorizes that key on your Tempo account, with a budget per period, an expiry and calls limited to the Tempex escrow.' },
    { n: '03', title: 'Tempo enforces it', body: 'The keychain meters every approval, refuses any other call and stops the key at expiry. Earnings land in your account. Revoke in one tap.' },
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
