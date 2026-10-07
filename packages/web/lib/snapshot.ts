import snapshotJson from '@/data/snapshot.json';

import type { Arbiters, JobRecord, JobsList, Proof, Quote, Reputation, RouteInfo, Stats } from './types';

/// The adjudication the arbiter signed for the demo receipt, as written by the
/// demo runner (runs/demo-*.json).
export type Adjudication = {
  jobId: number;
  engine: 'rules' | 'llm' | 'panel' | string;
  model: string;
  amount: string;
  evidenceHash: string;
  ruling: { sellerAwardBps: number; rationale: string; rationaleHash: string; issuedAt: number; validUntil: number; model: string };
  signature: string;
  digest: string;
  recovered: string;
  registeredArbiter: string;
  certified: boolean;
  money: {
    amount: string;
    bond: string;
    bondToSeller: string;
    arbitrationFee: string;
    arbitrationFeeBps: number;
    sellerAmount: string;
    buyerAmount: string;
  };
  band: { lowBps: number; highBps: number; center: number };
  offers: { lowBps: number; highBps: number };
  boundedBand: { lowBps: number; highBps: number; center: number };
  signals: {
    criteria: CriterionSignal[];
    totalWeight: number;
    checkedWeight: number;
    earnedWeight: number;
    openWeight: number;
    deliverableText?: string;
    sellerResponded: boolean;
  };
  clamped: boolean;
};

export type CriterionSignal = {
  id: string;
  text: string;
  weight: number;
  kind: 'check' | 'open' | string;
  credit?: number;
  evidence?: string;
  check?: string | { type: string; at?: string };
};

export type Receipt = {
  file: string;
  scenario: string;
  title: string;
  premise: string;
  at: string;
  chainId: number;
  escrow: string;
  escrowExplorer: string;
  ok: boolean;
  expectations: { check: string; expected: unknown; actual: unknown; passed: boolean }[];
  parties: { buyer: string; seller: string };
  session: {
    jobId: number;
    termsHash: string;
    deliverableHash: string;
    disputeHash: string;
    amount: number;
    stages: Record<string, Record<string, unknown>>;
  };
  adjudication: Adjudication;
  evidence: {
    terms: { title?: string; deliverableSpec?: string; acceptanceCriteria?: unknown[] } & Record<string, unknown>;
    bundle: { claim?: string; deliverable?: { content?: string } } & Record<string, unknown>;
    response: { statement?: string } & Record<string, unknown>;
  };
};

export type CorpusCase = {
  id: string;
  title: string;
  premise: string;
  expect: { band: [number, number]; center: number } & Record<string, unknown>;
  offers: { buyerOfferBps: number | null; sellerAskBps: number | null };
  prediction: {
    ok: boolean;
    center: number;
    band: [number, number];
    earnedWeight: number;
    openWeight: number;
    totalWeight: number;
    criteria: CriterionSignal[];
    rulingBps: number;
  };
  drill: { requested: number; bps: number; clamped: boolean; reading: string }[];
  terms: { title?: string; deliverableSpec?: string; amount?: string } & Record<string, unknown>;
  claim: string;
  deliverable: string | null;
  response: { statement?: string } | null;
};

export type Snapshot = {
  bakedAt: string;
  beaconAt: string | null;
  beacon: {
    url: string;
    stats: Stats;
    jobs: JobsList;
    detail: Record<string, JobRecord>;
    proofs: Record<string, Proof>;
    arbiters: Arbiters;
    reputation: Record<string, Reputation>;
    quote: { seller: Quote; buyer: Quote };
    onboard: { seller: unknown; buyer: unknown };
    policy: unknown;
    manifest: { routes: RouteInfo[]; tools?: unknown[] } & Record<string, unknown>;
    agent: Record<string, unknown>;
    health: Record<string, unknown>;
  } | null;
  receipt: Receipt;
  corpus: CorpusCase[];
};

export const snapshot = snapshotJson as unknown as Snapshot;

export const CANONICAL_JOB = String(snapshot.receipt.session.jobId);
