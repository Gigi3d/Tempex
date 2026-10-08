import { decodeEventLog, getAbiItem, getAddress, parseAbi, toFunctionSelector, type Address, type Hex } from 'viem';
import { Address as OxAddress, P256, PublicKey, Signature } from 'ox';

import { tempexEscrowAbi } from './abi/TempexEscrow.js';
import { hashCanonical } from './canonical.js';

/// Agent wallets on Tempo: an agent never holds the money. It holds an access key
/// under its owner's account, which Tempo's account keychain limits to a budget,
/// an expiry and a list of calls. Everything the agent signs settles as the
/// owner, and the owner can revoke the key in one transaction.
///
/// This module is the shared vocabulary of that arrangement, used by the agent
/// (which asks), the beacon (which relays and verifies) and the owner's browser
/// (which approves): the pairing request and its proof of key possession, the
/// least-privilege call scopes per role, and the keychain events that prove an
/// authorization happened.

/// Tempo's account keychain precompile.
export const KEYCHAIN_ADDRESS: Address = '0xaAAAaaAA00000000000000000000000000000000';

export const AGENT_ROLES = ['buyer', 'seller', 'both'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/// Budget periods an owner can choose. 0 means a one-off total, not a recurring budget.
export const AGENT_PERIODS = { none: 0, day: 86_400, week: 604_800, month: 2_592_000 } as const;
export type AgentPeriod = keyof typeof AGENT_PERIODS;

export const PAIRING_TTL_SECONDS = 15 * 60;
export const MAX_AGENT_DAYS = 90;
export const MAX_AGENT_NAME = 48;
/// The largest budget a pairing request may ask for, in token base units. An
/// owner can always grant less; asking for more is refused before anyone sees it.
export const MAX_AGENT_LIMIT = 10_000_000_000n;

/// Escrow calls per role. A buyer opens, funds and closes jobs; a seller delivers
/// and answers disputes; both may withdraw their own credit and run the
/// permissionless keeper calls that unstick a job.
const BUYER_CALLS = ['createJob', 'createJobWithArbiter', 'createJobWithReferrer', 'createMilestones', 'fund', 'cancel', 'accept', 'dispute'] as const;
const SELLER_CALLS = ['deliver', 'respond'] as const;
const ANYONE_CALLS = ['withdraw', 'autoAccept', 'settleLapsed', 'refundExpired'] as const;
/// TIP-20 `approve(address,uint256)`.
const APPROVE_SELECTOR: Hex = '0x095ea7b3';

export function agentCalls(role: AgentRole): string[] {
  return [
    ...(role === 'seller' ? [] : BUYER_CALLS),
    ...(role === 'buyer' ? [] : SELLER_CALLS),
    ...ANYONE_CALLS,
  ];
}

export type AgentScope = { address: Address; selector: Hex; recipients?: readonly Address[] };

/// The calls an agent key may make, and nothing else: named escrow functions
/// and, for a buyer, `approve` with the escrow as the only allowed spender. The
/// keychain refuses any other call, so a leaked key cannot send money anywhere.
export function agentScopes(role: AgentRole, escrow: Address, token: Address): AgentScope[] {
  const scopes: AgentScope[] = agentCalls(role).map((name) => ({
    address: escrow,
    selector: toFunctionSelector(getAbiItem({ abi: tempexEscrowAbi, name: name as never }) as never),
  }));
  if (role !== 'seller') scopes.push({ address: token, selector: APPROVE_SELECTOR, recipients: [escrow] });
  return scopes;
}

/// What an agent asks its owner for. Signed by the agent's own key, so nobody can
/// ask on behalf of a key they do not hold, and carrying a random witness the
/// owner's authorization binds to, so that authorization cannot be passed off as
/// the answer to any other request.
export type PairingRequest = {
  version: 1;
  chainId: number;
  escrow: Address;
  /// The access key's address: derived from `publicKey`, checked on receipt.
  keyId: Address;
  /// Uncompressed P-256 public key.
  publicKey: Hex;
  name: string;
  role: AgentRole;
  /// Requested budget per period, in token base units, as a decimal string.
  limit: string;
  /// Budget period in seconds; 0 for a one-off total.
  period: number;
  /// Requested lifetime of the key, in days.
  days: number;
  /// 32 random bytes the owner's on-chain authorization must carry.
  witness: Hex;
  /// Unix seconds; requests older than the pairing TTL are refused.
  issuedAt: number;
};

export type SignedPairingRequest = { request: PairingRequest; signature: Hex };

export function pairingDigest(request: PairingRequest): Hex {
  return hashCanonical({ domain: 'tempex.agent-pairing/1', ...request });
}

export function signPairingRequest(request: PairingRequest, privateKey: Hex): SignedPairingRequest {
  const signature = P256.sign({ payload: pairingDigest(request), privateKey });
  return { request, signature: Signature.toHex(signature) };
}

export function keyIdOf(publicKey: Hex): Address {
  return getAddress(OxAddress.fromPublicKey(PublicKey.fromHex(publicKey)));
}

/// Everything wrong with a signed pairing request, or nothing. Shape first, then
/// that the key id is the public key's, then that the public key signed it.
export function pairingProblems(
  signed: SignedPairingRequest,
  context: { chainId: number; escrow: Address; now?: number; maxLimit?: bigint },
): string[] {
  const problems: string[] = [];
  const r = signed?.request as Partial<PairingRequest> | undefined;
  if (!r || typeof r !== 'object') return ['missing request'];
  const now = context.now ?? Math.floor(Date.now() / 1000);
  if (r.version !== 1) problems.push('unsupported version');
  if (r.chainId !== context.chainId) problems.push(`request is for chain ${String(r.chainId)}, this is ${context.chainId}`);
  if (typeof r.escrow !== 'string' || r.escrow.toLowerCase() !== context.escrow.toLowerCase()) problems.push('request names a different escrow');
  if (typeof r.name !== 'string' || r.name.trim().length === 0 || r.name.length > MAX_AGENT_NAME || /[\u0000-\u001f<>]/.test(r.name)) {
    problems.push(`name must be 1-${MAX_AGENT_NAME} plain characters`);
  }
  if (!AGENT_ROLES.includes(r.role as AgentRole)) problems.push('role must be buyer, seller or both');
  let limit = -1n;
  try {
    limit = typeof r.limit === 'string' && /^\d{1,30}$/.test(r.limit) ? BigInt(r.limit) : -1n;
  } catch {
    limit = -1n;
  }
  if (limit < 0n || limit > (context.maxLimit ?? MAX_AGENT_LIMIT)) problems.push('limit must be a whole number of base units within the allowed maximum');
  if (r.role === 'seller' && limit !== 0n) problems.push('a seller key moves no money of its own; ask for a limit of 0');
  if (!Object.values(AGENT_PERIODS).includes(r.period as never)) problems.push('period must be none, day, week or month');
  if (!Number.isInteger(r.days) || (r.days as number) < 1 || (r.days as number) > MAX_AGENT_DAYS) problems.push(`days must be 1-${MAX_AGENT_DAYS}`);
  if (typeof r.witness !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r.witness)) problems.push('witness must be 32 bytes');
  if (!Number.isInteger(r.issuedAt) || (r.issuedAt as number) > now + 60 || (r.issuedAt as number) < now - PAIRING_TTL_SECONDS) {
    problems.push('request is stale or from the future');
  }
  if (problems.length > 0) return problems;

  try {
    if (keyIdOf(r.publicKey as Hex) !== getAddress(r.keyId as Address)) return ['keyId is not the address of publicKey'];
    const ok = P256.verify({
      publicKey: PublicKey.fromHex(r.publicKey as Hex),
      payload: pairingDigest(r as PairingRequest),
      signature: Signature.fromHex(signed.signature),
    });
    if (!ok) return ['signature does not verify against publicKey'];
  } catch {
    return ['publicKey or signature is malformed'];
  }
  return [];
}

/// The keychain events an authorization emits, for checking one from its receipt.
export const keychainEventsAbi = parseAbi([
  'event KeyAuthorized(address indexed account, address indexed publicKey, uint8 signatureType, uint64 expiry)',
  'event KeyRevoked(address indexed account, address indexed publicKey)',
  'event SpendingLimitUpdated(address indexed account, address indexed publicKey, address indexed token, uint256 newLimit)',
  'event AccessKeySpend(address indexed account, address indexed publicKey, address indexed token, uint256 amount, uint256 remainingLimit)',
  'event KeyAuthorizationWitness(address indexed account, bytes32 indexed witness)',
]);

/// Who authorized which key under which witness, read from a transaction's logs.
/// A pairing is proven when one owner both authorized the requested key and
/// bound the request's witness, in the same successful transaction.
export function authorizationsIn(logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[]): {
  keys: { account: Address; keyId: Address; expiry: bigint }[];
  witnesses: { account: Address; witness: Hex }[];
} {
  const keys: { account: Address; keyId: Address; expiry: bigint }[] = [];
  const witnesses: { account: Address; witness: Hex }[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== KEYCHAIN_ADDRESS.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: keychainEventsAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (event.eventName === 'KeyAuthorized') {
        keys.push({ account: getAddress(event.args.account), keyId: getAddress(event.args.publicKey), expiry: event.args.expiry });
      } else if (event.eventName === 'KeyAuthorizationWitness') {
        witnesses.push({ account: getAddress(event.args.account), witness: event.args.witness });
      }
    } catch {
      // another keychain event; not part of an authorization
    }
  }
  return { keys, witnesses };
}

export function provesPairing(
  logs: Parameters<typeof authorizationsIn>[0],
  request: Pick<PairingRequest, 'keyId' | 'witness'>,
): Address | null {
  const { keys, witnesses } = authorizationsIn(logs);
  for (const key of keys) {
    if (key.keyId.toLowerCase() !== request.keyId.toLowerCase()) continue;
    const bound = witnesses.some(
      (w) => w.account === key.account && w.witness.toLowerCase() === request.witness.toLowerCase(),
    );
    if (bound) return key.account;
  }
  return null;
}
