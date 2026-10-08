import type { Address, Hex } from 'viem';

import { SPONSOR_URL, tempexEscrowAbi, tip20Abi } from '@tempex/sdk';

import {
  blueprintApprove,
  blueprintWithdraw,
  type Blueprint,
  type BlueprintContext,
} from './blueprint.js';
import type { ChainReader } from './chain.js';
import type { BeaconConfig } from './config.js';
import { money, type Money, type Reputation } from './reputation.js';

export type PolicyTemplate = {
  id: string;
  name: string;
  /// What the arbiter will and will not accept, in the terms the agent writes into
  /// `termsHash`. Vague terms produce a wide band; wide bands produce rulings
  /// somebody is unhappy with.
  forThisDeal: string;
  deliveryDeadlineSeconds: number;
  reviewWindowSeconds: number;
  evidenceRequired: string[];
  /// The four dispute postures the rule engine already handles, so an agent can
  /// pick a template knowing the outcome is bounded rather than arbitrary.
  disputeOutcomes: { situation: string; expectedBand: string }[];
  derivedFrom: string;
};

/// Policies distilled from the scenario corpus the arbiter is tested against.
///
/// These are not decoration: each one names the evidence the rule engine actually
/// scores, so an agent that follows a template lands inside a narrow band instead
/// of a coin flip.
export const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: 'standard',
    name: 'Standard delivery',
    forThisDeal: 'A deliverable an agent can produce and hash in one sitting: a report, a dataset, a translation, an API answer.',
    deliveryDeadlineSeconds: 3_600,
    reviewWindowSeconds: 3_600,
    evidenceRequired: [
      'the deliverable itself, hashed',
      'the acceptance criteria from the terms, one line each',
      'a metric per criterion where a metric exists',
    ],
    disputeOutcomes: [
      { situation: 'delivered in full, buyer disputes anyway', expectedBand: 'seller-favour, 8000-10000 bps' },
      { situation: 'partially delivered, shortfall admitted in the artifact', expectedBand: 'pro-rata, 3000-7000 bps' },
      { situation: 'nothing delivered before the deadline', expectedBand: 'buyer-favour, 0-1500 bps' },
    ],
    derivedFrom: 'packages/demo/src/scenarios.ts — underdelivered, badfaith',
  },
  {
    id: 'strict-deadline',
    name: 'Time-critical',
    forThisDeal: 'Work whose value collapses if it is late: a price feed, a booking, a bid.',
    deliveryDeadlineSeconds: 600,
    reviewWindowSeconds: 600,
    evidenceRequired: [
      'timestamps from the producing system, not from the seller',
      'the deliverable, hashed at production time',
    ],
    disputeOutcomes: [
      { situation: 'late delivery', expectedBand: 'buyer-favour; lateness is objective and weighted heavily' },
      { situation: 'on time but short', expectedBand: 'pro-rata on completeness' },
    ],
    derivedFrom: 'packages/arbiter/src/rules.ts — deadline signals',
  },
  {
    id: 'high-value',
    name: 'High value, narrow band',
    forThisDeal: 'Anything large enough that a 10% error matters. More criteria, more artifacts, tighter band.',
    deliveryDeadlineSeconds: 86_400,
    reviewWindowSeconds: 43_200,
    evidenceRequired: [
      'every acceptance criterion backed by a named artifact',
      'reproduction steps or a verifiable source URI',
      'a metric with its unit and its measurement time',
    ],
    disputeOutcomes: [
      { situation: 'evidence complete on both sides', expectedBand: 'narrow, decided on the criteria' },
      { situation: 'one side has no artifacts', expectedBand: 'against the side with no evidence' },
    ],
    derivedFrom: 'packages/demo/src/scenarios.ts — admission',
  },
  {
    id: 'micropayment',
    name: 'Micropayment / per-call',
    forThisDeal: 'An x402 or MPP call priced per request. Amounts too small to arbitrate individually are batched into one job.',
    deliveryDeadlineSeconds: 300,
    reviewWindowSeconds: 300,
    evidenceRequired: [
      'the request and response pair, hashed',
      'the count and unit price from the metering log',
    ],
    disputeOutcomes: [
      { situation: 'stale or malformed responses', expectedBand: 'pro-rata on the fraction of calls that met the spec' },
      { situation: 'service returned nothing', expectedBand: 'buyer-favour, full refund of the batch' },
    ],
    derivedFrom: 'packages/demo/src/scenarios.ts — nodelivery',
  },
];

export function policyById(id: string): PolicyTemplate {
  return POLICY_TEMPLATES.find((template) => template.id === id) ?? POLICY_TEMPLATES[0]!;
}

export type OnboardingStep = {
  id: number;
  who: 'agent' | 'chain' | 'fee-payer' | 'faucet' | 'beacon';
  action: string;
  detail: string;
  /// The property that makes zero-balance onboarding work, stated per step.
  requiresBalance: boolean;
  cost: Money;
  endpoint?: string;
  command?: string;
};

export type OnboardingPlan = {
  role: Role;
  generatedAt: string;
  /// The claim, and the two facts it rests on. Both are checkable by the reader.
  claim: string;
  whyItWorks: string[];
  steps: OnboardingStep[];
  costs: {
    keypair: Money;
    registration: Money;
    firstTransaction: Money;
    unsponsoredFee: Money | null;
    principal: string;
    totalToStart: Money;
  };
  custody: string;
  guarantees: string[];
  policy: PolicyTemplate;
  endpoints: Record<string, string>;
};

export type Role = 'seller' | 'buyer';

export type OnboardParams = {
  config: BeaconConfig;
  role: Role;
  /// Amount the buyer intends to escrow. Sellers can ignore it.
  amount?: bigint;
  decimals: number;
  measuredFee: Money | null;
  policyId?: string;
};

const FREE: Money = { units: '0', value: '0' };

/// What it takes to start trading on Tempex, computed rather than advertised.
///
/// The headline is that a seller needs nothing: no account funding, no gas token,
/// no approval transaction. Tempo has no gas token and the hosted fee payer signs
/// the fee, while the escrow only ever pulls from the buyer and credits the seller.
export function onboardingPlan(params: OnboardParams): OnboardingPlan {
  const { config, role } = params;
  const sponsored = config.sponsorUrl !== null;
  const amount = params.amount ?? 0n;
  const policy = policyById(params.policyId ?? 'standard');
  const firstTxCost = sponsored ? FREE : (params.measuredFee ?? FREE);

  const steps: OnboardingStep[] = [
    {
      id: 1,
      who: 'agent',
      action: 'Generate a keypair locally',
      detail:
        'A Tempo account is a secp256k1 keypair. There is no signup, no email, no KYC, and no transaction to create it — the address exists the moment the key does.',
      requiresBalance: false,
      cost: FREE,
      command: 'cast wallet new   # or Account.fromSecp256k1(privateKey) from @tempex/sdk',
    },
    {
      id: 2,
      who: 'beacon',
      action: 'Check readiness',
      detail:
        'The beacon reads the chain for this address and reports exactly what is missing. For a seller the answer is nothing.',
      requiresBalance: false,
      cost: FREE,
      endpoint: `${config.host}/onboard/ready?address=<address>&role=${role}`,
    },
  ];

  if (role === 'seller') {
    steps.push(
      {
        id: 3,
        who: 'beacon',
        action: 'Register so buyers can find you',
        detail:
          'Sign a challenge with the new key. The signature proves control of the address; the beacon stores no key and cannot act as you.',
        requiresBalance: false,
        cost: FREE,
        endpoint: `${config.host}/registry/challenge then ${config.host}/registry/register`,
      },
      {
        id: 4,
        who: 'chain',
        action: 'Get hired and deliver',
        detail:
          'The buyer escrows the payment when it opens the job. The seller sends `deliver(jobId, deliverableHash)` and waits.',
        requiresBalance: false,
        cost: FREE,
        endpoint: `${config.host}/tx/deliver?jobId=<id>&deliverableHash=<bytes32>`,
      },
      {
        id: 5,
        who: 'fee-payer',
        action: 'Withdraw, with the fee sponsored',
        detail:
          'Payouts are pull-based: the escrow credits the seller, and `withdraw()` sends the balance out. The transaction fee goes to the hosted fee payer, so a seller with a zero balance still collects in full.',
        requiresBalance: false,
        cost: FREE,
        endpoint: `${config.host}/tx/withdraw`,
      },
    );
  } else {
    steps.push(
      {
        id: 3,
        who: 'faucet',
        action: 'Fund the principal',
        detail:
          'A buyer escrows real money, so it needs a balance. On Moderato the faucet mints testnet alphaUSD; on mainnet this is a treasury or an on-ramp. This is the only step that costs anything, and it is the payment itself — not a fee to Tempex.',
        requiresBalance: true,
        cost: money(amount, params.decimals),
        command: 'TempexClient.fundWithFaucet()   # client.faucet.fund on viem/tempo',
      },
      {
        id: 4,
        who: 'chain',
        action: 'Approve, create and fund in one batch',
        detail:
          'The escrow pulls the job amount with `transferFromWithMemo`, so the buyer approves once. Create-and-fund is a single transaction with two calls: a job can never exist unfunded.',
        requiresBalance: true,
        cost: sponsored ? FREE : (params.measuredFee ?? FREE),
        endpoint: `${config.host}/tx/create-and-fund?seller=<address>&amount=<units>&termsHash=<bytes32>`,
      },
      {
        id: 5,
        who: 'agent',
        action: 'Review, then accept or dispute',
        detail:
          'Accept and the escrow pays out immediately. Do nothing and `autoAccept` releases it when the review window closes. Dispute with an evidence hash and the arbiter rules inside a bounded band.',
        requiresBalance: false,
        cost: FREE,
        endpoint: `${config.host}/tx/accept?jobId=<id> or ${config.host}/tx/dispute?jobId=<id>&disputeHash=<bytes32>`,
      },
    );
  }

  return {
    role,
    generatedAt: new Date().toISOString(),
    claim:
      role === 'seller'
        ? 'A seller can be hired, deliver, and collect payment holding nothing but a private key.'
        : 'A buyer needs the payment itself and nothing else: no gas token, no separate fee balance.',
    whyItWorks: [
      'Tempo has no gas token. Fees are paid in a TIP-20 stablecoin, and a hosted fee payer can sign the fee leg instead of the caller.',
      'The escrow is pull-based. Sellers are credited, never paid directly, so a seller never needs funds to receive funds.',
      'An address is not an account registration. It exists as soon as the keypair does, and needs no transaction to activate.',
      sponsored
        ? `This beacon is configured with a fee payer at ${config.sponsorUrl}, so every blueprint it issues defaults to \`sponsored: true\`.`
        : 'No fee payer is configured, so the caller pays the measured fee in the payment token.',
    ],
    steps,
    costs: {
      keypair: FREE,
      registration: FREE,
      firstTransaction: firstTxCost,
      unsponsoredFee: params.measuredFee,
      principal:
        role === 'seller'
          ? 'none — the buyer escrows the payment'
          : `the job amount itself (${money(amount, params.decimals).value})`,
      totalToStart: role === 'seller' ? FREE : money(amount, params.decimals),
    },
    custody:
      'The beacon never sees a private key and cannot sign anything. It issues calldata blueprints and reads the chain; the agent signs and submits with its own key.',
    guarantees: [
      'No custody: job principal is only ever moved by `withdraw()` from the credited account, `resolve()` with a verdict signed by the registered arbiter, `accept()`/`autoAccept()`, or `refundExpired()` after the delivery deadline.',
      'No owner override: the owner can change the arbiter, treasury, and fee schedule, but fees are capped on-chain at 500 bps platform and 1000 bps arbitration, and no function lets the owner take a job principal.',
      'Bounded rulings: a verdict outside 0-10000 bps reverts, and every ruling is an EIP-712 signature over the job id, award, evidence hash, rationale hash, and validity window.',
      'Portable reputation: an address history is recomputable from escrow logs by anyone, so switching beacon costs nothing.',
    ],
    policy,
    endpoints: {
      ready: `${config.host}/onboard/ready`,
      quote: `${config.host}/onboard/quote`,
      policies: `${config.host}/onboard/policies`,
      register: `${config.host}/registry/register`,
    },
  };
}

// ------------------------------------------------------------------ readiness

export type ReadinessReport = {
  address: Address;
  role: Role;
  generatedAt: string;
  onChain: {
    exists: boolean;
    nonce: number;
    /// Reported for completeness and then dismissed: Tempo has no gas token, so a
    /// native balance is not a precondition for anything.
    nativeBalance: string;
    tokenBalance: Money;
    escrowAllowance: Money;
    escrowCredit: Money;
  };
  reputation: Pick<Reputation, 'score' | 'band' | 'counters'>;
  verdict: 'ready' | 'ready-sponsored' | 'needs-allowance' | 'needs-principal';
  blockers: string[];
  /// Blueprints for exactly the missing steps, already encoded.
  nextActions: Blueprint[];
};

export type ReadinessParams = {
  reader: ChainReader;
  config: BeaconConfig;
  address: Address;
  role: Role;
  /// Required for buyers: the amount they intend to escrow.
  amount?: bigint;
  decimals: number;
  measuredFee: Money | null;
  reputation: Reputation;
};

/// Can this address trade right now, and if not, what is the one transaction that
/// changes the answer?
export async function readiness(params: ReadinessParams): Promise<ReadinessReport> {
  const { reader, config, address, role, decimals } = params;
  const amount = params.amount ?? 0n;

  const [nonce, nativeBalance, tokenBalance, escrowAllowance, escrowCredit] = await Promise.all([
    reader.getTransactionCount({ address }),
    reader.getBalance({ address }),
    reader.readContract({
      address: config.token,
      abi: tip20Abi,
      functionName: 'balanceOf',
      args: [address],
    }),
    reader.readContract({
      address: config.token,
      abi: tip20Abi,
      functionName: 'allowance',
      args: [address, config.escrow],
    }),
    readCredit(reader, config.escrow, address),
  ]);

  const ctx: BlueprintContext = {
    escrow: config.escrow,
    token: config.token,
    rpcUrl: config.rpcUrl,
    sponsored: config.sponsorUrl !== null,
    measuredFee: params.measuredFee,
  };

  const blockers: string[] = [];
  const nextActions: Blueprint[] = [];
  let shortAllowance = false;
  let shortPrincipal = false;

  if (role === 'buyer' && amount > 0n) {
    if (tokenBalance < amount) {
      shortPrincipal = true;
      blockers.push(
        `needs ${money(amount - tokenBalance, decimals).value} more of the payment token to escrow this job`,
      );
    }
    if (escrowAllowance < amount) {
      shortAllowance = true;
      blockers.push(
        `the escrow can only pull ${money(escrowAllowance, decimals).value}; it needs ${money(amount, decimals).value}`,
      );
      nextActions.push(blueprintApprove(ctx, amount));
    }
  }

  if (role === 'seller' && escrowCredit > 0n) {
    nextActions.push(blueprintWithdraw(ctx));
  }

  const verdict: ReadinessReport['verdict'] = shortAllowance
    ? 'needs-allowance'
    : shortPrincipal
      ? 'needs-principal'
      : config.sponsorUrl !== null
        ? 'ready-sponsored'
        : 'ready';

  return {
    address,
    role,
    generatedAt: new Date().toISOString(),
    onChain: {
      exists: nonce > 0,
      nonce,
      nativeBalance: nativeBalance.toString(),
      tokenBalance: money(tokenBalance, decimals),
      escrowAllowance: money(escrowAllowance, decimals),
      escrowCredit: money(escrowCredit, decimals),
    },
    reputation: {
      score: params.reputation.score,
      band: params.reputation.band,
      counters: params.reputation.counters,
    },
    verdict,
    blockers,
    nextActions,
  };
}

async function readCredit(reader: ChainReader, escrow: Address, account: Address): Promise<bigint> {
  return reader.readContract({
    address: escrow,
    abi: tempexEscrowAbi,
    functionName: 'credits',
    args: [account],
  });
}

export type Quote = {
  generatedAt: string;
  role: Role;
  amount: Money;
  fee: {
    token: Address;
    sponsored: boolean;
    sponsorUrl: string | null;
    measured: Money | null;
    /// Where the measurement came from, so the number is auditable.
    measuredOn: { tx: Hex; block: number; jobId: string } | null;
  };
  total: Money;
  breakdown: { line: string; cost: Money; note: string }[];
};

/// The all-in cost of a job, with the fee measured from a real receipt.
export function quote(params: {
  config: BeaconConfig;
  role: Role;
  amount: bigint;
  decimals: number;
  measured: Money | null;
  measuredOn: { tx: Hex; block: number; jobId: string } | null;
  /// v3 launch guards, when the escrow has them
  guards?: { maxJobAmount: bigint; arbitrationFeeFloor: bigint; newJobsPaused: boolean } | null;
  arbitrationFeeBps?: number;
}): Quote {
  const { config, role, amount, decimals } = params;
  const sponsored = config.sponsorUrl !== null;
  const fee = sponsored ? FREE : (params.measured ?? FREE);
  const principal = role === 'buyer' ? amount : 0n;

  return {
    generatedAt: new Date().toISOString(),
    role,
    amount: money(amount, decimals),
    fee: {
      token: config.token,
      sponsored,
      sponsorUrl: config.sponsorUrl ?? SPONSOR_URL,
      measured: params.measured,
      measuredOn: params.measuredOn,
    },
    total: money(principal + BigInt(fee.units), decimals),
    breakdown: [
      {
        line: 'account creation',
        cost: FREE,
        note: 'a keypair is an account on Tempo; no activation transaction exists',
      },
      {
        line: 'beacon registration',
        cost: FREE,
        note: 'a signature over a challenge; the beacon stores no key',
      },
      {
        line: 'transaction fee',
        cost: fee,
        note: sponsored
          ? `routed to the hosted fee payer at ${config.sponsorUrl}`
          : 'paid by the caller in the payment token',
      },
      {
        line: role === 'buyer' ? 'escrowed principal' : 'principal',
        cost: money(principal, decimals),
        note:
          role === 'buyer'
            ? 'held by the escrow, returned or paid out by rule — not a fee'
            : 'the seller receives this; it is never a cost to the seller',
      },
      {
        line: 'platform fee on settlement',
        cost: FREE,
        note: 'deducted from the escrowed amount at payout, capped on-chain at 500 bps',
      },
      {
        line: 'arbitration fee, only if disputed',
        cost: FREE,
        note:
          params.guards && params.guards.arbitrationFeeFloor > 0n
            ? `deducted from the disputed amount at verdict: ${params.arbitrationFeeBps ?? 0} bps of the job, at least ${money(params.guards.arbitrationFeeFloor, decimals).value} (the floor this job would lock), never more than the job amount; the rate is capped on-chain at 1000 bps`
            : 'deducted from the disputed amount at verdict, capped on-chain at 1000 bps',
      },
      ...(params.guards
        ? [
            {
              line: 'launch limits',
              cost: FREE,
              note: params.guards.newJobsPaused
                ? 'new jobs are paused: the escrow accepts no new job until the owner lifts the pause'
                : `the escrow funds jobs up to ${params.guards.maxJobAmount === (1n << 256n) - 1n ? 'any size' : money(params.guards.maxJobAmount, decimals).value} each${params.guards.maxJobAmount !== (1n << 256n) - 1n && amount > params.guards.maxJobAmount ? '; this amount is above that cap and would be refused' : ''}`,
            },
          ]
        : []),
    ],
  };
}
