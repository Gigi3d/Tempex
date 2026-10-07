import {
  disputeHashOf,
  hashCanonical,
  hashText,
  tokenAmount,
  type Criterion,
  type EvidenceArtifact,
  type EvidenceBundle,
  type EvidenceCase,
  type Job,
  type JobTerms,
} from '@tempex/sdk';
import type { Address, Hex } from 'viem';

/// The four disputes this demo can stage, all over the same French localization
/// brief, so the only thing that changes between them is what was delivered.
export type ScenarioId = 'underdelivered' | 'nodelivery' | 'badfaith' | 'echo';

/// What the rule engine must say about a scenario, worked out by hand from the
/// terms' checks and weights before anything was run.
///
/// This is the point of the corpus: the expected band lives in the repository, so
/// a run that produces a different one is a failure the runner reports rather
/// than a number the presenter narrates. `packages/demo predict` asserts all of
/// it offline; the live runner asserts the headline scenario against the chain.
export type ScenarioExpectation = {
  /// each criterion's credit from its check, or null for one left open
  credits: Record<string, number | null>;
  /// the ruling the rule engine signs: the centre of the band, before offers
  center: number;
  band: readonly [number, number];
};

export type Scenario = {
  id: ScenarioId;
  title: string;
  /// One line the transcript prints before the stage list: what the parties
  /// disagree about, in the buyer's own framing.
  premise: string;
  /// Escrowed amount in whole tokens; the runner converts to base units.
  amount: string;
  deliveryDeadlineSeconds: number;
  reviewWindowSeconds: number;
  deliverableSpec: string;
  criteria: Criterion[];
  /// The delivered bytes. This is what the seller commits to by hash.
  deliverable: string;
  artifacts: EvidenceArtifact[];
  claim: string;
  /// What the seller says in its response to the dispute. Defaults to a plain
  /// statement that the attached deliverable is the work as delivered.
  sellerStatement?: string;
  /// Final offers pinned on chain: the buyer's at dispute, the seller's in its
  /// response. The award must land between them. Defaults: 0 and 10000.
  buyerOfferBps?: number;
  sellerAskBps?: number;
  expect: ScenarioExpectation;
  /// Only scenarios marked live are run against the chain; the rest are analysed
  /// offline, which needs no keys and costs nothing.
  live: boolean;
  /// Judge proposals fed through the real clamp in the offline drill.
  drill: number[];
};

/// Artifacts declare the hash of their own content, and the analysis checks it.
/// Building them through one helper means the corpus can never ship an artifact
/// that fails its own integrity check by accident.
function artifact(
  kind: EvidenceArtifact['kind'],
  label: string,
  content: string,
): EvidenceArtifact {
  return { kind, label, content, contentHash: hashText(content) };
}

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

/// The keys the brief asks for. A delivery is checked against this list, not
/// against the words of a criterion.
const REQUIRED_KEYS = [
  'cart.title',
  'checkout.title',
  'checkout.submit',
  'checkout.shipping',
  'checkout.coupon',
  'checkout.terms',
  'email.subject',
  'email.body',
];

const FRENCH_MONTHS = 'janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre';

/// The brief every scenario shares. Five criteria are checks, decided exactly
/// from the delivered JSON; the sixth is a judgement no code can make. Weights
/// total 10, so one unit of weight is 1000 bps.
const LOCALIZATION_SPEC =
  'Deliver locales/fr-FR.json for the checkout flow: every key in the brief, in French, prices and dates in French formats, using the supplied glossary.';
const LOCALIZATION_CRITERIA: Criterion[] = [
  {
    id: 'keys',
    text: 'Every checkout and email string in the brief is delivered',
    weight: 3,
    check: { type: 'jsonKeys', at: '/strings', keys: REQUIRED_KEYS },
  },
  {
    id: 'french',
    text: 'The strings are written in French',
    weight: 2,
    check: { type: 'language', at: '/strings', is: 'fr' },
  },
  {
    id: 'prices',
    text: 'Prices use the French format, e.g. 12,50 €',
    weight: 2,
    check: { type: 'regex', at: '/prices', pattern: '^\\d+,\\d{2} €$' },
  },
  {
    id: 'dates',
    text: 'Dates use the French long format, e.g. 7 octobre 2026',
    weight: 1,
    check: { type: 'regex', at: '/dates', pattern: `^\\d{1,2} (${FRENCH_MONTHS}) \\d{4}$` },
  },
  {
    id: 'glossary',
    text: 'The supplied glossary terms are used',
    weight: 1,
    check: { type: 'contains', at: '/strings', all: ['Valider la commande', 'Code promo'] },
  },
  {
    id: 'tone',
    text: 'The copy reads naturally to a French shopper',
    weight: 1,
  },
];

const locale = (body: Record<string, unknown>): string =>
  JSON.stringify({ locale: 'fr-FR', ...body }, null, 2);

/// The headline dispute, run live.
///
/// Six of the eight strings are delivered, in French; prices and dates were left
/// in US formats and the glossary was not used. Worked by hand: keys 6/8 of
/// weight 3 earns 2.25, French earns 2, prices, dates and glossary earn 0, so 4.25
/// of 10 is verified and the judgement criterion (weight 1) is open: band
/// 4250-5250, centre 4750. The parties' offers (2500, 5000) leave that intact.
const underdelivered: Scenario = {
  id: 'underdelivered',
  title: 'Localization sprint, partly delivered',
  premise:
    'A buyer paid 25 alphaUSD for a French checkout locale. Most strings arrived in French, but prices and dates are in US formats and the glossary was ignored.',
  amount: '25.00',
  deliveryDeadlineSeconds: 3_600,
  reviewWindowSeconds: 3_600,
  deliverableSpec: LOCALIZATION_SPEC,
  criteria: LOCALIZATION_CRITERIA,
  deliverable: locale({
    strings: {
      'cart.title': 'Votre panier',
      'checkout.title': 'Paiement',
      'checkout.submit': 'Payer maintenant',
      'checkout.shipping': 'Adresse de livraison',
      'email.subject': 'Confirmation de votre commande',
      'email.body': 'Merci pour votre commande. Elle sera expédiée sous deux jours ouvrés.',
    },
    prices: { 'checkout.total': '$12.50', 'checkout.shipping_fee': '$4.00' },
    dates: { 'order.placed': 'October 7, 2026' },
  }),
  artifacts: [
    artifact('log', 'localization-coverage.txt', 'locales/fr-FR.json: 6 of 8 keys translated; coupon and terms pending'),
  ],
  claim:
    'The delivery is incomplete: two strings are missing, prices and dates are in US formats, and the supplied glossary was not used.',
  sellerStatement:
    'The delivered locale is attached. The core checkout and email strings are translated; formats were left for a follow-up.',
  expect: {
    credits: { keys: 0.75, french: 1, prices: 0, dates: 0, glossary: 0, tone: null },
    center: 4_750,
    band: [4_250, 5_250],
  },
  // The buyer concedes a quarter was earned; the seller holds out for half. The
  // band sits inside both, so the offers bound the arbiter without moving it.
  buyerOfferBps: 2_500,
  sellerAskBps: 5_000,
  live: true,
  drill: [-8_000, 0, 4_500, 5_000, 10_000],
};

/// Paid, then nothing shipped. The deliverable is a status note, not a locale
/// file, so every check fails on it: 0 of 10 is verified and only the judgement
/// criterion is open. Band 0-1000, centre 500.
const nodelivery: Scenario = {
  id: 'nodelivery',
  title: 'Paid, then nothing shipped',
  premise:
    'The seller took the job and delivered a status note saying no work was done. The buyer disputes immediately.',
  amount: '40.00',
  deliveryDeadlineSeconds: 3_600,
  reviewWindowSeconds: 3_600,
  deliverableSpec: LOCALIZATION_SPEC,
  criteria: LOCALIZATION_CRITERIA,
  deliverable: 'Status update: nothing was produced. The work was never started and no strings were translated.',
  artifacts: [],
  claim: 'Nothing was delivered. The checkout was never translated and no locale file exists.',
  expect: {
    credits: { keys: 0, french: 0, prices: 0, dates: 0, glossary: 0, tone: null },
    center: 500,
    band: [0, 1_000],
  },
  live: false,
  drill: [0, 500, 5_000],
};

/// The dispute the escrow is designed to survive: a buyer who received exactly
/// what the terms asked for and disputes anyway. Every check passes, so 9 of 10
/// is verified on the delivered bytes alone, whatever the buyer claims. Band
/// 9000-10000, centre 9500.
const badfaith: Scenario = {
  id: 'badfaith',
  title: 'A dispute over work that was delivered',
  premise:
    'Every checkable criterion is met by the delivered file. The buyer disputes anyway; the checks rule against the complaint.',
  amount: '18.00',
  deliveryDeadlineSeconds: 3_600,
  reviewWindowSeconds: 3_600,
  deliverableSpec: LOCALIZATION_SPEC,
  criteria: LOCALIZATION_CRITERIA,
  deliverable: locale({
    strings: {
      'cart.title': 'Votre panier',
      'checkout.title': 'Paiement',
      'checkout.submit': 'Valider la commande',
      'checkout.shipping': 'Adresse de livraison',
      'checkout.coupon': 'Code promo',
      'checkout.terms': "J'accepte les conditions générales de vente",
      'email.subject': 'Confirmation de votre commande',
      'email.body': 'Merci pour votre commande. Elle sera expédiée sous deux jours ouvrés.',
    },
    prices: { 'checkout.total': '12,50 €', 'checkout.shipping_fee': '4,00 €' },
    dates: { 'order.placed': '7 octobre 2026', 'order.delivery': '9 octobre 2026' },
  }),
  artifacts: [
    artifact('log', 'delivery-manifest.txt', 'locales/fr-FR.json: 8 of 8 keys; prices and dates in fr-FR formats.'),
  ],
  claim: 'Nothing was delivered. The seller never translated the checkout and the prices are wrong.',
  expect: {
    credits: { keys: 1, french: 1, prices: 1, dates: 1, glossary: 1, tone: null },
    center: 9_500,
    band: [9_000, 10_000],
  },
  live: false,
  drill: [0, 9_600, 10_000],
};

/// The attack keyword scoring could not survive: the seller delivers the
/// acceptance criteria themselves, pasted back as prose. A keyword matcher gave
/// this full marks. Checks read the delivered bytes, not their vocabulary, so it
/// earns nothing: band 0-1000, centre 500, the same as delivering nothing.
const echo: Scenario = {
  id: 'echo',
  title: 'The criteria, pasted back as the delivery',
  premise:
    'The seller delivers a note that repeats every acceptance criterion word for word, and no locale file.',
  amount: '12.50',
  deliveryDeadlineSeconds: 3_600,
  reviewWindowSeconds: 3_600,
  deliverableSpec: LOCALIZATION_SPEC,
  criteria: LOCALIZATION_CRITERIA,
  deliverable:
    'Every checkout and email string in the brief is delivered. The strings are written in French. ' +
    'Prices use the French format, e.g. 12,50 €. Dates use the French long format, e.g. 7 octobre 2026. ' +
    'The supplied glossary terms are used. The copy reads naturally to a French shopper.',
  artifacts: [],
  claim: 'The delivery is a restatement of the brief. There is no locale file and nothing was translated.',
  expect: {
    credits: { keys: 0, french: 0, prices: 0, dates: 0, glossary: 0, tone: null },
    center: 500,
    band: [0, 1_000],
  },
  live: false,
  drill: [0, 1_000, 10_000],
};

export const SCENARIOS: readonly Scenario[] = [underdelivered, nodelivery, badfaith, echo];

export function scenarioById(id: string): Scenario {
  const found = SCENARIOS.find((scenario) => scenario.id === id);
  if (found === undefined) {
    throw new Error(
      `unknown scenario ${id}; expected one of ${SCENARIOS.map((s) => s.id).join(', ')}`,
    );
  }
  return found;
}

export const DEFAULT_SCENARIO = underdelivered.id;

export type DemoParties = { buyer: Address; seller: Address };

export function termsFor(scenario: Scenario, parties: DemoParties): JobTerms {
  return {
    title: scenario.title,
    deliverableSpec: scenario.deliverableSpec,
    acceptanceCriteria: structuredClone(scenario.criteria),
    amount: scenario.amount,
    currency: 'AlphaUSD',
    buyer: parties.buyer,
    seller: parties.seller,
  };
}

/// Builds the evidence case the buyer pins and the arbiter later reads.
///
/// `submittedAt` is passed in rather than read from the clock: the bundle is
/// hashed, the hash is pinned on chain, and a resumed run has to reproduce the
/// bundle byte for byte. A timestamp taken at call time would silently break that
/// on the second run.
export function bundleFor(
  scenario: Scenario,
  input: { jobId: number; termsHash: Hex; submittedAt: string },
): EvidenceBundle {
  return {
    version: 1,
    jobId: input.jobId,
    termsHash: input.termsHash,
    deliverableHash: hashText(scenario.deliverable),
    claim: scenario.claim,
    deliverable: {
      content: scenario.deliverable,
      contentHash: hashText(scenario.deliverable),
    },
    artifacts: scenario.artifacts.map((entry) => ({ ...entry })),
    submittedAt: input.submittedAt,
  };
}

export function caseFor(
  scenario: Scenario,
  input: { jobId: number; parties: DemoParties; submittedAt: string },
): EvidenceCase {
  const terms = termsFor(scenario, input.parties);
  return {
    terms,
    bundle: bundleFor(scenario, {
      jobId: input.jobId,
      termsHash: hashCanonical(terms),
      submittedAt: input.submittedAt,
    }),
  };
}

/// A stand-in for the on-chain job, built from the same files the chain will hold
/// hashes of. Running the analysis against this is what makes `predict` a real
/// rehearsal: every integrity check in `analyze` compares the same values it will
/// compare against the live contract.
export function jobFor(
  scenario: Scenario,
  input: { jobId: number; evidenceCase: EvidenceCase },
): Job {
  const { terms, bundle } = input.evidenceCase;
  return {
    buyer: terms.buyer as Address,
    seller: terms.seller as Address,
    amount: tokenAmount(scenario.amount),
    deliveryDeadline: 0,
    reviewWindow: 0,
    deliveredAt: 0,
    state: 'Disputed',
    termsHash: hashCanonical(terms),
    deliverableHash: hashText(scenario.deliverable),
    disputeHash: disputeHashOf(input.evidenceCase),
    verdictHash: ZERO_HASH,

    disputedAt: 0,
    respondedAt: 0,
    responseHash: ZERO_HASH,
    arbiter: `0x${'0'.repeat(40)}`,
    platformFeeBps: 0,
    arbitrationFeeBps: 0,
    protocolCutBps: 0,
    buyerOfferBps: 0,
    sellerAskBps: 10_000,
  };
}
