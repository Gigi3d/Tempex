import { randomBytes } from 'node:crypto';

import { getAddress, type Address, type Hex } from 'viem';
import { Actions } from 'viem/tempo';

import {
  AGENT_PERIODS,
  CHAIN_ID,
  provesPairing,
  signPairingRequest,
  tokenAmount,
  type AgentPeriod,
  type PairingRequest,
} from '@tempex/sdk';

import { readerClient } from './client.js';
import type { Agent } from './keystore.js';

export type PairingTicket = { code: string; approveUrl: string; expiresAt: string; request: PairingRequest };
export type PairingState = {
  code: string;
  status: 'pending' | 'approved' | 'expired';
  approval?: { owner: Address; tx: Hex };
};

/// Step 1: ask. The request carries only the public key, signed by the private
/// key it belongs to, and a fresh witness the owner's authorization must bind.
export async function requestPairing(params: {
  agent: Agent;
  beacon: string;
  escrow: Address;
  limit: string;
  period: AgentPeriod;
  days: number;
}): Promise<PairingTicket> {
  const request: PairingRequest = {
    version: 1,
    chainId: CHAIN_ID,
    escrow: getAddress(params.escrow),
    keyId: params.agent.keyId,
    publicKey: params.agent.publicKey,
    name: params.agent.name,
    role: params.agent.role,
    limit: params.agent.role === 'seller' ? '0' : tokenAmount(params.limit).toString(),
    period: AGENT_PERIODS[params.period],
    days: params.days,
    witness: `0x${randomBytes(32).toString('hex')}`,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  const response = await fetch(`${params.beacon}/agents/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signPairingRequest(request, params.agent.privateKey)),
  });
  const body = (await response.json()) as PairingTicket & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `the beacon answered ${response.status}`);
  if (body.request.witness !== request.witness || body.request.keyId !== request.keyId) {
    throw new Error('the beacon echoed a different request than the one signed; refusing to continue');
  }
  return { ...body, request };
}

/// Step 2: wait for the owner. Polls until approved or expired.
export async function waitForApproval(params: {
  beacon: string;
  code: string;
  timeoutMs?: number;
  intervalMs?: number;
  onTick?: (state: PairingState) => void;
}): Promise<PairingState> {
  const deadline = Date.now() + (params.timeoutMs ?? 16 * 60 * 1000);
  for (;;) {
    const response = await fetch(`${params.beacon}/agents/pair/${encodeURIComponent(params.code)}`);
    const state = (await response.json()) as PairingState & { message?: string };
    if (!response.ok) throw new Error(state.message ?? `the beacon answered ${response.status}`);
    params.onTick?.(state);
    if (state.status !== 'pending') return state;
    if (Date.now() > deadline) throw new Error('timed out waiting for the owner to approve');
    await new Promise((resolve) => setTimeout(resolve, params.intervalMs ?? 3_000));
  }
}

/// Step 3: trust nothing the beacon said. Read the authorization transaction and
/// the keychain directly: the owner must have authorized this key under this
/// request's witness, and the key must be live.
export async function verifyApproval(params: {
  agent: Agent;
  request: Pick<PairingRequest, 'keyId' | 'witness'>;
  tx: Hex;
}): Promise<{ owner: Address; expiry: number; spendPolicy: string }> {
  const reader = readerClient();
  const receipt = await reader.getTransactionReceipt({ hash: params.tx });
  if (receipt.status !== 'success') throw new Error('the authorization transaction reverted');
  const owner = provesPairing(receipt.logs as never, params.request);
  if (!owner) throw new Error('that transaction did not authorize this key under this pairing; refusing to use it');
  const meta = await Actions.accessKey.getMetadata(reader, { account: owner, accessKey: params.agent.keyId } as never);
  if (meta.isRevoked) throw new Error('the owner has already revoked this key');
  return { owner, expiry: Number(meta.expiry), spendPolicy: meta.spendPolicy };
}
