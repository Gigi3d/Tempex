'use client';

import { amount, shortHash } from '@/lib/format';

import { CopyButton } from '../copy';
import type { OwnerState } from './use-owner';

/// Who is signed in, and how. A passkey account is the real thing; a device key
/// is labelled as the throwaway it is.
export function OwnerBar({ owner, faucet = true }: { owner: OwnerState; faucet?: boolean }) {
  if (!owner.session) {
    return (
      <div className="panel flex flex-col gap-5 p-6 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1.5">
          <p className="label text-ref">Owner account</p>
          <p className="max-w-[56ch] text-[14px] leading-relaxed text-fg-2">
            Your passkey is your Tempo account: no seed phrase, no extension. Agents act for it through keys it authorizes and can revoke.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {owner.canPasskey ? (
            <button type="button" className="btn btn-primary" disabled={!!owner.busy} onClick={() => void owner.signIn('passkey')}>
              {owner.remembered ? 'Sign in with passkey' : 'Create owner passkey'}
            </button>
          ) : null}
          <button type="button" className="btn" disabled={!!owner.busy} onClick={() => void owner.signIn('device')}>
            {owner.canPasskey ? 'Use a device key (testing)' : 'Use a device key'}
          </button>
        </div>
      </div>
    );
  }
  const { session } = owner;
  return (
    <div className="panel flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-4">
        <div className="grid h-11 w-11 place-items-center border border-ref-dim bg-ink-2 font-mono text-[11px] text-ref" aria-hidden>
          {session.kind === 'passkey' ? 'KEY' : 'DEV'}
        </div>
        <div className="flex flex-col">
          <p className="label">{session.kind === 'passkey' ? 'Signed in with passkey' : 'Device key, gone when this tab closes'}</p>
          <span className="flex items-center gap-2 font-mono text-[14px]">
            {shortHash(session.address, 10, 8)} <CopyButton value={session.address} label="Copy owner address" />
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[13px] text-fg-2">{owner.balance === null ? '…' : `${amount(owner.balance)} αUSD`}</span>
        {faucet ? (
          <button type="button" className="btn" disabled={!!owner.busy} onClick={() => void owner.fund()}>
            Testnet faucet
          </button>
        ) : null}
        <button type="button" className="btn" onClick={owner.signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
