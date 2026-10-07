import { hashCanonical, hashText, type Criterion, type EvidenceBundle, type Job, type JobTerms, type SellerResponse } from '@tempex/sdk';
import type { Address, Hex } from 'viem';

import { analyze } from '../src/rules.js';

export const BUYER = `0x${'11'.repeat(20)}` as Address;
export const SELLER = `0x${'22'.repeat(20)}` as Address;
const ZERO = `0x${'00'.repeat(32)}` as Hex;

const MONTHS = 'janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre';

/// The localization brief the audit's failures were found on, as typed checks.
export const BRIEF: Criterion[] = [
  { id: 'keys', text: 'Every checkout and email string in the brief is delivered', weight: 3,
    check: { type: 'jsonKeys', at: '/strings', keys: ['cart.title', 'checkout.title', 'checkout.submit', 'email.subject'] } },
  { id: 'french', text: 'The strings are written in French', weight: 2, check: { type: 'language', at: '/strings', is: 'fr' } },
  { id: 'prices', text: 'Prices use the French format, e.g. 12,50 €', weight: 2, check: { type: 'regex', at: '/prices', pattern: '^\\d+,\\d{2} €$' } },
  { id: 'dates', text: 'Dates use the French long format, e.g. 7 octobre 2026', weight: 1,
    check: { type: 'regex', at: '/dates', pattern: `^\\d{1,2} (${MONTHS}) \\d{4}$` } },
  { id: 'glossary', text: 'The supplied glossary terms are used', weight: 1, check: { type: 'contains', at: '/strings', all: ['Valider la commande'] } },
  { id: 'tone', text: 'The copy reads naturally to a French shopper', weight: 1 },
];

/// Honest, complete work. Its wording shares almost nothing with the criteria,
/// which is what defeated keyword scoring.
export const HONEST_WORK = JSON.stringify({
  strings: {
    'cart.title': 'Votre panier',
    'checkout.title': 'Paiement sécurisé',
    'checkout.submit': 'Valider la commande',
    'email.subject': 'Merci ! Votre commande est confirmée',
  },
  prices: { total: '12,50 €', shipping: '4,00 €' },
  dates: { placed: '7 octobre 2026' },
});

export function terms(criteria: Criterion[] = BRIEF): JobTerms {
  return {
    title: 'Checkout localization',
    deliverableSpec: 'locales/fr-FR.json for the checkout flow',
    acceptanceCriteria: criteria,
    amount: '25.00',
    buyer: BUYER,
    seller: SELLER,
  };
}

/// A case whose on-chain commitment is `delivered`, with the buyer handing in
/// `buyerCopy` (which may differ: that is the fabrication attack).
export function caseFor(input: {
  delivered: string;
  buyerCopy?: string;
  criteria?: Criterion[];
  response?: SellerResponse;
  disputedAt?: number;
}): { job: Job; terms: JobTerms; bundle: EvidenceBundle; response?: SellerResponse } {
  const t = terms(input.criteria);
  const deliverableHash = hashText(input.delivered);
  const buyerCopy = input.buyerCopy ?? input.delivered;
  const bundle: EvidenceBundle = {
    version: 1,
    jobId: 1,
    termsHash: hashCanonical(t),
    deliverableHash,
    claim: 'The delivery does not meet the agreed criteria.',
    // The fabrication attack declares the real hash over fake content.
    deliverable: { content: buyerCopy, contentHash: deliverableHash },
    artifacts: [],
    submittedAt: '2026-01-01T00:00:00.000Z',
  };
  const job: Job = {
    buyer: BUYER,
    seller: SELLER,
    amount: 25_000_000n,
    deliveryDeadline: 0,
    reviewWindow: 3_600,
    deliveredAt: 1,
    state: 'Disputed',
    termsHash: hashCanonical(t),
    deliverableHash,
    disputeHash: hashCanonical(bundle),
    verdictHash: ZERO,
    disputedAt: input.disputedAt ?? 0,
    respondedAt: input.response ? 2 : 0,
    responseHash: ZERO,
    arbiter: BUYER,
    platformFeeBps: 50,
    arbitrationFeeBps: 200,
    protocolCutBps: 10_000,
    buyerOfferBps: 0,
    sellerAskBps: 10_000,
  };
  return { job, terms: t, bundle, ...(input.response ? { response: input.response } : {}) };
}

export function analyzeCase(input: Parameters<typeof caseFor>[0] & { fetched?: { uri: string; text: string } }) {
  const c = caseFor(input);
  return analyze({
    jobId: 1,
    job: c.job,
    terms: c.terms,
    bundle: c.bundle,
    ...(c.response ? { response: c.response } : {}),
    ...(input.fetched ? { fetched: input.fetched } : {}),
  });
}

export const credit = (analysis: ReturnType<typeof analyze>, id: string): number | null => {
  const found = analysis.signals.criteria.find((c) => c.id === id);
  if (!found) throw new Error(`no criterion ${id}`);
  return found.kind === 'check' ? found.credit! : null;
};

/// Deterministic pseudo-random numbers, so property tests are reproducible.
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}
