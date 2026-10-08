// The agent desk relays and verifies; it must never record an approval the chain
// does not prove, and must not be a free-for-all for whoever floods it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { P256, PublicKey } from 'ox';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from 'viem';

import { KEYCHAIN_ADDRESS, keyIdOf, keychainEventsAbi, signPairingRequest, type PairingRequest } from '@tempex/sdk';

import { AgentDesk } from '../src/agents.js';
import type { ChainReader } from '../src/chain.js';

const ESCROW = getAddress('0xe3E3Dece68B7D8AD3dc8638B38bf546FF594268a');
const OWNER = getAddress('0x4e80bbc179Ce06E4911081F75f150656862FD943');
const TX = `0x${'11'.repeat(32)}` as Hex;

function signed(overrides: Partial<PairingRequest> = {}) {
  const privateKey = P256.randomPrivateKey();
  const publicKey = PublicKey.toHex(P256.getPublicKey({ privateKey }));
  const request: PairingRequest = {
    version: 1, chainId: 42431, escrow: ESCROW, keyId: keyIdOf(publicKey), publicKey, name: 'bot', role: 'buyer',
    limit: '50000000', period: 604_800, days: 30, witness: `0x${'ab'.repeat(32)}`, issuedAt: Math.floor(Date.now() / 1000), ...overrides,
  };
  return signPairingRequest(request, privateKey);
}

function desk(receipt: unknown = null) {
  const dir = mkdtempSync(join(tmpdir(), 'desk-'));
  const reader = { getTransactionReceipt: async () => receipt } as unknown as ChainReader;
  return {
    file: join(dir, 'agents.json'),
    desk: new AgentDesk({ reader, chainId: 42431, escrow: ESCROW, token: ESCROW, fromBlock: 0n, chunkBlocks: 1000n, approveUrl: 'https://x/agents/pair', profilesFile: join(dir, 'agents.json') }),
  };
}

const proof = (keyId: string, witness: Hex, status = 'success') => ({
  status,
  logs: [
    { address: KEYCHAIN_ADDRESS, topics: encodeEventTopics({ abi: keychainEventsAbi, eventName: 'KeyAuthorized', args: { account: OWNER, publicKey: keyId as Hex } }), data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint64' }], [1, 1_800_000_000n]) },
    { address: KEYCHAIN_ADDRESS, topics: encodeEventTopics({ abi: keychainEventsAbi, eventName: 'KeyAuthorizationWitness', args: { account: OWNER, witness } }), data: '0x' },
  ],
});

describe('agent desk', () => {
  it('issues a code and an approval link for a valid request, and refuses an invalid one', () => {
    const { desk: d } = desk();
    const ticket = d.request(signed(), '1.1.1.1');
    assert.match(ticket.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(ticket.approveUrl, `https://x/agents/pair/${ticket.code}`);
    assert.equal(d.get(ticket.code.toLowerCase()).status, 'pending', 'codes are case-insensitive');
    const bad = signed();
    bad.request.limit = '1';
    assert.throws(() => d.request(bad, '1.1.1.1'), /signature does not verify/);
  });

  it('refuses a second request for a key already waiting', () => {
    const { desk: d } = desk();
    const s = signed();
    d.request(s, '1.1.1.1');
    assert.throws(() => d.request(s, '1.1.1.2'), /already has a pairing in flight/);
  });

  it('rate-limits a flood from one address', () => {
    const { desk: d } = desk();
    for (let i = 0; i < 10; i += 1) d.request(signed(), '9.9.9.9');
    assert.throws(() => d.request(signed(), '9.9.9.9'), /too many pairing requests/);
    d.request(signed(), '8.8.8.8');
  });

  it('records an approval only when the transaction proves this key and this witness', async () => {
    const s = signed();
    const wrong = desk(proof(s.request.keyId, `0x${'cd'.repeat(32)}`));
    const t1 = wrong.desk.request(s, '1.1.1.1');
    await assert.rejects(wrong.desk.confirm(t1.code, { tx: TX }), /did not authorize this key under this pairing/);

    const reverted = desk(proof(s.request.keyId, s.request.witness, 'reverted'));
    const t2 = reverted.desk.request(s, '1.1.1.1');
    await assert.rejects(reverted.desk.confirm(t2.code, { tx: TX }), /reverted/);

    const good = desk(proof(s.request.keyId, s.request.witness));
    const t3 = good.desk.request(s, '1.1.1.1');
    const approved = await good.desk.confirm(t3.code, { tx: TX, limit: '999999999999' });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approval?.owner, OWNER);
    const profiles = JSON.parse(readFileSync(good.file, 'utf8'));
    assert.equal(profiles[s.request.keyId.toLowerCase()].limit, s.request.limit, 'a claimed grant above the request is ignored');
    assert.equal(statSync(good.file).mode & 0o777, 0o600);
  });

  it('refuses a malformed transaction hash and an unknown code', async () => {
    const { desk: d } = desk();
    const t = d.request(signed(), '1.1.1.1');
    await assert.rejects(d.confirm(t.code, { tx: 'nope' }), /transaction hash/);
    assert.throws(() => d.get('ZZZZ-ZZZZ'), /no such pairing/);
  });
});
