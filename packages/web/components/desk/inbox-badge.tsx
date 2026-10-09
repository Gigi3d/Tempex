'use client';

import { useEffect, useState } from 'react';

import { keyIdOf } from '@tempex/sdk/browser';

import type { JobRecord } from '@/lib/types';
import { inbox } from '@/lib/workflow';

/// How many things wait on the owner this browser remembers, beside the nav link.
/// Read-only and prompt-free: the address comes from the passkey's public key.
export function InboxBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let signedOut = false;
    try {
      signedOut = sessionStorage.getItem('tempex.owner.signedOut') === '1';
    } catch {
      signedOut = false;
    }
    // Read directly rather than through lib/owner, which would put the whole
    // signing client into every page's bundle for a number.
    let stored: { publicKey?: `0x${string}` } | null = null;
    try {
      stored = JSON.parse(localStorage.getItem('tempex.owner.passkey') ?? 'null');
    } catch {
      stored = null;
    }
    if (!stored?.publicKey || signedOut) return;
    const address = keyIdOf(stored.publicKey);
    let live = true;
    const check = async () => {
      try {
        const response = await fetch(`/api/jobs?address=${address}`, { cache: 'no-store' });
        if (!response.ok) return;
        const { jobs } = (await response.json()) as { jobs: JobRecord[] };
        if (live) setCount(inbox(jobs, address).length);
      } catch {
        // the badge is a convenience; stay quiet
      }
    };
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (count === 0) return null;
  return (
    <span className="ml-1.5 inline-grid min-w-[18px] place-items-center bg-ref px-1 font-mono text-[10.5px] font-semibold leading-[18px] text-ink" aria-label={`${count} waiting on you`}>
      {count}
    </span>
  );
}
