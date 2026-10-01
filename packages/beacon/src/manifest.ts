import { toFunctionSelector, type Address, type Hex } from 'viem';

import { WS_URL } from '@tempex/sdk';

import type { EscrowConfig, TokenInfo } from './chain.js';
import type { BeaconConfig } from './config.js';
import { endpoint } from './config.js';
import type { Money } from './reputation.js';
import { POLICY_TEMPLATES } from './onboard.js';
import { PAYMENT_SCHEME, type PaymentRequirement } from './payments.js';

/// Schema version of the manifest itself. An agent that cannot parse this version
/// should say so loudly rather than guess.
export const MANIFEST_SCHEMA = 'tempex/1';

export type Route = {
  path: string;
  method: 'GET' | 'POST';
  summary: string;
  /// Paid routes sit behind the 402 gate; everything an agent needs to *decide*
  /// is free, because a paywall in front of the evidence is a paywall in front of
  /// the truth.
  paid: boolean;
};

/// The one route table, read by both the manifest and the router.
///
/// Shared so the documented API and the served API cannot drift apart — a manifest
/// that advertises a route the server does not implement is worse than no manifest.
export const ROUTES: Route[] = [
  { path: '/', method: 'GET', summary: 'Landing: who this beacon is, and the two documents to read first.', paid: false },
  { path: '/.well-known/tempex.json', method: 'GET', summary: 'This document: identity, protocol state, costs, tools, and how to verify all of it.', paid: false },
  { path: '/.well-known/agent.json', method: 'GET', summary: 'Agent card (A2A-style): skills, modes, and the endpoint to call.', paid: false },
  { path: '/health', method: 'GET', summary: 'Liveness plus how far the index has caught up to the head of the chain.', paid: false },
  { path: '/stats', method: 'GET', summary: 'Whole-network evidence: jobs by stage, money moved, verdict bounds, measured arbitration latency.', paid: false },
  { path: '/jobs', method: 'GET', summary: 'Every job the escrow has ever seen, folded from events. Supports ?stage= and ?limit=.', paid: false },
  { path: '/jobs/:jobId', method: 'GET', summary: 'One job, with the block and transaction behind each of its state changes.', paid: false },
  { path: '/proof/:jobId', method: 'GET', summary: 'The receipts for one job plus the exact calls needed to re-derive them.', paid: false },
  { path: '/reputation/:address', method: 'GET', summary: 'An itemised, recomputable reputation score for any address.', paid: false },
  { path: '/arbiters', method: 'GET', summary: 'The arbiter market: the house arbiter and every listed one, with fees and a track record folded from escrow events.', paid: false },
  { path: '/policy', method: 'GET', summary: 'Deal-policy templates: deadlines, review windows, evidence requirements, expected verdict bands.', paid: false },
  { path: '/onboard', method: 'GET', summary: 'What it takes to start trading, per role, with the zero-balance claim stated and justified.', paid: false },
  { path: '/ready', method: 'GET', summary: 'Can this address trade right now? Reads nonce, balance, allowance, and escrow credit.', paid: false },
  { path: '/quote', method: 'GET', summary: 'All-in cost of a job, line by line, with the fee measured from a real receipt.', paid: false },
  { path: '/blueprint/:action', method: 'POST', summary: 'Encoded calldata for one intent. The beacon builds it; the agent signs it.', paid: false },
  { path: '/discover', method: 'GET', summary: 'Find registered agents by capability, ranked by on-chain reputation.', paid: true },
  { path: '/registry/challenge', method: 'POST', summary: 'Ask for a registration challenge bound to this beacon, this escrow, and an expiry.', paid: false },
  { path: '/registry', method: 'POST', summary: 'Register an agent by signing the challenge. The signature is the only credential.', paid: false },
  { path: '/registry', method: 'GET', summary: 'The signed registry file, portable to any other beacon.', paid: false },
];

export type ToolDescriptor = {
  name: string;
  description: string;
  route: string;
  method: 'GET' | 'POST';
  paid: boolean;
  inputSchema: Record<string, unknown>;
  returns: string;
  /// A single sentence an agent can act on without reading anything else.
  when: string;
};

/// The manifest as MCP-style tools, so an agent that speaks tool-calling can use
/// Tempex without reading a TypeScript SDK.
export const TOOLS: ToolDescriptor[] = [
  {
    name: 'tempex_network_stats',
    description: 'Every job, payment, refund and verdict the escrow has produced, aggregated with the receipts behind each number.',
    route: '/stats',
    method: 'GET',
    paid: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    returns: 'NetworkStats: job counts by stage, money totals, verdict bounds, measured dispute-to-verdict latency, proofs.',
    when: 'You are deciding whether this protocol is real.',
  },
  {
    name: 'tempex_reputation',
    description: 'Reputation for any address, decomposed into the factors that produced it and a recipe for recomputing it independently.',
    route: '/reputation/:address',
    method: 'GET',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'Any Tempo address.' } },
      required: ['address'],
      additionalProperties: false,
    },
    returns: 'Reputation: score 0-1000, band, itemised factors, buyer/seller history, proof job ids.',
    when: 'You are deciding whether to trust a counterparty you have never met.',
  },
  {
    name: 'tempex_job',
    description: 'The full on-chain state of one escrow job, including the transaction behind every state change.',
    route: '/jobs/:jobId',
    method: 'GET',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Decimal job id.' } },
      required: ['jobId'],
      additionalProperties: false,
    },
    returns: 'JobRecord: parties, amount, deadlines, stage, delivery, verdict, refund, and the block/tx for each.',
    when: 'You need to know exactly where a deal stands.',
  },
  {
    name: 'tempex_onboarding_plan',
    description: 'The steps, costs and guarantees for starting to trade, for a buyer or a seller, computed from live chain state.',
    route: '/onboard',
    method: 'GET',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['seller', 'buyer'] },
        amount: { type: 'string', description: 'Optional principal to escrow, in whole token units (e.g. "25").' },
        policy: { type: 'string', description: 'Policy template id; defaults to "standard".' },
      },
      required: ['role'],
      additionalProperties: false,
    },
    returns: 'OnboardingPlan: claim, whyItWorks, steps with per-step balance requirements, costs, custody statement, guarantees.',
    when: 'You have a key and no balance and want to know what you can already do.',
  },
  {
    name: 'tempex_readiness',
    description: 'Whether a specific address can transact right now, and the encoded transactions that fix whatever is missing.',
    route: '/ready',
    method: 'GET',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        role: { type: 'string', enum: ['seller', 'buyer'] },
        amount: { type: 'string', description: 'Required for buyers: the principal they intend to escrow.' },
      },
      required: ['address', 'role'],
      additionalProperties: false,
    },
    returns: 'ReadinessReport: verdict, blockers, on-chain balances/allowance/credit, and ready-to-sign next actions.',
    when: 'You are about to transact and want to fail before you broadcast, not after.',
  },
  {
    name: 'tempex_quote',
    description: 'The all-in cost of a job, itemised, with the transaction fee measured from a real receipt rather than estimated.',
    route: '/quote',
    method: 'GET',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['seller', 'buyer'] },
        amount: { type: 'string', description: 'Principal in whole token units.' },
      },
      required: ['role'],
      additionalProperties: false,
    },
    returns: 'Quote: total, breakdown lines, fee measurement with the transaction it was measured on.',
    when: 'You need a number you can put in a budget and defend.',
  },
  {
    name: 'tempex_blueprint',
    description: 'Encoded calldata for one escrow intent, with fee treatment and prerequisites. The beacon never signs; you do.',
    route: '/blueprint/:action',
    method: 'POST',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create-and-fund', 'approve', 'deliver', 'accept', 'auto-accept', 'dispute', 'respond', 'resolve', 'refund-expired', 'settle-lapsed', 'create-milestones', 'list-arbiter', 'delist-arbiter', 'withdraw'],
        },
        params: { type: 'object', description: 'Action-specific arguments; see the decoded call in the response.' },
        sponsored: { type: 'boolean', description: 'Default true: route the fee to Tempo’s hosted fee payer.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    returns: 'Blueprint: calls[], decoded calls, writeOptions, fee, prerequisites, and how to submit.',
    when: 'You want to act on Tempex without depending on a SDK.',
  },
  {
    name: 'tempex_discover',
    description: 'Registered agents matching a capability, ranked by on-chain reputation rather than by who paid or registered first.',
    route: '/discover',
    method: 'GET',
    paid: true,
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string' },
        role: { type: 'string', enum: ['seller', 'buyer', 'arbiter', 'relay'] },
        minScore: { type: 'number', description: 'Floor on the 0-1000 reputation score.' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    returns: 'RegistryListing[] with rank and reputation, or a 402 body describing how to pay.',
    when: 'You need a counterparty and want the ranking to be something nobody can buy.',
  },
  {
    name: 'tempex_register',
    description: 'List an agent. Two calls: fetch a challenge, then submit it signed with personal_sign.',
    route: '/registry',
    method: 'POST',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        name: { type: 'string' },
        agent: { type: 'string', description: 'One paragraph another agent reads to decide whether to hire you.' },
        role: { type: 'string', enum: ['seller', 'buyer', 'arbiter', 'relay'] },
        capabilities: { type: 'array', items: { type: 'string' } },
        endpoint: { type: 'string' },
        policy: { type: 'object' },
        accepts: { type: 'object' },
      },
      required: ['address', 'name', 'agent', 'role', 'capabilities'],
      additionalProperties: false,
    },
    returns: 'The stored RegistryEntry, carrying your signature so any beacon can re-verify it.',
    when: 'You want to be found, and to be judged by the same escrow everyone else is.',
  },
];

export type ManifestParams = {
  config: BeaconConfig;
  escrow: EscrowConfig;
  token: TokenInfo;
  index: {
    fromBlock: bigint;
    toBlock: bigint;
    head: bigint;
    events: number;
    jobs: number;
  };
  fee: { measured: Money | null; tx: Hex | null };
  discovery: PaymentRequirement;
  registry: { listings: number; file: string };
};

export type Claim = {
  claim: string;
  /// An executable check. If it cannot be checked, it does not belong here.
  check: string;
};

export type Manifest = {
  schema: typeof MANIFEST_SCHEMA;
  generatedAt: string;
  identity: {
    name: string;
    version: string;
    tagline: string;
    description: string;
    host: string;
    network: string;
    chainId: number;
    rpcUrl: string;
    wsUrl: string;
    explorerUrl: string;
    sponsorUrl: string | null;
    repository: string;
  };
  protocol: {
    escrow: Address;
    arbiter: Address;
    treasury: Address;
    owner: Address;
    paymentToken: { address: Address; symbol: string; decimals: number };
    fees: {
      platformBps: number;
      arbitrationBps: number;
      caps: { platformBps: number; arbitrationBps: number };
      denominator: number;
      note: string;
    };
    counters: { jobCount: string; nextJobId: string };
    custody: {
      beaconHoldsKeys: false;
      escrowIsUpgradeable: false;
      ownerCanTakeJobPrincipal: false;
      ownerPowers: string[];
      withdrawalMemo: Hex;
    };
  };
  index: {
    fromBlock: string;
    toBlock: string;
    head: string;
    lagBlocks: string;
    events: number;
    jobs: number;
    storage: string;
    note: string;
  };
  costs: {
    onboarding: Money;
    registration: Money;
    transactionFee: { sponsored: Money; unsponsored: Money | null; measuredOn: Hex | null };
    platformFee: string;
    arbitrationFee: string;
    discovery: { enabled: boolean; scheme: string; price: Money; payTo: Address | null };
    note: string;
  };
  claims: Claim[];
  verification: {
    /// Ordered, runnable steps. An agent that follows these does not need to trust
    /// anything in this document.
    recipe: string[];
    selectors: Record<string, Hex>;
  };
  endpoints: Record<string, string>;
  routes: Route[];
  tools: ToolDescriptor[];
  policies: { id: string; forThisDeal: string }[];
  registry: {
    listings: number;
    portable: boolean;
    signatureScheme: string;
    file: string;
    note: string;
  };
};

const SELECTORS: Record<string, string> = {
  arbiter: 'arbiter()',
  treasury: 'treasury()',
  owner: 'owner()',
  paymentToken: 'paymentToken()',
  platformFeeBps: 'platformFeeBps()',
  arbitrationFeeBps: 'arbitrationFeeBps()',
  maxPlatformFeeBps: 'MAX_PLATFORM_FEE_BPS()',
  maxArbitrationFeeBps: 'MAX_ARBITRATION_FEE_BPS()',
  jobCount: 'jobCount()',
  nextJobId: 'nextJobId()',
  credits: 'credits(address)',
  getJob: 'getJob(uint256)',
  eip712Domain: 'eip712Domain()',
  verdictDigest: 'verdictDigest((uint256,uint16,bytes32,bytes32,uint64,uint64))',
};

/// The document an agent reads first: what this is, what it costs, what it
/// guarantees, and how to check every one of those without trusting the author.
export function buildManifest(params: ManifestParams): Manifest {
  const { config, escrow, token, index } = params;
  const selectors = Object.fromEntries(
    Object.entries(SELECTORS).map(([key, signature]) => [key, toFunctionSelector(signature)]),
  ) as Record<string, Hex>;

  const zero: Money = { units: '0', value: '0' };
  const sponsored = config.sponsorUrl !== null;

  return {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    identity: {
      name: config.name,
      version: config.version,
      tagline: 'The default referee for agent commerce. No humans required.',
      description:
        'Tempex settles deals between agents that have never met and cannot sue each other. Money goes into an escrow on Tempo, delivery is hashed onto the chain, and a dispute is decided by a referee whose verdict the contract itself validates by signature. This beacon is the read-only front door: it indexes the escrow, derives reputation from it, prices discovery, and hands back calldata an agent signs with its own key.',
      host: config.host,
      network: config.network,
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
      wsUrl: WS_URL,
      explorerUrl: config.explorerUrl,
      sponsorUrl: config.sponsorUrl,
      repository: 'https://github.com/Gigi3d/Tempex',
    },
    protocol: {
      escrow: escrow.escrow,
      arbiter: escrow.arbiter,
      treasury: escrow.treasury,
      owner: escrow.owner,
      paymentToken: { address: token.address, symbol: token.symbol, decimals: token.decimals },
      fees: {
        platformBps: escrow.platformFeeBps,
        arbitrationBps: escrow.arbitrationFeeBps,
        caps: { platformBps: escrow.maxPlatformFeeBps, arbitrationBps: escrow.maxArbitrationFeeBps },
        denominator: escrow.bpsDenominator,
        note: `The owner can move fees within the caps and no further: setFees reverts above ${escrow.maxPlatformFeeBps} bps platform or ${escrow.maxArbitrationFeeBps} bps arbitration. Both caps are public constants, readable at the selectors below.`,
      },
      counters: { jobCount: escrow.jobCount.toString(), nextJobId: escrow.nextJobId.toString() },
      custody: {
        beaconHoldsKeys: false,
        escrowIsUpgradeable: false,
        ownerCanTakeJobPrincipal: false,
        ownerPowers: [
          'setArbiter(address) — choose the default referee for jobs created afterwards; every existing job keeps the arbiter it locked at creation',
          'setTreasury(address) — redirect future platform fees',
          'setFees(uint16,uint16) — within the on-chain caps, for jobs created afterwards only',
          'transferOwnership(address) + acceptOwnership() (two-step) / renounceOwnership()',
        ],
        withdrawalMemo: escrow.withdrawMemo,
      },
    },
    index: {
      fromBlock: index.fromBlock.toString(),
      toBlock: index.toBlock.toString(),
      head: index.head.toString(),
      lagBlocks: (index.head - index.toBlock).toString(),
      events: index.events,
      jobs: index.jobs,
      storage: 'memory, rebuilt from eth_getLogs on every start',
      note: 'There is no database. Every number this beacon serves is a fold over events it re-read from the chain, so it cannot drift, and anyone can reproduce it with the same scan.',
    },
    costs: {
      onboarding: zero,
      registration: zero,
      transactionFee: {
        sponsored: zero,
        unsponsored: params.fee.measured,
        measuredOn: params.fee.tx,
      },
      platformFee: `${escrow.platformFeeBps} bps of the escrowed amount, deducted at payout, capped at ${escrow.maxPlatformFeeBps} bps`,
      arbitrationFee: `${escrow.arbitrationFeeBps} bps, charged only when a dispute is resolved, capped at ${escrow.maxArbitrationFeeBps} bps`,
      discovery: {
        enabled: config.treasury !== null && config.discoveryPrice > 0n,
        scheme: PAYMENT_SCHEME,
        price: params.discovery.amount,
        payTo: params.discovery.payTo,
      },
      note: sponsored
        ? 'A seller can be hired, deliver, and collect holding nothing but a private key: Tempo has no gas token, the hosted fee payer signs the fee, and the escrow credits rather than pushes, so the first transaction a brand-new address ever sends can be the withdrawal of its first payment.'
        : 'No fee payer is configured for this beacon, so callers pay the transaction fee themselves in the payment token.',
    },
    claims: [
      {
        claim: 'Onboarding costs nothing. An address with a zero balance can earn and withdraw.',
        check: `GET /onboard?role=seller, then confirm the escrow's credits are pull-based: eth_call ${escrow.escrow} ${selectors['credits']} with your address, and read withdraw() in the source.`,
      },
      {
        claim: 'The referee cannot be forged, and cannot rule outside 0-10000 bps.',
        check: `resolve() recovers the EIP-712 signer and requires it to equal the arbiter the job locked at creation; read it from getJob(jobId) or the job's JobTermsLocked event and compare against its VerdictResolved verdictDigest.`,
      },
      {
        claim: 'The owner cannot take job principal.',
        check: 'Read contracts/src/TempexEscrow.sol: the only owner functions are setArbiter, setTreasury, setFees and ownership transfer. No function moves a job\'s amount to the owner.',
      },
      {
        claim: 'Fees are capped on-chain, not by policy.',
        check: `eth_call ${selectors['maxPlatformFeeBps']} and ${selectors['maxArbitrationFeeBps']}; setFees reverts above them.`,
      },
      {
        claim: 'Reputation is derived, not assigned, and any third party can recompute it.',
        check: 'GET /reputation/:address returns the itemised factors and a recipe; re-run the same scan from block ' + index.fromBlock.toString() + ' and you get the same score.',
      },
      {
        claim: 'Discovery ranking cannot be bought.',
        check: 'rankEntries sorts by on-chain score, then settled count, then registration age. Paying the discovery fee buys a query, never a position.',
      },
      {
        claim: 'Every statistic is backed by receipts.',
        check: 'GET /stats returns proofs[] with a block and transaction hash for the most recent jobs; fetch any of them from ' + config.explorerUrl + '.',
      },
    ],
    verification: {
      recipe: [
        `1. Point an RPC client at ${config.rpcUrl} (chainId ${config.chainId}).`,
        `2. Read the escrow's governance: eth_call to ${escrow.escrow} for arbiter(), owner(), treasury(), paymentToken(), platformFeeBps(), arbitrationFeeBps(), MAX_PLATFORM_FEE_BPS(), MAX_ARBITRATION_FEE_BPS(). They must equal the values in "protocol" above.`,
        `3. Rebuild the index: eth_getLogs from block ${index.fromBlock} to head, address ${escrow.escrow}, all topics. Fold JobCreated/JobFunded/JobDelivered/JobAccepted/DisputeRaised/VerdictResolved/JobRefunded/Withdrawal into job records.`,
        '4. Compare your fold against GET /stats and GET /jobs. Any difference is a bug in one of us, and the chain settles which.',
        `5. Check the referee: read eip712Domain() and confirm verifyingContract is ${escrow.escrow}; for any resolved job, recompute verdictDigest(verdict) and confirm ECDSA.recover(digest, signature) equals arbiter().`,
        `6. Check the money: for any job, the TIP-20 TransferWithMemo into the escrow carries memo == jobId, and payouts credit sellers via credits() with memo ${escrow.withdrawMemo} on withdrawal.`,
        `7. Check the fee: pull any transaction receipt and find the Transfer to Tempo's fee manager. That is the whole fee mechanism — there is no gas token.`,
        '8. Check this beacon holds nothing: it has no signing key, no custody, and no write path to the escrow. Every endpoint is a read or a calldata build.',
      ],
      selectors,
    },
    endpoints: Object.fromEntries(
      ROUTES.filter((route) => route.method === 'GET').map((route) => [
        route.path.replace(/^\//, '').replace(/\//g, '.') || 'root',
        endpoint(config, route.path),
      ]),
    ),
    routes: ROUTES,
    tools: TOOLS,
    policies: POLICY_TEMPLATES.map((policy) => ({ id: policy.id, forThisDeal: policy.forThisDeal })),
    registry: {
      listings: params.registry.listings,
      portable: true,
      signatureScheme: 'personal_sign over a beacon-bound, expiring challenge (EIP-191)',
      file: params.registry.file,
      note: 'A listing carries its own signature, so any beacon can import and re-verify the file. Registration is not an account: it is a claim about an address, signed by that address.',
    },
  };
}

export type AgentSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
};

/// A2A-shaped card, served at `/.well-known/agent.json`.
///
/// Same information as the manifest, arranged the way an agent-to-agent directory
/// already knows how to read, so Tempex is discoverable by crawlers that were
/// never told about it.
export function agentCard(manifest: Manifest): Record<string, unknown> {
  return {
    name: manifest.identity.name,
    description: manifest.identity.tagline,
    url: manifest.identity.host,
    version: manifest.identity.version,
    protocol: MANIFEST_SCHEMA,
    provider: {
      organization: 'Tempex',
      url: manifest.identity.repository,
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
      settlement: true,
      arbitration: true,
      custody: false,
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    network: {
      name: manifest.identity.network,
      chainId: manifest.identity.chainId,
      rpcUrl: manifest.identity.rpcUrl,
      explorerUrl: manifest.identity.explorerUrl,
      feePayer: manifest.identity.sponsorUrl,
    },
    contracts: {
      escrow: manifest.protocol.escrow,
      arbiter: manifest.protocol.arbiter,
      paymentToken: manifest.protocol.paymentToken.address,
    },
    skills: [
      {
        id: 'settle',
        name: 'Escrowed settlement',
        description: 'Hold payment in a contract until delivery is accepted, auto-accepted after a review window, or refunded past a deadline.',
        tags: ['escrow', 'settlement', 'payments', 'stablecoin'],
        examples: ['Escrow 25 alphaUSD for a translation job due in an hour', 'Release job 12 to the seller', 'Refund job 12, the deadline passed'],
      },
      {
        id: 'arbitrate',
        name: 'Binding arbitration',
        description: 'Hand a disputed delivery to a referee whose EIP-712 verdict the contract validates and executes, splitting the escrow within 0-10000 bps.',
        tags: ['arbitration', 'disputes', 'eip712', 'referee'],
        examples: ['Dispute job 12 with this evidence bundle', 'Relay the arbiter verdict for job 12'],
      },
      {
        id: 'trust',
        name: 'Derived reputation',
        description: 'Score any address from its settlement history alone, with every factor itemised and a recipe for recomputing it.',
        tags: ['reputation', 'trust', 'identity', 'scoring'],
        examples: ['How trustworthy is 0xabc…?', 'Rank sellers who do translation work'],
      },
      {
        id: 'discover',
        name: 'Agent discovery',
        description: 'A signed registry of agents that accept Tempex arbitration, ranked by on-chain history rather than by payment.',
        tags: ['discovery', 'registry', 'marketplace', 'a2a'],
        examples: ['Find me a seller who can summarise legal text', 'List agents with a score above 700'],
      },
      {
        id: 'onboard',
        name: 'Zero-balance onboarding',
        description: 'Plans, readiness checks, cost quotes and encoded calldata so an agent with a key and no funds can start trading immediately.',
        tags: ['onboarding', 'sponsored', 'calldata', 'fee-payer'],
        examples: ['What do I need to start selling?', 'Can 0xabc… fund a 25 unit job right now?', 'Give me the calldata to withdraw'],
      },
    ] satisfies AgentSkill[],
    payment: {
      scheme: PAYMENT_SCHEME,
      appliesTo: manifest.routes.filter((route) => route.paid).map((route) => route.path),
      requirement: manifest.costs.discovery,
      header: 'X-Payment',
      quoteHeader: 'X-Payment-Quote',
    },
    documentation: {
      manifest: endpointUrl(manifest, '/.well-known/tempex.json'),
      repository: manifest.identity.repository,
      verification: manifest.verification.recipe,
    },
  };
}

function endpointUrl(manifest: Manifest, path: string): string {
  return `${manifest.identity.host}${path}`;
}
