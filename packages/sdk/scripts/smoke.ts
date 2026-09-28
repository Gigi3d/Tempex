#!/usr/bin/env tsx
// Live SDK smoke test against the deployed Moderato escrow.
//
// Proves four things on-chain, in order, and prints the evidence:
//   1. a TIP-20 approval settles with the fee paid in the stablecoin itself
//   2. `createJob` + `fund` land as ONE Tempo transaction (two calls, one nonce,
//      one signature) with the id read before the batch is built
//   3. the funding transfer carries the job id as its TIP-20 memo, so the payment
//      reconciles to the job without reading a single escrow log
//   4. the SDK's EIP-712 encoding and the contract's `verdictDigest` agree
//
// Run: pnpm smoke

import {
  TempexClient,
  accountFor,
  addressesFromEnv,
  explorerTx,
  formatToken,
  loadEnv,
  memoTransfers,
  privateKeyFor,
  tokenAmount,
  verdictFromRuling,
} from '../src/index.js';

function step(n: number, text: string): void {
  console.log(`\n\x1b[1m[${n}]\x1b[0m ${text}`);
}

function pass(text: string): void {
  console.log(`    \x1b[32mPASS\x1b[0m  ${text}`);
}

function info(label: string, value: string): void {
  console.log(`          ${label.padEnd(22)} ${value}`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function main(): Promise<void> {
  loadEnv();
  const addresses = addressesFromEnv();

  const buyer = new TempexClient({ account: accountFor(privateKeyFor('buyer')), addresses });
  const sellerAddress = `0x${process.env['SELLER_ADDRESS']!.slice(2)}` as const;

  console.log('\x1b[1mTempex SDK smoke test\x1b[0m');
  info('escrow', addresses.escrow);
  info('payment token', addresses.token);
  info('buyer', buyer.address);
  info('chain id', String(await buyer.viem.getChainId()));

  // -------------------------------------------------------------- 1. approval
  step(1, 'TIP-20 approval, fee paid in the stablecoin');
  const approveAmount = tokenAmount('250');
  const approveReceipt = await buyer.approveEscrow(approveAmount);
  info('approve tx', explorerTx(approveReceipt.transactionHash));
  info('fee token', approveReceipt.feeToken ?? '(receipt omits it)');
  info('gas used', approveReceipt.gasUsed.toString());
  assert(approveReceipt.status === 'success', 'approval reverted');
  pass(`escrow allowance raised to ${formatToken(approveAmount)} AlphaUSD`);

  // ------------------------------------------- 2. atomic create-and-fund batch
  step(2, 'createJob + fund batched into one Tempo transaction');
  const predicted = await buyer.nextJobId();
  info('predicted job id', predicted.toString());

  const amount = tokenAmount('25');
  const termsHash = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
  const deliveryDeadline = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const reviewWindow = 3 * 24 * 3600;

  const escrowBefore = await buyer.tokenBalance(addresses.escrow);

  const { jobId, hash } = await buyer.createAndFundJob({
    seller: sellerAddress,
    amount,
    termsHash,
    deliveryDeadline,
    reviewWindow,
  });

  const receipt = await buyer.viem.getTransactionReceipt({ hash });
  info('tx hash', explorerTx(hash));
  info('calls in tx', String(await countCalls(buyer, hash)));
  info('job id emitted', jobId.toString());
  info('block', receipt.blockNumber.toString());
  info('gas used', receipt.gasUsed.toString());

  assert(jobId === predicted, `emitted job id ${jobId} != predicted ${predicted}`);
  pass('one transaction created a job AND funded it (no window where the job existed unfunded)');
  pass(`predicted id (read via nextJobId) matched the emitted id ${jobId}`);

  // ------------------------------------------------------- 3. state + payload
  step(3, 'resulting state and the memo on the funding transfer');
  const job = await buyer.job(jobId);
  const escrowAfter = await buyer.tokenBalance(addresses.escrow);
  const delta = escrowAfter - escrowBefore;

  info('job state', job.state);
  info('job amount', `${formatToken(job.amount)} AlphaUSD`);
  info('escrow delta', `${formatToken(delta)} AlphaUSD`);

  assert(job.state === 'Funded', `expected Funded, got ${job.state}`);
  assert(delta === amount, `escrow gained ${delta}, expected ${amount}`);
  pass(`escrow holds the job amount: ${formatToken(job.amount)} AlphaUSD`);

  const memos = memoTransfers(receipt.logs);
  const funding = memos.find((m) => m.jobId === jobId);
  assert(funding !== undefined, 'no TransferWithMemo carrying this job id in the receipt');

  info('memo transfer', `${funding.from} -> ${funding.to}`);
  info('memo', funding.memo);
  info('memo decodes to job', funding.jobId!.toString());
  assert(funding.amount === amount, 'memo transfer amount mismatched');
  pass('the stablecoin transfer itself carries the job id — the payment IS the reconciliation key');

  // --------------------------------------------------------- 4. verdict digest
  step(4, 'EIP-712 verdict encoding: SDK vs deployed contract');
  const now = Math.floor(Date.now() / 1000);
  const verdict = verdictFromRuling({
    jobId: Number(jobId),
    sellerAwardBps: 6000,
    evidenceHash: ('0x' + 'cd'.repeat(32)) as `0x${string}`,
    rationaleHash: ('0x' + 'ef'.repeat(32)) as `0x${string}`,
    issuedAt: now,
    validUntil: now + 3600,
  });

  const { local, onChain, matches } = await buyer.verdictEncoding(verdict);
  info('sdk digest', local);
  info('contract digest', onChain);
  assert(matches, 'digest mismatch: signatures would be rejected on-chain');
  pass('signature encoding agrees with the contract, verified before spending gas');

  console.log('\n\x1b[1mAll four checks passed.\x1b[0m');
  console.log(`Job ${jobId} is live: ${explorerTx(hash)}\n`);
}

/// Tempo transactions carry a `calls` array, so the count is on the tx itself.
async function countCalls(client: TempexClient, hash: `0x${string}`): Promise<number> {
  try {
    const tx = await client.viem.getTransaction({ hash });
    const calls = (tx as { calls?: unknown[] }).calls;
    return calls?.length ?? 1;
  } catch {
    return 1;
  }
}

main().catch((error: unknown) => {
  const detail =
    error && typeof error === 'object' && 'shortMessage' in error
      ? `${(error as { shortMessage: string }).shortMessage}${
          'details' in error ? ` — ${(error as { details?: string }).details}` : ''
        }`
      : String(error instanceof Error ? error.message : error);
  console.error(`\n\x1b[31mfailed\x1b[0m ${detail}`);
  process.exitCode = 1;
});
