/// Shapes of the beacon's read routes, written from real responses
/// (packages/beacon/src/beacon.ts). Amounts arrive as decimal strings of token
/// units; a `{ units, value }` pair carries both the raw units and the display value.

export type Amount = { units: string; value: string };
export type TxRef = { block: number; tx: `0x${string}` };

export type Stage =
  | 'created'
  | 'funded'
  | 'delivered'
  | 'accepted'
  | 'disputed'
  | 'responded'
  | 'resolved'
  | 'refunded'
  | 'cancelled'
  | 'lapsed';

export type JobRecord = {
  jobId: string;
  buyer: `0x${string}`;
  seller: `0x${string}`;
  amount: string;
  termsHash: `0x${string}`;
  deliveryDeadline: number;
  reviewWindow: number;
  stage: Stage;
  created?: TxRef;
  terms?: TxRef & {
    arbiter: `0x${string}`;
    platformFeeBps: number;
    arbitrationFeeBps: number;
    protocolCutBps: number;
    /// v3 escrows: the minimum arbitration fee the job locked, in token units
    arbitrationFeeFloor?: string;
  };
  /// v3 escrows: who brought the job and what it has been paid
  referral?: TxRef & { referrer: `0x${string}`; shareBps: number; paid: string };
  funded?: TxRef & { amount: string };
  delivered?: TxRef & {
    deliverableHash: `0x${string}`;
    deliveredAt: number;
    reviewDeadline: number;
    uri?: string;
  };
  accepted?: TxRef;
  dispute?: TxRef & {
    disputeHash: `0x${string}`;
    disputedAt: number;
    buyerOfferBps: number;
    responseDeadline: number;
  };
  response?: TxRef & { responseHash: `0x${string}`; respondedAt: number; sellerAskBps: number };
  verdict?: TxRef & {
    sellerAwardBps: number;
    sellerAmount: string;
    buyerAmount: string;
    arbitrationFee: string;
    evidenceHash: `0x${string}`;
    rationaleHash: `0x${string}`;
    verdictDigest: `0x${string}`;
  };
  refunded?: TxRef;
  cancelled?: TxRef;
  lapsed?: TxRef;
};

export type JobsList = { count: number; indexed: number; order: string; jobs: JobRecord[] };

export type TimelineEntry = {
  event: string;
  block: number;
  tx: `0x${string}`;
  explorer: string;
  detail: string;
};

export type Proof = {
  jobId: string;
  stage: Stage;
  job: JobRecord;
  timeline: TimelineEntry[];
  replay: string[];
};

export type Stats = {
  generatedAt: string;
  chainId: number;
  network: string;
  escrow: `0x${string}`;
  token: { address: `0x${string}`; symbol: string; decimals: number };
  blockRange: { from: string; to: string };
  events: number;
  jobs: {
    total: number;
    created: number;
    funded: number;
    delivered: number;
    accepted: number;
    disputed: number;
    resolved: number;
    refunded: number;
    cancelled: number;
    settlementRate: number;
    disputeRate: number;
  };
  money: Record<
    'escrowed' | 'paidToSellers' | 'refundedToBuyers' | 'arbitrationFees' | 'platformFees' | 'withdrawn' | 'stillInEscrow',
    Amount
  >;
  arbitration: {
    verdicts: number;
    avgSellerAwardBps: number | null;
    minSellerAwardBps: number | null;
    maxSellerAwardBps: number | null;
    bounded: boolean;
    timings: { jobId: string; disputedAt: number; verdictAt: number; seconds: number; blocks: number; tx: string }[];
  };
  participants: { buyers: number; sellers: number; unique: number };
  proofs: { jobId: string; stage: string; block: number; tx: string }[];
};

export type ArbiterRecord = {
  jobs: number;
  disputes: number;
  ruled: number;
  lapsed: number;
  openDisputes: number;
  averageSellerAwardBps: number | null;
};
export type ArbiterListing = {
  arbiter: `0x${string}`;
  active: boolean;
  feeBps: number;
  metadataURI: string | null;
  record: ArbiterRecord;
};
export type Arbiters = { house: ArbiterListing; listed: ArbiterListing[]; note: string };

export type Reputation = {
  address: `0x${string}`;
  generatedAt: string;
  blockRange: { from: string; to: string };
  score: number;
  band: 'unproven' | 'active' | 'settled' | 'trusted' | 'contested';
  factors: { label: string; points: number; detail: string }[];
  asBuyer: { jobs: number; escrowed: Amount; accepted: number; disputed: number; refunded: number };
  asSeller: {
    jobs: number;
    earned: Amount;
    accepted: number;
    disputed: number;
    verdicts: number;
    avgAwardBps: number | null;
    withdrawn: Amount;
  };
  counters: Record<string, number>;
  proofJobIds: string[];
  recipe: string[];
};

export type Quote = {
  generatedAt: string;
  role: 'seller' | 'buyer';
  amount: Amount;
  fee: {
    token: string;
    sponsored: boolean;
    sponsorUrl: string;
    measured: Amount;
    measuredOn: { tx: string; block: number; jobId: string };
  };
  total: Amount;
  breakdown: { line: string; cost: Amount; note: string }[];
};

export type Ready = {
  address: `0x${string}`;
  role: string;
  generatedAt: string;
  onChain: {
    exists: boolean;
    nonce: number;
    tokenBalance: Amount;
    escrowAllowance: Amount;
    escrowCredit: Amount;
  };
  reputation: { score: number; band: string };
  verdict: string;
  blockers: string[];
  nextActions: string[];
};

export type RouteInfo = { path: string; method: 'GET' | 'POST'; summary: string; paid: boolean };

/// Where a value came from: the live beacon, or the baked snapshot.
export type Sourced<T> = { data: T; source: 'live' | 'snapshot'; asOf: string };

/// An access key an owner authorized, as the beacon's agent desk reads it from
/// Tempo's keychain.
export type AgentKey = {
  keyId: `0x${string}`;
  name: string | null;
  role: 'buyer' | 'seller' | 'both' | null;
  limit: string | null;
  period: number | null;
  keyType: string;
  expiry: number;
  revoked: boolean;
  expired: boolean;
  spendPolicy: string;
  remaining: string | null;
  periodEnd: number | null;
  spent: string;
  authorized: { block: number; tx: `0x${string}` };
  revokedAt?: { block: number; tx: `0x${string}` };
};

export type AgentPairing = {
  code: string;
  status: 'pending' | 'approved' | 'expired';
  createdAt: number;
  expiresAt: number;
  request: {
    version: 1;
    chainId: number;
    escrow: `0x${string}`;
    keyId: `0x${string}`;
    publicKey: `0x${string}`;
    name: string;
    role: 'buyer' | 'seller' | 'both';
    limit: string;
    period: number;
    days: number;
    witness: `0x${string}`;
    issuedAt: number;
  };
  approval?: { owner: `0x${string}`; tx: `0x${string}`; at: number };
};
