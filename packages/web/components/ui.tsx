import Link from 'next/link';
import type { ReactNode } from 'react';

import { addressUrl, ago, shortHash, txUrl } from '@/lib/format';

import { CopyButton } from './copy';

export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2" aria-label="Tempex">
      <span
        aria-hidden
        className="grid place-items-center bg-ref text-ink"
        style={{ width: size + 4, height: size + 4, fontFamily: 'var(--font-mark)', fontStyle: 'italic', fontWeight: 800, fontSize: size * 0.82 }}
      >
        X
      </span>
      <span style={{ fontFamily: 'var(--font-mark)', fontStyle: 'italic', fontWeight: 800, fontSize: size, letterSpacing: '-0.02em' }}>
        TEMPEX
      </span>
    </span>
  );
}

export function Eyebrow({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'ref' | 'pip' | 'bolt' }) {
  const color = tone === 'ref' ? 'text-ref' : tone === 'pip' ? 'text-pip' : tone === 'bolt' ? 'text-bolt' : 'text-fg-3';
  return <p className={`label ${color}`}>{children}</p>;
}

export function Chip({ children, tone = 'plain', title }: { children: ReactNode; tone?: 'plain' | 'ref' | 'pip' | 'bolt' | 'fail'; title?: string }) {
  const cls = tone === 'plain' ? 'chip' : `chip chip-${tone}`;
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

export function SourceChip({ source, asOf }: { source: 'live' | 'snapshot'; asOf: string }) {
  return source === 'live' ? (
    <Chip tone="ref" title="Read from the beacon just now">
      <span className="square" aria-hidden /> live
    </Chip>
  ) : (
    <Chip tone="pip" title="The beacon did not answer; this is the baked snapshot">
      <span className="square" aria-hidden /> snapshot · {ago(asOf)}
    </Chip>
  );
}

/// A hash or address, shortened, with copy and an explorer link where one exists.
export function Hash({ value, kind = 'plain', head = 6, tail = 4 }: { value: string; kind?: 'tx' | 'address' | 'plain'; head?: number; tail?: number }) {
  const href = kind === 'tx' ? txUrl(value) : kind === 'address' ? addressUrl(value) : null;
  const text = shortHash(value, head, tail);
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] text-fg-2" title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="hover:text-fg underline decoration-line-2 underline-offset-4 hover:decoration-ref">
          {text}
        </a>
      ) : (
        <span>{text}</span>
      )}
      <CopyButton value={value} label={`Copy ${value}`} />
    </span>
  );
}

export function SectionHead({ eyebrow, title, children, tone }: { eyebrow: string; title: ReactNode; children?: ReactNode; tone?: 'ref' | 'pip' | 'bolt' }) {
  return (
    <div className="flex flex-col gap-3">
      <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
      <h2 className="h2">{title}</h2>
      {children ? <p className="lede">{children}</p> : null}
    </div>
  );
}

export function Stat({ label, value, sub, href }: { label: string; value: ReactNode; sub?: ReactNode; href?: string }) {
  const body = (
    <>
      <p className="label">{label}</p>
      <p className="mt-2 font-mono text-[26px] font-light num tracking-tight">{value}</p>
      {sub ? <p className="mt-1 text-[12.5px] text-fg-3">{sub}</p> : null}
    </>
  );
  return href ? (
    <Link href={href} className="block p-5 hover:bg-panel transition-colors">
      {body}
    </Link>
  ) : (
    <div className="p-5">{body}</div>
  );
}

export function ArrowUpRight({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M5 11L11 5M6 5h5v5" />
    </svg>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1">
      {children}
      <ArrowUpRight />
    </a>
  );
}

export function Notice({ tone = 'pip', children }: { tone?: 'pip' | 'fail' | 'ref'; children: ReactNode }) {
  const border = tone === 'fail' ? 'border-l-fail' : tone === 'ref' ? 'border-l-ref' : 'border-l-pip';
  return <div className={`panel border-l-2 ${border} px-4 py-3 text-[14px] text-fg-2`}>{children}</div>;
}
