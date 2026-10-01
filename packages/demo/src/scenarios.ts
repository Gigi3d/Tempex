import {
  disputeHashOf,
  hashCanonical,
  hashText,
  tokenAmount,
  type EvidenceArtifact,
  type EvidenceBundle,
  type EvidenceCase,
  type Job,
  type JobTerms,
} from '@tempex/sdk';
import type { RuleSignals } from '@tempex/arbiter';
import type { Address, Hex } from 'viem';

/// The four disputes this demo can stage. Three of them exercise a different
/// corner of the rule engine's judgement; the fourth exists to prove the band
/// protects a seller who actually delivered.
export type ScenarioId = 'underdelivered' | 'nodelivery' | 'badfaith' | 'admission';

/// What the rule engine must say about a scenario, worked out by hand from the
/// engine's own constants before anything was run.
///
/// This is the point of the corpus: the expected band lives in the repository, so
/// a run that produces a different one is a failure the runner reports rather
/// than a number the presenter narrates. `packages/demo predict` asserts all of
/// it offline; the live runner asserts the headline scenario against the chain.
export type ScenarioExpectation = {
  coverage: number;
  corroboration: RuleSignals['corroboration'];
  /// terms the artifact raises only to say it did not deliver them
  admitted: string[];
  /// the ruling the rule engine signs: the centre of the band, unclamped
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
  criteria: string[];
  /// The delivered text. This is the bytes whose hash the seller commits to.
  deliverable: string;
  artifacts: EvidenceArtifact[];
  claim: string;
  /// What the seller says in its response to the dispute. Defaults to a plain
  /// statement that the attached deliverable is the work as delivered.
  sellerStatement?: string;
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

/// The headline dispute.
///
/// A buyer paid for a French localization and received a handoff note that covers
/// two of the four agreed criteria and names what it skipped. The word "Not" is
/// load-bearing: everything after it is a term the seller raised in order to say
/// it is absent, so the artifact cannot vote for its own completeness.
///
/// Hand-computed from the engine's constants: criteria scores 0.50 / 0.00 / 0.00 /
/// 1.00 mean 0.375, centre 3750 bps, a grounded claim earns the -500 nudge, and
/// the deliverable hash binds to the chain so the band is the tight +/-1200.
const underdelivered: Scenario = {
  id: 'underdelivered',
  title: 'Localization sprint, partly delivered',
  premise:
    'A buyer paid 25 alphaUSD for a French localization. The seller delivered a handoff note that says, in its own words, which parts were not done.',
  amount: '25.00',
  deliveryDeadlineSeconds: 3_600,
  reviewWindowSeconds: 3_600,
  deliverableSpec:
    'Translate the checkout flow into French for the fr-FR locale, following the glossary supplied with the brief.',
  criteria: [
    'Checkout strings translated to French',
    'Prices and dates in European formats',
    'Supplied glossary terms preserved',
    'Order confirmation email localized',
  ],
  deliverable:
    'Handoff note: the cart, checkout and payment screens were rewritten in French, and the order confirmation email is localized.\n' +
    'Not delivered: prices and dates in European formats; the supplied glossary.',
  artifacts: [
    artifact(
      'log',
      'localization-coverage.txt',
      'locales/fr-FR.json: 412 keys parsed, 411 present, 1 missing (pricing.legal.notice)',
    ),
  ],
  claim:
    'The delivery is incomplete: the prices and dates are in US formats, the supplied glossary is missing, and the checkout strings were never translated.',
  expect: {
    coverage: 0.375,
    corroboration: 'grounded',
    admitted: ['date', 'european', 'format', 'glossary', 'price', 'supplied'],
    center: 3_250,
    band: [2_050, 4_450],
  },
  live: true,
  drill: [-8_000, 0, 3_100, 5_000, 10_000],
};

/// Paid, then nothing shipped. Coverage floors at zero and the band reaches down
/// to it, but the arbitration fee still applies to the full escrow, so the zero
/// case is not quite a full refund — which is a fee-schedule question, not a
/// judgement one, and the receipt says both.
const nodelivery: Scenario = {
  id: 'nodelivery',
  title: 'Paid, then nothing shipped',
  premise:
    'The seller took the job and delivered a status update explaining that no work was done. The buyer disputes immediately.',
  amount: '40.00',
  deliveryDeadlineSeconds: 3_600,
  reviewWindowSeconds: 3_600,
  deliverableSpec: 'Translate the checkout flow into French for the fr-FR locale.',
  criteria: [
    'Checkout strings translated to French',
    'Prices and dates in European formats',
    'Order confirmation email localized',
  ],
  deliverable:
    'Status update: nothing was produced. The work was never started and no strings were translated.',
  artifacts: [],
  claim:
    'Nothing was delivered. The checkout was never translated and no prices or dates were localized.',
  expect: {
    coverage: 0,
    corroboration: 'grounded',
    admitted: ['string', 'translated'],
    center: 0,
    band: [0, 1_200],
  },
  live: false,
  drill: [0, 5_000],
};

/// The dispute the escrow is designed to survive: a buyer who received exactly
/// what the terms asked for and disputes anyway. Every criterion scores 1.00, the
/// engine records the claim as contradicted by the text, and the band is pushed
/// up to 8800-10000 bps. A seller who delivered is protected from a buyer who
/// would rather not pay, using only the buyer's own pinned evidence.
const badfaith: Scenario = {
  id: 'badfaith',
  title: 'A dispute over work that was delivered',
  premise:
    'Every criterion is met and the deliverable says so. The buyer disputes anyway; the arbiter rules against the complaint.',
  amount: '18.00',
  deliveryDeadlineSeconds: 3_600,
  reviewWindowSeconds: 3_600,
  deliverableSpec: 'Translate the checkout flow into French for the fr-FR locale.',
  criteria: [
    'Checkout strings translated to French',
    'Prices and dates in European formats',
    'Order confirmation email localized',
  ],
  deliverable:
    'Delivery complete: checkout strings are translated to French, prices and dates use European formats, and the order confirmation email is localized.',
  artifacts: [
    artifact(
      'log',
      'delivery-manifest.txt',
      'Build 412 - 3 of 3 acceptance criteria verified; locale fr-FR; 512 keys; zero missing.',
    ),
  ],
  claim:
    'Nothing was delivered. The seller never translated the checkout and the prices are wrong.',
  expect: {
    coverage: 1,
    corroboration: 'contradicted',
    admitted: [],
    center: 10_000,
    band: [8_800, 10_000],
  },
  live: false,
  drill: [0, 5_000],
};

/// The case that motivates negation awareness, and the reason `admitted` exists.
///
/// The glossary criterion scores 0.75 — three of its four terms appear plainly, so
/// a keyword matcher calls it delivered. But the fourth, "preserved", appears only
/// inside a negation ("Nothing was preserved..."). The engine strips it out of
/// coverage, keeps it as an admission, and when the buyer's oddly-worded complaint
/// does not name any term the deliverable *missed*, the seller's own sentence is
/// what corroborates the complaint.
///
/// Without the admitted path this dispute falls to 'unknown' and the complaint is
/// treated as noise. With it, the ruling is grounded in the artifact's own record.
const admission: Scenario = {
  id: 'admission',
  title: 'The complaint the artifact itself corroborates',
  premise:
    'The buyer complains in words that never name what was missed. The seller\'s own note says "nothing was preserved", and that sentence is what grounds the ruling.',
  amount: '12.50',
  deliveryDeadlineSeconds: 3_600,
  reviewWindowSeconds: 3_600,
  deliverableSpec:
    'Produce the French checkout screens and confirm the supplied glossary survived the rewrite intact.',
  criteria: [
    'Checkout strings translated to French',
    'Supplied glossary terms preserved',
    'Order confirmation email localized',
  ],
  deliverable:
    'The cart and checkout screens were rewritten in French. ' +
    'The supplied glossary ships with 120 terms. ' +
    'The order confirmation email is localized. ' +
    'Nothing was preserved from the original layout.',
  artifacts: [],
  claim:
    'The deliverable is incomplete. The checkout flow was never finished, and the preserved terminology from the supplied glossary is missing.',
  expect: {
    coverage: 0.75,
    corroboration: 'grounded',
    admitted: ['preserved'],
    center: 7_000,
    band: [5_800, 8_200],
  },
  live: false,
  drill: [3_000, 10_000],
};

export const SCENARIOS: readonly Scenario[] = [
  underdelivered,
  nodelivery,
  badfaith,
  admission,
];

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
    acceptanceCriteria: [...scenario.criteria],
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
  };
}
