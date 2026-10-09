import { http, type Address, type Hex } from 'viem';
import { createClient } from 'viem/tempo';
import { tempoTestnet } from 'viem/tempo/chains';

import { RPC_URL, feePaid, tempexEscrowAbi, tip20Abi, type FeePayment } from '@tempex/sdk';

import { DEFAULT_SCAN_CHUNK_BLOCKS } from './config.js';

/// One decoded escrow event, flattened.
///
/// The beacon never stores these: they are re-read from the chain on every cold
/// start, which is what makes every number it serves an observation rather than a
/// claim.
export type EscrowEvent = {
  name: string;
  args: Record<string, unknown>;
  blockNumber: number;
  transactionHash: Hex;
  logIndex: number;
};

type RawLog = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
};

/// Read-only chain access. No account, no key: a beacon that cannot sign cannot
/// move funds, and that is a property worth being able to state plainly.
export function openChain(rpcUrl: string = RPC_URL) {
  return createClient({ chain: tempoTestnet, transport: http(rpcUrl) });
}

export type ChainReader = ReturnType<typeof openChain>;

export async function headBlock(reader: ChainReader): Promise<bigint> {
  return reader.getBlockNumber();
}

export type EscrowConfig = {
  escrow: Address;
  arbiter: Address;
  treasury: Address;
  owner: Address;
  paymentToken: Address;
  platformFeeBps: number;
  arbitrationFeeBps: number;
  /// The ceilings the owner cannot raise fees past, read from the contract itself
  /// so "fees are capped" is an observation and not a promise.
  maxPlatformFeeBps: number;
  maxArbitrationFeeBps: number;
  bpsDenominator: number;
  withdrawMemo: Hex;
  jobCount: bigint;
  nextJobId: bigint;
  /// v3 and later: the upgrade path and the launch guards. Null on an escrow
  /// that predates them (v2 is neither upgradeable nor guarded).
  upgrade: { implementation: Address; version: string } | null;
  guards: {
    newJobsPaused: boolean;
    maxJobAmount: bigint;
    maxOpenValue: bigint;
    openValue: bigint;
    arbitrationFeeFloor: bigint;
    referralShareBps: number;
    maxReferralShareBps: number;
  } | null;
};

/// ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1.
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/// The escrow's own view of its governance and fee schedule.
///
/// Read live rather than configured, because the manifest that quotes these numbers
/// has to agree with the contract an agent will actually call.
export async function escrowConfig(reader: ChainReader, escrow: Address): Promise<EscrowConfig> {
  const [
    arbiter,
    treasury,
    owner,
    paymentToken,
    platformFeeBps,
    arbitrationFeeBps,
    maxPlatformFeeBps,
    maxArbitrationFeeBps,
    bpsDenominator,
    withdrawMemo,
    jobCount,
    nextJobId,
  ] = await Promise.all([
    read<Address>(reader, escrow, 'arbiter'),
    read<Address>(reader, escrow, 'treasury'),
    read<Address>(reader, escrow, 'owner'),
    read<Address>(reader, escrow, 'paymentToken'),
    read<number>(reader, escrow, 'platformFeeBps'),
    read<number>(reader, escrow, 'arbitrationFeeBps'),
    read<number>(reader, escrow, 'MAX_PLATFORM_FEE_BPS'),
    read<number>(reader, escrow, 'MAX_ARBITRATION_FEE_BPS'),
    read<number>(reader, escrow, 'BPS_DENOMINATOR'),
    read<Hex>(reader, escrow, 'WITHDRAW_MEMO'),
    read<bigint>(reader, escrow, 'jobCount'),
    read<bigint>(reader, escrow, 'nextJobId'),
  ]);

  // An escrow that answers `version()` is v3: a proxy whose owner can replace
  // the code. Read the implementation from the proxy's own storage slot rather
  // than trusting any record of it.
  let upgrade: EscrowConfig['upgrade'] = null;
  let guards: EscrowConfig['guards'] = null;
  const version = await read<string>(reader, escrow, 'version').catch(() => null);
  if (version !== null) {
    const slot = await reader.getStorageAt({ address: escrow, slot: IMPLEMENTATION_SLOT });
    upgrade = { implementation: `0x${(slot ?? '0x').slice(-40).padStart(40, '0')}` as Address, version };
    const [newJobsPaused, maxJobAmount, maxOpenValue, openValue, arbitrationFeeFloor, referralShareBps, maxReferralShareBps] =
      await Promise.all([
        read<boolean>(reader, escrow, 'newJobsPaused'),
        read<bigint>(reader, escrow, 'maxJobAmount'),
        read<bigint>(reader, escrow, 'maxOpenValue'),
        read<bigint>(reader, escrow, 'openValue'),
        read<bigint>(reader, escrow, 'arbitrationFeeFloor'),
        read<number>(reader, escrow, 'referralShareBps'),
        read<number>(reader, escrow, 'MAX_REFERRAL_SHARE_BPS'),
      ]);
    guards = {
      newJobsPaused,
      maxJobAmount,
      maxOpenValue,
      openValue,
      arbitrationFeeFloor,
      referralShareBps: Number(referralShareBps),
      maxReferralShareBps: Number(maxReferralShareBps),
    };
  }

  return {
    escrow,
    arbiter,
    treasury,
    owner,
    paymentToken,
    platformFeeBps: Number(platformFeeBps),
    arbitrationFeeBps: Number(arbitrationFeeBps),
    maxPlatformFeeBps: Number(maxPlatformFeeBps),
    maxArbitrationFeeBps: Number(maxArbitrationFeeBps),
    bpsDenominator: Number(bpsDenominator),
    withdrawMemo,
    jobCount,
    nextJobId,
    upgrade,
    guards,
  };
}

async function read<T>(reader: ChainReader, address: Address, functionName: string): Promise<T> {
  return reader.readContract({
    address,
    abi: tempexEscrowAbi,
    functionName: functionName as never,
  }) as Promise<T>;
}

export type TokenInfo = {
  address: Address;
  symbol: string;
  decimals: number;
  /// The escrow's own balance: the pool of in-flight and unwithdrawn job money.
  escrowBalance: bigint;
};

export async function tokenInfo(
  reader: ChainReader,
  token: Address,
  escrow: Address,
): Promise<TokenInfo> {
  const [symbol, decimals, escrowBalance] = await Promise.all([
    reader.readContract({ address: token, abi: tip20Abi, functionName: 'symbol' }),
    reader.readContract({ address: token, abi: tip20Abi, functionName: 'decimals' }),
    reader.readContract({
      address: token,
      abi: tip20Abi,
      functionName: 'balanceOf',
      args: [escrow],
    }),
  ]);
  return { address: token, symbol, decimals: Number(decimals), escrowBalance };
}

export type ScanRange = {
  escrow: Address;
  fromBlock: bigint;
  toBlock: bigint;
  chunkBlocks?: bigint;
};

/// Pulls every escrow event in a block range, in chunks.
///
/// Chunked because a beacon that has been offline for a week must still be able to
/// catch up in one call, and a single oversized `eth_getLogs` is the usual reason
/// indexers give up and reach for a database.
export async function scanEvents(reader: ChainReader, range: ScanRange): Promise<EscrowEvent[]> {
  const chunk = range.chunkBlocks ?? DEFAULT_SCAN_CHUNK_BLOCKS;
  const events: EscrowEvent[] = [];

  for (let from = range.fromBlock; from <= range.toBlock; from += chunk) {
    const to = from + chunk - 1n > range.toBlock ? range.toBlock : from + chunk - 1n;
    const logs = (await reader.getContractEvents({
      address: range.escrow,
      abi: tempexEscrowAbi,
      fromBlock: from,
      toBlock: to,
    })) as unknown as RawLog[];

    for (const log of logs) {
      events.push({
        name: log.eventName,
        args: log.args,
        blockNumber: Number(log.blockNumber),
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      });
    }
  }

  return events.sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  );
}

/// Reads the fee a specific transaction actually paid, in the stablecoin.
///
/// Tempo has no gas token, so the fee is a TIP-20 transfer inside the receipt. That
/// means the beacon can quote a *measured* onboarding cost from a real transaction
/// instead of an estimate that turns out to be wrong at the worst moment.
export async function measureFee(
  reader: ChainReader,
  transactionHash: Hex,
  feeManager?: Address,
): Promise<(FeePayment & { transactionHash: Hex }) | null> {
  const receipt = await reader.getTransactionReceipt({ hash: transactionHash });
  const payment = feePaid(receipt.logs, feeManager);
  return payment ? { ...payment, transactionHash } : null;
}
