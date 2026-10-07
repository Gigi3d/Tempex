import type { Address, Hex } from 'viem';

import { tokenAmount } from './config.js';
import { hashCanonical, type Criterion, type JobTerms } from './evidence.js';

/// A deal paid in tranches. Each milestone becomes its own escrow job, with its
/// own criteria, amount and deadline, so delivering, accepting or disputing one
/// tranche never puts the others at stake.
export type MilestonePlan = {
  version: 1;
  title: string;
  deliverableSpec: string;
  buyer: string;
  seller: string;
  currency?: string;
  milestones: {
    title: string;
    acceptanceCriteria: Criterion[];
    /// whole tokens, e.g. "250.00"
    amount: string;
    /// unix seconds; must strictly increase from one milestone to the next
    deliveryDeadline: number;
  }[];
};

/// The plan's identity on chain: `createMilestones` links every tranche to it.
export function planHashOf(plan: MilestonePlan): Hex {
  return hashCanonical(plan);
}

/// The terms document for one tranche. It names the plan and its position, so a
/// tranche's termsHash cannot be lifted into another plan, and it carries only
/// that tranche's criteria, which is what the arbiter rules on if it is disputed.
export function milestoneTerms(plan: MilestonePlan, index: number): JobTerms {
  const milestone = plan.milestones[index];
  if (milestone === undefined) throw new Error(`plan has no milestone ${index}`);
  const count = plan.milestones.length;
  return {
    title: `${plan.title} — milestone ${index + 1} of ${count}: ${milestone.title}`,
    deliverableSpec: plan.deliverableSpec,
    acceptanceCriteria: milestone.acceptanceCriteria,
    amount: milestone.amount,
    ...(plan.currency !== undefined ? { currency: plan.currency } : {}),
    buyer: plan.buyer,
    seller: plan.seller,
    plan: { hash: planHashOf(plan), index, count },
  };
}

/// The calldata argument for `createMilestones`, plus the plan's total.
export function milestoneArgs(plan: MilestonePlan): {
  planHash: Hex;
  milestones: { termsHash: Hex; amount: bigint; deliveryDeadline: bigint }[];
  total: bigint;
} {
  const milestones = plan.milestones.map((milestone, index) => ({
    termsHash: hashCanonical(milestoneTerms(plan, index)),
    amount: tokenAmount(milestone.amount),
    deliveryDeadline: BigInt(milestone.deliveryDeadline),
  }));
  return {
    planHash: planHashOf(plan),
    milestones,
    total: milestones.reduce((sum, m) => sum + m.amount, 0n),
  };
}

/// Problems that would make `createMilestones` revert, caught before signing.
export function planProblems(plan: MilestonePlan, now: number): string[] {
  const problems: string[] = [];
  const { milestones } = plan;
  if (milestones.length < 2 || milestones.length > 20) {
    problems.push(`a plan needs 2 to 20 milestones, this one has ${milestones.length}`);
  }
  milestones.forEach((milestone, index) => {
    if (milestone.acceptanceCriteria.length === 0) {
      problems.push(`milestone ${index + 1} has no acceptance criteria to rule on`);
    }
    if (tokenAmount(milestone.amount) <= 0n) problems.push(`milestone ${index + 1} has no amount`);
    if (milestone.deliveryDeadline <= now) problems.push(`milestone ${index + 1}'s deadline has passed`);
    const previous = milestones[index - 1];
    if (previous !== undefined && milestone.deliveryDeadline <= previous.deliveryDeadline) {
      problems.push(`milestone ${index + 1}'s deadline must be after milestone ${index}'s`);
    }
  });
  for (const [role, address] of [['buyer', plan.buyer], ['seller', plan.seller]] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) problems.push(`plan ${role} is not an address`);
  }
  return problems;
}

export type MilestoneJobs = { planHash: Hex; firstJobId: bigint; jobIds: bigint[]; arbiter?: Address };
