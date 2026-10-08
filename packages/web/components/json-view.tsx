'use client';

import { useMemo, useState, type ReactNode } from 'react';

import { CopyButton } from './copy';

/// The raw record behind anything an agent touched, as a collapsible tree. Every
/// value is shown in full (no truncation), hashes and addresses are selectable,
/// and the whole document copies as formatted JSON. Colors follow the site's
/// parties: strings in ref mint, numbers in bolt blue, booleans in pip amber.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function JsonView({
  value,
  label = 'json',
  depth = 2,
  maxHeight = 420,
  caption,
  focus,
}: {
  value: unknown;
  label?: string;
  /// How many levels open on first render.
  depth?: number;
  /// Paths that open regardless of depth, e.g. ['calls', 'calls.*', 'calls.*.args'];
  /// `*` matches any one key or index.
  focus?: string[];
  maxHeight?: number;
  caption?: ReactNode;
}) {
  const data = useMemo(() => normalize(value), [value]);
  const text = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const [generation, setGeneration] = useState(0);
  const [openDepth, setOpenDepth] = useState(depth);
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');

  return (
    <div className="panel-sunk flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b hairline px-3 py-2">
        <span className="label flex items-center gap-2">
          <span className="text-ref">{'{ }'}</span> {label}
          {caption ? <span className="normal-case tracking-normal text-fg-3">· {caption}</span> : null}
        </span>
        <span className="flex items-center gap-1">
          <button type="button" className="tab" aria-pressed={mode === 'tree'} aria-selected={mode === 'tree'} onClick={() => setMode('tree')}>
            tree
          </button>
          <button type="button" className="tab" aria-pressed={mode === 'raw'} aria-selected={mode === 'raw'} onClick={() => setMode('raw')}>
            raw
          </button>
          {mode === 'tree' ? (
            <>
              <button type="button" className="tab" onClick={() => { setOpenDepth(99); setGeneration((g) => g + 1); }}>
                expand
              </button>
              <button type="button" className="tab" onClick={() => { setOpenDepth(0); setGeneration((g) => g + 1); }}>
                collapse
              </button>
            </>
          ) : null}
          <CopyButton value={text} label={`Copy ${label} as JSON`}>
            <span className="tab inline-block">copy</span>
          </CopyButton>
        </span>
      </div>
      <div className="overflow-auto px-3 py-2.5 font-mono text-[12px] leading-[1.75]" style={{ maxHeight }}>
        {mode === 'raw' ? (
          <pre className="whitespace-pre text-[#d6d6d0]">{text}</pre>
        ) : (
          <Node key={generation} name={null} value={data} level={0} openDepth={openDepth} focus={generation === 0 ? (focus ?? []) : []} path={[]} last />
        )}
      </div>
    </div>
  );
}

function Node({ name, value, level, openDepth, focus, path, last }: { name: string | null; value: Json; level: number; openDepth: number; focus: string[]; path: string[]; last: boolean }) {
  const [open, setOpen] = useState(level < openDepth || focus.some((pattern) => matches(pattern, path)));
  const comma = last ? '' : ',';
  const key = name === null ? null : (
    <>
      <span className="text-fg-2">&quot;{name}&quot;</span>
      <span className="text-fg-3">: </span>
    </>
  );

  if (value === null || typeof value !== 'object') {
    return (
      <div className="whitespace-pre-wrap break-all" style={{ paddingLeft: level ? 16 : 0 }}>
        {key}
        <Scalar value={value} />
        <span className="text-fg-3">{comma}</span>
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, Json][] = isArray ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  const [openBrace, closeBrace] = isArray ? ['[', ']'] : ['{', '}'];

  if (entries.length === 0) {
    return (
      <div style={{ paddingLeft: level ? 16 : 0 }}>
        {key}
        <span className="text-fg-3">{openBrace}{closeBrace}{comma}</span>
      </div>
    );
  }

  return (
    <div style={{ paddingLeft: level ? 16 : 0 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group -ml-3.5 inline-flex items-baseline text-left hover:text-fg"
      >
        <span className={`inline-block w-3.5 text-[9px] text-fg-3 transition-transform group-hover:text-ref ${open ? 'rotate-90' : ''}`} aria-hidden>
          ▶
        </span>
        <span>
          {key}
          <span className="text-fg-3">{openBrace}</span>
          {!open ? (
            <span className="text-fg-3">
              {' '}
              <span className="text-fg-3/80 italic">{isArray ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : summary(entries)}</span> {closeBrace}
              {comma}
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <>
          <div className="border-l border-line">
            {entries.map(([childKey, child], index) => (
              <Node key={childKey} name={isArray ? null : childKey} value={child} level={level + 1} openDepth={openDepth} focus={focus} path={[...path, childKey]} last={index === entries.length - 1} />
            ))}
          </div>
          <span className="text-fg-3">{closeBrace}{comma}</span>
        </>
      ) : null}
    </div>
  );
}

function Scalar({ value }: { value: null | boolean | number | string }) {
  if (value === null) return <span className="text-fg-3">null</span>;
  if (typeof value === 'boolean') return <span className="text-pip">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-bolt">{value}</span>;
  // Hex (hashes, addresses, calldata) reads as data, prose as prose.
  if (/^0x[0-9a-fA-F]*$/.test(value)) return <span className="select-all text-ref">&quot;{value}&quot;</span>;
  if (/^\d+$/.test(value) && value.length > 6) return <span className="text-bolt">&quot;{value}&quot;</span>;
  return <span className="text-[#cfe9dc]">&quot;{value}&quot;</span>;
}

function matches(pattern: string, path: string[]): boolean {
  const parts = pattern.split('.');
  return parts.length === path.length && parts.every((part, index) => part === '*' || part === path[index]);
}

function summary(entries: [string, Json][]): string {
  const keys = entries.map(([key]) => key);
  const shown = keys.slice(0, 3).join(', ');
  return keys.length > 3 ? `${shown}, +${keys.length - 3}` : shown;
}

/// bigints become decimal strings, undefined is dropped, Dates become ISO.
function normalize(value: unknown): Json {
  if (value === undefined) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return String(value);
}

/// A disclosure that reveals a JsonView, for rows where the record is secondary.
export function JsonDisclosure({ value, label, summaryText = 'json', depth = 2 }: { value: unknown; label?: string; summaryText?: string; depth?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`chip w-fit cursor-pointer transition-colors hover:border-ref-dim hover:text-ref ${open ? 'chip-ref' : ''}`}
      >
        <span aria-hidden>{open ? '−' : '+'}</span> {'{ }'} {summaryText}
      </button>
      {open ? <JsonView value={value} label={label ?? summaryText} depth={depth} /> : null}
    </div>
  );
}
