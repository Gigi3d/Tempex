'use client';

import { useState } from 'react';

const EXAMPLES: Record<string, Record<string, unknown>> = {
  accept: { jobId: '2' },
  'auto-accept': { jobId: '2' },
  deliver: { jobId: '2', deliverable: '{"locale":"fr-FR"}', uri: 'data:application/json,{"locale":"fr-FR"}' },
  dispute: { jobId: '2', evidence: { claim: 'The checkout screens are missing.' }, buyerOfferBps: 2500 },
  respond: { jobId: '2', response: { statement: 'Six of eight strings shipped.' }, sellerAskBps: 5000 },
  'create-and-fund': {
    buyer: '0x8CAb45977CF5576A7d19363225E4F98D7D884bC4',
    seller: '0x7798Af822DE1D5F0c0340895B07d804019E7ca64',
    amount: '25',
    terms: { title: 'French checkout locale' },
    policy: 'standard',
  },
  'settle-lapsed': { jobId: '2' },
  'refund-expired': { jobId: '2' },
  withdraw: {},
  'list-arbiter': { feeBps: 150, metadataURI: 'https://example.com/arbiter.json' },
};

type Blueprint = {
  intent?: string;
  signer?: string;
  calls?: { to: string; data: string }[];
  decoded?: { contract: string; function: string; args: Record<string, unknown> }[];
  prerequisites?: unknown[];
  error?: string;
  message?: string;
  hint?: string;
};

export function BlueprintBuilder() {
  const [action, setAction] = useState('dispute');
  const [params, setParams] = useState(JSON.stringify(EXAMPLES['dispute'], null, 2));
  const [result, setResult] = useState<Blueprint | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function pick(next: string) {
    setAction(next);
    setParams(JSON.stringify(EXAMPLES[next] ?? {}, null, 2));
    setResult(null);
    setProblem(null);
  }

  async function build(event: React.FormEvent) {
    event.preventDefault();
    setProblem(null);
    let body: unknown;
    try {
      body = JSON.parse(params);
    } catch {
      setProblem('The parameters are not valid JSON. Check for a missing quote or comma.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/blueprint/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await response.json()) as Blueprint;
      if (!response.ok || data.error) setProblem([data.message ?? data.error, data.hint].filter(Boolean).join(' '));
      setResult(response.ok && !data.error ? data : null);
    } catch {
      setProblem('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={build} className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        <label htmlFor="bp-action" className="label">
          Intent
        </label>
        <select id="bp-action" value={action} onChange={(event) => pick(event.target.value)} className="border hairline bg-ink-2 px-3 py-2.5 font-mono text-[13px]">
          {Object.keys(EXAMPLES).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label htmlFor="bp-params" className="label mt-2">
          Parameters (JSON)
        </label>
        <textarea
          id="bp-params"
          value={params}
          onChange={(event) => setParams(event.target.value)}
          spellCheck={false}
          rows={10}
          className="code min-h-[220px] resize-y outline-none focus:border-ref"
        />
        <button type="submit" className="btn btn-primary w-fit" disabled={busy}>
          {busy ? 'Building…' : 'Build calldata'}
        </button>
        <p className="text-[12.5px] text-fg-3">The beacon encodes the calls. Nothing is signed or sent from this page.</p>
      </div>
      <div className="flex min-w-0 flex-col gap-3" aria-live="polite">
        <p className="label">Blueprint</p>
        {problem ? <p className="border border-fail-dim px-4 py-3 text-[14px] text-fail">{problem}</p> : null}
        {result ? (
          <div className="flex flex-col gap-4">
            <p className="text-[15px]">{result.intent}</p>
            <p className="text-[13px] text-fg-3">signed by the {result.signer}</p>
            {result.decoded?.map((call, index) => (
              <div key={index} className="panel-sunk p-4">
                <p className="font-mono text-[13px]">
                  <span className="text-fg-3">{call.contract}.</span>
                  <span className="text-ref">{call.function}</span>(
                </p>
                {Object.entries(call.args).map(([name, value]) => (
                  <p key={name} className="pl-4 font-mono text-[12.5px] text-fg-2 break-all">
                    {name}: <span className="text-fg">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
                  </p>
                ))}
                <p className="font-mono text-[13px]">)</p>
                <p className="mt-2 font-mono text-[11px] text-fg-3 break-all">
                  to {result.calls?.[index]?.to} · data {result.calls?.[index]?.data.slice(0, 74)}…
                </p>
              </div>
            ))}
          </div>
        ) : !problem ? (
          <p className="text-[14px] text-fg-3">Pick an intent and build it to see the decoded calls and raw calldata.</p>
        ) : null}
      </div>
    </form>
  );
}
