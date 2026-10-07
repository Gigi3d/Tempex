'use client';

import { useState } from 'react';

import type { Ready } from '@/lib/types';

export function ReadyCheck({ example }: { example: string }) {
  const [address, setAddress] = useState(example);
  const [role, setRole] = useState<'seller' | 'buyer'>('seller');
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; ready?: Ready; error?: string }>({ status: 'idle' });

  async function check(event: React.FormEvent) {
    event.preventDefault();
    setState({ status: 'loading' });
    try {
      const response = await fetch(`/api/ready?role=${role}&address=${encodeURIComponent(address.trim())}`);
      const body = (await response.json()) as Ready & { error?: string };
      if (!response.ok) setState({ status: 'error', error: body.error ?? 'The check failed.' });
      else setState({ status: 'done', ready: body });
    } catch {
      setState({ status: 'error', error: 'The check could not reach the server.' });
    }
  }

  const ready = state.ready;
  const yes = ready?.verdict.startsWith('ready');
  return (
    <form onSubmit={check} className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <label htmlFor="ready-address" className="sr-only">
          Address
        </label>
        <input
          id="ready-address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          spellCheck={false}
          className="min-w-0 flex-1 border hairline bg-ink-2 px-3 py-2.5 font-mono text-[13px] text-fg outline-none focus:border-ref"
          placeholder="0x…"
        />
        <label htmlFor="ready-role" className="sr-only">
          Role
        </label>
        <select id="ready-role" value={role} onChange={(event) => setRole(event.target.value as 'seller' | 'buyer')} className="border hairline bg-ink-2 px-3 py-2.5 text-[13px]">
          <option value="seller">as seller</option>
          <option value="buyer">as buyer</option>
        </select>
        <button type="submit" className="btn btn-primary" disabled={state.status === 'loading'}>
          {state.status === 'loading' ? 'Checking…' : 'Can it start now?'}
        </button>
      </div>
      <div aria-live="polite">
        {state.status === 'error' ? <p className="text-[14px] text-fail">{state.error}</p> : null}
        {ready ? (
          <div className="flex flex-col gap-2 border hairline p-4">
            <p className={`font-mono text-[15px] ${yes ? 'text-ref' : 'text-pip'}`}>
              {yes ? '✓ yes' : '✕ not yet'} · {ready.verdict}
            </p>
            <p className="text-[13px] text-fg-2">
              nonce {ready.onChain.nonce} · balance {ready.onChain.tokenBalance.value} αUSD · reputation {ready.reputation.score} ({ready.reputation.band})
            </p>
            {ready.blockers.map((blocker) => (
              <p key={blocker} className="text-[13px] text-pip">
                {blocker}
              </p>
            ))}
            {ready.nextActions.map((action) => (
              <p key={action} className="text-[13px] text-fg-2">
                → {action}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </form>
  );
}
