'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { disputeBond, disputeHashOf, type EvidenceCase, type JobTerms } from '@tempex/sdk/browser';

import { amount, pct, shortHash, txUrl } from '@/lib/format';
import * as play from '@/lib/play';
import type { CorpusCase } from '@/lib/snapshot';

import { Bolt, Pip, Ref } from './characters';
import { RulingGauge } from './gauge';
import { CriterionScorecard } from './scorecard';

type Stage = 'seat' | 'fund' | 'open' | 'deliver' | 'decide' | 'respond' | 'rule' | 'settled';
const ORDER: Stage[] = ['seat', 'fund', 'open', 'deliver', 'decide', 'respond', 'rule', 'settled'];
type Entry = { who: 'pip' | 'bolt' | 'ref' | 'tempo'; text: string; hash?: string };

const WHO_TONE: Record<Entry['who'], string> = { pip: 'text-pip', bolt: 'text-bolt', ref: 'text-ref', tempo: 'text-fg-3' };
const WHO_NAME: Record<Entry['who'], string> = { pip: 'PIP', bolt: 'BOLT', ref: 'REF', tempo: 'TEMPO' };

export function PlayTable({ table, scenarios }: { table: play.Table; scenarios: CorpusCase[] }) {
  // A link can pick the case (?scenario=echo) and name a referrer (?ref=0x…).
  const [scenarioId, setScenarioId] = useState(() => {
    const wanted = new URLSearchParams(window.location.search).get('scenario');
    return scenarios.find((entry) => entry.id === wanted)?.id ?? scenarios[0]!.id;
  });
  const [referrer] = useState(play.referrerFromUrl);
  const scenario = scenarios.find((entry) => entry.id === scenarioId)!;
  const [stage, setStage] = useState<Stage>('seat');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<Entry[]>([]);

  const [buyer, setBuyer] = useState<play.Seat | null>(null);
  const [seller, setSeller] = useState<play.Seat | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);

  const [jobId, setJobId] = useState<bigint | null>(null);
  const [terms, setTerms] = useState<JobTerms | null>(null);
  const [claim, setClaim] = useState(scenario.claim);
  const [offer, setOffer] = useState(scenario.offers.buyerOfferBps ?? 0);
  const [statement, setStatement] = useState(scenario.sellerStatement ?? 'The attached deliverable is the work committed on chain at delivery; it is submitted as delivered.');
  const [ask, setAsk] = useState(scenario.offers.sellerAskBps ?? 10_000);
  const [evidenceCase, setEvidenceCase] = useState<EvidenceCase | null>(null);
  const [preview, setPreview] = useState<play.Preview | null>(null);
  const [ruling, setRuling] = useState<play.Ruling | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [paid, setPaid] = useState<{ pip?: string; bolt?: string }>({});
  const [resumable, setResumable] = useState<play.SavedSession | null>(null);
  const autoRef = useRef(false);
  const ledgerRef = useRef<HTMLOListElement>(null);

  const content = scenario.deliverable ?? '';
  const escrowed = play.amountOf(scenario);
  const need = escrowed + disputeBond(escrowed);
  const index = ORDER.indexOf(stage);

  useEffect(() => {
    setClaim(scenario.claim);
    setOffer(scenario.offers.buyerOfferBps ?? 0);
    setAsk(scenario.offers.sellerAskBps ?? 10_000);
    setStatement(scenario.sellerStatement ?? 'The attached deliverable is the work committed on chain at delivery; it is submitted as delivered.');
  }, [scenario]);

  useEffect(() => {
    const saved = play.loadSession();
    if (saved && table.court) setResumable(saved);
  }, [table.court]);

  useEffect(() => {
    ledgerRef.current?.scrollTo({ top: ledgerRef.current.scrollHeight, behavior: 'smooth' });
  }, [log]);

  const note = useCallback((entry: Entry) => setLog((rows) => [...rows, entry]), []);

  /// Every action runs through here: one busy flag, one error line, no double sends.
  const run = useCallback(
    async <T,>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
      setBusy(label);
      setError(null);
      try {
        return await action();
      } catch (caught) {
        const message = (caught as Error).message ?? String(caught);
        setError(message.split('\n')[0]!.slice(0, 400));
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // ------------------------------------------------------------------ steps

  const seat = (usePasskey: boolean) =>
    run('Seating the parties', async () => {
      const pip = usePasskey ? await play.passkeySeat(table) : await play.deviceSeat('buyer', table);
      const bolt = await play.deviceSeat('seller', table);
      setBuyer(pip);
      setSeller(bolt);
      note({ who: 'pip', text: `seated with a ${pip.kind === 'passkey' ? 'passkey' : 'key held in this tab'} · ${shortHash(pip.address)}` });
      note({ who: 'bolt', text: `seated with a key held in this tab · ${shortHash(bolt.address)}` });
      setBalance(await play.balanceOf(pip));
      setStage('fund');
      return { pip, bolt };
    });

  const fund = (pip = buyer) =>
    run('Asking the faucet', async () => {
      const value = await play.fund(pip!, need);
      setBalance(value);
      note({ who: 'tempo', text: `faucet funded Pip · ${amount(value)} αUSD` });
      setStage('open');
      return value;
    });

  const open = (pip = buyer, bolt = seller) =>
    run('Opening the deal', async () => {
      const opened = await play.openDeal(pip!, bolt!, scenario, table, referrer);
      setJobId(opened.jobId);
      setTerms(opened.terms);
      note({ who: 'pip', text: 'approved the escrow', hash: opened.approveHash });
      note({
        who: 'pip',
        text: `opened job ${opened.jobId} and escrowed ${amount(escrowed)} αUSD in one transaction${referrer ? `, referred by ${shortHash(referrer)}` : ''}`,
        hash: opened.hash,
      });
      setBalance(await play.balanceOf(pip!));
      setStage('deliver');
      return opened;
    });

  const deliver = (bolt = seller, id = jobId) =>
    run('Bolt is delivering', async () => {
      const sent = await play.deliver(bolt!, id!, content);
      note({ who: 'bolt', text: 'delivered the work, committed by hash, readable in the delivery itself', hash: sent.hash });
      setStage('decide');
      return sent;
    });

  const accept = () =>
    run('Pip accepts', async () => {
      const sent = await play.accept(buyer!, jobId!);
      note({ who: 'pip', text: 'accepted the delivery. Bolt is paid in full.', hash: sent.hash });
      setAccepted(true);
      setStage('settled');
      return sent;
    });

  const dispute = (pip = buyer, id = jobId, t = terms) =>
    run('Pip disputes', async () => {
      const bundle = play.bundleFor({ jobId: id!, terms: t!, content, claim, scenario });
      const draft: EvidenceCase = { terms: t!, bundle };
      const sent = await play.dispute(pip!, id!, draft, offer);
      setEvidenceCase(draft);
      note({ who: 'pip', text: `disputed with a final offer of ${pct(offer)} and a ${amount(disputeBond(escrowed))} αUSD bond; evidence pinned ${shortHash(sent.disputeHash)}`, hash: sent.hash });
      setStage('respond');
      return { draft, disputeHash: sent.disputeHash };
    });

  const respond = (bolt = seller, id = jobId, draft = evidenceCase) =>
    run('Bolt answers', async () => {
      const response = play.responseFor({ jobId: id!, disputeHash: disputeHashOf(draft!), statement, content });
      const sent = await play.respond(bolt!, id!, response, ask);
      const full: EvidenceCase = { ...draft!, response };
      setEvidenceCase(full);
      play.saveSession({ jobId: String(id), scenario: scenario.id, evidenceCase: full, content });
      note({ who: 'bolt', text: `answered with a final ask of ${pct(ask)}. Evidence is closed.`, hash: sent.hash });
      const seen = await play.preview(bolt!, id!, full, content);
      setPreview(seen);
      note({ who: 'ref', text: `checked the work in your browser: the evidence supports ${pct(seen.analysis.band.lowBps)}–${pct(seen.analysis.band.highBps)}; the offers narrow it to ${pct(seen.effective.lowBps)}–${pct(seen.effective.highBps)}` });
      setStage('rule');
      return full;
    });

  const rule = (id = jobId, full = evidenceCase) =>
    run('The referee is ruling', async () => {
      const result = await play.callReferee(id!, full!);
      setRuling(result);
      play.saveSession(null);
      setResumable(null);
      note({ who: 'ref', text: `ruled ${pct(result.sellerAwardBps)} to Bolt and settled on Tempo`, ...(result.relay ? { hash: result.relay.hash } : {}) });
      setStage('settled');
      return result;
    });

  const collect = () =>
    run('Paying out', async () => {
      const out: { pip?: string; bolt?: string } = {};
      for (const [who, seatOf] of [['pip', buyer], ['bolt', seller]] as const) {
        if (!seatOf) continue;
        const sent = await play.withdraw(seatOf);
        if (sent) {
          out[who] = sent.hash;
          note({ who, text: `withdrew ${amount(sent.amount)} αUSD to its own wallet`, hash: sent.hash });
        }
      }
      setPaid(out);
      if (buyer) setBalance(await play.balanceOf(buyer));
      return out;
    });

  const resume = (saved: play.SavedSession) =>
    run('The referee is ruling', async () => {
      setScenarioId(saved.scenario);
      setJobId(BigInt(saved.jobId));
      setEvidenceCase(saved.evidenceCase);
      const result = await play.callReferee(BigInt(saved.jobId), saved.evidenceCase);
      setRuling(result);
      play.saveSession(null);
      setResumable(null);
      note({ who: 'ref', text: `ruled job ${saved.jobId}: ${pct(result.sellerAwardBps)} to Bolt`, ...(result.relay ? { hash: result.relay.hash } : {}) });
      setStage('settled');
      return result;
    });

  /// The whole deal with the scenario's own offers, one step after another.
  const autoplay = async (usePasskey: boolean) => {
    if (autoRef.current) return;
    autoRef.current = true;
    try {
      const seats = await seat(usePasskey);
      if (!seats) return;
      if ((await fund(seats.pip)) === undefined) return;
      const opened = await open(seats.pip, seats.bolt);
      if (!opened) return;
      if (!(await deliver(seats.bolt, opened.jobId))) return;
      const disputed = await dispute(seats.pip, opened.jobId, opened.terms);
      if (!disputed) return;
      const full = await respond(seats.bolt, opened.jobId, disputed.draft);
      if (!full || !table.court) return;
      await rule(opened.jobId, full);
    } finally {
      autoRef.current = false;
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auto') === '1') void autoplay(params.get('keys') !== 'device' && play.passkeysAvailable());
    // Autoplay runs once, on arrival, when the link asks for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    setStage('seat');
    setLog([]);
    setJobId(null);
    setTerms(null);
    setEvidenceCase(null);
    setPreview(null);
    setRuling(null);
    setAccepted(false);
    setPaid({});
    setError(null);
  };

  const pipMood = ruling ? (ruling.sellerAwardBps < 5000 ? 'happy' : 'calm') : stage === 'respond' || stage === 'rule' ? 'worried' : accepted ? 'beaming' : 'happy';
  const boltMood = ruling ? (ruling.sellerAwardBps >= 5000 ? 'beaming' : 'calm') : stage === 'respond' ? 'listening' : accepted ? 'beaming' : 'happy';
  const refMood = busy === 'The referee is ruling' ? 'listening' : ruling ? 'wink' : 'calm';

  const steps = useMemo(
    () => [
      { id: 'seat' as const, n: '01', title: 'Take your seats', who: 'pip' as const },
      { id: 'fund' as const, n: '02', title: 'Fund Pip from the faucet', who: 'tempo' as const },
      { id: 'open' as const, n: '03', title: 'Open the deal', who: 'pip' as const },
      { id: 'deliver' as const, n: '04', title: 'Bolt delivers', who: 'bolt' as const },
      { id: 'decide' as const, n: '05', title: 'Pip accepts or disputes', who: 'pip' as const },
      { id: 'respond' as const, n: '06', title: 'Bolt answers', who: 'bolt' as const },
      { id: 'rule' as const, n: '07', title: 'Call the referee', who: 'ref' as const },
    ],
    [],
  );

  const body = (id: Stage): ReactNode => {
    switch (id) {
      case 'seat':
        return (
          <div className="flex flex-col gap-4">
            <p className="text-[14px] leading-relaxed text-fg-2">
              Pip buys, Bolt sells, and you play both. Pip signs with a passkey on this device. Bolt gets a key that lives in this tab and nowhere else. Tempo&rsquo;s testnet sponsor pays every fee, so neither needs gas.
            </p>
            <div className="flex flex-wrap gap-3">
              {play.passkeysAvailable() ? (
                <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void seat(true)}>
                  Create Pip&rsquo;s passkey
                </button>
              ) : null}
              <button type="button" className="btn" disabled={!!busy} onClick={() => void seat(false)}>
                {play.passkeysAvailable() ? 'Use keys in this tab instead' : 'Seat both with keys in this tab'}
              </button>
              <button type="button" className="btn btn-ref" disabled={!!busy} onClick={() => void autoplay(false)}>
                Play the whole deal ▸
              </button>
            </div>
          </div>
        );
      case 'fund':
        return (
          <div className="flex flex-wrap items-center gap-4">
            <p className="text-[14px] text-fg-2">
              Pip needs {amount(escrowed)} αUSD for the job and {amount(disputeBond(escrowed))} for a dispute bond. Balance: <span className="font-mono text-fg">{balance === null ? '…' : amount(balance)}</span>
            </p>
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void fund()}>
              Fund from the Tempo faucet
            </button>
          </div>
        );
      case 'open':
        return (
          <div className="flex flex-col gap-4">
            <dl className="grid gap-px border hairline bg-line text-[13px] [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
              {[
                ['job', String(scenario.terms.title ?? scenario.title)],
                ['escrow', `${amount(escrowed)} αUSD`],
                ['referee', table.arbiter ? shortHash(table.arbiter) : 'house arbiter'],
                ['fees', 'sponsored'],
                ...(referrer ? [['referrer', shortHash(referrer)]] : []),
              ].map(([k, v]) => (
                <div key={k} className="bg-ink-2 p-3">
                  <dt className="label">{k}</dt>
                  <dd className="mt-1 font-mono">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[13px] text-fg-3">{String(scenario.terms.deliverableSpec ?? '')}</p>
            <button type="button" className="btn btn-primary self-start" disabled={!!busy} onClick={() => void open()}>
              Lock {amount(escrowed)} αUSD in escrow
            </button>
          </div>
        );
      case 'deliver':
        return (
          <div className="flex flex-col gap-4">
            <pre className="code max-h-56 overflow-auto whitespace-pre-wrap text-[12px]">{content || '(an empty delivery)'}</pre>
            <button type="button" className="btn btn-primary self-start" disabled={!!busy} onClick={() => void deliver()}>
              Deliver as Bolt
            </button>
          </div>
        );
      case 'decide':
        return (
          <div className="flex flex-col gap-4">
            <label className="label" htmlFor="claim">
              Pip&rsquo;s claim
            </label>
            <textarea id="claim" className="panel-sunk min-h-24 p-3 text-[14px] leading-relaxed" value={claim} onChange={(event) => setClaim(event.target.value)} />
            <Slider id="offer" label="Pip's final offer: the most Pip concedes Bolt earned" value={offer} onChange={setOffer} tone="pip" />
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn btn-primary" disabled={!!busy || !claim.trim()} onClick={() => void dispute()}>
                Dispute and post the bond
              </button>
              <button type="button" className="btn" disabled={!!busy} onClick={() => void accept()}>
                Accept and pay Bolt
              </button>
            </div>
          </div>
        );
      case 'respond':
        return (
          <div className="flex flex-col gap-4">
            <label className="label" htmlFor="statement">
              Bolt&rsquo;s answer
            </label>
            <textarea id="statement" className="panel-sunk min-h-24 p-3 text-[14px] leading-relaxed" value={statement} onChange={(event) => setStatement(event.target.value)} />
            <Slider id="ask" label="Bolt's final ask: the least Bolt will take" value={ask} onChange={setAsk} tone="bolt" />
            <button type="button" className="btn btn-primary self-start" disabled={!!busy || !statement.trim()} onClick={() => void respond()}>
              Answer as Bolt
            </button>
          </div>
        );
      case 'rule':
        return (
          <div className="flex flex-col gap-5">
            {preview ? (
              <>
                <p className="text-[14px] text-fg-2">
                  The rule engine ran in your browser against job {String(jobId)} as the chain holds it. The referee cannot sign outside the mint band.
                </p>
                <RulingGauge ruleBand={preview.analysis.band} offers={preview.offers} awardBps={null} />
                {preview.analysis.blocking.length > 0 ? (
                  <p className="border border-fail-dim px-4 py-3 font-mono text-[12px] text-fail">The referee will refuse: {preview.analysis.blocking.join('; ')}</p>
                ) : null}
              </>
            ) : null}
            {table.court ? (
              <button type="button" className="btn btn-ref self-start" disabled={!!busy} onClick={() => void rule()}>
                Call the referee
              </button>
            ) : (
              <p className="border border-pip-dim px-4 py-3 text-[13px] text-pip">
                No referee is connected to this site, so job {String(jobId)} waits on chain with its evidence closed. Run <code className="font-mono">pnpm court</code> and set TEMPEX_COURT_URL to rule it here.
              </p>
            )}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-6">
        <div className="panel grid grid-cols-3 divide-x divide-line">
          {[
            { key: 'pip', name: 'Pip', role: 'buyer', seat: buyer, art: <Pip id="play-pip" size={92} mood={pipMood} />, tone: 'text-pip' },
            { key: 'ref', name: 'Ref', role: 'referee', seat: null, art: <Ref id="play-ref" size={92} mood={refMood} />, tone: 'text-ref' },
            { key: 'bolt', name: 'Bolt', role: 'seller', seat: seller, art: <Bolt id="play-bolt" size={92} mood={boltMood} />, tone: 'text-bolt' },
          ].map((party) => (
            <div key={party.key} className="flex flex-col items-center gap-2 p-4 text-center">
              {party.art}
              <p className={`label ${party.tone}`}>
                {party.name} · {party.role}
              </p>
              <p className="font-mono text-[11.5px] text-fg-3">
                {party.key === 'ref' ? (table.arbiter ? shortHash(table.arbiter) : '—') : party.seat ? `${shortHash(party.seat.address)} · ${party.seat.kind}` : 'not seated'}
              </p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Scenario">
          <span className="label mr-2">Scenario</span>
          {scenarios.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={entry.id === scenarioId}
              disabled={index > ORDER.indexOf('fund')}
              onClick={() => setScenarioId(entry.id)}
              className={`chip ${entry.id === scenarioId ? 'chip-ref' : ''} disabled:opacity-40`}
            >
              {entry.title}
            </button>
          ))}
        </div>
        <p className="-mt-3 text-[14px] text-fg-2">{scenario.premise}</p>

        {resumable && stage === 'seat' ? (
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-4 text-[14px]">
            <span>Job {resumable.jobId} is waiting for its ruling. Its evidence is saved in this browser.</span>
            <button type="button" className="btn btn-ref" disabled={!!busy} onClick={() => void resume(resumable)}>
              Call the referee for job {resumable.jobId}
            </button>
          </div>
        ) : null}

        <ol className="flex flex-col gap-px border hairline bg-line">
          {steps.map((step) => {
            const position = ORDER.indexOf(step.id);
            const done = position < index || (step.id === 'rule' && !!ruling);
            const active = step.id === stage;
            const skipped = accepted && (step.id === 'respond' || step.id === 'rule');
            return (
              <li key={step.id} className={`bg-panel ${active ? '' : 'opacity-90'}`} aria-current={active ? 'step' : undefined}>
                <div className="flex items-center gap-4 px-5 py-4">
                  <span className={`font-mono text-[12px] ${done ? 'text-ref' : active ? 'text-fg' : 'text-fg-3'}`}>{done ? '✓' : step.n}</span>
                  <span className={`text-[15px] ${active ? 'text-fg' : done ? 'text-fg-2' : 'text-fg-3'}`}>{step.title}</span>
                  {skipped ? <span className="chip ml-auto">skipped</span> : null}
                  {active && busy ? <span className="label ml-auto anim-pulse text-ref">{busy}…</span> : null}
                </div>
                {active ? <div className="border-t hairline px-5 py-5">{body(step.id)}</div> : null}
              </li>
            );
          })}
        </ol>

        {error ? (
          <p role="alert" className="border border-fail-dim px-4 py-3 font-mono text-[12.5px] text-fail">
            {error}
          </p>
        ) : null}

        {stage === 'settled' ? (
          <section className="panel flex flex-col gap-5 p-6" aria-live="polite">
            {ruling ? (
              <>
                <p className="label text-ref">Ruling · job {ruling.jobId}</p>
                <p className="display text-[clamp(36px,5vw,64px)]">{pct(ruling.sellerAwardBps)} to Bolt.</p>
                <RulingGauge ruleBand={ruling.band} offers={preview?.offers ?? null} awardBps={ruling.sellerAwardBps} />
                <p className="max-w-[70ch] text-[14px] leading-relaxed text-fg-2">{ruling.rationale}</p>
                {ruling.panelFallback ? (
                  <p className="border border-pip-dim px-4 py-3 font-mono text-[12px] text-pip">
                    The judge panel was unavailable, so the rule engine ruled and judgement criteria stood at the neutral midpoint.
                  </p>
                ) : null}
                <dl className="grid gap-px border hairline bg-line text-[13px] [grid-template-columns:repeat(auto-fit,minmax(140px,1fr))]">
                  {[
                    ['Bolt gets', amount(ruling.money.sellerAmount, 'ledger')],
                    ['Pip gets back', amount(ruling.money.buyerAmount, 'ledger')],
                    ['referee fee', amount(ruling.money.arbitrationFee, 'ledger')],
                    ['engine', ruling.engine === 'llm' ? `judge panel${ruling.usage ? ` · ${(ruling.usage.inputTokens + ruling.usage.outputTokens).toLocaleString('en-US')} tokens` : ''}` : 'rule engine'],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-ink-2 p-3">
                      <dt className="label">{k}</dt>
                      <dd className="mt-1 font-mono">{v}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <>
                <p className="label text-ref">Settled · job {String(jobId)}</p>
                <p className="display text-[clamp(36px,5vw,64px)]">Bolt is paid in full.</p>
              </>
            )}
            <div className="flex flex-wrap gap-3">
              {buyer || seller ? (
                <button type="button" className="btn btn-primary" disabled={!!busy || !!(paid.pip || paid.bolt)} onClick={() => void collect()}>
                  {paid.pip || paid.bolt ? 'Paid out' : 'Withdraw both sides'}
                </button>
              ) : null}
              <Link className="btn btn-ref" href={`/proof/${ruling?.jobId ?? String(jobId)}`}>
                Open the receipt
              </Link>
              <button type="button" className="btn" onClick={reset}>
                Play again
              </button>
            </div>
          </section>
        ) : null}

        {preview && stage !== 'rule' ? (
          <details className="panel p-5">
            <summary className="label cursor-pointer">The scorecard the referee read</summary>
            <div className="mt-4">
              <CriterionScorecard
                rows={preview.analysis.signals.criteria}
                totals={{ total: preview.analysis.signals.totalWeight, checked: preview.analysis.signals.checkedWeight, earned: preview.analysis.signals.earnedWeight, open: preview.analysis.signals.openWeight }}
              />
            </div>
          </details>
        ) : null}
      </div>

      <aside className="panel-sunk flex h-fit flex-col lg:sticky lg:top-20">
        <div className="flex items-center justify-between border-b hairline px-4 py-3">
          <p className="label">Ledger · Moderato 42431</p>
          <span className={`chip ${table.court ? 'chip-ref' : 'chip-pip'}`}>{table.court ? 'referee online' : 'no referee'}</span>
        </div>
        <ol ref={ledgerRef} className="flex max-h-[560px] flex-col overflow-auto font-mono text-[12px]" aria-live="polite">
          {log.length === 0 ? <li className="px-4 py-6 text-fg-3">Every signature lands here, with a link to the explorer.</li> : null}
          {log.map((entry, i) => (
            <li key={i} className="anim-fade border-b hairline px-4 py-3 leading-relaxed">
              <span className={`${WHO_TONE[entry.who]} mr-2`}>{WHO_NAME[entry.who]}</span>
              <span className="text-fg-2">{entry.text}</span>
              {entry.hash ? (
                <a className="link mt-1 block text-fg-3" href={txUrl(entry.hash)} target="_blank" rel="noreferrer">
                  {shortHash(entry.hash, 10, 6)} ↗
                </a>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="border-t hairline px-4 py-3 text-[12px] leading-relaxed text-fg-3">
          Keys stay on this device. This site holds none, stores no accounts, and sends the referee only the evidence already pinned on chain.
        </p>
      </aside>
    </div>
  );
}

function Slider({ id, label, value, onChange, tone }: { id: string; label: string; value: number; onChange: (v: number) => void; tone: 'pip' | 'bolt' }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="label">
          {label}
        </label>
        <span className={`font-mono text-[18px] num ${tone === 'pip' ? 'text-pip' : 'text-bolt'}`}>{pct(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={10_000}
        step={250}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className={`mt-3 w-full ${tone === 'pip' ? 'accent-[#f7c548]' : 'accent-[#6aa8ff]'}`}
        aria-valuetext={pct(value)}
      />
    </div>
  );
}
