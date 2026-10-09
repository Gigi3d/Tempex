#!/usr/bin/env tsx
// Deploys TempexEscrow v3 to Tempo Moderato behind a UUPS proxy, then proves the
// deployment is the code in this repository, configured as intended.
//
//   1. Build      read the forge artifacts: escrow implementation and ERC-1967 proxy
//   2. Preflight  chain id, payment token, deployer balance, gas vs block limit
//   3. Deploy     the implementation, then the proxy, which initializes the escrow
//                 in its own constructor so nobody can front-run initialization;
//                 then the launch guards (caps, fee floor, referral share) in one
//                 batched Tempo transaction when the deployer is the owner
//   4. Verify     both runtimes equal the build (outside the implementation's
//                 immutable slots), the proxy points at the implementation, the
//                 implementation refuses initialization, and every setting reads
//                 back from the live proxy
//   5. Record     deployments/<network>.json, with the receipts' own numbers
//
// Why not `forge create` / `forge script`: stock forge cannot send Tempo's
// type-0x76 transaction or pay the fee in a TIP-20 token, and forge script's gas
// estimate ignores Tempo's pricing for contract creation (see deployments notes).
// The node's own eth_estimateGas does price it correctly, so it is used here.
//
// Env: DEPLOYER_KEY   pays the fees; by default also the owner, the one key that
//                     can upgrade the escrow and set its guards
//      TEMPEX_OWNER (deployer), TEMPEX_ARBITER, TEMPEX_TREASURY (owner),
//      TEMPEX_TOKEN (alphaUSD), TEMPEX_PLATFORM_FEE_BPS (50),
//      TEMPEX_ARBITRATION_FEE_BPS (200),
//      TEMPEX_MAX_JOB_AMOUNT, TEMPEX_MAX_OPEN_VALUE (whole tokens; default no cap),
//      TEMPEX_ARBITRATION_FLOOR (whole tokens, default 0),
//      TEMPEX_REFERRAL_SHARE_BPS (0).
// Flags: --faucet  top the deployer up from the testnet faucet first
//        --dry     stop after preflight
//
// Run: pnpm deploy:escrow [--faucet] [--dry]

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  maxUint256,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createClient, http } from 'viem/tempo';
import { tempoTestnet } from 'viem/tempo/chains';

import { tempexEscrowAbi } from '../src/abi/TempexEscrow.js';
import { tip20Abi } from '../src/abi/TIP20.js';
import { CHAIN_ID, EXPLORER_URL, RPC_URL, TOKENS, loadEnv } from '../src/config.js';

const REPO = resolve(import.meta.dirname, '../../..');
const ESCROW_ARTIFACT = resolve(REPO, 'contracts/out/TempexEscrow.sol/TempexEscrow.json');
const PROXY_ARTIFACT = resolve(REPO, 'contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json');
const RECORD = resolve(REPO, 'deployments/moderato.json');
/// ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1.
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO = getAddress('0x0000000000000000000000000000000000000000');
const VERSION = '3.0.0';
/// Headroom over the node's estimate; creation cost on Tempo is deterministic,
/// so this only absorbs state that changes between estimate and inclusion.
const GAS_HEADROOM_PERCENT = 20n;
/// Moderato rejects any transaction whose gas limit exceeds this, whatever the
/// block limit, so headroom is clamped to it.
const TX_GAS_CAP = 30_000_000n;
const withHeadroom = (estimate: bigint): bigint => {
  const padded = (estimate * (100n + GAS_HEADROOM_PERCENT)) / 100n;
  return padded > TX_GAS_CAP ? TX_GAS_CAP : padded;
};

type Artifact = {
  bytecode: { object: Hex };
  deployedBytecode: {
    object: Hex;
    immutableReferences?: Record<string, { start: number; length: number }[]>;
  };
};

const flags = new Set(process.argv.slice(2));
const out = (label: string, value: string): void => console.log(`  ${label.padEnd(20)} ${value}`);
const step = (text: string): void => console.log(`\n\x1b[1m${text}\x1b[0m`);
const pass = (text: string): void => console.log(`  \x1b[32mPASS\x1b[0m  ${text}`);
function fail(text: string): never {
  throw new Error(text);
}
function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`set ${name} (see the header of this script)`);
  return value;
}
const optional = (name: string): string | undefined => process.env[name]?.trim() || undefined;
function bpsEnv(name: string, fallback: number): number {
  const value = Number(optional(name) ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) fail(`${name} must be whole bps`);
  return value;
}
const tokensEnv = (name: string, decimals: number): bigint | undefined => {
  const value = optional(name);
  return value === undefined ? undefined : parseUnits(value, decimals);
};

/// Runtime bytes with every immutable slot zeroed. The implementation's
/// constructor writes its own address into those slots (UUPS uses it to refuse
/// upgrade calls made directly on the implementation), so they are the only
/// bytes allowed to differ between the build and the chain.
function maskImmutables(code: Hex, artifact: Artifact): Hex {
  const bytes = Buffer.from(code.slice(2), 'hex');
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) bytes.fill(0, start, start + length);
  }
  return `0x${bytes.toString('hex')}`;
}

async function main(): Promise<void> {
  loadEnv(REPO);
  console.log('\x1b[1mTempexEscrow v3 deployment (UUPS proxy)\x1b[0m');

  // ---------------------------------------------------------------- 1. build
  step('1. Build artifacts');
  const escrowArtifact = JSON.parse(readFileSync(ESCROW_ARTIFACT, 'utf8')) as Artifact;
  const proxyArtifact = JSON.parse(readFileSync(PROXY_ARTIFACT, 'utf8')) as Artifact;
  const runtime = escrowArtifact.deployedBytecode.object;
  out('implementation', `${(runtime.length - 2) / 2} bytes runtime (EIP-170 limit 24,576)`);
  out('implementation hash', keccak256(runtime));
  out('proxy', `${(proxyArtifact.deployedBytecode.object.length - 2) / 2} bytes runtime (ERC1967Proxy)`);
  if ((runtime.length - 2) / 2 > 24_576) fail('implementation runtime exceeds EIP-170');

  // ------------------------------------------------------------ 2. preflight
  step('2. Preflight');
  const account = privateKeyToAccount(need('DEPLOYER_KEY') as Hex);
  const token = getAddress(optional('TEMPEX_TOKEN') ?? TOKENS.alphaUsd);
  const owner = getAddress(optional('TEMPEX_OWNER') ?? account.address);
  const arbiter = getAddress(need('TEMPEX_ARBITER'));
  const treasury = getAddress(optional('TEMPEX_TREASURY') ?? owner);
  const platformFeeBps = bpsEnv('TEMPEX_PLATFORM_FEE_BPS', 50);
  const arbitrationFeeBps = bpsEnv('TEMPEX_ARBITRATION_FEE_BPS', 200);
  const referralShareBps = bpsEnv('TEMPEX_REFERRAL_SHARE_BPS', 0);
  if (platformFeeBps > 500) fail('platform fee above the contract cap of 500 bps');
  if (arbitrationFeeBps > 1_000) fail('arbitration fee above the contract cap of 1000 bps');
  if (referralShareBps > 5_000) fail('referral share above the contract cap of 5000 bps');

  const client = createClient({
    account,
    chain: tempoTestnet,
    feeToken: token,
    transport: http(optional('TEMPO_RPC_URL') ?? RPC_URL),
  });

  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) fail(`connected to chain ${chainId}, expected ${CHAIN_ID}`);
  pass(`chain ${chainId} (Tempo Moderato)`);

  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: tip20Abi, functionName: 'symbol' }),
    client.readContract({ address: token, abi: tip20Abi, functionName: 'decimals' }),
  ]);
  pass(`payment and fee token ${symbol} at ${token}, ${decimals} decimals`);

  const maxJobAmount = tokensEnv('TEMPEX_MAX_JOB_AMOUNT', Number(decimals)) ?? maxUint256;
  const maxOpenValue = tokensEnv('TEMPEX_MAX_OPEN_VALUE', Number(decimals)) ?? maxUint256;
  const floor = tokensEnv('TEMPEX_ARBITRATION_FLOOR', Number(decimals)) ?? 0n;
  const show = (units: bigint): string => (units === maxUint256 ? 'no cap' : `${formatUnits(units, Number(decimals))} ${symbol}`);

  out('deployer', account.address);
  out('owner (upgrade key)', `${owner}${owner === account.address ? ' (the deployer: one key)' : ''}`);
  out('house arbiter', arbiter);
  out('treasury', treasury);
  out('fees', `platform ${platformFeeBps} bps, arbitration ${arbitrationFeeBps} bps, floor ${formatUnits(floor, Number(decimals))} ${symbol}`);
  out('caps', `per job ${show(maxJobAmount)}, open value ${show(maxOpenValue)}`);
  out('referral share', `${referralShareBps} bps of protocol fees`);
  const wantsGuards = maxJobAmount !== maxUint256 || maxOpenValue !== maxUint256 || floor !== 0n || referralShareBps !== 0;
  if (wantsGuards && owner !== account.address) {
    console.log('  \x1b[33mnote\x1b[0m  the owner is not the deployer: set the guards from the owner key afterwards');
  }

  if (flags.has('--faucet')) {
    const hashes = (await client.faucet.fund({ account: account.address })) as Hex[];
    for (const hash of hashes) await client.waitForTransactionReceipt({ hash, checkReplacement: false });
    pass(`faucet funded the deployer (${hashes.length} transfers)`);
  }

  const balance = await client.readContract({ address: token, abi: tip20Abi, functionName: 'balanceOf', args: [account.address] });
  out('deployer balance', `${formatUnits(balance, Number(decimals))} ${symbol}`);

  const block = await client.getBlock();
  const implEstimate = await client.estimateGas({ account, data: escrowArtifact.bytecode.object });
  const implGas = withHeadroom(implEstimate);
  out('gas, implementation', `${implEstimate} (limit ${implGas}, per-tx cap ${TX_GAS_CAP}, block limit ${block.gasLimit})`);
  if (implEstimate > TX_GAS_CAP || implGas > block.gasLimit) fail('the implementation would not fit in one transaction');
  pass('the implementation fits in one transaction');

  if (flags.has('--dry')) {
    console.log('\n--dry: stopping before broadcast');
    return;
  }

  // --------------------------------------------------------------- 3. deploy
  step('3. Deploy');
  const implHash = await client.sendTransaction({ account, data: escrowArtifact.bytecode.object, gas: implGas });
  out('implementation tx', `${EXPLORER_URL}/tx/${implHash}`);
  const implReceipt = await client.waitForTransactionReceipt({ hash: implHash, checkReplacement: false });
  if (implReceipt.status !== 'success' || !implReceipt.contractAddress) fail('implementation deployment failed');
  const implementation = getAddress(implReceipt.contractAddress);
  pass(`implementation at ${implementation}, block ${implReceipt.blockNumber}`);

  const initData = encodeFunctionData({
    abi: tempexEscrowAbi,
    functionName: 'initialize',
    args: [token, owner, arbiter, treasury, platformFeeBps, arbitrationFeeBps],
  });
  const proxyArgs = encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [implementation, initData]);
  const proxyData = `${proxyArtifact.bytecode.object}${proxyArgs.slice(2)}` as Hex;
  const proxyEstimate = await client.estimateGas({ account, data: proxyData });
  const proxyHash = await client.sendTransaction({ account, data: proxyData, gas: withHeadroom(proxyEstimate) });
  out('proxy tx', `${EXPLORER_URL}/tx/${proxyHash}`);
  const proxyReceipt = await client.waitForTransactionReceipt({ hash: proxyHash, checkReplacement: false });
  if (proxyReceipt.status !== 'success' || !proxyReceipt.contractAddress) fail('proxy deployment failed');
  const escrow = getAddress(proxyReceipt.contractAddress);
  pass(`escrow (proxy) at ${escrow}, block ${proxyReceipt.blockNumber}, initialized in the same transaction`);

  let guardsHash: Hex | null = null;
  if (wantsGuards && owner === account.address) {
    const call = (functionName: string, args: readonly unknown[]) => ({
      to: escrow,
      data: encodeFunctionData({ abi: tempexEscrowAbi, functionName: functionName as never, args: args as never }),
    });
    const calls = [
      ...(maxJobAmount !== maxUint256 || maxOpenValue !== maxUint256 ? [call('setLimits', [maxJobAmount, maxOpenValue])] : []),
      ...(floor !== 0n ? [call('setArbitrationFeeFloor', [floor])] : []),
      ...(referralShareBps !== 0 ? [call('setReferralShare', [referralShareBps])] : []),
    ];
    guardsHash = await client.sendTransaction({ account, calls });
    const guardsReceipt = await client.waitForTransactionReceipt({ hash: guardsHash, checkReplacement: false });
    if (guardsReceipt.status !== 'success') fail('setting the launch guards reverted');
    pass(`launch guards set in one transaction (${calls.length} calls): ${EXPLORER_URL}/tx/${guardsHash}`);
  }

  // --------------------------------------------------------------- 4. verify
  step('4. Verify against the build');
  const implCode = await client.getCode({ address: implementation });
  if (!implCode || maskImmutables(implCode, escrowArtifact) !== maskImmutables(runtime, escrowArtifact)) {
    fail('implementation runtime differs from the build outside its immutable slots');
  }
  pass('implementation runtime matches the build byte for byte outside its immutable slots');
  const proxyCode = await client.getCode({ address: escrow });
  if (proxyCode !== proxyArtifact.deployedBytecode.object) fail('proxy runtime differs from the ERC1967Proxy build');
  pass('proxy runtime matches the ERC1967Proxy build byte for byte');
  const slot = await client.getStorageAt({ address: escrow, slot: IMPLEMENTATION_SLOT });
  if (!slot || getAddress(`0x${slot.slice(-40)}`) !== implementation) fail(`proxy implementation slot holds ${slot}`);
  pass('the proxy points at the implementation (ERC-1967 slot)');
  try {
    await client.call({
      account,
      to: implementation,
      data: encodeFunctionData({ abi: tempexEscrowAbi, functionName: 'initialize', args: [token, account.address, arbiter, treasury, 0, 0] }),
    });
    fail('the implementation accepted an initialize call');
  } catch (error) {
    if (error instanceof Error && error.message.includes('accepted an initialize')) throw error;
    pass('the implementation refuses initialization');
  }

  const read = <T>(functionName: string): Promise<T> =>
    client.readContract({ address: escrow, abi: tempexEscrowAbi, functionName: functionName as never }) as Promise<T>;
  const checks: [string, unknown, unknown][] = [
    ['version', await read<string>('version'), VERSION],
    ['owner', getAddress(await read<Address>('owner')), owner],
    ['pendingOwner', getAddress(await read<Address>('pendingOwner')), ZERO],
    ['arbiter', getAddress(await read<Address>('arbiter')), arbiter],
    ['treasury', getAddress(await read<Address>('treasury')), treasury],
    ['paymentToken', getAddress(await read<Address>('paymentToken')), token],
    ['platformFeeBps', Number(await read<number>('platformFeeBps')), platformFeeBps],
    ['arbitrationFeeBps', Number(await read<number>('arbitrationFeeBps')), arbitrationFeeBps],
    ['protocolCutBps', Number(await read<number>('protocolCutBps')), 2_000],
    ['jobCount', await read<bigint>('jobCount'), 0n],
    ['newJobsPaused', await read<boolean>('newJobsPaused'), false],
    ['maxJobAmount', await read<bigint>('maxJobAmount'), owner === account.address ? maxJobAmount : maxUint256],
    ['maxOpenValue', await read<bigint>('maxOpenValue'), owner === account.address ? maxOpenValue : maxUint256],
    ['arbitrationFeeFloor', await read<bigint>('arbitrationFeeFloor'), owner === account.address ? floor : 0n],
    ['referralShareBps', Number(await read<number>('referralShareBps')), owner === account.address ? referralShareBps : 0],
    ['SELLER_RESPONSE_WINDOW', await read<bigint>('SELLER_RESPONSE_WINDOW'), 604_800n],
    ['ARBITRATION_WINDOW', await read<bigint>('ARBITRATION_WINDOW'), 604_800n],
    ['DISPUTE_BOND_BPS', Number(await read<number>('DISPUTE_BOND_BPS')), 500],
  ];
  for (const [name, actual, expected] of checks) {
    if (actual !== expected) fail(`${name} is ${String(actual)}, expected ${String(expected)}`);
  }
  pass(`${checks.length} settings read back from the live proxy match the deployment`);

  const domain = (await client.readContract({ address: escrow, abi: tempexEscrowAbi, functionName: 'eip712Domain' })) as readonly [
    Hex,
    string,
    string,
    bigint,
    Address,
    Hex,
    readonly bigint[],
  ];
  if (domain[1] !== 'Tempex' || domain[2] !== '1' || domain[3] !== BigInt(CHAIN_ID) || getAddress(domain[4]) !== escrow) {
    fail(`EIP-712 domain is ${domain[1]}/${domain[2]}/${domain[3]}/${domain[4]}`);
  }
  pass(`EIP-712 domain Tempex/1, chain ${CHAIN_ID}, verifyingContract ${escrow} (the proxy, so verdicts survive upgrades)`);

  // --------------------------------------------------------------- 5. record
  step('5. Record');
  const previous = JSON.parse(readFileSync(RECORD, 'utf8')) as Record<string, unknown>;
  const previousEscrow = (previous['contracts'] as Record<string, { address: string; blockNumber: number }> | undefined)?.['TempexEscrow'];
  const record = {
    network: 'tempo-moderato-testnet',
    chainId: CHAIN_ID,
    rpc: RPC_URL,
    explorer: EXPLORER_URL,
    contracts: {
      TempexEscrow: {
        address: escrow,
        kind: 'ERC-1967 proxy (UUPS); upgradeable by the owner key',
        version: VERSION,
        txHash: proxyHash,
        blockNumber: Number(proxyReceipt.blockNumber),
        deployer: account.address,
        implementation,
        implementationTxHash: implHash,
        implementationBlockNumber: Number(implReceipt.blockNumber),
        implementationRuntimeBytes: (runtime.length - 2) / 2,
        implementationRuntimeKeccak: keccak256(runtime),
        ...(guardsHash ? { guardsTxHash: guardsHash } : {}),
        feeToken: token,
        feeTokenSymbol: symbol,
        verifiedBy:
          'packages/sdk/scripts/deploy.ts: both runtimes equal the forge build (implementation outside its immutable slots), the ERC-1967 slot points at the implementation, the implementation refuses initialize, and every setting read back',
      },
    },
    config: {
      paymentToken: token,
      owner,
      upgradeKey: owner,
      arbiter,
      treasury,
      platformFeeBps,
      arbitrationFeeBps,
      arbitrationFeeFloor: (owner === account.address ? floor : 0n).toString(),
      maxJobAmount: (owner === account.address ? maxJobAmount : maxUint256).toString(),
      maxOpenValue: (owner === account.address ? maxOpenValue : maxUint256).toString(),
      referralShareBps: owner === account.address ? referralShareBps : 0,
      protocolCutBps: 2_000,
      maxPlatformFeeBps: 500,
      maxArbitrationFeeBps: 1_000,
      maxReferralShareBps: 5_000,
      sellerResponseWindowSeconds: 604_800,
      arbitrationWindowSeconds: 604_800,
      disputeBondBps: 500,
    },
    supersedes: previousEscrow ? { address: previousEscrow.address, blockNumber: previousEscrow.blockNumber, record: previous } : null,
  };
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  pass(`wrote ${RECORD.slice(REPO.length + 1)}`);
  console.log(`\nset TEMPEX_ESCROW=${escrow} and TEMPEX_INDEX_FROM_BLOCK=${proxyReceipt.blockNumber}`);
}

main().catch((error: unknown) => {
  console.error(`\n\x1b[31mfailed\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
