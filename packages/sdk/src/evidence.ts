import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, stringToHex, type Hex } from 'viem';

/// Deterministic JSON: object keys sorted recursively, arrays preserved in order.
///
/// Both the buyer (who pins `disputeHash`) and the arbiter (who pins
/// `evidenceHash`) hash the same byte string for the same logical content, in any
/// runtime, without depending on key insertion order.
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortValue(source[key]);
    return sorted;
  }
  return value;
}

/// keccak256 over the canonical UTF-8 encoding of `value`.
export function hashCanonical(value: unknown): Hex {
  return keccak256(stringToHex(canonicalize(value)));
}

/// keccak256 over a raw string. Used for free-text rationale.
export function hashText(text: string): Hex {
  return keccak256(stringToHex(text));
}

/// 32-byte memo carrying a job id, matching what `TempexEscrow.fund` writes.
export function jobMemo(jobId: bigint): Hex {
  return `0x${jobId.toString(16).padStart(64, '0')}` as Hex;
}

export type JobTerms = {
  title: string;
  deliverableSpec: string;
  acceptanceCriteria: string[];
  amount: string;
  currency?: string;
  buyer: string;
  seller: string;
  /// Present when the job is one tranche of a milestone plan.
  plan?: { hash: Hex; index: number; count: number };
};

export type EvidenceArtifact = {
  kind: 'text' | 'file' | 'uri' | 'metric' | 'log';
  label: string;
  content?: string;
  uri?: string;
  contentHash?: Hex;
};

/// What the buyer hands the arbiter when opening a dispute.
export type EvidenceBundle = {
  version: 1;
  jobId: number;
  termsHash: Hex;
  deliverableHash: Hex;
  claim: string;
  deliverable: {
    content?: string;
    uri?: string;
    contentHash: Hex;
  };
  artifacts: EvidenceArtifact[];
  submittedAt: string;
};

/// What the seller hands the arbiter after a dispute: its own copy of the
/// delivered work and its account of why it meets the terms. Pinned on chain by
/// `respond(jobId, hashCanonical(response))` inside the response window.
///
/// The seller's copy of the deliverable matters: the chain holds only its hash,
/// and the buyer's bundle is not trusted to reproduce it faithfully. Whichever
/// copy hashes to the on-chain commitment is the one the arbiter scores.
export type SellerResponse = {
  version: 1;
  jobId: number;
  /// the dispute this answers, so a response cannot be replayed onto another
  disputeHash: Hex;
  statement: string;
  deliverable: {
    content?: string;
    uri?: string;
    contentHash: Hex;
  };
  artifacts: EvidenceArtifact[];
  submittedAt: string;
};

/// What the arbiter produces. `rationaleHash` commits the model to its reasoning:
/// the full text lives in the receipt, the hash lives in the signature.
export type Ruling = {
  jobId: number;
  sellerAwardBps: number;
  evidenceHash: Hex;
  rationaleHash: Hex;
  rationale: string;
  issuedAt: number;
  validUntil: number;
  model: string;
  confidence?: number;
  factors?: string[];
};

// --------------------------------------------------------------- case files

/// One dispute's paper trail: the terms both parties agreed to, and the bundle
/// the buyer submitted when opening the dispute.
///
/// The terms document is not optional. The chain stores only `termsHash`, so an
/// arbiter that evaluates criteria it cannot see would be ruling on the hash of
/// a promise; the file is what makes the ruling checkable.
export type EvidenceCase = {
  terms: JobTerms;
  bundle: EvidenceBundle;
  /// The seller's answer, when it responded. Absent if it stayed silent.
  response?: SellerResponse;
};

export function casePaths(
  dir: string,
  jobId: number | bigint,
): { terms: string; bundle: string; response: string } {
  const stem = `job-${jobId}`;
  return {
    terms: resolve(dir, `${stem}.terms.json`),
    bundle: resolve(dir, `${stem}.evidence.json`),
    response: resolve(dir, `${stem}.response.json`),
  };
}

/// Writes both files in canonical form, so the bytes on disk are exactly the
/// bytes that hash to `termsHash` / `disputeHash`. A receipt that reproduces the
/// hash from the file is then a real check, not a formality.
export function writeCase(
  dir: string,
  jobId: number | bigint,
  evidenceCase: EvidenceCase,
): { terms: string; bundle: string; response: string } {
  const paths = casePaths(dir, jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(paths.terms, `${canonicalize(evidenceCase.terms)}\n`);
  writeFileSync(paths.bundle, `${canonicalize(evidenceCase.bundle)}\n`);
  if (evidenceCase.response !== undefined) writeResponse(dir, jobId, evidenceCase.response);
  return paths;
}

/// Writes the seller's response in canonical form, next to the buyer's bundle.
export function writeResponse(
  dir: string,
  jobId: number | bigint,
  response: SellerResponse,
): string {
  const path = casePaths(dir, jobId).response;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${canonicalize(response)}\n`);
  return path;
}

export function readCase(dir: string, jobId: number | bigint): EvidenceCase {
  const paths = casePaths(dir, jobId);
  const evidenceCase: EvidenceCase = {
    terms: JSON.parse(readFileSync(paths.terms, 'utf8')) as JobTerms,
    bundle: JSON.parse(readFileSync(paths.bundle, 'utf8')) as EvidenceBundle,
  };
  if (existsSync(paths.response)) {
    evidenceCase.response = JSON.parse(readFileSync(paths.response, 'utf8')) as SellerResponse;
  }
  return evidenceCase;
}

/// The bundle's own integrity: the terms document must be the one the bundle
/// pinned, and the bundle must be for the job it claims. Enforced before hashing
/// so a mismatch is reported as a readable problem instead of a wrong hash.
export function caseIntegrity(evidenceCase: EvidenceCase): string[] {
  const problems: string[] = [];
  const { terms, bundle } = evidenceCase;
  const termsHash = hashCanonical(terms);
  if (termsHash !== bundle.termsHash) {
    problems.push(
      `terms document hashes to ${termsHash} but the bundle pins ${bundle.termsHash}`,
    );
  }
  if (bundle.version !== 1) {
    problems.push(`unsupported bundle version ${String(bundle.version)}`);
  }
  for (const [role, address] of [
    ['buyer', terms.buyer],
    ['seller', terms.seller],
  ] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      problems.push(`terms ${role} is not an address: ${String(address)}`);
    }
  }
  if (terms.acceptanceCriteria.length === 0) {
    problems.push('terms carry no acceptance criteria to rule on');
  }
  const { response } = evidenceCase;
  if (response !== undefined) {
    if (response.version !== 1) {
      problems.push(`unsupported response version ${String(response.version)}`);
    }
    if (response.jobId !== bundle.jobId) {
      problems.push(`response is for job ${response.jobId}, not job ${bundle.jobId}`);
    }
    if (response.disputeHash !== hashCanonical(bundle)) {
      problems.push('response answers a different dispute than the bundle on file');
    }
  }
  return problems;
}

/// The bundle the arbiter evaluated must be the bundle the buyer pinned on
/// chain. Recomputed here so both sides of the comparison come from one place.
export function disputeHashOf(evidenceCase: EvidenceCase): Hex {
  return hashCanonical(evidenceCase.bundle);
}

/// What the seller pins with `respond`: the canonical hash of its response.
export function responseHashOf(response: SellerResponse): Hex {
  return hashCanonical(response);
}
