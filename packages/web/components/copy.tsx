'use client';

import { useState } from 'react';

/// Copies a value; falls back to selecting nothing and showing the value when the
/// clipboard is refused (some embedded browsers do).
export function CopyButton({ value, label, children }: { value: string; label: string; children?: React.ReactNode }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      aria-label={label}
      title={state === 'failed' ? value : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState('copied');
        } catch {
          setState('failed');
        }
        setTimeout(() => setState('idle'), 1400);
      }}
      className="inline-flex items-center gap-1 text-fg-3 hover:text-ref transition-colors"
    >
      {children}
      {state === 'copied' ? (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M3 8.5l3 3 7-7" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <rect x="5" y="5" width="8" height="8" />
          <path d="M3 10V3h7" />
        </svg>
      )}
      <span className="sr-only" aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </button>
  );
}
