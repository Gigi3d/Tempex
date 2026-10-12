/// A seller's standing offer, carried entirely in a link: what it will do, what
/// counts as done, the price and the windows. No server stores it; whoever opens
/// the link sees exactly what the seller wrote, and the job form opens prefilled.
/// The offer itself binds nobody: the buyer's terms, filed and hashed when the
/// job opens, are what the escrow holds both sides to.

export type OfferCriterion = { text: string; kind: 'unchecked' | 'contains' | 'count' | 'language'; value: string; weight: number };

export type Offer = {
  v: 1;
  seller: `0x${string}`;
  title: string;
  spec: string;
  criteria: OfferCriterion[];
  /// decimal αUSD
  amount: string;
  deliverySeconds: number;
  reviewSeconds: number;
};

const KINDS = new Set(['unchecked', 'contains', 'count', 'language']);
const MAX_LINK_CHARS = 6_000;

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
}

export function encodeOffer(offer: Offer): string {
  return toBase64Url(JSON.stringify(offer));
}

/// Anything that is not a well-formed offer reads as no offer at all.
export function decodeOffer(value: string | null | undefined): Offer | null {
  if (!value || value.length > MAX_LINK_CHARS) return null;
  try {
    const raw = JSON.parse(fromBase64Url(value)) as Partial<Offer>;
    if (raw.v !== 1 || typeof raw.seller !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw.seller)) return null;
    if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 200) return null;
    if (typeof raw.spec !== 'string' || !raw.spec.trim() || raw.spec.length > 4_000) return null;
    if (typeof raw.amount !== 'string' || !/^\d+(\.\d{1,6})?$/.test(raw.amount)) return null;
    if (!Array.isArray(raw.criteria) || raw.criteria.length === 0 || raw.criteria.length > 20) return null;
    const criteria = raw.criteria.map((c) => ({
      text: String(c?.text ?? '').slice(0, 300),
      kind: (KINDS.has(String(c?.kind)) ? c!.kind : 'unchecked') as OfferCriterion['kind'],
      value: String(c?.value ?? '').slice(0, 200),
      weight: Math.max(1, Math.min(10, Number(c?.weight) || 1)),
    }));
    if (criteria.some((c) => !c.text.trim())) return null;
    const seconds = (n: unknown, fallback: number) => (Number.isSafeInteger(n) && (n as number) >= 3_600 && (n as number) <= 30 * 86_400 ? (n as number) : fallback);
    return {
      v: 1,
      seller: raw.seller as `0x${string}`,
      title: raw.title.trim(),
      spec: raw.spec.trim(),
      criteria,
      amount: raw.amount,
      deliverySeconds: seconds(raw.deliverySeconds, 3 * 86_400),
      reviewSeconds: seconds(raw.reviewSeconds, 86_400),
    };
  } catch {
    return null;
  }
}

/// The same job, opened by an agent from the command line.
export function agentCommand(offer: Offer): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    'tempex-agent open',
    `--seller ${offer.seller}`,
    `--amount ${offer.amount}`,
    `--title ${quote(offer.title)}`,
    `--terms ${quote(offer.spec)}`,
    `--criteria ${quote(offer.criteria.map((c) => c.text).join(' | '))}`,
    `--hours ${Math.round(offer.deliverySeconds / 3600)}`,
  ].join(' \\\n  ');
}
