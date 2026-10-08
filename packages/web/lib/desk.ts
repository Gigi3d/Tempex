import { getAddress, type Address, type Hex } from 'viem';

import {
  hashCanonical,
  hashText,
  responseHashOf,
  tokenAmount,
  type Criterion,
  type EvidenceArtifact,
  type EvidenceBundle,
  type EvidenceCase,
  type JobTerms,
  type SellerResponse,
} from '@tempex/sdk/browser';

import { decodeDataUri } from './format';
import type { OwnerSession } from './owner';
import { callReferee, settled, type Ruling } from './play';
import type { DocKind, JobRecord, StoredDoc } from './types';

/// Every write an owner makes from the dashboard. Each one is a sponsored Tempo
/// transaction signed by the owner's passkey through the same TempexClient the
/// CLI and the agents use; this file adds the paperwork around it: the terms,
/// the evidence and the seller's answer, filed by hash so the other party and
/// the arbiter can read exactly what was committed on chain.

const write = { sponsored: true } as const;
/// The escrow keeps a deliverable URI to 2,048 bytes.
const MAX_URI_BYTES = 2_048;

// ------------------------------------------------------------------- papers

/// Files a document and checks the store filed it under the hash this browser
/// computed. A store that answered with any other hash is not trusted.
export async function fileDoc(kind: DocKind, doc: unknown): Promise<Hex> {
  const expected = kind === 'deliverable' ? hashText(doc as string) : hashCanonical(doc);
  const response = await fetch('/api/docs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, doc }),
  });
  const body = (await response.json()) as { hash?: Hex; message?: string };
  if (!response.ok) throw new Error(body.message ?? `the document store answered ${response.status}`);
  if (body.hash?.toLowerCase() !== expected.toLowerCase()) throw new Error('the document store filed this under a different hash; refusing to rely on it');
  return expected;
}

/// A document by its hash, re-hashed here: what comes back is what was committed,
/// or nothing.
export async function readDoc<T>(hash: string | undefined | null, kind: DocKind): Promise<StoredDoc<T> | null> {
  if (!hash || /^0x0{64}$/.test(hash)) return null;
  const response = await fetch(`/api/docs/${hash}`, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`the document store answered ${response.status}`);
  const stored = (await response.json()) as StoredDoc<T>;
  const actual = kind === 'deliverable' ? hashText(stored.doc as string) : hashCanonical(stored.doc);
  if (actual.toLowerCase() !== hash.toLowerCase() || stored.kind !== kind) throw new Error(`the ${kind} filed under ${hash.slice(0, 10)}… does not hash to it`);
  return stored;
}

/// The delivered work: from the data URI it rode in on, or from the store.
export async function readDeliverable(job: JobRecord): Promise<string | null> {
  if (!job.delivered) return null;
  const inline = decodeDataUri(job.delivered.uri);
  if (inline !== null && hashText(inline).toLowerCase() === job.delivered.deliverableHash.toLowerCase()) return inline;
  const stored = await readDoc<string>(job.delivered.deliverableHash, 'deliverable');
  return stored?.doc ?? null;
}

// --------------------------------------------------------------------- open

export type NewJob = {
  seller: Address;
  title: string;
  spec: string;
  criteria: Criterion[];
  /// decimal αUSD, e.g. "25" or "12.5"
  amount: string;
  deliverySeconds: number;
  reviewSeconds: number;
  arbiter?: Address;
  referrer?: Address;
};

export function termsOf(draft: NewJob, buyer: Address): JobTerms {
  return {
    title: draft.title.trim(),
    deliverableSpec: draft.spec.trim(),
    acceptanceCriteria: draft.criteria,
    amount: draft.amount,
    currency: 'αUSD',
    buyer: getAddress(buyer),
    seller: getAddress(draft.seller),
  };
}

/// Files the terms, then approves, creates and funds in one transaction. The
/// terms go first: a job is never opened on terms the seller cannot read.
export async function openJob(session: OwnerSession, draft: NewJob): Promise<{ jobId: bigint; hash: Hex; termsHash: Hex }> {
  const terms = termsOf(draft, session.address);
  const termsHash = await fileDoc('terms', terms);
  const now = Math.floor(Date.now() / 1000);
  const { jobId, hash } = await settled(() =>
    session.tempex.createAndFundJob(
      {
        seller: getAddress(draft.seller),
        amount: tokenAmount(draft.amount),
        termsHash,
        deliveryDeadline: now + draft.deliverySeconds,
        reviewWindow: draft.reviewSeconds,
        approve: true,
        ...(draft.arbiter ? { arbiter: draft.arbiter } : {}),
        ...(draft.referrer ? { referrer: draft.referrer } : {}),
      },
      write,
    ),
  );
  return { jobId, hash, termsHash };
}

// ------------------------------------------------------------------- moves

const id = (job: JobRecord) => BigInt(job.jobId);

/// The seller commits the work by hash. Short work rides in the transaction as a
/// data URI; longer work is filed in the store and linked from this site, where
/// the arbiter can fetch it and check it against the hash.
export async function deliver(session: OwnerSession, job: JobRecord, content: string): Promise<Hex> {
  const hash = await fileDoc('deliverable', content);
  const inline = `data:text/plain;charset=utf-8;base64,${base64(content)}`;
  const uri = new TextEncoder().encode(inline).length <= MAX_URI_BYTES ? inline : `${window.location.origin}/api/docs/${hash}/raw`;
  const receipt = await settled(() => session.tempex.deliver(id(job), hash, uri, write));
  return receipt.transactionHash;
}

export async function accept(session: OwnerSession, job: JobRecord): Promise<Hex> {
  return (await settled(() => session.tempex.accept(id(job), write))).transactionHash;
}

export async function fund(session: OwnerSession, job: JobRecord): Promise<Hex> {
  return (await settled(() => session.tempex.approveAndFund(id(job), BigInt(job.amount), write))).transactionHash;
}

export async function cancel(session: OwnerSession, job: JobRecord): Promise<Hex> {
  return (await settled(() => session.tempex.cancel(id(job), write))).transactionHash;
}

export async function autoAccept(session: OwnerSession, job: JobRecord): Promise<Hex> {
  return (await settled(() => session.tempex.autoAccept(id(job), write))).transactionHash;
}

export async function refundExpired(session: OwnerSession, job: JobRecord): Promise<Hex> {
  return (await settled(() => session.tempex.refundExpired(id(job), write))).transactionHash;
}

export async function settleLapsed(session: OwnerSession, job: JobRecord): Promise<Hex> {
  return (await settled(() => session.tempex.settleLapsed(id(job), write))).transactionHash;
}

export async function withdraw(session: OwnerSession): Promise<{ hash: Hex; amount: bigint } | null> {
  const credit = await session.tempex.credits();
  if (credit === 0n) return null;
  const receipt = await settled(() => session.tempex.withdraw(write));
  return { hash: receipt.transactionHash, amount: credit };
}

/// The buyer's side of a dispute: its claim, its own copy of the work and any
/// extra artifacts, pinned by hash with its final offer. The case is only
/// useful to the arbiter with the terms on file, so it refuses without them.
export async function dispute(
  session: OwnerSession,
  job: JobRecord,
  input: { claim: string; offerBps: number; artifacts: EvidenceArtifact[] },
): Promise<{ tx: Hex; disputeHash: Hex }> {
  const terms = await readDoc<JobTerms>(job.termsHash, 'terms');
  if (!terms) throw new Error('The terms behind this job are not on file, so the arbiter could not rule on them. Attach them first.');
  const content = await readDeliverable(job);
  const bundle: EvidenceBundle = {
    version: 1,
    jobId: Number(job.jobId),
    termsHash: job.termsHash,
    deliverableHash: job.delivered!.deliverableHash,
    claim: input.claim.trim(),
    deliverable: { ...(content !== null ? { content } : {}), ...(job.delivered!.uri ? { uri: job.delivered!.uri } : {}), contentHash: job.delivered!.deliverableHash },
    artifacts: input.artifacts,
    submittedAt: new Date().toISOString(),
  };
  const disputeHash = await fileDoc('evidence', bundle);
  const receipt = await settled(() => session.tempex.dispute(id(job), disputeHash, input.offerBps, write));
  return { tx: receipt.transactionHash, disputeHash };
}

/// The seller's answer: its statement, its own copy of the work (whichever copy
/// hashes to the on-chain commitment is the one the arbiter scores) and its
/// final ask.
export async function respond(session: OwnerSession, job: JobRecord, input: { statement: string; askBps: number; artifacts: EvidenceArtifact[] }): Promise<Hex> {
  const content = await readDeliverable(job);
  const response: SellerResponse = {
    version: 1,
    jobId: Number(job.jobId),
    disputeHash: job.dispute!.disputeHash,
    statement: input.statement.trim(),
    deliverable: { ...(content !== null ? { content } : {}), ...(job.delivered?.uri ? { uri: job.delivered.uri } : {}), contentHash: job.delivered!.deliverableHash },
    artifacts: input.artifacts,
    submittedAt: new Date().toISOString(),
  };
  const responseHash = await fileDoc('response', response);
  if (responseHash !== responseHashOf(response)) throw new Error('response hash mismatch');
  const receipt = await settled(() => session.tempex.respond(id(job), responseHash, input.askBps, write));
  return receipt.transactionHash;
}

/// Assembles the case from the papers on file (each re-hashed against the
/// chain's commitment) and hands it to the arbiter's court.
export async function caseFor(job: JobRecord): Promise<{ evidenceCase: EvidenceCase | null; missing: string[] }> {
  const [terms, bundle, response] = await Promise.all([
    readDoc<JobTerms>(job.termsHash, 'terms'),
    readDoc<EvidenceBundle>(job.dispute?.disputeHash, 'evidence'),
    readDoc<SellerResponse>(job.response?.responseHash, 'response'),
  ]);
  const missing: string[] = [];
  if (!terms) missing.push('the terms');
  if (!bundle) missing.push('the buyer’s evidence');
  if (job.response && !response) missing.push('the seller’s answer');
  if (!terms || !bundle) return { evidenceCase: null, missing };
  return { evidenceCase: { terms: terms.doc, bundle: bundle.doc, ...(response ? { response: response.doc } : {}) }, missing };
}

export async function requestRuling(job: JobRecord): Promise<Ruling> {
  const { evidenceCase, missing } = await caseFor(job);
  if (!evidenceCase) throw new Error(`The arbiter needs ${missing.join(' and ')}, and they are not on file.`);
  return callReferee(id(job), evidenceCase);
}

/// Attaches terms written elsewhere (a CLI run, an agent) to a job, after
/// checking they are the terms the job committed to.
export async function attachTerms(job: JobRecord, text: string): Promise<void> {
  let terms: unknown;
  try {
    terms = JSON.parse(text);
  } catch {
    throw new Error('That is not JSON.');
  }
  if (hashCanonical(terms).toLowerCase() !== job.termsHash.toLowerCase()) {
    throw new Error(`Those terms hash to ${hashCanonical(terms).slice(0, 12)}…, but the job committed to ${job.termsHash.slice(0, 12)}…`);
  }
  await fileDoc('terms', terms);
}

function base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
