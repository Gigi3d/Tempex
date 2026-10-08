import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isAddress, isHash, type Hex } from 'viem';

import { hashCanonical, hashText } from '@tempex/sdk';

import { BeaconError } from './beacon.js';

/// The document store: where the papers behind a job live, so both parties (and
/// the arbiter) can read what the chain only commits to by hash.
///
/// Content-addressed and verified on the way in. The store computes every hash
/// itself, the same way the escrow's callers do (`hashCanonical` for terms,
/// evidence and responses, `hashText` for a deliverable), so a document can only
/// ever be filed under the hash it really has. Nobody can overwrite a document,
/// and nobody can file a forgery under someone else's commitment.
///
/// Everything here is public to anyone who knows the hash. A job's terms hash is
/// on chain, so its terms are, in effect, public. The site says so before an
/// owner stores anything.

export const DOC_KINDS = ['terms', 'evidence', 'response', 'deliverable'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export type StoredDoc = { kind: DocKind; hash: Hex; doc: unknown; storedAt: string; bytes: number };

const MAX_DOC_BYTES = 128 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 40;

export class DocStore {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /// Files a document under the hash it actually has. Idempotent: storing the
  /// same document twice answers with the first filing.
  put(body: Record<string, unknown>, ip: string): StoredDoc & { existed: boolean } {
    const kind = body['kind'];
    if (typeof kind !== 'string' || !(DOC_KINDS as readonly string[]).includes(kind)) {
      throw new BeaconError(`"kind" must be one of ${DOC_KINDS.join(', ')}`, 400);
    }
    const doc = body['doc'];
    const problems = shapeProblems(kind as DocKind, doc);
    if (problems.length > 0) throw new BeaconError(`not a valid ${kind} document: ${problems.join('; ')}`, 400);

    const serialized = JSON.stringify(doc);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_DOC_BYTES) throw new BeaconError(`documents are capped at ${MAX_DOC_BYTES} bytes; this one is ${bytes}`, 413);

    const hash = kind === 'deliverable' ? hashText(doc as string) : hashCanonical(doc);
    const existing = this.get(hash);
    if (existing) return { ...existing, existed: true };

    this.limit(ip);
    const record: StoredDoc = { kind: kind as DocKind, hash, doc, storedAt: new Date().toISOString(), bytes };
    const file = this.file(hash);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    renameSync(temp, file);
    return { ...record, existed: false };
  }

  get(hash: string): StoredDoc | null {
    if (!isHash(hash)) throw new BeaconError('a document is addressed by its 32-byte hash', 400);
    const file = this.file(hash);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as StoredDoc;
  }

  private file(hash: string): string {
    return join(this.dir, `${hash.toLowerCase()}.json`);
  }

  private limit(ip: string): void {
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) throw new BeaconError('too many documents from this address; try again in a few minutes', 429);
    recent.push(now);
    this.hits.set(ip, recent);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 20_000): value is string => typeof value === 'string' && value.length <= max;

/// Enough shape to be what it says it is. The arbiter checks the rest (that
/// terms name the job's parties, that a bundle answers the job) before it rules.
export function shapeProblems(kind: DocKind, doc: unknown): string[] {
  const problems: string[] = [];
  if (kind === 'deliverable') {
    if (typeof doc !== 'string' || doc.length === 0) problems.push('a deliverable is a non-empty string');
    return problems;
  }
  if (!isObject(doc)) return ['the document must be a JSON object'];
  if (kind === 'terms') {
    if (!isText(doc['title'], 200) || !doc['title']) problems.push('title: a string up to 200 characters');
    if (!isText(doc['deliverableSpec']) || !doc['deliverableSpec']) problems.push('deliverableSpec: a non-empty string');
    if (!Array.isArray(doc['acceptanceCriteria']) || doc['acceptanceCriteria'].length === 0 || doc['acceptanceCriteria'].length > 50) {
      problems.push('acceptanceCriteria: 1 to 50 criteria');
    }
    if (typeof doc['amount'] !== 'string' || !/^\d+(\.\d{1,6})?$/.test(doc['amount'])) problems.push('amount: a decimal string');
    for (const party of ['buyer', 'seller'] as const) {
      if (typeof doc[party] !== 'string' || !isAddress(doc[party] as string)) problems.push(`${party}: an address`);
    }
    return problems;
  }
  if (doc['version'] !== 1) problems.push('version: 1');
  if (typeof doc['jobId'] !== 'number' || !Number.isSafeInteger(doc['jobId']) || doc['jobId'] < 1) problems.push('jobId: a job number');
  const deliverable = doc['deliverable'];
  if (!isObject(deliverable) || typeof deliverable['contentHash'] !== 'string' || !isHash(deliverable['contentHash'])) {
    problems.push('deliverable.contentHash: a 32-byte hash');
  }
  if (!Array.isArray(doc['artifacts'])) problems.push('artifacts: a list');
  if (kind === 'evidence') {
    if (!isText(doc['claim']) || !doc['claim']) problems.push('claim: a non-empty string');
    for (const field of ['termsHash', 'deliverableHash'] as const) {
      if (typeof doc[field] !== 'string' || !isHash(doc[field] as string)) problems.push(`${field}: a 32-byte hash`);
    }
  } else {
    if (!isText(doc['statement']) || !doc['statement']) problems.push('statement: a non-empty string');
    if (typeof doc['disputeHash'] !== 'string' || !isHash(doc['disputeHash'] as string)) problems.push('disputeHash: a 32-byte hash');
  }
  return problems;
}
