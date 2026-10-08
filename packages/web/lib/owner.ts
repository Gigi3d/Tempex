import { P256, PublicKey } from 'ox';
import { getAddress, type Address, type Hex } from 'viem';
import { Account, Actions, WebAuthnP256, WebCryptoP256, createClient, http, withFeePayer } from 'viem/tempo';
import { tempoTestnet } from 'viem/tempo/chains';

import { AGENT_PERIODS, RPC_URL, SPONSOR_URL, agentScopes, keyIdOf, type AgentPeriod, type AgentRole } from '@tempex/sdk/browser';
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
  return sessionFor(Account.fromWebAuthnP256(stored), 'passkey', protocol);
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
