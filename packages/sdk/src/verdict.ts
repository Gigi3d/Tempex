import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
  type TypedDataDomain,
} from 'viem';

/// Mirrors `TempexEscrow.VERDICT_TYPEHASH` field-for-field and in order.
/// Any divergence here produces signatures the contract rejects, so the shape is
/// asserted against the live contract's `verdictDigest` in the demo run.
export const VERDICT_TYPES = {
  Verdict: [
    { name: 'jobId', type: 'uint256' },
    { name: 'sellerAwardBps', type: 'uint16' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'rationaleHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const;

/// Mirrors the on-chain struct exactly, which means `uint64` timestamps are
/// `bigint` here — viem infers integer widths wider than 32 bits as bigint when
/// signing EIP-712, and the contract ABI decoder does the same for `resolve`.
export type VerdictStruct = {
  jobId: bigint;
  sellerAwardBps: number;
  evidenceHash: Hex;
  rationaleHash: Hex;
  issuedAt: bigint;
  validUntil: bigint;
};

/// Matches the escrow's EIP-712 domain: EIP712("Tempex", "1").
export function tempexDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { name: 'Tempex', version: '1', chainId, verifyingContract };
}

/// A ruling is JSON (numbers, rule name, prose); the signed struct is only the
/// five fields the contract checks plus the two timestamps. The rationale itself
/// is committed by hash, never carried on-chain.
export function verdictFromRuling(ruling: {
  jobId: number;
  sellerAwardBps: number;
  evidenceHash: Hex;
  rationaleHash: Hex;
  issuedAt: number;
  validUntil: number;
}): VerdictStruct {
  return {
    jobId: BigInt(ruling.jobId),
    sellerAwardBps: ruling.sellerAwardBps,
    evidenceHash: ruling.evidenceHash,
    rationaleHash: ruling.rationaleHash,
    issuedAt: BigInt(ruling.issuedAt),
    validUntil: BigInt(ruling.validUntil),
  };
}

export function verdictTypedData(
  verdict: VerdictStruct,
  domain: TypedDataDomain,
) {
  return { domain, types: VERDICT_TYPES, primaryType: 'Verdict' as const, message: verdict };
}

/// Off-chain equivalent of `TempexEscrow.verdictDigest`.
export function verdictDigest(
  verdict: VerdictStruct,
  domain: TypedDataDomain,
): Hex {
  return hashTypedData(verdictTypedData(verdict, domain));
}

export async function signVerdict(
  account: LocalAccount,
  verdict: VerdictStruct,
  domain: TypedDataDomain,
): Promise<Hex> {
  return account.signTypedData(verdictTypedData(verdict, domain));
}

/// Recovers the signer so a relayer can check a verdict before paying gas for it.
export async function recoverVerdictSigner(
  verdict: VerdictStruct,
  signature: Hex,
  domain: TypedDataDomain,
): Promise<Address> {
  return recoverTypedDataAddress({ ...verdictTypedData(verdict, domain), signature });
}
