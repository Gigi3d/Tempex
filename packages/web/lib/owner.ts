import { Base64, Bytes, Hash, Hex as OxHex, P256, PublicKey, WebAuthnP256 as OxWebAuthn } from 'ox';
import { getAddress, type Address, type Hex } from 'viem';
import { Account, Actions, WebAuthnP256, WebCryptoP256, createClient, http, withFeePayer } from 'viem/tempo';
import { tempoTestnet } from 'viem/tempo/chains';

import { AGENT_PERIODS, RPC_URL, SPONSOR_URL, agentScopes, keyIdOf, tip20Abi, type AgentPeriod, type AgentRole } from '@tempex/sdk/browser';
import { TempexClient } from '@tempex/sdk/client';

/// The owner's side of agent wallets. The owner signs in with a passkey: the
/// Tempo account it controls is the one every agent acts for, and every agent is
/// an access key that account authorizes, tops up or revokes, one passkey
/// prompt at a time. Nothing here holds an agent's private key unless the owner
/// creates one in this tab, and then only until it is handed over.

export type Protocol = { escrow: Address; token: Address };

export type OwnerSession = {
  address: Address;
  kind: 'passkey' | 'device';
  /// A viem Tempo client signing as the owner, with fees sponsored.
  client: unknown;
  tempex: TempexClient;
};

const PASSKEY_STORE = 'tempex.owner.passkey';
/// Set for this tab when the owner signs out, so a reload does not sign them back in.
const SIGNED_OUT = 'tempex.owner.signedOut';

export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' && window.isSecureContext;
}

function sessionFor(account: unknown, kind: OwnerSession['kind'], protocol: Protocol): OwnerSession {
  const client = createClient({
    account: account as never,
    chain: tempoTestnet,
    feeToken: protocol.token,
    transport: withFeePayer(http(RPC_URL), http(SPONSOR_URL)),
  });
  return {
    address: getAddress((account as { address: Address }).address),
    kind,
    client,
    tempex: new TempexClient({ account: account as never, addresses: protocol, sponsorUrl: SPONSOR_URL }),
  };
}

export function rememberedPasskey(): { id: string; publicKey: Hex } | null {
  try {
    return JSON.parse(localStorage.getItem(PASSKEY_STORE) ?? 'null');
  } catch {
    return null;
  }
}

/// Signs the owner in with the passkey this device remembers, or creates one.
export async function signInWithPasskey(protocol: Protocol): Promise<OwnerSession> {
  let stored = rememberedPasskey();
  if (!stored) {
    const credential = await WebAuthnP256.createCredential({ label: 'Tempex owner' });
    stored = { id: credential.id, publicKey: credential.publicKey };
    try {
      localStorage.setItem(PASSKEY_STORE, JSON.stringify(stored));
    } catch {
      // a private window: the passkey still works for this visit
    }
  }
  markSignedOut(false);
  return sessionFor(Account.fromWebAuthnP256(stored), 'passkey', protocol);
}

/// Signing back in needs no prompt: the passkey's public key is all an account
/// needs to be addressed, and every signature still asks the authenticator.
export function restoreSession(protocol: Protocol): OwnerSession | null {
  const stored = rememberedPasskey();
  if (!stored) return null;
  try {
    if (sessionStorage.getItem(SIGNED_OUT) === '1') return null;
  } catch {
    // no session storage: restore anyway
  }
  return sessionFor(Account.fromWebAuthnP256(stored), 'passkey', protocol);
}

export function markSignedOut(signedOut: boolean): void {
  try {
    if (signedOut) sessionStorage.setItem(SIGNED_OUT, '1');
    else sessionStorage.removeItem(SIGNED_OUT);
  } catch {
    // nothing to remember
  }
}

/// The address a passkey's public key controls on Tempo.
export function addressOfPasskey(publicKey: Hex): Address {
  return keyIdOf(publicKey);
}

/// A passkey made on another device (synced by iCloud Keychain, Google Password
/// Manager, a security key) signs in here without any server remembering it.
///
/// A WebAuthn assertion does not carry its public key, but an ECDSA signature
/// pins it to one of two candidates. If only one candidate account has ever been
/// used, that is the owner. Otherwise a second assertion narrows the two to one.
/// Nothing is trusted that this browser did not recover itself.
export async function signInWithExistingPasskey(protocol: Protocol, footprint: (address: Address) => Promise<boolean>): Promise<OwnerSession> {
  const first = await candidates();
  let publicKey: Hex | null = null;
  if (first.keys.length === 1) publicKey = first.keys[0]!;
  else {
    const used = await Promise.all(first.keys.map((key) => footprint(addressOfPasskey(key)).catch(() => false)));
    if (used.filter(Boolean).length === 1) publicKey = first.keys[used.indexOf(true)]!;
  }
  if (!publicKey) {
    const second = await candidates(first.id);
    publicKey = first.keys.find((key) => second.keys.includes(key)) ?? null;
  }
  if (!publicKey) throw new Error('This passkey could not be matched to one account. Try again, or create a new passkey.');
  const stored = { id: first.id, publicKey };
  try {
    localStorage.setItem(PASSKEY_STORE, JSON.stringify(stored));
  } catch {
    // a private window: the passkey still works for this visit
  }
  markSignedOut(false);
  return sessionFor(Account.fromWebAuthnP256(stored), 'passkey', protocol);
}

/// One assertion over a random challenge, and the two public keys it could have come from.
async function candidates(credentialId?: string): Promise<{ id: string; keys: Hex[] }> {
  const challenge = OxHex.fromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const { id, metadata, signature } = await OxWebAuthn.sign({ challenge, ...(credentialId ? { credentialId } : {}) });
  const clientData = JSON.parse(metadata.clientDataJSON) as { type?: string; challenge?: string };
  if (clientData.type !== 'webauthn.get' || OxHex.fromBytes(Base64.toBytes(clientData.challenge ?? '')) !== challenge) {
    throw new Error('The authenticator answered a different challenge.');
  }
  const digest = Hash.sha256(Bytes.concat(Bytes.fromHex(metadata.authenticatorData), Hash.sha256(Bytes.fromString(metadata.clientDataJSON), { as: 'Bytes' })));
  const keys: Hex[] = [];
  for (const yParity of [0, 1]) {
    try {
      // The same encoding passkey creation stores: x‖y, no 0x04 prefix.
      const key = PublicKey.toHex(P256.recoverPublicKey({ payload: digest, signature: { r: signature.r, s: signature.s, yParity } }), { includePrefix: false });
      // Recovery can only produce a key that verifies; check anyway.
      if (P256.verify({ payload: digest, publicKey: PublicKey.fromHex(key), signature: { r: signature.r, s: signature.s } }) && !keys.includes(key)) keys.push(key);
    } catch {
      // this parity has no valid point
    }
  }
  if (keys.length === 0) throw new Error('No public key could be recovered from the passkey\u2019s signature.');
  return { id, keys };
}

/// Whether an account has ever been used: a balance, or any Tempex job.
export async function hasFootprint(address: Address, protocol: Protocol): Promise<boolean> {
  const reader = createClient({ chain: tempoTestnet, transport: http(RPC_URL) });
  const balance = (await (reader as unknown as { readContract: (p: unknown) => Promise<bigint> }).readContract({
    address: protocol.token,
    abi: tip20Abi,
    functionName: 'balanceOf',
    args: [address],
  })) as bigint;
  if (balance > 0n) return true;
  const response = await fetch(`/api/jobs?address=${address}`, { cache: 'no-store' });
  if (!response.ok) return false;
  return ((await response.json()) as { count?: number }).count! > 0;
}

/// Where passkeys are unavailable (an insecure origin, an old browser): a key
/// held by this tab. Clearly labelled; it is gone when the tab closes.
export async function signInWithDeviceKey(protocol: Protocol): Promise<OwnerSession> {
  return sessionFor(Account.fromWebCryptoP256(await WebCryptoP256.createKeyPair()), 'device', protocol);
}

export function forgetPasskey(): void {
  try {
    localStorage.removeItem(PASSKEY_STORE);
  } catch {
    // nothing stored
  }
}

export type Grant = {
  keyId: Address;
  role: AgentRole;
  /// Budget per period in token base units (ignored for a seller, which gets 0).
  limit: bigint;
  period: AgentPeriod;
  days: number;
  /// Present when the grant answers a pairing request.
  witness?: Hex;
};

/// Authorizes an agent key in one transaction: an expiry, a budget the keychain
/// meters on every approve, and calls limited to the escrow's functions for the
/// role (plus approve-to-escrow for a buyer). Fees are sponsored.
export async function authorizeAgent(owner: OwnerSession, protocol: Protocol, grant: Grant): Promise<Hex> {
  const period = AGENT_PERIODS[grant.period];
  const hash = await Actions.accessKey.authorize(owner.client as never, {
    accessKey: { address: grant.keyId, type: 'p256' },
    expiry: Math.floor(Date.now() / 1000) + grant.days * 86_400,
    // A seller key gets a zero budget: it can deliver and respond, never spend.
    limits: [{ token: protocol.token, limit: grant.role === 'seller' ? 0n : grant.limit, ...(period ? { period } : {}) }],
    scopes: agentScopes(grant.role, protocol.escrow, protocol.token),
    ...(grant.witness ? { witness: grant.witness } : {}),
    feePayer: true,
  } as never);
  await waitFor(owner, hash);
  return hash;
}

export async function revokeAgent(owner: OwnerSession, keyId: Address): Promise<Hex> {
  const hash = await Actions.accessKey.revoke(owner.client as never, { accessKey: keyId, feePayer: true } as never);
  await waitFor(owner, hash);
  return hash;
}

export async function setBudget(owner: OwnerSession, protocol: Protocol, keyId: Address, limit: bigint): Promise<Hex> {
  const hash = await Actions.accessKey.updateLimit(owner.client as never, { accessKey: keyId, token: protocol.token, limit, feePayer: true } as never);
  await waitFor(owner, hash);
  return hash;
}

async function waitFor(owner: OwnerSession, hash: Hex): Promise<void> {
  // Expiring nonces make viem's replacement detection unreliable on Tempo; wait
  // for this hash and nothing else.
  const receipt = await (owner.client as never as { waitForTransactionReceipt: (p: unknown) => Promise<{ status: string }> }).waitForTransactionReceipt({
    hash,
    checkReplacement: false,
  });
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
}

/// A key made in this tab for an agent the owner runs itself. Shown once and
/// handed over as environment variables; this page keeps no copy.
export function newAgentKey(): { privateKey: Hex; publicKey: Hex; keyId: Address } {
  const privateKey = P256.randomPrivateKey();
  const publicKey = PublicKey.toHex(P256.getPublicKey({ privateKey }));
  return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
}
