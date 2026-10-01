import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  caseIntegrity,
  disputeHashOf,
  domainFor,
  hashCanonical,
  hashText,
  readCase,
  recoverVerdictSigner,
  signVerdict,
  tokenAmount,
  writeCase,
  type EvidenceBundle,
  type EvidenceCase,
  type Job,
  type JobTerms,
  type TempexClient,
  type VerdictStruct,
} from '@tempex/sdk';
import type { Address, Hex } from 'viem';

import { clampToBand, escrowArbiterConfig } from './adjudicate.js';
import { analyze, type RuleAnalysis } from './rules.js';

export type CheckResult = {
  name: string;
  passed: boolean;
  detail: string;
};

export type VerifyReport = {
  passed: boolean;
  checks: CheckResult[];
  escrow: Address;
  /// The key this process signs with.
  signer: Address;
  /// The escrow's registered arbiter, or null when the chain could not be read.
  registeredArbiter: Address | null;
};

/// Job id that cannot belong to a real deployment's history, so the fixture can
/// never be confused with an actual case file.
const VERIFY_JOB_ID = 9001;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;
/// Deliberately not real accounts: this fixture must never be mistaken for a demo run.
const FIXTURE_BUYER = `0x${'11'.repeat(20)}` as Address;
const FIXTURE_SELLER = `0x${'22'.repeat(20)}` as Address;

const FIXTURE_TERMS: JobTerms = {
  title: 'Localize the marketing site to French',
  deliverableSpec: 'The full landing page copy in French, with fr-FR formats.',
  acceptanceCriteria: [
    'French translation of the marketing site copy',
    'Localized currency and date formats',
    'Glossary terms preserved as supplied',
  ],
  amount: '25.00',
  currency: 'AlphaUSD',
  buyer: FIXTURE_BUYER,
  seller: FIXTURE_SELLER,
};

const FIXTURE_DELIVERABLE =
  'Landing page copy translated into French: the hero, pricing and testimonials ' +
  'sections are now in French, and the translation covers the marketing site ' +
  'throughout. The checkout still shows $ and MM/DD/YYYY.';

const FIXTURE_ARTIFACT =
  'translation memory export: 412 segments, 388 confirmed, 24 fuzzy matches pending review';

const FIXTURE_CLAIM = 'The glossary terms are missing from the delivery.';

/// A dispute that never happened, shaped exactly like one that did: a partial
/// delivery (one of three criteria met) against three agreed criteria.
///
/// `analyze` is a pure function, so a fabricated job proves the band without
/// needing a real dispute. A live job cannot be used for this: the integrity
/// gate refuses any case whose terms document does not hash to the job's
/// on-chain `termsHash`, and no real deployment has this fixture's preimage.
function fixture(): { terms: JobTerms; bundle: EvidenceBundle; job: Job } {
  const terms = FIXTURE_TERMS;
  const bundle: EvidenceBundle = {
    version: 1,
    jobId: VERIFY_JOB_ID,
    termsHash: hashCanonical(terms),
    deliverableHash: hashText(FIXTURE_DELIVERABLE),
    claim: FIXTURE_CLAIM,
    deliverable: {
      content: FIXTURE_DELIVERABLE,
      contentHash: hashText(FIXTURE_DELIVERABLE),
    },
    artifacts: [
      {
        kind: 'text',
        label: 'translation-memory.txt',
        content: FIXTURE_ARTIFACT,
        contentHash: hashText(FIXTURE_ARTIFACT),
      },
    ],
    submittedAt: '2026-01-01T00:00:00.000Z',
  };

  const job: Job = {
    buyer: FIXTURE_BUYER,
    seller: FIXTURE_SELLER,
    amount: tokenAmount('25'),
    deliveryDeadline: 1_800_000_000,
    reviewWindow: 3_600,
    deliveredAt: 1_799_900_000,
    state: 'Delivered',
    termsHash: hashCanonical(terms),
    deliverableHash: hashText(FIXTURE_DELIVERABLE),
    disputeHash: hashCanonical(bundle),
    verdictHash: ZERO_HASH,

    disputedAt: 0,
    respondedAt: 0,
    responseHash: ZERO_HASH,
    arbiter: `0x${'0'.repeat(40)}`,
    platformFeeBps: 0,
    arbitrationFeeBps: 0,
  };

  return { terms, bundle, job };
}

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const signalsDigest = (analysis: RuleAnalysis): Hex =>
  hashCanonical({ band: analysis.band, signals: analysis.signals });

/// Proves the three claims the arbiter rests on, in the order a sceptic would
/// check them: the files reproduce the pinned hash, the band is a function of
/// those files, and the signature would be accepted by the deployed escrow.
///
/// The first three checks are local and run offline. The last two read the
/// contract, so a failure there is reported as a failed check rather than a
/// crash: a refusal to sign is the system working, and it should be legible.
export async function verifyArbiter(params: { client: TempexClient }): Promise<VerifyReport> {
  const { client } = params;
  const checks: CheckResult[] = [];
  const check = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };

  // ---- 1. the files on disk are the files that hash to the pinned commitments ----
  const { terms, bundle, job } = fixture();
  const evidenceCase: EvidenceCase = { terms, bundle };
  const dir = mkdtempSync(join(tmpdir(), 'tempex-verify-'));
  let reread = evidenceCase;
  try {
    writeCase(dir, VERIFY_JOB_ID, evidenceCase);
    reread = readCase(dir, VERIFY_JOB_ID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const pinned = disputeHashOf(evidenceCase);
  const roundTripped = disputeHashOf(reread);
  const problems = caseIntegrity(reread);
  check(
    'case files reproduce the pinned evidence hash',
    pinned === roundTripped && problems.length === 0,
    problems.length > 0
      ? problems.join('; ')
      : `${pinned} survives a canonical write and read`,
  );

  // ---- 2. the band is a function of the evidence, not of when it ran ----
  const fromMemory = analyze({
    jobId: VERIFY_JOB_ID,
    job,
    terms: evidenceCase.terms,
    bundle: evidenceCase.bundle,
  });
  const fromDisk = analyze({
    jobId: VERIFY_JOB_ID,
    job,
    terms: reread.terms,
    bundle: reread.bundle,
  });
  const band = fromDisk.band;
  const stable =
    signalsDigest(fromMemory) === signalsDigest(fromDisk) &&
    fromDisk.blocking.length === 0 &&
    band.lowBps <= band.center &&
    band.center <= band.highBps;
  check(
    'the same files re-derive the same band',
    stable,
    fromDisk.blocking.length > 0
      ? `fixture refused: ${fromDisk.blocking.join('; ')}`
      : `band ${band.lowBps}-${band.highBps} bps (centre ${band.center}), signals ${signalsDigest(fromDisk)}`,
  );

  // ---- 3. the guardrail pulls a judge into that band ----
  const low = clampToBand(band.lowBps - 2_500, band);
  const high = clampToBand(band.highBps + 2_500, band);
  const centre = clampToBand(band.center, band);
  check(
    'a judge outside the band is clamped into it',
    low.clamped &&
      low.bps === band.lowBps &&
      high.clamped &&
      high.bps === band.highBps &&
      !centre.clamped &&
      centre.bps === band.center,
    `${band.highBps + 2_500} bps -> ${high.bps} bps; the objective centre passes through unclamped`,
  );

  // ---- 4 & 5 are about the deployed contract ----
  const now = Math.floor(Date.now() / 1000);
  const verdict: VerdictStruct = {
    jobId: BigInt(VERIFY_JOB_ID),
    sellerAwardBps: band.center,
    evidenceHash: pinned,
    rationaleHash: hashText('tempex verify: offline fixture, no live job was touched'),
    issuedAt: BigInt(now - 60),
    validUntil: BigInt(now + 3_600),
  };

  try {
    const { local, onChain, matches } = await client.verdictEncoding(verdict);
    check(
      'the deployed escrow certifies this service\'s digest',
      matches,
      matches
        ? `${local} == TempexEscrow.verdictDigest`
        : `off-chain ${local} != on-chain ${onChain}`,
    );
  } catch (error) {
    check(
      'the deployed escrow certifies this service\'s digest',
      false,
      `could not reach ${client.addresses.escrow}: ${reason(error)}`,
    );
  }

  let registeredArbiter: Address | null = null;
  let arbiterReadError: string | null = null;
  try {
    registeredArbiter = (await escrowArbiterConfig(client)).arbiter;
  } catch (error) {
    arbiterReadError = reason(error);
  }

  let recovered: Address | null = null;
  let signError: string | null = null;
  try {
    const signature = await signVerdict(client.account, verdict, domainFor(client.addresses));
    recovered = await recoverVerdictSigner(verdict, signature, domainFor(client.addresses));
  } catch (error) {
    signError = reason(error);
  }

  const signer = client.address;
  let signatureDetail: string;
  let signatureOk = false;
  if (registeredArbiter === null) {
    signatureDetail = `could not read escrow.arbiter(): ${arbiterReadError}`;
  } else if (recovered === null) {
    signatureDetail = `could not sign or recover: ${signError}`;
  } else if (recovered.toLowerCase() === registeredArbiter.toLowerCase()) {
    signatureOk = true;
    signatureDetail = `${signer} == escrow.arbiter()`;
  } else {
    signatureDetail =
      `${signer} is NOT the escrow's arbiter (${registeredArbiter}); ` +
      'verdicts it signs will revert with "bad verdict signature"';
  }
  check('a signature from this key recovers to the escrow\'s arbiter', signatureOk, signatureDetail);

  return {
    passed: checks.every((entry) => entry.passed),
    checks,
    escrow: client.addresses.escrow,
    signer,
    registeredArbiter,
  };
}
