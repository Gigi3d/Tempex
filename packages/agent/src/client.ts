import { type Address } from 'viem';
import { Account, Actions, createClient, http } from 'viem/tempo';
import { tempoTestnet } from 'viem/tempo/chains';

import { RPC_URL, SPONSOR_URL, TempexClient, type TempexAddresses } from '@tempex/sdk';

import type { Agent } from './keystore.js';

/// Read-only chain access, for verifying what the beacon says.
export function readerClient() {
  return createClient({ chain: tempoTestnet, transport: http(process.env['TEMPO_RPC_URL'] || RPC_URL) });
}

/// The agent's Tempo account: its own key, acting for its owner's account. Every
/// transaction it signs settles as the owner, inside the limits the owner set.
export function agentAccount(agent: Agent) {
  if (!agent.owner) throw new Error('this agent has no owner yet; run `tempex-agent pair`');
  return Account.fromP256(agent.privateKey, { access: agent.owner });
}

/// A Tempex client that signs as the agent, with fees paid by the sponsor.
export function agentTempex(agent: Agent, addresses: TempexAddresses, options: { sponsored?: boolean } = {}): TempexClient {
  return new TempexClient({
    account: agentAccount(agent) as never,
    addresses,
    ...(options.sponsored === false ? {} : { sponsorUrl: process.env['TEMPEX_SPONSOR_URL'] || SPONSOR_URL }),
  });
}

/// The agent's standing on chain: is its key live, and how much budget is left.
export async function agentStanding(agent: Agent, token: Address) {
  if (!agent.owner) return null;
  const reader = readerClient();
  const meta = await Actions.accessKey.getMetadata(reader, { account: agent.owner, accessKey: agent.keyId } as never);
  const limit =
    meta.spendPolicy === 'limited' && !meta.isRevoked
      ? await Actions.accessKey.getRemainingLimit(reader, { account: agent.owner, accessKey: agent.keyId, token } as never)
      : null;
  const expiry = Number(meta.expiry);
  return {
    revoked: meta.isRevoked,
    expiry,
    expired: expiry !== 0 && expiry < Date.now() / 1000,
    spendPolicy: meta.spendPolicy,
    remaining: limit?.remaining ?? null,
    periodEnd: limit?.periodEnd ? Number(limit.periodEnd) : null,
  };
}
