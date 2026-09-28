import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
};

export function casePaths(
  dir: string,
  jobId: number | bigint,
): { terms: string; bundle: string } {
  const stem = `job-${jobId}`;
  return {
    terms: resolve(dir, `${stem}.terms.json`),
    bundle: resolve(dir, `${stem}.evidence.json`),
  };
}

/// Writes both files in canonical form, so the bytes on disk are exactly the
/// bytes that hash to `termsHash` / `disputeHash`. A receipt that reproduces the
/// hash from the file is then a real check, not a formality.
export function writeCase(
  dir: string,
  jobId: number | bigint,
  evidenceCase: EvidenceCase,
): { terms: string; bundle: string } {
  const paths = casePaths(dir, jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(paths.terms, `${canonicalize(evidenceCase.terms)}\n`);
  writeFileSync(paths.bundle, `${canonicalize(evidenceCase.bundle)}\n`);
  return paths;
}

export function readCase(dir: string, jobId: number | bigint): EvidenceCase {
  const paths = casePaths(dir, jobId);
  return {
    terms: JSON.parse(readFileSync(paths.terms, 'utf8')) as JobTerms,
    bundle: JSON.parse(readFileSync(paths.bundle, 'utf8')) as EvidenceBundle,
  };
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
  return problems;
}

/// The bundle the arbiter evaluated must be the bundle the buyer pinned on
/// chain. Recomputed here so both sides of the comparison come from one place.
export function disputeHashOf(evidenceCase: EvidenceCase): Hex {
  return hashCanonical(evidenceCase.bundle);
}
