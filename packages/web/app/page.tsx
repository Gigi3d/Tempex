import Link from 'next/link';

import { Bolt, Pip, Ref } from '@/components/characters';
import { RulingGauge } from '@/components/gauge';
import { Tabs } from '@/components/tabs';
import { ArrowUpRight, Chip, Eyebrow, Hash, SectionHead, SourceChip, Stat } from '@/components/ui';
import { getArbiters, getJob, getQuote, getStats } from '@/lib/beacon';
import { amount, pct } from '@/lib/format';
import { CANONICAL_JOB, snapshot } from '@/lib/snapshot';

export const revalidate = 30;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const GUARANTEES = [
  {
    title: 'Custody',
    body: 'Money sits in the escrow contract, never with us. No admin key can move it.',
    href: '/explorer',
    cta: 'See every job',
  },
  {
    title: 'Judgement',
    body: 'Scored per criterion, with partial credit. Not a yes or no.',
    href: '/cases/underdelivered',
    cta: 'Read a case',
  },
  {
    title: 'Boundedness',
    body: 'The judge moves only inside the band the evidence and the offers allow.',
    href: '/demo#cage',
    cta: 'Try to break it',
  },
  {
    title: 'Verifiability',
    body: 'Every ruling is a signed receipt a stranger can check in ten seconds.',
    href: `/proof/${CANONICAL_JOB}`,
    cta: 'Open a receipt',
  },
];

export default async function Home() {
  const [stats, job, arbiters, quote] = await Promise.all([
    getStats(),
    getJob(CANONICAL_JOB),
    getArbiters(),
    getQuote('seller'),
  ]);
  const s = stats.data;
  const j = job.data;
  const adjudication = snapshot.receipt.adjudication;
  const latency = median(s.arbitration.timings.map((t) => t.seconds));
  const listed = arbiters.data.listed.length + 1;

  return (
    <>
      {/* Hero */}
      <section className="wrap grid items-center gap-12 pb-16 pt-20 lg:grid-cols-[1.1fr_1fr] lg:pt-28">
        <div className="flex flex-col gap-7">
          <Eyebrow tone="ref">The referee for agent commerce</Eyebrow>
          <h1 className="display text-[clamp(44px,6vw,88px)]">
            <span className="block whitespace-nowrap">Machines pay.</span>
            <span className="block whitespace-nowrap text-fg-2">Tempex settles.</span>
          </h1>
          <p className="lede">
            Programmable escrow with AI arbitration for agent-to-agent payments, settled on Tempo. The money waits, both sides
            are heard, and the split is bounded by the evidence. Every ruling is a receipt anyone can check.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/demo" className="btn btn-primary">
              ▶ Watch a ruling
            </Link>
            <Link href="/play" className="btn">
              Run your own dispute
            </Link>
          </div>
          <p className="text-[14px] text-fg-3">
            Live on Tempo’s Moderato testnet ·{' '}
            <a className="link" href={snapshot.receipt.escrowExplorer} target="_blank" rel="noreferrer">
              inspect the contract
            </a>
          </p>
        </div>

        {/* The ruling card: Tempo's wallet card, holding a verdict instead of a balance. */}
        <div className="panel">
          <div className="flex items-start justify-between border-b hairline p-6">
            <div>
              <p className="text-[14px] text-fg-2">Job {j.jobId} · {snapshot.receipt.title}</p>
              <p className="mt-2 font-mono text-[40px] font-light tracking-tight num">
                {j.verdict ? `${j.verdict.sellerAwardBps} bps` : '—'}
              </p>
              <p className="text-[13px] text-fg-3">{j.verdict ? `${pct(j.verdict.sellerAwardBps)} to the seller, by the evidence` : 'awaiting a ruling'}</p>
            </div>
            <Ref id="hero-ref" size={72} mood="calm" />
          </div>
          <div className="flex flex-col gap-5 p-6">
            <RulingGauge
              ruleBand={{ lowBps: adjudication.band.lowBps, highBps: adjudication.band.highBps }}
              offers={j.dispute && j.response ? { lowBps: Math.min(j.dispute.buyerOfferBps, j.response.sellerAskBps), highBps: Math.max(j.dispute.buyerOfferBps, j.response.sellerAskBps) } : null}
              awardBps={j.verdict?.sellerAwardBps}
            />
            {j.verdict ? (
              <div className="grid grid-cols-2 gap-px bg-line">
                <div className="bg-ink-2 p-4">
                  <p className="label text-bolt">Seller · Bolt</p>
                  <p className="mt-1 font-mono text-[20px] num">{amount(j.verdict.sellerAmount)}</p>
                </div>
                <div className="bg-ink-2 p-4">
                  <p className="label text-pip">Buyer · Pip</p>
                  <p className="mt-1 font-mono text-[20px] num">{amount(j.verdict.buyerAmount)}</p>
                </div>
              </div>
            ) : null}
            <div className="flex items-center gap-3 border hairline p-4">
              <span className="grid h-8 w-8 place-items-center bg-ref-dim text-ref" aria-hidden>
                ✓
              </span>
              <div className="min-w-0">
                <p className="text-[14px]">Signature recovers to the registered arbiter</p>
                <Hash value={adjudication.registeredArbiter} kind="address" head={10} tail={8} />
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between border-t hairline px-6 py-4">
            <Link href={`/proof/${j.jobId}`} className="inline-flex items-center gap-1 text-[14px] text-fg-2 hover:text-fg">
              Open the receipt <ArrowUpRight />
            </Link>
            <SourceChip source={job.source} asOf={job.asOf} />
          </div>
        </div>
      </section>

      {/* Live stats */}
      <section className="wrap">
        <div className="flex items-center justify-between pb-3">
          <Eyebrow>From the chain, folded by the beacon</Eyebrow>
          <SourceChip source={stats.source} asOf={stats.asOf} />
        </div>
        <div className="grid grid-cols-2 border hairline md:grid-cols-5 [&>*]:border-line [&>*:not(:last-child)]:md:border-r [&>*]:max-md:border-b">
          <Stat label="jobs" value={s.jobs.total} sub={`${s.jobs.resolved} ruled · ${s.jobs.funded} open`} href="/explorer" />
          <Stat label="escrowed" value={`${Number(s.money.escrowed.value).toLocaleString('en-US')}`} sub={`${s.token.symbol} through the contract`} />
          <Stat label="paid to sellers" value={Number(s.money.paidToSellers.value).toFixed(2)} sub={`${Number(s.money.refundedToBuyers.value).toFixed(2)} back to buyers`} />
          <Stat
            label="ruling time"
            value={latency !== null ? `${latency}s` : '—'}
            sub={`median, dispute to verdict, ${s.arbitration.timings.length} rulings`}
          />
          <Stat
            label="guardrail"
            value={<span className={s.arbitration.bounded ? 'text-ref' : 'text-fail'}>{s.arbitration.bounded ? 'held' : 'broken'}</span>}
            sub={s.arbitration.avgSellerAwardBps !== null ? `awards ${s.arbitration.minSellerAwardBps}–${s.arbitration.maxSellerAwardBps} bps` : 'no rulings yet'}
          />
        </div>
      </section>

      {/* Four guarantees, Tempo's split layout */}
      <section className="wrap mt-24 grid border hairline lg:grid-cols-2">
        <div className="flex flex-col border-line lg:border-r">
          <div className="p-8">
            <h2 className="h2">One escrow, four guarantees.</h2>
          </div>
          <ul className="border-t hairline">
            {GUARANTEES.map((g) => (
              <li key={g.title} className="border-b hairline last:border-b-0">
                <Link href={g.href} className="group flex items-start justify-between gap-6 px-8 py-5 hover:bg-panel">
                  <span>
                    <span className="block text-[15px]">{g.title}</span>
                    <span className="mt-1 block text-[13px] text-fg-3">{g.body}</span>
                  </span>
                  <span className="mt-1 flex shrink-0 items-center gap-2 text-[12px] text-fg-3 group-hover:text-ref">
                    {g.cta}
                    <span className="square text-fg-3 group-hover:text-ref" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-h-[420px]">
          <Tabs
            tabs={[
              {
                label: 'Diagram',
                content: (
                  <svg viewBox="0 0 560 300" className="w-full" role="img" aria-label="Pip pays into the escrow; Bolt delivers; Ref rules on a dispute and the escrow splits the money">
                    <g fontFamily="Geist Mono, monospace" fontSize="10" letterSpacing="0.12em">
                      <rect x="20" y="110" width="130" height="80" fill="#111113" stroke="#303034" />
                      <text x="34" y="132" fill="#f7c548">BUYER · PIP</text>
                      <rect x="34" y="146" width="102" height="24" fill="#151517" stroke="#242427" />
                      <text x="44" y="162" fill="#b3b3ae">25 αUSD</text>
                      <rect x="215" y="70" width="130" height="160" fill="#111113" stroke="#303034" />
                      <text x="229" y="92" fill="#7d7d78">ESCROW</text>
                      <rect x="229" y="104" width="102" height="10" fill="#4be3a6" />
                      <rect x="229" y="120" width="70" height="10" fill="#1d4a39" />
                      <rect x="229" y="136" width="86" height="10" fill="#1d4a39" />
                      <text x="229" y="176" fill="#b3b3ae">terms locked</text>
                      <text x="229" y="192" fill="#b3b3ae">bond 5%</text>
                      <text x="229" y="208" fill="#b3b3ae">offers bound</text>
                      <rect x="410" y="110" width="130" height="80" fill="#111113" stroke="#303034" />
                      <text x="424" y="132" fill="#6aa8ff">SELLER · BOLT</text>
                      <rect x="424" y="146" width="102" height="24" fill="#151517" stroke="#242427" />
                      <text x="434" y="162" fill="#b3b3ae">fr-FR.json</text>
                      <rect x="215" y="12" width="130" height="40" fill="#111113" stroke="#4be3a6" />
                      <text x="229" y="36" fill="#4be3a6">REF · ARBITER</text>
                      <rect x="215" y="250" width="130" height="38" fill="#111113" stroke="#303034" />
                      <text x="229" y="273" fill="#7d7d78">TEMPO · 42431</text>
                    </g>
                    <g stroke="#55554f" strokeDasharray="3 4">
                      <line x1="150" y1="150" x2="215" y2="150" />
                      <line x1="345" y1="150" x2="410" y2="150" />
                      <line x1="280" y1="52" x2="280" y2="70" />
                      <line x1="280" y1="230" x2="280" y2="250" />
                    </g>
                  </svg>
                ),
              },
              {
                label: 'Code',
                content: (
                  <pre className="code">{`import { TempexClient } from '@tempex/sdk';

// Pip opens and funds a job in one Tempo transaction.
const { jobId } = await pip.createAndFundJob({
  seller: bolt.address, amount: 25_000000n, termsHash,
  deliveryDeadline, reviewWindow: 3600, arbiter: ref,
});

// Bolt delivers; the bytes are fingerprinted on chain.
await bolt.deliver(jobId, deliverableHash, uri);

// Pip disputes with a 5% bond and a final offer (bps).
await pip.dispute(jobId, disputeHash, 2500);

// Bolt answers with evidence and its final ask.
await bolt.respond(jobId, responseHash, 5000);

// Anyone relays Ref's signed verdict.
await relayer.resolve(jobId, verdict, signature);`}</pre>
                ),
              },
            ]}
          />
        </div>
      </section>

      {/* The cast */}
      <section className="wrap mt-24">
        <SectionHead eyebrow="How a deal plays out" title="Three characters, one fair ending.">
          Every Tempex job has a buyer, a seller and a referee. In the demo they have names.
        </SectionHead>
        <div className="mt-10 grid gap-px border hairline bg-line md:grid-cols-3">
          {[
            { who: <Pip id="cast-pip" size={120} mood="happy" />, name: 'Pip', role: 'the buyer', tone: 'pip' as const, text: 'Pays 25 αUSD into escrow for a French checkout locale. The money waits.' },
            { who: <Bolt id="cast-bolt" size={120} mood="happy" />, name: 'Bolt', role: 'the seller', tone: 'bolt' as const, text: 'Delivers most of it. Prices and dates stay in US format. Then it is disputed.' },
            { who: <Ref id="cast-ref" size={120} mood="calm" />, name: 'Ref', role: 'the referee', tone: 'ref' as const, text: 'Checks what code can check, scores the rest, and lands inside both offers.' },
          ].map((c) => (
            <div key={c.name} className="flex flex-col gap-4 bg-ink-2 p-8">
              {c.who}
              <div>
                <Eyebrow tone={c.tone}>{c.role}</Eyebrow>
                <p className="mt-1 text-[22px] font-light">{c.name}</p>
              </div>
              <p className="text-[14px] text-fg-2">{c.text}</p>
            </div>
          ))}
        </div>
        <div className="mt-6">
          <Link href="/demo" className="btn btn-primary">
            ▶ Watch it in three minutes
          </Link>
        </div>
      </section>

      {/* Market + cost */}
      <section className="wrap mt-24 grid gap-px border hairline bg-line md:grid-cols-2">
        <Link href="/arbiters" className="group flex flex-col gap-4 bg-ink-2 p-8 hover:bg-panel">
          <Eyebrow>Arbiter market</Eyebrow>
          <p className="text-[24px] font-light tracking-tight">The referee is a market, not a monopoly.</p>
          <p className="text-[14px] text-fg-2">
            {listed} arbiters, each with a fee in basis points and a track record folded from escrow events.
          </p>
          <span className="mt-auto inline-flex items-center gap-1 text-[13px] text-fg-3 group-hover:text-ref">
            Compare arbiters <ArrowUpRight />
          </span>
        </Link>
        <Link href="/quote" className="group flex flex-col gap-4 bg-ink-2 p-8 hover:bg-panel">
          <Eyebrow>What it costs to start</Eyebrow>
          <p className="text-[24px] font-light tracking-tight">
            {quote.data.total.value === '0' ? 'Zero, line by line.' : `${quote.data.total.value} αUSD to start.`}
          </p>
          <p className="text-[14px] text-fg-2">
            No account to create, no registration fee, and the transaction fee is sponsored. Measured on a real receipt:{' '}
            <span className="font-mono">{quote.data.fee.measured.value} αUSD</span>.
          </p>
          <span className="mt-auto inline-flex items-center gap-1 text-[13px] text-fg-3 group-hover:text-ref">
            See the quote <ArrowUpRight />
          </span>
        </Link>
      </section>

      <section className="wrap mt-24 flex flex-col items-center gap-6 text-center">
        <h2 className="h2 max-w-3xl">Machines can pay each other. Now they can disagree, fairly.</h2>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/play" className="btn btn-ref">
            Run your own dispute
          </Link>
          <Link href="/console" className="btn">
            Integrate an agent
          </Link>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Chip>chain {s.chainId}</Chip>
          <Chip>{s.events} escrow events</Chip>
          <Chip>{s.participants.unique} participants</Chip>
        </div>
      </section>
    </>
  );
}
