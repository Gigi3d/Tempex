import { analyze, withinOffers, type RuleAnalysis, type RuleBand } from '@tempex/arbiter/guardrail';
import { TempexClient } from '@tempex/sdk/client';
import {
  SPONSOR_URL,
  awardBounds,
  disputeHashOf,
  hashCanonical,
  hashText,
  responseHashOf,
  tokenAmount,
  type EvidenceBundle,
  type EvidenceCase,
  type Job,
  type JobTerms,
  type SellerResponse,
} from '@tempex/sdk/browser';
import { getAddress, type Address, type Hex } from 'viem';
import { Account, WebAuthnP256, WebCryptoP256 } from 'viem/tempo';

import { requestTestnetFunds } from './faucet';
import type { CorpusCase } from './snapshot';

/// The deal engine behind /play. Every write goes through the same TempexClient
/// the CLI uses, from keys that live only in this tab (or in the user's passkey),
/// with fees paid by Tempo's testnet sponsor.

export type Table = { escrow: Address; token: Address; arbiter: Address | null; court: boolean };

export type Seat = {
  role: 'buyer' | 'seller';
  /// 'passkey' signs with WebAuthn (Face ID, Touch ID, a security key); 'device'
  /// is a P-256 key held by WebCrypto in this tab and gone when it closes.
  kind: 'passkey' | 'device';
  client: TempexClient;
  address: Address;
};

const PASSKEY_STORE = 'tempex.play.pip.passkey';
const SESSION_STORE = 'tempex.play.session';
const write = { sponsored: true } as const;

/// The sponsor fills each transaction against its own node, which can trail the
/// block the last write landed in by a moment. A revert at fill time means
/// nothing was sent, so it is safe to wait and try again.
export async function settled<T>(action: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const message = (error as Error).message ?? '';
      const preSend = /Execution reverted|eth_fillTransaction|transaction expired/i.test(message) && !/transaction reverted: 0x/.test(message);
      if (!preSend || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_200 * attempt));
    }
  }
}

function clientFor(account: ConstructorParameters<typeof TempexClient>[0]['account'], table: Table): TempexClient {
  return new TempexClient({ account, addresses: { escrow: table.escrow, token: table.token }, sponsorUrl: SPONSOR_URL });
}

export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' && window.isSecureContext;
}

/// Pip's passkey: created once, then reused on this device. Only the credential
/// id and public key are stored; the private key never leaves the authenticator.
export async function passkeySeat(table: Table): Promise<Seat> {
  let stored: { id: string; publicKey: Hex } | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(PASSKEY_STORE) ?? 'null');
  } catch {
    stored = null;
  }
  if (!stored) {
    const credential = await WebAuthnP256.createCredential({ label: `Pip · Tempex buyer · ${new Date().toISOString().slice(0, 10)}` });
    stored = { id: credential.id, publicKey: credential.publicKey };
    try {
      localStorage.setItem(PASSKEY_STORE, JSON.stringify(stored));
    } catch {
      // Private windows refuse storage; the passkey still works for this visit.
    }
  }
  const account = Account.fromWebAuthnP256(stored);
  return { role: 'buyer', kind: 'passkey', client: clientFor(account, table), address: account.address };
}

export function forgetPasskey(): void {
  try {
    localStorage.removeItem(PASSKEY_STORE);
  } catch {
    // nothing stored
  }
}

export async function deviceSeat(role: Seat['role'], table: Table): Promise<Seat> {
  const keyPair = await WebCryptoP256.createKeyPair();
  const account = Account.fromWebCryptoP256(keyPair);
  return { role, kind: 'device', client: clientFor(account, table), address: account.address };
}

export async function balanceOf(seat: Seat): Promise<bigint> {
  return seat.client.tokenBalance();
}

/// Tempo's testnet faucet, then a wait until the balance shows it.
export async function fund(seat: Seat, need: bigint): Promise<bigint> {
  if ((await balanceOf(seat)) >= need) return balanceOf(seat);
  await requestTestnetFunds(seat.client, seat.address);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const balance = await balanceOf(seat);
    if (balance >= need) return balance;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('the faucet has not landed after 30 seconds; try again');
}

export function termsFor(scenario: CorpusCase, buyer: Address, seller: Address): JobTerms {
  return { ...(structuredClone(scenario.terms) as unknown as JobTerms), buyer, seller };
}

export function amountOf(scenario: CorpusCase): bigint {
  return tokenAmount(String(scenario.terms.amount ?? '0'));
}

function dataUri(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:text/plain;charset=utf-8;base64,${btoa(binary)}`;
}

/// A `?ref=0x…` link names who brought the deal; v3 escrows pay that referrer a
/// share of the protocol's fees on the job.
export function referrerFromUrl(): Address | null {
  if (typeof window === 'undefined') return null;
  const ref = new URLSearchParams(window.location.search).get('ref');
  // Normalized through the lowercase form, so a link with a mistyped checksum
  // still names the same address instead of failing at signing time.
  return ref && /^0x[0-9a-fA-F]{40}$/.test(ref) ? getAddress(ref.toLowerCase()) : null;
}

export async function openDeal(buyer: Seat, seller: Seat, scenario: CorpusCase, table: Table, referrer: Address | null = null) {
  const terms = termsFor(scenario, buyer.address, seller.address);
  const amount = amountOf(scenario);
  const approved = await settled(() => buyer.client.approveEscrow(amount, write));
  const now = Math.floor(Date.now() / 1000);
  const created = await settled(() => buyer.client.createAndFundJob(
    {
      seller: seller.address,
      amount,
      termsHash: hashCanonical(terms),
      deliveryDeadline: now + scenario.deliveryDeadlineSeconds,
      reviewWindow: scenario.reviewWindowSeconds,
      ...(table.arbiter ? { arbiter: table.arbiter } : {}),
      ...(referrer ? { referrer } : {}),
    },
    write,
  ));
  return { jobId: created.jobId, terms, approveHash: approved.transactionHash, hash: created.hash };
}

export async function deliver(seller: Seat, jobId: bigint, content: string) {
  const receipt = await settled(() => seller.client.deliver(jobId, hashText(content), dataUri(content), write));
  return { hash: receipt.transactionHash };
}

export async function accept(buyer: Seat, jobId: bigint) {
  const receipt = await settled(() => buyer.client.accept(jobId, write));
  return { hash: receipt.transactionHash };
}

export function bundleFor(input: { jobId: bigint; terms: JobTerms; content: string; claim: string; scenario: CorpusCase }): EvidenceBundle {
  return {
    version: 1,
    jobId: Number(input.jobId),
    termsHash: hashCanonical(input.terms),
    deliverableHash: hashText(input.content),
    claim: input.claim,
    deliverable: { content: input.content, contentHash: hashText(input.content) },
    artifacts: input.scenario.artifacts.map((entry) => ({ ...entry })) as EvidenceBundle['artifacts'],
    submittedAt: new Date().toISOString(),
  };
}

export async function dispute(buyer: Seat, jobId: bigint, evidenceCase: EvidenceCase, offerBps: number) {
  const disputeHash = disputeHashOf(evidenceCase);
  const receipt = await settled(() => buyer.client.dispute(jobId, disputeHash, offerBps, write));
  return { hash: receipt.transactionHash, disputeHash };
}

export function responseFor(input: { jobId: bigint; disputeHash: Hex; statement: string; content: string }): SellerResponse {
  return {
    version: 1,
    jobId: Number(input.jobId),
    disputeHash: input.disputeHash,
    statement: input.statement,
    deliverable: { content: input.content, contentHash: hashText(input.content) },
    artifacts: [],
    submittedAt: new Date().toISOString(),
  };
}

export async function respond(seller: Seat, jobId: bigint, response: SellerResponse, askBps: number) {
  const receipt = await settled(() => seller.client.respond(jobId, responseHashOf(response), askBps, write));
  return { hash: receipt.transactionHash };
}

export type Preview = { analysis: RuleAnalysis; offers: { lowBps: number; highBps: number }; effective: RuleBand; job: Job };

/// What the rule engine will say, computed here with the arbiter's own code
/// against the job as the chain holds it. The referee cannot sign outside this.
export async function preview(reader: Seat, jobId: bigint, evidenceCase: EvidenceCase, content: string): Promise<Preview> {
  const job = await reader.client.job(jobId);
  const uri = await reader.client.deliverableURI(jobId);
  const analysis = analyze({
    jobId: Number(jobId),
    job,
    terms: evidenceCase.terms,
    bundle: evidenceCase.bundle,
    ...(evidenceCase.response ? { response: evidenceCase.response } : {}),
    fetched: { uri, text: content },
  });
  const offers = awardBounds(job);
  return { analysis, offers, effective: withinOffers(analysis.band, offers), job };
}

export type Ruling = {
  jobId: string;
  engine: string;
  model: string;
  sellerAwardBps: number;
  rationale: string;
  band: RuleBand;
  boundedBand: RuleBand;
  clamped: boolean;
  money: { sellerAmount: string; buyerAmount: string; arbitrationFee: string; bond: string; bondToSeller: string };
  relay: { hash: string } | null;
};

export async function callReferee(jobId: bigint, evidenceCase: EvidenceCase): Promise<Ruling> {
  const response = await fetch(`/api/court/${jobId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(evidenceCase),
  });
  const body = (await response.json()) as Ruling & { error?: string; message?: string; reasons?: string[]; problems?: string[] };
  if (!response.ok) {
    const detail = body.reasons?.join('; ') ?? body.problems?.join('; ') ?? body.message ?? body.error;
    throw new Error(`the referee ${response.status === 409 && body.error === 'refused' ? 'refused to rule' : 'could not rule'}: ${detail}`);
  }
  return body;
}

export async function withdraw(seat: Seat): Promise<{ hash: string; amount: bigint } | null> {
  const credits = await seat.client.credits();
  if (credits === 0n) return null;
  const receipt = await settled(() => seat.client.withdraw(write));
  return { hash: receipt.transactionHash, amount: credits };
}

/// The evidence is the only thing a reload would lose that the chain does not
/// hold, so it is kept here until the referee has ruled.
export type SavedSession = { jobId: string; scenario: string; evidenceCase: EvidenceCase; content: string };

export function saveSession(session: SavedSession | null): void {
  try {
    if (session) localStorage.setItem(SESSION_STORE, JSON.stringify(session));
    else localStorage.removeItem(SESSION_STORE);
  } catch {
    // storage refused: the session just does not survive a reload
  }
}

export function loadSession(): SavedSession | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_STORE) ?? 'null');
  } catch {
    return null;
  }
}
