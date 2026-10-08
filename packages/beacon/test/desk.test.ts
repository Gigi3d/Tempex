// The document store files a document only under the hash it really has, and the
// inspector names the key that signed: these are what let a dashboard say "your
// agent did this" and show the papers behind a job without trusting anyone.
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { encodeFunctionData, getAddress, type Hex } from 'viem';

import { hashCanonical, hashText, tempexEscrowAbi } from '@tempex/sdk';

import { DocStore, shapeProblems } from '../src/docs.js';
import { TxInspector, activityOf, signerOf, stepsOf } from '../src/inspect.js';
import type { ChainReader } from '../src/chain.js';
import type { JobRecord } from '../src/ledger.js';

const ESCROW = getAddress('0xe3E3Dece68B7D8AD3dc8638B38bf546FF594268a');
const TOKEN = getAddress('0x20C0000000000000000000000000000000000001');
const OWNER = getAddress('0x0cb56973b78647f13e594810d519bcb432e3a33c');
const SELLER = getAddress('0x4e80bbc179Ce06E4911081F75f150656862FD943');
const KEY = getAddress('0x2319ac1555ded6238e5e863daaf13a5cbdae81fc');
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

const terms = {
  title: 'Translate the README',
  deliverableSpec: 'Spanish, Markdown',
  acceptanceCriteria: ['Every heading is translated'],
  amount: '12.5',
  buyer: OWNER,
  seller: SELLER,
};

describe('document store', () => {
  const store = () => new DocStore(join(mkdtempSync(join(tmpdir(), 'docs-')), 'docs'));

  it('files terms under their canonical hash, and only there', () => {
    const docs = store();
    const filed = docs.put({ kind: 'terms', doc: terms }, '1.1.1.1');
    assert.equal(filed.hash, hashCanonical(terms));
    assert.equal(filed.existed, false);
    assert.deepEqual(docs.get(filed.hash)?.doc, terms);
    // the same document again is the same filing
    assert.equal(docs.put({ kind: 'terms', doc: terms }, '1.1.1.1').existed, true);
  });

  it('files a deliverable under the hash a seller commits on chain', () => {
    const docs = store();
    const filed = docs.put({ kind: 'deliverable', doc: '# Hola' }, 'ip');
    assert.equal(filed.hash, hashText('# Hola'));
  });

  it('keeps files private to the beacon process', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'docs-')), 'docs');
    const docs = new DocStore(dir);
    const filed = docs.put({ kind: 'terms', doc: terms }, 'ip');
    assert.equal(statSync(join(dir, `${filed.hash.toLowerCase()}.json`)).mode & 0o077, 0);
  });

  it('refuses malformed documents and unknown kinds', () => {
    const docs = store();
    assert.throws(() => docs.put({ kind: 'invoice', doc: {} }, 'ip'), /kind/);
    assert.throws(() => docs.put({ kind: 'terms', doc: { ...terms, buyer: 'me' } }, 'ip'), /buyer/);
    assert.ok(shapeProblems('evidence', { version: 1, jobId: 3 }).length > 0);
    assert.ok(shapeProblems('response', { version: 1, jobId: 3, statement: 'done', disputeHash: tx(1), deliverable: { contentHash: tx(2) }, artifacts: [] }).length === 0);
  });

  it('answers a lookup of nothing with nothing, and a bad address with an error', () => {
    const docs = store();
    assert.equal(docs.get(tx(9)), null);
    assert.throws(() => docs.get('../../etc/passwd'), /32-byte hash/);
  });

  it('rate-limits new filings per address', () => {
    const docs = store();
    for (let i = 0; i < 40; i += 1) docs.put({ kind: 'deliverable', doc: `work ${i}` }, 'flood');
    assert.throws(() => docs.put({ kind: 'deliverable', doc: 'one more' }, 'flood'), /too many/);
    assert.doesNotThrow(() => docs.put({ kind: 'deliverable', doc: 'one more' }, 'someone else'));
  });
});

describe('signer attribution', () => {
  it('reads an access key from a keychain envelope', () => {
    const signer = signerOf({ from: OWNER, signature: { userAddress: OWNER, keyId: KEY, signature: { type: 'p256' } } });
    assert.deepEqual(signer, { account: OWNER, kind: 'access-key', keyId: KEY, signatureType: 'p256' });
  });

  it('treats any other envelope as the account itself', () => {
    assert.equal(signerOf({ from: OWNER, signature: { type: 'webAuthn' } }).kind, 'root');
    assert.equal(signerOf({ from: OWNER, signature: null }).keyId, null);
  });
});

describe('activity', () => {
  const job: JobRecord = {
    jobId: 5n, buyer: OWNER, seller: SELLER, amount: 1n, termsHash: tx(0), deliveryDeadline: 0, reviewWindow: 0, stage: 'accepted',
    created: { block: 10, tx: tx(1) },
    funded: { block: 10, tx: tx(1), amount: 1n },
    delivered: { block: 11, tx: tx(2), deliverableHash: tx(0), deliveredAt: 0, reviewDeadline: 0 },
    accepted: { block: 12, tx: tx(3), sellerAmount: 1n, platformFee: 0n },
  };

  it('lists every step a job took with its transaction', () => {
    assert.deepEqual(stepsOf(job).map((entry) => entry.step), ['created', 'funded', 'delivered', 'accepted']);
  });

  it('attributes each step to the key that signed it', async () => {
    const signed: Record<string, unknown> = {
      [tx(1)]: { from: OWNER, blockTimestamp: '0x10', signature: { userAddress: OWNER, keyId: KEY, signature: { type: 'p256' } }, calls: [{ to: ESCROW, input: encodeFunctionData({ abi: tempexEscrowAbi, functionName: 'fund', args: [5n] }) }] },
      [tx(2)]: { from: SELLER, blockTimestamp: '0x11', signature: { type: 'secp256k1' } },
      [tx(3)]: { from: OWNER, blockTimestamp: '0x12', signature: { type: 'webAuthn' } },
    };
    const reader = {
      request: async ({ method, params }: { method: string; params: string[] }) => {
        const hash = params[0]!;
        if (method === 'eth_getTransactionByHash') return signed[hash] ?? null;
        return { status: '0x1', blockNumber: '0xa', gasUsed: '0x1', feePayer: '0x0000000000000000000000000000000000000001', logs: [] };
      },
    } as unknown as ChainReader;
    const inspector = new TxInspector(reader, { escrow: ESCROW, token: TOKEN });

    const decoded = await inspector.inspect(tx(1));
    assert.equal(decoded.calls[0]?.function, 'fund');
    assert.deepEqual(decoded.calls[0]?.args, { jobId: '5' });
    assert.equal(decoded.sponsored, true);

    const activity = await activityOf(inspector, OWNER, [job], []);
    assert.equal(activity.count, 4, 'every step of the job shows, the seller\'s delivery included');
    assert.equal(activity.entries.find((entry) => entry.step === 'delivered')?.self, false);
    const mine = activity.entries.filter((entry) => entry.self);
    assert.deepEqual(mine.map((entry) => entry.step).sort(), ['accepted', 'created', 'funded']);
    assert.equal(activity.byKey[KEY], 2);
    assert.equal(activity.byKey['root'], 1);
  });
});
