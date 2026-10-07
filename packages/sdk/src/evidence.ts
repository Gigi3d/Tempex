import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canonicalize,
  type EvidenceBundle,
  type EvidenceCase,
  type JobTerms,
  type SellerResponse,
} from './canonical.js';

export {
  canonicalize,
  hashCanonical,
  hashText,
  jobMemo,
  normalizeCriteria,
  caseIntegrity,
  disputeHashOf,
  responseHashOf,
} from './canonical.js';
export type {
  CriterionCheck,
  Criterion,
  NormalizedCriterion,
  JobTerms,
  EvidenceArtifact,
  EvidenceBundle,
  SellerResponse,
  Ruling,
  EvidenceCase,
} from './canonical.js';

/// Reading and writing case files. Node only; the hashing they rely on lives in
/// `canonical.ts`, which a browser can import.

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
