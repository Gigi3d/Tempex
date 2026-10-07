import { snapshot, type CorpusCase, type CriterionSignal } from './snapshot';

/// The corpus predictions omit each criterion's check; the terms carry it.
export function criteriaWithChecks(entry: CorpusCase): CriterionSignal[] {
  const terms = (entry.terms['acceptanceCriteria'] ?? []) as { id: string; check?: { type: string; at?: string } }[];
  return entry.prediction.criteria.map((criterion) => ({
    ...criterion,
    check: terms.find((t) => t.id === criterion.id)?.check,
  }));
}

export function caseById(id: string): CorpusCase | undefined {
  return snapshot.corpus.find((entry) => entry.id === id);
}

/// The live job that ran a scenario, when one did.
export function liveJobFor(id: string): string | null {
  return snapshot.receipt.scenario === id ? String(snapshot.receipt.session.jobId) : null;
}

export const CASE_NOTES: Record<string, { why: string; twist: string }> = {
  underdelivered: {
    why: 'The honest middle: partial credit, by the math.',
    twist: 'Six of eight strings arrived in French; prices, dates and the glossary did not. The award lands between both offers.',
  },
  nodelivery: {
    why: 'Code verifies emptiness as surely as quality.',
    twist: 'Nothing arrived, and every check says so. The band sits at the floor without anyone arguing.',
  },
  badfaith: {
    why: 'The escrow’s survival test: the checks rule against the complaint.',
    twist: 'The buyer disputes work that meets every check. The seller is paid almost in full.',
  },
  echo: {
    why: 'Vocabulary is not delivery.',
    twist: 'The seller pastes the acceptance criteria back as the deliverable. It earns what an empty delivery earns.',
  },
};
