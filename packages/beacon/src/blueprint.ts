import { encodeFunctionData, type Abi, type AbiFunction, type Address, type Hex } from 'viem';

import { tempexEscrowAbi, tip20Abi, type WriteOptions } from '@tempex/sdk';

import type { Money } from './reputation.js';

export type Call = { to: Address; data: Hex };

export type DecodedCall = {
  contract: 'escrow' | 'token';
  function: string;
  args: Record<string, string>;
};

export type Blueprint = {
  intent: string;
  /// Who must sign. Always the agent's own key: the beacon builds calldata, it
  /// never sees a private key and cannot submit on anyone's behalf.
  signer: 'buyer' | 'seller' | 'either' | 'arbiter-relay';
  calls: Call[];
  decoded: DecodedCall[];
  writeOptions: WriteOptions;
  fee: {
    /// Tempo charges the fee in the same stablecoin as the payment, so the fee is
    /// quoted in the token the agent is already holding.
    token: Address;
    sponsored: boolean;
    payer: 'caller' | 'fee-payer';
    /// A fee measured from a real receipt, not a gas estimate. Null until the
    /// beacon has seen one.
    measured: Money | null;
  };
  /// Transactions that must land first, in order.
  prerequisites: { intent: string; signer: Blueprint['signer']; calls: Call[]; decoded: DecodedCall[] }[];
  submit: {
    method: string;
    rpcUrl: string;
    notes: string[];
    sdk: string;
  };
};

export type BlueprintContext = {
  escrow: Address;
  token: Address;
  rpcUrl: string;
  /// When true the blueprint asks Tempo's hosted fee payer to cover the fee, which
  /// is what lets an agent with a zero balance transact.
  sponsored?: boolean;
  measuredFee?: Money | null;
};

function abiFor(contract: 'escrow' | 'token'): Abi {
  return (contract === 'escrow' ? tempexEscrowAbi : tip20Abi) as Abi;
}

function call(contract: 'escrow' | 'token', to: Address, functionName: string, args: readonly unknown[]): Call {
  return {
    to,
    data: encodeFunctionData({
      abi: abiFor(contract),
      functionName: functionName as never,
      args: args as never,
    }),
  };
}

/// Arguments labelled with the ABI's own parameter names, so a decoded call reads as
/// `{"jobId":"5"}` rather than `{"arg0":"5"}`. An agent that cannot name what it is
/// about to sign cannot check it, and checking before signing is the point of a
/// blueprint.
function show(contract: 'escrow' | 'token', fn: string, args: readonly unknown[]): Record<string, string> {
  const item = abiFor(contract).find(
    (entry): entry is AbiFunction => entry.type === 'function' && entry.name === fn,
  );
  const names = item?.inputs.map((input) => input.name) ?? [];
  return Object.fromEntries(
    args.map((value, index) => [names[index] || `arg${index}`, String(value)]),
  );
}

function base(
  ctx: BlueprintContext,
  intent: string,
  signer: Blueprint['signer'],
  entries: { contract: 'escrow' | 'token'; to: Address; fn: string; args: readonly unknown[] }[],
  prerequisites: Blueprint['prerequisites'] = [],
): Blueprint {
  return {
    intent,
    signer,
    calls: entries.map((entry) => call(entry.contract, entry.to, entry.fn, entry.args)),
    decoded: entries.map((entry) => ({
      contract: entry.contract,
      function: entry.fn,
      args: show(entry.contract, entry.fn, entry.args),
    })),
    writeOptions: { sponsored: ctx.sponsored ?? true },
    fee: {
      token: ctx.token,
      sponsored: ctx.sponsored ?? true,
      payer: (ctx.sponsored ?? true) ? 'fee-payer' : 'caller',
      measured: ctx.measuredFee ?? null,
    },
    prerequisites,
    submit: {
      method: 'eth_sendTransaction',
      rpcUrl: ctx.rpcUrl,
      notes: [
        'Tempo transactions carry a `calls` array, so every call above lands in one atomic write.',
        'Set `feeToken` to the token address above: there is no gas token on Tempo.',
        ctx.sponsored ?? true
          ? 'Set `feePayer: true` to route the fee to the hosted fee payer; the caller pays nothing.'
          : 'Without `feePayer`, the caller must hold enough of the fee token to cover the fee.',
        'A distinct `nonceKey` occupies a separate nonce lane, so unrelated payments can be submitted concurrently.',
      ],
      sdk: '@tempex/sdk — TempexClient',
    },
  };
}

/// Create-and-fund in one atomic transaction.
///
/// `nextJobId` is read first and passed explicitly because batched calls cannot see
/// each other's return values. An agent that skips the read builds a transaction
/// that funds somebody else's job.
export function blueprintCreateAndFund(
  ctx: BlueprintContext,
  params: {
    buyer: Address;
    seller: Address;
    amount: bigint;
    termsHash: Hex;
    deliveryDeadline: number;
    reviewWindow: number;
    nextJobId: bigint;
    allowance: bigint;
  },
): Blueprint {
  const needsApproval = params.allowance < params.amount;
  const approve = {
    intent: `raise the escrow's allowance to ${params.amount}`,
    signer: 'buyer' as const,
    calls: [call('token', ctx.token, 'approve', [ctx.escrow, params.amount])],
    decoded: [{ contract: 'token' as const, function: 'approve', args: show('token', 'approve', [ctx.escrow, params.amount]) }],
  };

  return base(
    ctx,
    `open job ${params.nextJobId} with ${params.seller} for ${params.amount} units and fund it atomically`,
    'buyer',
    [
      {
        contract: 'escrow',
        to: ctx.escrow,
        fn: 'createJob',
        args: [params.seller, params.amount, params.termsHash, params.deliveryDeadline, params.reviewWindow],
      },
      { contract: 'escrow', to: ctx.escrow, fn: 'fund', args: [params.nextJobId] },
    ],
    needsApproval ? [approve] : [],
  );
}

export function blueprintApprove(ctx: BlueprintContext, amount: bigint): Blueprint {
  return base(ctx, `allow the escrow to pull ${amount} units of the payment token`, 'buyer', [
    { contract: 'token', to: ctx.token, fn: 'approve', args: [ctx.escrow, amount] },
  ]);
}

export function blueprintDeliver(ctx: BlueprintContext, jobId: bigint, deliverableHash: Hex): Blueprint {
  return base(ctx, `deliver job ${jobId}`, 'seller', [
    { contract: 'escrow', to: ctx.escrow, fn: 'deliver', args: [jobId, deliverableHash] },
  ]);
}

export function blueprintAccept(ctx: BlueprintContext, jobId: bigint): Blueprint {
  return base(ctx, `accept job ${jobId} and release the escrow`, 'buyer', [
    { contract: 'escrow', to: ctx.escrow, fn: 'accept', args: [jobId] },
  ]);
}

export function blueprintAutoAccept(ctx: BlueprintContext, jobId: bigint): Blueprint {
  return base(ctx, `auto-accept job ${jobId} after the review window (permissionless)`, 'either', [
    { contract: 'escrow', to: ctx.escrow, fn: 'autoAccept', args: [jobId] },
  ]);
}

export function blueprintDispute(ctx: BlueprintContext, jobId: bigint, disputeHash: Hex): Blueprint {
  return base(ctx, `dispute job ${jobId} and hand it to the arbiter`, 'buyer', [
    { contract: 'escrow', to: ctx.escrow, fn: 'dispute', args: [jobId, disputeHash] },
  ]);
}

/// The seller's answer to a dispute: pins its evidence of proper delivery inside
/// the 7-day response window. The arbiter will not rule before this lands or
/// the window closes.
export function blueprintRespond(ctx: BlueprintContext, jobId: bigint, responseHash: Hex): Blueprint {
  return base(ctx, `respond to the dispute on job ${jobId} with the seller's evidence`, 'seller', [
    { contract: 'escrow', to: ctx.escrow, fn: 'respond', args: [jobId, responseHash] },
  ]);
}

/// Relaying a verdict is permissionless: whoever submits it pays the fee (or has it
/// sponsored), but only a verdict signed by the registered arbiter recovers.
export function blueprintResolve(
  ctx: BlueprintContext,
  jobId: bigint,
  verdict: { sellerAwardBps: number; evidenceHash: Hex; rationaleHash: Hex; issuedAt: bigint; validUntil: bigint },
  signature: Hex,
): Blueprint {
  return base(
    ctx,
    `settle job ${jobId} with the arbiter's signed verdict`,
    'arbiter-relay',
    [
      {
        contract: 'escrow',
        to: ctx.escrow,
        fn: 'resolve',
        args: [
          jobId,
          {
            jobId,
            sellerAwardBps: verdict.sellerAwardBps,
            evidenceHash: verdict.evidenceHash,
            rationaleHash: verdict.rationaleHash,
            issuedAt: verdict.issuedAt,
            validUntil: verdict.validUntil,
          },
          signature,
        ],
      },
    ],
  );
}

/// Closes a dispute whose arbiter never ruled within its window, on the escrow's
/// fixed even split with no arbitration fee. Permissionless.
export function blueprintSettleLapsed(ctx: BlueprintContext, jobId: bigint): Blueprint {
  return base(ctx, `settle lapsed dispute on job ${jobId} on the default split (permissionless)`, 'either', [
    { contract: 'escrow', to: ctx.escrow, fn: 'settleLapsed', args: [jobId] },
  ]);
}

export function blueprintRefundExpired(ctx: BlueprintContext, jobId: bigint): Blueprint {
  return base(ctx, `refund job ${jobId} after the delivery deadline passed undelivered`, 'either', [
    { contract: 'escrow', to: ctx.escrow, fn: 'refundExpired', args: [jobId] },
  ]);
}

/// The transaction a brand-new, zero-balance seller sends to collect its first
/// payment. Sponsored, so it costs the seller nothing.
export function blueprintWithdraw(ctx: BlueprintContext): Blueprint {
  return base(ctx, 'withdraw the caller credited balance', 'either', [
    { contract: 'escrow', to: ctx.escrow, fn: 'withdraw', args: [] },
  ]);
}
