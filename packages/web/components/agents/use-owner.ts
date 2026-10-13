'use client';

import { useCallback, useEffect, useState } from 'react';

import { requestTestnetFunds } from '@/lib/faucet';
import * as owner from '@/lib/owner';

export type OwnerState = {
  session: owner.OwnerSession | null;
  balance: bigint | null;
  busy: string | null;
  error: string | null;
  canPasskey: boolean;
  remembered: boolean;
  signIn: (kind: 'passkey' | 'existing' | 'device') => Promise<void>;
  /// Set once the page has checked for a remembered passkey.
  ready: boolean;
  signOut: () => void;
  refreshBalance: () => Promise<void>;
  fund: () => Promise<void>;
  run: <T>(label: string, action: () => Promise<T>) => Promise<T | undefined>;
};

/// One owner session per page. Every action goes through `run`: one busy label,
/// one error line, no double submits.
export function useOwner(protocol: owner.Protocol): OwnerState {
  const [session, setSession] = useState<owner.OwnerSession | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canPasskey, setCanPasskey] = useState(false);
  const [remembered, setRemembered] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setCanPasskey(owner.passkeysAvailable());
    setRemembered(owner.rememberedPasskey() !== null);
    // A passkey this device already knows signs back in without a prompt.
    const restored = owner.restoreSession(protocol);
    if (restored) setSession(restored);
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(async <T,>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(friendly(caught));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    if (session) setBalance(await session.tempex.tokenBalance());
  }, [session]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const signIn = useCallback(
    async (kind: 'passkey' | 'existing' | 'device') => {
      const next = await run(kind === 'device' ? 'Creating a device key' : kind === 'existing' ? 'Choose your passkey' : 'Waiting for your passkey', () =>
        kind === 'passkey'
          ? owner.signInWithPasskey(protocol)
          : kind === 'existing'
            ? owner.signInWithExistingPasskey(protocol, (address) => owner.hasFootprint(address, protocol))
            : owner.signInWithDeviceKey(protocol),
      );
      if (next) {
        setSession(next);
        setRemembered(owner.rememberedPasskey() !== null);
      }
    },
    [protocol, run],
  );

  const fund = useCallback(async () => {
    if (!session) return;
    await run('Asking the testnet faucet', async () => {
      await requestTestnetFunds(session.tempex, session.address);
      for (let i = 0; i < 30; i += 1) {
        const value = await session.tempex.tokenBalance();
        if (value > (balance ?? 0n)) {
          setBalance(value);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    });
  }, [balance, run, session]);

  return {
    session,
    balance,
    busy,
    error,
    canPasskey,
    remembered,
    signIn,
    ready,
    signOut: () => {
      if (session?.kind === 'passkey') owner.markSignedOut(true);
      setSession(null);
      setBalance(null);
    },
    refreshBalance,
    fund,
    run,
  };
}

/// Chain errors are long; owners need the reason, not the stack.
export function friendly(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  if (/NotAllowedError|The operation either timed out or was not allowed/i.test(message)) return 'The passkey prompt was dismissed. Nothing was signed.';
  if (/KeyAlreadyExists/i.test(message)) return 'That key is already authorized on this account.';
  if (/SpendingLimitExceeded/i.test(message)) return 'That would exceed the agent’s budget.';
  if (/KeyNotFound/i.test(message)) return 'That key is not authorized on this account.';
  const reason = message.split('\n').find((line) => /reason:|Details:/i.test(line));
  return (reason ?? message.split('\n')[0] ?? message).replace(/^.*?(reason:|Details:)\s*/i, '').slice(0, 300);
}
