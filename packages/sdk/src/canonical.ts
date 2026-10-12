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

/// How one acceptance criterion is verified, agreed in the terms before any work
/// starts. Every check is a pure function of the delivered bytes, so anyone can
/// re-run it and get the same answer. `at` is an RFC 6901 JSON pointer into the
/// deliverable; omitted, the check reads the whole deliverable as text.
export type CriterionCheck =
  /// the selection parses as JSON and, when given, satisfies a JSON Schema
  | { type: 'json'; at?: string; schema?: Record<string, unknown> }
  /// these dotted keys exist in the selected object; credit is the share present
  | { type: 'jsonKeys'; at?: string; keys: string[]; nonEmpty?: boolean }
  /// how many words, lines or items the selection holds
  | { type: 'count'; at?: string; unit: 'words' | 'lines' | 'items'; min?: number; max?: number }
  /// the selection's text is written in this language (ISO 639-1 or 639-3)
  | { type: 'language'; at?: string; is: string; minLength?: number }
  /// selected string values (optionally only keys matching a glob) match a
  /// pattern; credit is the share that match
  | { type: 'regex'; at?: string; keys?: string; pattern: string; flags?: string }
  /// the selection's text contains each of these literal strings
  | { type: 'contains'; at?: string; all: string[]; caseSensitive?: boolean };

/// An acceptance criterion. A plain string, or an object without a `check`, is a
/// unchecked criterion: no code can decide it, so its weight splits at the
/// midpoint, bounded by the parties' offers. An object with a `check` is decided exactly.
export type Criterion =
  | string
  | { id?: string; text: string; weight?: number; check?: CriterionCheck };

/// A criterion with its defaults filled in: an id, a text, and a weight.
export type NormalizedCriterion = {
  id: string;
  text: string;
  weight: number;
  check?: CriterionCheck;
};

/// Fills in each criterion's id (`c1`, `c2`, …) and weight (1). Throws on a
/// weight that is not a positive finite number or on a duplicate id, both of
/// which would make the band ambiguous.
export function normalizeCriteria(criteria: readonly Criterion[]): NormalizedCriterion[] {
  const seen = new Set<string>();
  return criteria.map((criterion, index) => {
    const normalized: NormalizedCriterion =
      typeof criterion === 'string'
        ? { id: `c${index + 1}`, text: criterion, weight: 1 }
        : {
            id: criterion.id ?? `c${index + 1}`,
            text: criterion.text,
            weight: criterion.weight ?? 1,
            ...(criterion.check !== undefined ? { check: criterion.check } : {}),
          };
    if (!Number.isFinite(normalized.weight) || normalized.weight <= 0) {
      throw new Error(`criterion ${normalized.id} has weight ${normalized.weight}; weights must be positive`);
    }
    if (seen.has(normalized.id)) throw new Error(`criterion id ${normalized.id} is used twice`);
    seen.add(normalized.id);
    return normalized;
  });
}

export type JobTerms = {
  title: string;
  deliverableSpec: string;
  acceptanceCriteria: Criterion[];
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

/// What the arbiter produces. `rationaleHash` commits the arbiter to its reasoning:
/// the full text lives in the receipt, the hash lives in the signature.
export type Ruling = {
  jobId: number;
  sellerAwardBps: number;
  evidenceHash: Hex;
  rationaleHash: Hex;
  rationale: string;
  issuedAt: number;
  validUntil: number;
  /// the settlement rule that produced the ruling, e.g. `tempex-rules/1`
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
