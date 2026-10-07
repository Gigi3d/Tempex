import { EXPLORER_URL, TOKEN_DECIMALS, formatToken } from '@tempex/sdk/browser';

/// 25000000 units → "25.00" in prose, "25.000000" in ledger contexts.
export function amount(units: string | bigint | number, mode: 'prose' | 'ledger' = 'prose'): string {
  const value = typeof units === 'bigint' ? units : BigInt(units);
  if (mode === 'ledger') {
    const base = 10n ** BigInt(TOKEN_DECIMALS);
    const whole = value / base;
    const fraction = (value % base).toString().padStart(TOKEN_DECIMALS, '0');
    return `${whole}.${fraction}`;
  }
  const [whole = '0', fraction = ''] = formatToken(value).split('.');
  return `${Number(whole).toLocaleString('en-US')}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

export const pct = (bps: number): string => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
export const bps = (value: number): string => `${value} bps`;

export function shortHash(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export const txUrl = (hash: string): string => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (address: string): string => `${EXPLORER_URL}/address/${address}`;

export function utc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function ago(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

export function until(seconds: number, now: number = Date.now() / 1000): string {
  const left = Math.round(seconds - now);
  if (left <= 0) return 'passed';
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export const STAGE_LABEL: Record<string, string> = {
  created: 'Created',
  funded: 'Funded',
  delivered: 'Delivered',
  accepted: 'Accepted',
  disputed: 'Disputed',
  responded: 'Responded',
  resolved: 'Ruled',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
  lapsed: 'Lapsed',
};

export function stageTone(stage: string): 'ref' | 'pip' | 'bolt' | 'fail' | 'plain' {
  if (stage === 'resolved' || stage === 'accepted') return 'ref';
  if (stage === 'disputed' || stage === 'responded') return 'pip';
  if (stage === 'funded' || stage === 'delivered') return 'bolt';
  if (stage === 'refunded' || stage === 'cancelled' || stage === 'lapsed') return 'fail';
  return 'plain';
}

/// Decodes a data: URI deliverable (how the demo pins its deliverable on chain).
export function decodeDataUri(uri: string | undefined): string | null {
  if (!uri?.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  if (meta.endsWith(';base64')) {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(payload);
}
