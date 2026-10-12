'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getAddress, isAddress, type Address } from 'viem';

import { hashCanonical, tokenAmount, type Criterion, type CriterionCheck } from '@tempex/sdk/browser';

import * as desk from '@/lib/desk';
import { amount, pct, shortHash, txUrl } from '@/lib/format';
import type { Protocol } from '@/lib/owner';
import { decodeOffer, encodeOffer, type Offer } from '@/lib/offer';
import type { Reputation } from '@/lib/types';
import { CopyButton } from '../copy';

import { OwnerBar } from '../agents/owner-bar';
import { useOwner } from '../agents/use-owner';
import { JsonView } from '../json-view';
import { BusyLine } from './shared';

export type NewJobContext = {
  protocol: Protocol;
  platformFeeBps: number;
  house: { arbiter: Address; feeBps: number };
  listed: { arbiter: Address; feeBps: number; metadataURI: string | null; ruled: number }[];
  maxJobAmount: string | null;
  arbitrationFeeFloor: string | null;
  referralShareBps: number;
};

type CheckKind = 'unchecked' | 'contains' | 'count' | 'language';
type DraftCriterion = { text: string; kind: CheckKind; value: string; weight: number };

const DELIVERY = [
  { label: '1 hour', seconds: 3_600 },
  { label: '1 day', seconds: 86_400 },
  { label: '3 days', seconds: 3 * 86_400 },
  { label: '1 week', seconds: 7 * 86_400 },
  { label: '2 weeks', seconds: 14 * 86_400 },
];
const REVIEW = [
  { label: '1 hour', seconds: 3_600 },
  { label: '1 day', seconds: 86_400 },
  { label: '3 days', seconds: 3 * 86_400 },
  { label: '7 days', seconds: 7 * 86_400 },
];

function toCriterion(draft: DraftCriterion): Criterion | null {
  const text = draft.text.trim();
  if (!text) return null;
  const weight = draft.weight !== 1 ? { weight: draft.weight } : {};
  let check: CriterionCheck | null = null;
  if (draft.kind === 'contains') {
    const all = draft.value.split(',').map((part) => part.trim()).filter(Boolean);
    if (all.length) check = { type: 'contains', all };
  } else if (draft.kind === 'count') {
    const min = Number.parseInt(draft.value, 10);
    if (Number.isFinite(min) && min > 0) check = { type: 'count', unit: 'words', min };
  } else if (draft.kind === 'language') {
    if (/^[a-z]{2,3}$/.test(draft.value.trim())) check = { type: 'language', is: draft.value.trim() };
  }
  if (!check && draft.weight === 1) return text;
  return { text, ...weight, ...(check ? { check } : {}) };
}

/// Writing a job: who does the work, what counts as done, what it pays and how
/// long each side has. The terms are shown as the exact JSON that will be filed
/// and hashed, with the hash the escrow will hold, before anything is signed.
export function NewJob({ context, mode = 'job' }: { context: NewJobContext; mode?: 'job' | 'offer' }) {
  const o = useOwner(context.protocol);
  const offering = mode === 'offer';
  const [offerLink, setOfferLink] = useState<string | null>(null);
  const [fromOffer, setFromOffer] = useState<Offer | null>(null);
  const [seller, setSeller] = useState('');
  const [title, setTitle] = useState('');
  const [spec, setSpec] = useState('');
  const [criteria, setCriteria] = useState<DraftCriterion[]>([
    { text: '', kind: 'unchecked', value: '', weight: 1 },
  ]);
  const [price, setPrice] = useState('25');
  const [delivery, setDelivery] = useState(DELIVERY[2]!.seconds);
  const [review, setReview] = useState(REVIEW[1]!.seconds);
  const [arbiter, setArbiter] = useState<'house' | Address>('house');
  const [referrer, setReferrer] = useState('');
  const [reputation, setReputation] = useState<Reputation | null | 'none'>(null);
  const [opened, setOpened] = useState<{ jobId: bigint; hash: string; termsHash: string } | null>(null);

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get('ref');
    if (ref && /^0x[0-9a-fA-F]{40}$/.test(ref)) setReferrer(ref);
    const to = new URLSearchParams(window.location.search).get('seller');
    if (to && /^0x[0-9a-fA-F]{40}$/.test(to)) setSeller(to);
    // A seller's hire link: the form opens with its offer, still editable, and the
    // buyer's terms are what get filed and hashed.
    const offer = decodeOffer(new URLSearchParams(window.location.search).get('o'));
    if (offer && !offering) {
      setFromOffer(offer);
      setSeller(offer.seller);
      setTitle(offer.title);
      setSpec(offer.spec);
      setCriteria(offer.criteria);
      setPrice(offer.amount);
      setDelivery(offer.deliverySeconds);
      setReview(offer.reviewSeconds);
    }
  }, [offering]);

  // Offering: the seller is whoever is signed in.
  useEffect(() => {
    if (offering && o.session) setSeller(o.session.address);
  }, [offering, o.session]);

  useEffect(() => {
    setReputation(null);
    if (!isAddress(seller.trim(), { strict: false })) return;
    let live = true;
    void fetch(`/api/reputation/${seller.trim()}`, { cache: 'no-store' })
      .then(async (response) => (response.ok ? ((await response.json()) as Reputation) : 'none'))
      .then((value) => live && setReputation(value), () => live && setReputation('none'));
    return () => {
      live = false;
    };
  }, [seller]);

  const me = o.session?.address ?? null;
  const sellerAddress = isAddress(seller.trim(), { strict: false }) ? getAddress(seller.trim().toLowerCase()) : null;
  const units = /^\d+(\.\d{1,6})?$/.test(price) ? tokenAmount(price) : null;
  const cap = context.maxJobAmount ? BigInt(context.maxJobAmount) : null;
  const built = criteria.map(toCriterion).filter((criterion): criterion is Criterion => criterion !== null);
  const referrerAddress = referrer && isAddress(referrer.trim(), { strict: false }) ? getAddress(referrer.trim().toLowerCase()) : null;

  const draft: desk.NewJob | null =
    sellerAddress && units && units > 0n
      ? {
          seller: sellerAddress,
          title,
          spec,
          criteria: built,
          amount: price,
          deliverySeconds: delivery,
          reviewSeconds: review,
          ...(arbiter !== 'house' ? { arbiter } : {}),
          ...(referrerAddress ? { referrer: referrerAddress } : {}),
        }
      : null;
  const terms = useMemo(() => (draft && me ? desk.termsOf(draft, me) : null), [draft, me]);
  const termsHash = useMemo(() => (terms ? hashCanonical(terms) : null), [terms]);

  const problems: string[] = [];
  if (offering && !me) problems.push('you to sign in, so buyers know whom they hire');
  else if (!sellerAddress) problems.push('a seller address');
  else if (!offering && me && sellerAddress.toLowerCase() === me.toLowerCase()) problems.push('a seller other than yourself');
  if (!title.trim()) problems.push('a title');
  if (!spec.trim()) problems.push('what to deliver');
  if (built.length === 0) problems.push('at least one acceptance criterion');
  if (!units || units === 0n) problems.push('an amount');
  else if (cap !== null && units > cap) problems.push(`an amount within the ${amount(cap)} αUSD launch cap`);
  if (referrer && !referrerAddress) problems.push('a valid referrer address (or none)');
  if (!offering && o.balance !== null && units && units > o.balance) problems.push(`more αUSD in your wallet (you have ${amount(o.balance)})`);

  const arbiterFee = arbiter === 'house' ? context.house.feeBps : (context.listed.find((entry) => entry.arbiter === arbiter)?.feeBps ?? context.house.feeBps);
  const platformFee = units ? (units * BigInt(context.platformFeeBps)) / 10_000n : 0n;

  if (offerLink) {
    return (
      <div className="flex flex-col gap-6">
        <section className="panel flex flex-col gap-5 border-ref-dim p-8" aria-live="polite">
          <p className="label text-ref">Your hire link</p>
          <h2 className="h2">Send this to whoever should hire you.</h2>
          <p className="max-w-[66ch] text-[15px] text-fg-2">
            It opens your offer with your record beside it. A buyer reviews it and funds the job with one passkey prompt; an agent gets the exact command to open it. Nothing is stored: the offer lives in the link.
          </p>
          <div className="panel-sunk flex items-center gap-4 px-4 py-3 font-mono text-[12.5px]">
            <span className="min-w-0 flex-1 truncate">{offerLink}</span>
            <CopyButton value={offerLink} label="Copy the hire link">
              <span className="btn px-3 py-1.5 text-[12px]">Copy</span>
            </CopyButton>
          </div>
          <div className="flex flex-wrap gap-3">
            <a className="btn btn-ref" href={offerLink} target="_blank" rel="noreferrer">
              Preview as a buyer ↗
            </a>
            <button type="button" className="btn" onClick={() => setOfferLink(null)}>
              Edit the offer
            </button>
            <Link className="btn" href="/dashboard">
              Dashboard
            </Link>
          </div>
        </section>
      </div>
    );
  }

  if (opened) {
    const link = `${typeof window === 'undefined' ? '' : window.location.origin}/dashboard/jobs/${opened.jobId}`;
    return (
      <div className="flex flex-col gap-6">
        <section className="panel flex flex-col gap-5 border-ref-dim p-8" aria-live="polite">
          <p className="label text-ref">Opened and funded</p>
          <h2 className="h2">Job #{opened.jobId.toString()} is live.</h2>
          <p className="max-w-[64ch] text-[15px] text-fg-2">
            {amount(units!)} αUSD is in escrow. The seller can read the terms and deliver from their own dashboard. Send them the link:
          </p>
          <div className="panel-sunk flex items-center justify-between gap-4 px-4 py-3 font-mono text-[13px]">
            <span className="truncate">{link}</span>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link className="btn btn-ref" href={`/dashboard/jobs/${opened.jobId}`}>
              Open the job
            </Link>
            <Link className="btn" href="/dashboard">
              Dashboard
            </Link>
            <a className="btn" href={txUrl(opened.hash)} target="_blank" rel="noreferrer">
              Transaction ↗
            </a>
          </div>
        </section>
        {terms ? <JsonView value={terms} label="terms as filed" depth={2} caption={shortHash(opened.termsHash, 10, 6)} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <OwnerBar owner={o} />
      <BusyLine busy={o.busy} error={o.error} />

      <form
        className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_420px]"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!draft || problems.length > 0 || !o.session) return;
          if (offering) {
            const offer: Offer = { v: 1, seller: o.session.address, title: title.trim(), spec: spec.trim(), criteria: criteria.filter((c) => c.text.trim()), amount: price, deliverySeconds: delivery, reviewSeconds: review };
            setOfferLink(`${window.location.origin}/hire/${o.session.address}?o=${encodeOffer(offer)}`);
            return;
          }
          const result = await o.run('Filing the terms, then approving, creating and funding with your passkey', () => desk.openJob(o.session!, draft));
          if (result) {
            setOpened({ jobId: result.jobId, hash: result.hash, termsHash: result.termsHash });
            await o.refreshBalance();
          }
        }}
      >
        <div className="flex min-w-0 flex-col gap-px border hairline bg-line">
          {offering ? (
            <Step n="01" title="You are the seller">
              <p className="text-[14px] text-fg-2">
                Buyers hire <span className="font-mono text-[13px] text-fg">{me ? shortHash(me, 10, 8) : 'your account, once you sign in'}</span>. They see your on-chain record beside the offer, and payment lands in your escrow credit when the work is accepted.
              </p>
            </Step>
          ) : (
          <Step n="01" title="Who does the work">
            {fromOffer ? (
              <p className="border border-ref-dim px-4 py-3 text-[13px] text-ref">From the seller&rsquo;s hire link. Everything below is theirs to start from and yours to change before you sign.</p>
            ) : null}
            <Field label="Seller address">
              <input value={seller} onChange={(event) => setSeller(event.target.value)} placeholder="0x…" spellCheck={false} className="panel-sunk px-4 py-3 font-mono text-[14px]" />
            </Field>
            {sellerAddress ? (
              <div className="panel-sunk flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-[13px]">
                {reputation === null ? (
                  <span className="label anim-pulse">Reading their record…</span>
                ) : reputation === 'none' ? (
                  <span className="text-fg-3">No record yet: this address has never settled a job here.</span>
                ) : (
                  <>
                    <span className="font-mono">
                      score <span className="text-ref">{reputation.score}</span> · {reputation.band}
                    </span>
                    <span className="text-fg-3">
                      {reputation.asSeller.jobs} jobs as seller · {reputation.asSeller.accepted} accepted · {reputation.asSeller.disputed} disputed
                    </span>
                    <Link className="link font-mono text-[12px]" href={`/reputation/${sellerAddress}`} target="_blank">
                      full record ↗
                    </Link>
                  </>
                )}
              </div>
            ) : null}
          </Step>
          )}

          <Step n="02" title="What counts as done">
            <Field label="Title">
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} placeholder="Translate the README into Spanish" className="panel-sunk px-4 py-3 text-[15px]" />
            </Field>
            <Field label="What to deliver">
              <textarea value={spec} onChange={(event) => setSpec(event.target.value)} rows={5} placeholder="The full spec: format, length, scope, anything the seller needs." className="panel-sunk px-4 py-3 text-[14px] leading-relaxed" />
            </Field>
            <div className="flex flex-col gap-2">
              <span className="label">Acceptance criteria</span>
              <p className="text-[12.5px] text-fg-3">A checked criterion is decided exactly by code; an unchecked one splits at the midpoint in a dispute, always inside both parties&rsquo; offers.</p>
              <ol className="flex flex-col gap-px border hairline bg-line">
                {criteria.map((criterion, index) => (
                  <li key={index} className="flex flex-col gap-3 bg-ink-2 p-3 md:flex-row md:items-center">
                    <span className="w-6 font-mono text-[11px] text-fg-3">c{index + 1}</span>
                    <input
                      value={criterion.text}
                      onChange={(event) => setCriteria(criteria.map((c, i) => (i === index ? { ...c, text: event.target.value } : c)))}
                      placeholder="Every heading is translated"
                      className="panel min-w-0 flex-1 px-3 py-2 text-[14px]"
                    />
                    <select
                      value={criterion.kind}
                      onChange={(event) => setCriteria(criteria.map((c, i) => (i === index ? { ...c, kind: event.target.value as CheckKind, value: '' } : c)))}
                      className="panel px-2 py-2 text-[13px]"
                      aria-label={`How c${index + 1} is decided`}
                    >
                      <option value="unchecked">unchecked</option>
                      <option value="contains">contains…</option>
                      <option value="count">at least N words</option>
                      <option value="language">in language…</option>
                    </select>
                    {criterion.kind !== 'unchecked' ? (
                      <input
                        value={criterion.value}
                        onChange={(event) => setCriteria(criteria.map((c, i) => (i === index ? { ...c, value: event.target.value } : c)))}
                        placeholder={criterion.kind === 'contains' ? 'word, phrase' : criterion.kind === 'count' ? '300' : 'es'}
                        className="panel w-full px-3 py-2 font-mono text-[13px] md:w-32"
                      />
                    ) : null}
                    <label className="flex items-center gap-1 font-mono text-[11px] text-fg-3" title="Relative weight in the score">
                      ×
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={criterion.weight}
                        onChange={(event) => setCriteria(criteria.map((c, i) => (i === index ? { ...c, weight: Math.max(1, Math.min(10, Number(event.target.value) || 1)) } : c)))}
                        className="panel w-12 px-2 py-2 text-[12px]"
                      />
                    </label>
                    <button type="button" className="font-mono text-[13px] text-fg-3 hover:text-fail" aria-label={`Remove c${index + 1}`} onClick={() => setCriteria(criteria.length > 1 ? criteria.filter((_, i) => i !== index) : criteria)}>
                      ✕
                    </button>
                  </li>
                ))}
              </ol>
              <button type="button" className="btn self-start px-3 py-1.5 text-[12.5px]" onClick={() => setCriteria([...criteria, { text: '', kind: 'unchecked', value: '', weight: 1 }])}>
                + Add criterion
              </button>
            </div>
          </Step>

          <Step n="03" title="Money and time">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Amount (αUSD)">
                <input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" className="panel-sunk px-4 py-3 font-mono text-[16px]" />
              </Field>
              <Field label="Deliver within">
                <select value={delivery} onChange={(event) => setDelivery(Number(event.target.value))} className="panel-sunk px-4 py-3 text-[14px]">
                  {DELIVERY.map((option) => (
                    <option key={option.seconds} value={option.seconds}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="You review within">
                <select value={review} onChange={(event) => setReview(Number(event.target.value))} className="panel-sunk px-4 py-3 text-[14px]">
                  {REVIEW.map((option) => (
                    <option key={option.seconds} value={option.seconds}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {cap !== null ? <p className="font-mono text-[11.5px] text-fg-3">launch cap: {amount(cap)} αUSD per job</p> : null}
          </Step>

          {offering ? null : (
          <Step n="04" title="Who rules if you disagree">
            <div className="flex flex-col gap-2" role="radiogroup" aria-label="Arbiter">
              <ArbiterOption checked={arbiter === 'house'} onSelect={() => setArbiter('house')} title="House arbiter" detail={`${pct(context.house.feeBps)} fee, charged only on a ruling`} address={context.house.arbiter} />
              {context.listed
                .filter((entry) => entry.arbiter.toLowerCase() !== context.house.arbiter.toLowerCase())
                .map((entry) => (
                  <ArbiterOption key={entry.arbiter} checked={arbiter === entry.arbiter} onSelect={() => setArbiter(entry.arbiter)} title={entry.metadataURI ?? 'Listed arbiter'} detail={`${pct(entry.feeBps)} fee · ${entry.ruled} rulings`} address={entry.arbiter} />
                ))}
            </div>
            <Field label="Referrer (optional)">
              <input value={referrer} onChange={(event) => setReferrer(event.target.value)} placeholder="0x… who brought you this deal" spellCheck={false} className="panel-sunk px-4 py-3 font-mono text-[13px]" />
            </Field>
            {referrerAddress ? <p className="font-mono text-[11.5px] text-fg-3">earns {pct(context.referralShareBps)} of the protocol&rsquo;s fees on this job; costs you nothing extra</p> : null}
          </Step>
          )}
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-20">
          <section className="panel flex flex-col gap-4 p-5">
            <p className="label text-ref">{offering ? 'Your offer' : 'Summary'}</p>
            <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-[14px]">
              <dt className="text-fg-2">{offering ? 'Your price' : 'Escrowed now'}</dt>
              <dd className="font-mono num">{units ? amount(units) : '—'}</dd>
              <dt className="text-fg-2">Platform fee, on accept</dt>
              <dd className="font-mono num text-fg-3">{pct(context.platformFeeBps)} · {amount(platformFee)}</dd>
              <dt className="text-fg-2">Arbitration, only if ruled</dt>
              <dd className="font-mono num text-fg-3">
                {pct(arbiterFee)}
                {context.arbitrationFeeFloor && context.arbitrationFeeFloor !== '0' ? `, min ${amount(context.arbitrationFeeFloor)}` : ''}
              </dd>
              <dt className="text-fg-2">Network fee</dt>
              <dd className="font-mono text-ref">sponsored</dd>
            </dl>
            <p className="border-t hairline pt-3 text-[12.5px] leading-relaxed text-fg-3">
              {offering
                ? 'Nothing is signed or stored. The link carries the offer; the buyer files the terms and funds the job when they hire you.'
                : `One passkey prompt approves ${units ? amount(units) : 'the amount'} αUSD to the escrow, creates the job and funds it, in a single Tempo transaction. All three land or none do.`}
            </p>
            {problems.length > 0 ? (
              <p className="text-[12.5px] text-pip">Still needs {problems.join(', ')}.</p>
            ) : null}
            <button type="submit" className="btn btn-ref justify-center" disabled={!o.session || problems.length > 0 || !!o.busy}>
              {offering ? 'Create hire link' : o.session ? 'Open and fund with passkey' : 'Sign in to open a job'}
            </button>
          </section>
          {terms ? (
            <JsonView value={terms} label={offering ? 'terms a buyer will file' : 'terms to be filed'} depth={2} caption={termsHash ? `hash ${shortHash(termsHash, 8, 6)}` : undefined} />
          ) : (
            <div className="panel-sunk p-5 text-[13px] text-fg-3">The exact terms JSON, and the hash the escrow will hold, appear here as you fill the form.</div>
          )}
          <p className="text-[11.5px] leading-relaxed text-fg-3">
            Terms are filed in the beacon&rsquo;s public document store, so the seller and the arbiter can read them. Anyone who knows the job&rsquo;s terms hash, which is on chain, can read them too. Leave secrets out.
          </p>
        </aside>
      </form>
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-5 bg-panel p-6">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[12px] text-ref">{n}</span>
        <h2 className="text-[19px]">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function ArbiterOption({ checked, onSelect, title, detail, address }: { checked: boolean; onSelect: () => void; title: string; detail: string; address: string }) {
  return (
    <button type="button" role="radio" aria-checked={checked} onClick={onSelect} className={`flex items-center gap-4 border px-4 py-3 text-left transition-colors ${checked ? 'border-ref-dim bg-[rgb(75_227_166/0.05)]' : 'border-line bg-ink-2 hover:border-line-2'}`}>
      <span className={`grid h-4 w-4 place-items-center border ${checked ? 'border-ref' : 'border-line-2'}`} aria-hidden>
        {checked ? <span className="h-2 w-2 bg-ref" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px]">{title}</span>
        <span className="font-mono text-[11.5px] text-fg-3">
          {detail} · {shortHash(address)}
        </span>
      </span>
    </button>
  );
}
