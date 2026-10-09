// The parts of agent wallets that must not be wrong: who may ask for a key, what
// a key may call, what proves an owner said yes, and how the key rests on disk.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { P256, PublicKey } from 'ox';
import { encodeAbiParameters, encodeEventTopics, getAbiItem, getAddress, toFunctionSelector, type Address, type Hex } from 'viem';

import {
  KEYCHAIN_ADDRESS,
  agentCalls,
  agentScopes,
  keyIdOf,
  keychainEventsAbi,
  pairingProblems,
  provesPairing,
  signPairingRequest,
  tempexEscrowAbi,
  type PairingRequest,
} from '@tempex/sdk';

import { createAgent, loadAgent, seal, unseal } from '../src/keystore.js';

const ESCROW = getAddress('0xe3E3Dece68B7D8AD3dc8638B38bf546FF594268a');
const TOKEN = getAddress('0x20C0000000000000000000000000000000000001');
const CONTEXT = { chainId: 42431, escrow: ESCROW };

function keypair() {
  const privateKey = P256.randomPrivateKey();
  const publicKey = PublicKey.toHex(P256.getPublicKey({ privateKey }));
  return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
}

function request(key = keypair(), overrides: Partial<PairingRequest> = {}): { key: ReturnType<typeof keypair>; request: PairingRequest } {
  return {
    key,
    request: {
      version: 1,
      chainId: 42431,
      escrow: ESCROW,
      keyId: key.keyId,
      publicKey: key.publicKey,
      name: 'translator-bot',
      role: 'buyer',
      limit: '100000000',
      period: 604_800,
      days: 30,
      witness: `0x${'ab'.repeat(32)}`,
      issuedAt: Math.floor(Date.now() / 1000),
      ...overrides,
    },
  };
}

describe('pairing requests', () => {
  it('accept a request signed by the key it names', () => {
    const { key, request: r } = request();
    assert.deepEqual(pairingProblems(signPairingRequest(r, key.privateKey), CONTEXT), []);
  });

  it('refuse a request signed by another key', () => {
    const { request: r } = request();
    const signed = signPairingRequest(r, keypair().privateKey);
    assert.match(pairingProblems(signed, CONTEXT).join(), /signature does not verify/);
  });

  it('refuse a request altered after signing', () => {
    const { key, request: r } = request();
    const signed = signPairingRequest(r, key.privateKey);
    signed.request = { ...signed.request, limit: '9000000000' };
    assert.match(pairingProblems(signed, CONTEXT).join(), /signature does not verify/);
  });

  it('refuse a key id that is not the public key\'s', () => {
    const { key, request: r } = request(keypair(), {});
    const signed = signPairingRequest({ ...r, keyId: keypair().keyId }, key.privateKey);
    assert.match(pairingProblems(signed, CONTEXT).join(), /keyId is not the address/);
  });

  it('refuse other chains, other escrows, stale requests and oversized budgets', () => {
    const cases: [Partial<PairingRequest>, RegExp][] = [
      [{ chainId: 1 }, /chain/],
      [{ escrow: TOKEN }, /different escrow/],
      [{ issuedAt: Math.floor(Date.now() / 1000) - 3600 }, /stale/],
      [{ limit: '99999999999999' }, /limit/],
      [{ role: 'seller' }, /seller key moves no money/],
      [{ name: '<script>' }, /name/],
      [{ days: 365 }, /days/],
      [{ period: 42 }, /period/],
    ];
    for (const [overrides, pattern] of cases) {
      const { key, request: r } = request(keypair(), overrides);
      assert.match(pairingProblems(signPairingRequest(r, key.privateKey), CONTEXT).join(), pattern, JSON.stringify(overrides));
    }
  });
});

describe('scopes', () => {
  it('give a buyer the escrow\'s buyer calls and approve with the escrow as the only spender', () => {
    const scopes = agentScopes('buyer', ESCROW, TOKEN);
    const approve = scopes.filter((scope) => scope.address === TOKEN);
    assert.equal(approve.length, 1);
    assert.equal(approve[0]!.selector, '0x095ea7b3');
    assert.deepEqual(approve[0]!.recipients, [ESCROW]);
    const selectors = new Set(scopes.filter((s) => s.address === ESCROW).map((s) => s.selector));
    for (const name of ['createJob', 'fund', 'dispute', 'withdraw']) {
      assert.ok(selectors.has(toFunctionSelector(getAbiItem({ abi: tempexEscrowAbi, name: name as never }) as never)), name);
    }
    assert.ok(!agentCalls('buyer').includes('deliver'));
  });

  it('give a seller no token call at all', () => {
    const scopes = agentScopes('seller', ESCROW, TOKEN);
    assert.ok(scopes.every((scope) => scope.address === ESCROW));
    assert.ok(agentCalls('seller').includes('respond'));
    assert.ok(!agentCalls('seller').includes('createJob'));
  });

  it('never include an upgrade or admin call', () => {
    for (const forbidden of ['upgradeToAndCall', 'transferOwnership', 'setFees', 'setNewJobsPaused', 'resolve']) {
      assert.ok(!agentCalls('both').includes(forbidden), forbidden);
    }
  });
});

describe('proof of an owner\'s approval', () => {
  const owner = getAddress('0x4e80bbc179Ce06E4911081F75f150656862FD943');
  const keyId = keypair().keyId;
  const witness: Hex = `0x${'cd'.repeat(32)}`;
  const log = (name: string, args: Record<string, unknown>, data: Hex = '0x') => ({
    address: KEYCHAIN_ADDRESS,
    topics: encodeEventTopics({ abi: keychainEventsAbi, eventName: name as never, args: args as never }) as Hex[],
    data,
  });
  const authorized = (account: Address, key: Address) =>
    log('KeyAuthorized', { account, publicKey: key }, encodeAbiParameters([{ type: 'uint8' }, { type: 'uint64' }], [1, 1_800_000_000n]));

  it('names the owner when one transaction authorized the key and bound the witness', () => {
    assert.equal(provesPairing([authorized(owner, keyId), log('KeyAuthorizationWitness', { account: owner, witness })], { keyId, witness }), owner);
  });

  it('refuses a different witness, a different key, or a witness bound by someone else', () => {
    const other = getAddress('0x000000000000000000000000000000000000dEaD');
    assert.equal(provesPairing([authorized(owner, keyId), log('KeyAuthorizationWitness', { account: owner, witness: `0x${'ef'.repeat(32)}` })], { keyId, witness }), null);
    assert.equal(provesPairing([authorized(owner, keypair().keyId), log('KeyAuthorizationWitness', { account: owner, witness })], { keyId, witness }), null);
    assert.equal(provesPairing([authorized(owner, keyId), log('KeyAuthorizationWitness', { account: other, witness })], { keyId, witness }), null);
  });

  it('ignores look-alike events from other contracts', () => {
    const fake = { ...authorized(owner, keyId), address: '0x0000000000000000000000000000000000000001' };
    assert.equal(provesPairing([fake, log('KeyAuthorizationWitness', { account: owner, witness })], { keyId, witness }), null);
  });
});

describe('the key on disk', () => {
  it('is written owner-only and loads back to the same key', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agent-')), 'agent.json');
    const created = createAgent({ name: 'a', role: 'buyer', file });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const loaded = loadAgent({ file });
    assert.equal(loaded.keyId, created.keyId);
    assert.equal(loaded.privateKey, created.privateKey);
  });

  it('is sealed under a passphrase, and refuses a wrong one', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agent-')), 'agent.json');
    const created = createAgent({ name: 'a', role: 'buyer', file, passphrase: 'correct horse' });
    assert.ok(!readFileSync(file, 'utf8').includes(created.privateKey.slice(2)), 'the private key is not on disk in the clear');
    assert.equal(loadAgent({ file, passphrase: 'correct horse' }).privateKey, created.privateKey);
    assert.throws(() => loadAgent({ file, passphrase: 'wrong' }), /wrong passphrase/);
    const sealed = seal(created.privateKey, 'p');
    assert.equal(unseal(sealed, 'p'), created.privateKey);
  });

  it('refuses a file other users can read, and one whose key does not match its id', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agent-')), 'agent.json');
    createAgent({ name: 'a', role: 'buyer', file });
    chmodSync(file, 0o644);
    assert.throws(() => loadAgent({ file }), /readable by other users/);
    chmodSync(file, 0o600);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...stored, keyId: keypair().keyId }), { mode: 0o600 });
    assert.throws(() => loadAgent({ file }), /inconsistent/);
  });

  it('refuses to overwrite an existing agent without --force', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agent-')), 'agent.json');
    createAgent({ name: 'a', role: 'buyer', file });
    assert.throws(() => createAgent({ name: 'b', role: 'buyer', file }), /already holds an agent key/);
  });
});
