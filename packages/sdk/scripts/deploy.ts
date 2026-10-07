#!/usr/bin/env tsx
// Deploys TempexEscrow to Tempo Moderato from first principles, then proves the
// deployment is the code in this repository, configured as intended.
//
//   1. Build      read the forge artifact: initcode, runtime, immutable slots
//   2. Preflight  chain id, payment token, deployer balance, gas vs block limit
//   3. Deploy     one type-0x76 transaction whose single call has no `to`: a create
//   4. Verify     eth_getCode equals the compiled runtime byte for byte, outside
//                 the immutable slots the constructor fills; then every setting
//                 the constructor took is read back from the live contract
//   5. Record     deployments/<network>.json, with the receipt's own numbers
//
// Why not `forge create` / `forge script`: stock forge cannot send Tempo's
// type-0x76 transaction or pay the fee in a TIP-20 token, and forge script's gas
// estimate ignores Tempo's pricing for contract creation (see deployments notes).
// The node's own eth_estimateGas does price it correctly, so it is used here.
//
// Env: DEPLOYER_KEY (pays the fee; gets no power over the contract),
//      TEMPEX_OWNER, TEMPEX_ARBITER, TEMPEX_TREASURY, TEMPEX_TOKEN,
//      TEMPEX_PLATFORM_FEE_BPS (50), TEMPEX_ARBITRATION_FEE_BPS (200).
// Flags: --faucet         top the deployer up from the testnet faucet first
//        --dry            stop after preflight
//        --resume <hash>  skip broadcasting; verify and record the deployment
//                         that transaction already made
//
// Run: pnpm deploy:escrow [--faucet] [--dry]

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  encodeAbiParameters,
  formatUnits,
  getAddress,
  keccak256,
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
const ARTIFACT = resolve(REPO, 'contracts/out/TempexEscrow.sol/TempexEscrow.json');
const RECORD = resolve(REPO, 'deployments/moderato.json');
/// Headroom over the node's estimate; creation cost on Tempo is deterministic,
/// so this only absorbs state that changes between estimate and inclusion.
const GAS_HEADROOM_PERCENT = 20n;

type Artifact = {
  bytecode: { object: Hex };
  deployedBytecode: {
    object: Hex;
    immutableReferences?: Record<string, { start: number; length: number }[]>;
  };
};

const argv = process.argv.slice(2);
const flags = new Set(argv);
const resumeIndex = argv.indexOf('--resume');
const resumeHash = resumeIndex >= 0 ? (argv[resumeIndex + 1] as Hex | undefined) : undefined;
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
const addressEnv = (name: string): Address => getAddress(need(name));
function bpsEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim() || fallback);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) fail(`${name} must be whole bps`);
  return value;
}

/// Runtime bytes with every immutable slot zeroed. The constructor writes those
/// slots (token address, chain id, cached domain separator, this address), so
/// they are the only bytes allowed to differ between the build and the chain.
function maskImmutables(code: Hex, artifact: Artifact): Hex {
  const bytes = Buffer.from(code.slice(2), 'hex');
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) bytes.fill(0, start, start + length);
  }
  return `0x${bytes.toString('hex')}`;
}

async function main(): Promise<void> {
  loadEnv(REPO);
  console.log('\x1b[1mTempexEscrow deployment\x1b[0m');

  // ---------------------------------------------------------------- 1. build
  step('1. Build artifact');
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as Artifact;
  const initcode = artifact.bytecode.object;
  const runtime = artifact.deployedBytecode.object;
  out('initcode', `${(initcode.length - 2) / 2} bytes`);
  out('runtime', `${(runtime.length - 2) / 2} bytes (EIP-170 limit 24,576)`);
  out('runtime hash', keccak256(runtime));
  if ((runtime.length - 2) / 2 > 24_576) fail('runtime exceeds EIP-170');

  // ------------------------------------------------------------ 2. preflight
  step('2. Preflight');
  const account = privateKeyToAccount(need('DEPLOYER_KEY') as Hex);
  const token = getAddress(process.env['TEMPEX_TOKEN']?.trim() || TOKENS.alphaUsd);
  const owner = addressEnv('TEMPEX_OWNER');
  const arbiter = addressEnv('TEMPEX_ARBITER');
  const treasury = addressEnv('TEMPEX_TREASURY');
  const platformFeeBps = bpsEnv('TEMPEX_PLATFORM_FEE_BPS', 50);
  const arbitrationFeeBps = bpsEnv('TEMPEX_ARBITRATION_FEE_BPS', 200);
  if (platformFeeBps > 500) fail('platform fee above the contract cap of 500 bps');
  if (arbitrationFeeBps > 1_000) fail('arbitration fee above the contract cap of 1000 bps');

  const client = createClient({
    account,
    chain: tempoTestnet,
    feeToken: token,
    transport: http(process.env['TEMPO_RPC_URL']?.trim() || RPC_URL),
  });

  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) fail(`connected to chain ${chainId}, expected ${CHAIN_ID}`);
  pass(`chain ${chainId} (Tempo Moderato)`);

  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: tip20Abi, functionName: 'symbol' }),
    client.readContract({ address: token, abi: tip20Abi, functionName: 'decimals' }),
  ]);
  pass(`payment and fee token ${symbol} at ${token}, ${decimals} decimals`);

  out('deployer', `${account.address} (pays the fee; no role in the contract)`);
  out('owner', owner);
  out('house arbiter', arbiter);
  out('treasury', treasury);
  out('fees', `platform ${platformFeeBps} bps, arbitration ${arbitrationFeeBps} bps`);
  if (arbiter === owner) console.log('  \x1b[33mnote\x1b[0m  owner and arbiter are the same key');

  if (flags.has('--faucet') && resumeHash === undefined) {
    const hashes = await client.faucet.fund({ account: account.address });
    for (const hash of hashes as Hex[]) await client.waitForTransactionReceipt({ hash });
    pass(`faucet funded the deployer (${(hashes as Hex[]).length} transfers)`);
  }

  const balance = await client.readContract({
    address: token,
    abi: tip20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  out('deployer balance', `${formatUnits(balance, Number(decimals))} ${symbol}`);

  const args = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint16' },
      { type: 'uint16' },
    ],
    [token, owner, arbiter, treasury, platformFeeBps, arbitrationFeeBps],
  );
  const data = `${initcode}${args.slice(2)}` as Hex;
  out('creation payload', `${(data.length - 2) / 2} bytes (initcode + ${(args.length - 2) / 2} of args)`);

  const estimate = await client.estimateGas({ account, data });
  const gas = (estimate * (100n + GAS_HEADROOM_PERCENT)) / 100n;
  const block = await client.getBlock();
  out('gas estimate', `${estimate} (limit ${gas}, block limit ${block.gasLimit})`);
  if (gas > block.gasLimit) fail('creation would not fit in a block');
  pass('the creation fits in a block');

  if (flags.has('--dry')) {
    console.log('\n--dry: stopping before broadcast');
    return;
  }

  // --------------------------------------------------------------- 3. deploy
  step(resumeHash ? '3. Deploy (resumed from an earlier broadcast)' : '3. Deploy');
  // No `to` on the call: the Tempo transaction's single call is a contract creation.
  const hash = resumeHash ?? (await client.sendTransaction({ account, data, gas }));
  out('tx', `${EXPLORER_URL}/tx/${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') fail(`deployment reverted in block ${receipt.blockNumber}`);
  if (getAddress(receipt.from) !== account.address) fail(`that transaction was sent by ${receipt.from}, not this deployer`);
  if (!receipt.contractAddress) fail('the receipt names no contract address');
  const escrow = getAddress(receipt.contractAddress);
  pass(`TempexEscrow at ${escrow}, block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);

  // --------------------------------------------------------------- 4. verify
  step('4. Verify against the build');
  const onChain = await client.getCode({ address: escrow, blockNumber: receipt.blockNumber });
  if (!onChain || onChain === '0x') fail('no code at the new address');
  if (onChain.length !== runtime.length) {
    fail(`runtime is ${(onChain.length - 2) / 2} bytes on chain, ${(runtime.length - 2) / 2} in the build`);
  }
  if (maskImmutables(onChain, artifact) !== maskImmutables(runtime, artifact)) {
    fail('deployed runtime differs from the build outside the immutable slots');
  }
  pass(`runtime matches the build byte for byte outside ${Object.values(artifact.deployedBytecode.immutableReferences ?? {}).flat().length} immutable slots`);

  const read = <T>(functionName: string): Promise<T> =>
    client.readContract({ address: escrow, abi: tempexEscrowAbi, functionName: functionName as never }) as Promise<T>;
  const checks: [string, unknown, unknown][] = [
    ['owner', getAddress(await read<Address>('owner')), owner],
    ['pendingOwner', getAddress(await read<Address>('pendingOwner')), getAddress('0x0000000000000000000000000000000000000000')],
    ['arbiter', getAddress(await read<Address>('arbiter')), arbiter],
    ['treasury', getAddress(await read<Address>('treasury')), treasury],
    ['paymentToken', getAddress(await read<Address>('paymentToken')), token],
    ['platformFeeBps', Number(await read<number>('platformFeeBps')), platformFeeBps],
    ['arbitrationFeeBps', Number(await read<number>('arbitrationFeeBps')), arbitrationFeeBps],
    ['protocolCutBps', Number(await read<number>('protocolCutBps')), 2_000],
    ['jobCount', await read<bigint>('jobCount'), 0n],
    ['SELLER_RESPONSE_WINDOW', await read<bigint>('SELLER_RESPONSE_WINDOW'), 604_800n],
    ['ARBITRATION_WINDOW', await read<bigint>('ARBITRATION_WINDOW'), 604_800n],
    ['DISPUTE_BOND_BPS', Number(await read<number>('DISPUTE_BOND_BPS')), 500],
  ];
  for (const [name, actual, expected] of checks) {
    if (actual !== expected) fail(`${name} is ${String(actual)}, expected ${String(expected)}`);
  }
  pass(`${checks.length} settings read back from the live contract match the constructor and constants`);

  const domain = (await client.readContract({
    address: escrow,
    abi: tempexEscrowAbi,
    functionName: 'eip712Domain',
  })) as readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];
  if (domain[1] !== 'Tempex' || domain[2] !== '1' || domain[3] !== BigInt(CHAIN_ID) || getAddress(domain[4]) !== escrow) {
    fail(`EIP-712 domain is ${domain[1]}/${domain[2]}/${domain[3]}/${domain[4]}`);
  }
  pass(`EIP-712 domain Tempex/1, chain ${CHAIN_ID}, verifyingContract ${escrow}`);

  const fee = receipt.logs.find(
    (log) => log.address.toLowerCase() === token.toLowerCase() && log.topics[2]?.toLowerCase().endsWith('feec000000000000000000000000000000000000'),
  );
  const feePaid = fee ? BigInt(fee.data) : null;
  if (feePaid !== null) out('fee paid', `${formatUnits(feePaid, Number(decimals))} ${symbol}, a TIP-20 transfer to the fee manager`);

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
        txHash: hash,
        blockNumber: Number(receipt.blockNumber),
        deployer: account.address,
        gasUsed: Number(receipt.gasUsed),
        ...(feePaid !== null ? { feePaid: feePaid.toString(), feePaidFormatted: `${formatUnits(feePaid, Number(decimals))} ${symbol}` } : {}),
        feeToken: token,
        feeTokenSymbol: symbol,
        initcodeBytes: (initcode.length - 2) / 2,
        runtimeBytes: (runtime.length - 2) / 2,
        runtimeKeccak: keccak256(runtime),
        verifiedBy: 'packages/sdk/scripts/deploy.ts: eth_getCode equals the forge build outside immutable slots, and every constructor setting read back',
      },
    },
    config: {
      paymentToken: token,
      owner,
      arbiter,
      treasury,
      platformFeeBps,
      arbitrationFeeBps,
      protocolCutBps: 2_000,
      maxPlatformFeeBps: 500,
      maxArbitrationFeeBps: 1_000,
      sellerResponseWindowSeconds: 604_800,
      arbitrationWindowSeconds: 604_800,
      disputeBondBps: 500,
    },
    supersedes: previousEscrow
      ? { address: previousEscrow.address, blockNumber: previousEscrow.blockNumber, record: previous }
      : null,
  };
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  pass(`wrote ${RECORD.slice(REPO.length + 1)}`);
  console.log(`\nset TEMPEX_ESCROW=${escrow} and TEMPEX_INDEX_FROM_BLOCK=${receipt.blockNumber}`);
}

main().catch((error: unknown) => {
  console.error(`\n\x1b[31mfailed\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
