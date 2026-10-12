/// Seeds a hosted Tempex site with real testnet activity: eight jobs between
/// six throwaway wallets, in every state a visitor should see (accepted,
/// awaiting review, in progress, disputed and settled by rule).
///
/// It talks only to the public site, the same routes the browser uses:
/// `/api/docs` files the terms, the delivered work, the evidence and the
/// answers; `/api/court/:id` asks the site's court to settle a dispute. Every
/// transaction is a real Moderato transaction from the wallets it creates; the
/// fee sponsor pays the fees and the faucet funds the wallets.
///
///   pnpm --filter @tempex/demo seed                      # https://tempex-web.fly.dev
///   pnpm --filter @tempex/demo seed --site http://localhost:3000
///   pnpm --filter @tempex/demo seed --dry                # checks only, no chain
///
/// Wallet keys are throwaway testnet keys kept in ~/.tempex/seed-wallets.json
/// (outside the repo), so a second run reuses them instead of asking the faucet.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  SPONSOR_URL,
  TempexClient,
  accountFor,
  formatToken,
  hashCanonical,
  hashText,
  responseHashOf,
  tokenAmount,
  type Criterion,
  type EvidenceBundle,
  type JobTerms,
  type SellerResponse,
} from '@tempex/sdk';
import { runCheck } from '@tempex/arbiter';
import { generatePrivateKey } from 'viem/accounts';
import { getAddress, type Address, type Hex } from 'viem';

const ESCROW = getAddress('0xe3E3Dece68B7D8AD3dc8638B38bf546FF594268a');
const TOKEN = getAddress('0x20c0000000000000000000000000000000000001');
const WALLET_FILE = join(homedir(), '.tempex', 'seed-wallets.json');
const MAX_INLINE_URI = 2_048;
/// Every write goes through the fee sponsor, so the wallets only ever hold αUSD.
const W = { sponsored: true } as const;

type Persona = 'northwind' | 'lumen' | 'fieldnote' | 'kite' | 'polyglot' | 'patchwork';
type End = 'funded' | 'delivered' | 'accepted' | 'settled';

type Scenario = {
  buyer: Persona;
  seller: Persona;
  title: string;
  spec: string;
  amount: string;
  criteria: Criterion[];
  deliverable: string;
  end: End;
  dispute?: { claim: string; offerBps: number; answer: string; askBps: number };
};

// ---------------------------------------------------------------- the jobs

/// Deterministic pseudo-randomness, so the delivered datasets are the same on
/// every run and the settlements can be worked out in advance.
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}
const pick = <T,>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
const hex = (next: () => number, length: number): string =>
  Array.from({ length }, () => Math.floor(next() * 16).toString(16)).join('');

function labeledImages(count: number, bad: number, classes: readonly string[], seed: number, prefix: string): string {
  const next = rng(seed);
  const items = Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i + 1).padStart(4, '0')}`,
    sha256: hex(next, 16),
    class: i >= count - bad ? 'unsure' : pick(next, classes),
  }));
  return JSON.stringify({ images: count, license: 'exclusive to buyer', labels: items });
}

function scenarios(): Scenario[] {
  const productClasses = ['damaged', 'wrong_size', 'not_as_pictured', 'fine'] as const;
  const streetClasses = ['pedestrian', 'cyclist', 'scooter', 'curb', 'clear'] as const;

  const invoices = JSON.stringify({
    source: '300 supplier invoices, Q3',
    rows: Array.from({ length: 24 }, (_, i) => ({
      invoice: `INV-${3100 + i}`,
      supplier: ['Acme Fasteners', 'Nordic Pallets', 'Brightline Paper'][i % 3],
      sku: `SKU-${4400 + i * 7}`,
      qty: (i % 9) + 1,
      unit_price: Number((3.5 + (i % 7) * 1.25).toFixed(2)),
    })),
    rows_total: 1_146,
  });

  const emails = JSON.stringify({
    welcome: 'Bem-vindo à Fieldnote! Sua conta está pronta e você já pode começar a usar todas as ferramentas.',
    verify: 'Confirme seu endereço de e-mail para ativar a conta e receber nossas novidades.',
    first_project: 'Crie o seu primeiro projeto em menos de dois minutos e convide a sua equipe.',
    reminder: 'Você ainda não terminou a configuração. Precisa de ajuda? Responda este e-mail.',
  });

  const patch = JSON.stringify({
    pr: 'fix(checkout): await payment intent before asserting the redirect',
    files: ['checkout/flow.spec.ts', 'checkout/payment.ts'],
    tests: { passed: 412, failed: 0, flaky_reruns: 0 },
    note: 'The test raced the payment intent; it now waits on the intent promise.',
  });

  const calls = JSON.stringify({
    calls: Array.from({ length: 34 }, (_, i) => ({
      id: `call-${String(i + 1).padStart(2, '0')}`,
      minutes: 4 + (i % 11),
      speakers: ['speaker_a', 'speaker_b'],
      transcript: `speaker_a: Thanks for calling, how can I help? speaker_b: My order ${7000 + i} arrived late.`,
    })),
  });

  const tickets = [
    'ticket,tag,summary',
    ...Array.from({ length: 25 }, (_, i) => `T-${5200 + i},${['billing', 'shipping', 'login', 'refund', 'bug'][i % 5]},${['Charged twice', 'Parcel stuck in transit', 'Reset link expired', 'Wants refund for damaged item', 'App crashes on upload'][i % 5]}`),
  ].join('\n');

  return [
    {
      buyer: 'lumen', seller: 'kite', amount: '120', end: 'accepted',
      title: 'Label 1,200 product-return photos for a returns model',
      spec: 'Label each return photo with one reason from the agreed set: damaged, wrong_size, not_as_pictured, fine. JSON under /labels, one entry per photo with its sha256.',
      criteria: [
        { id: 'c1', text: 'All 1,200 photos labeled', weight: 1, check: { type: 'count', at: '/labels', unit: 'items', min: 1200 } },
        { id: 'c2', text: 'Every label comes from the agreed set', weight: 3, check: { type: 'regex', at: '/labels', keys: '*.class', pattern: '^(damaged|wrong_size|not_as_pictured|fine)$' } },
      ],
      deliverable: labeledImages(1_200, 0, productClasses, 11, 'ret'),
    },
    {
      buyer: 'northwind', seller: 'polyglot', amount: '75', end: 'accepted',
      title: 'Extract line items from 300 supplier invoices',
      spec: 'Every line item from the Q3 supplier invoices as JSON rows: invoice, supplier, sku, qty, unit_price.',
      criteria: [
        { id: 'c1', text: 'Rows carry invoice, supplier, sku, qty and unit_price', weight: 2, check: { type: 'jsonKeys', at: '/rows/0', keys: ['invoice', 'supplier', 'sku', 'qty', 'unit_price'] } },
        { id: 'c2', text: 'Invoice numbers keep the INV- format', weight: 1, check: { type: 'regex', at: '/rows', keys: '*.invoice', pattern: '^INV-\\d{4}$' } },
      ],
      deliverable: invoices,
    },
    {
      buyer: 'fieldnote', seller: 'polyglot', amount: '30', end: 'accepted',
      title: 'Translate onboarding emails into Brazilian Portuguese',
      spec: 'The four onboarding emails (welcome, verify, first_project, reminder) in pt-BR, same keys, same tone.',
      criteria: [
        { id: 'c1', text: 'All four emails present', weight: 2, check: { type: 'jsonKeys', keys: ['welcome', 'verify', 'first_project', 'reminder'] } },
        { id: 'c2', text: 'Written in Portuguese', weight: 2, check: { type: 'language', is: 'pt' } },
      ],
      deliverable: emails,
    },
    {
      buyer: 'northwind', seller: 'kite', amount: '90', end: 'settled',
      title: 'Sell 60 annotated night-street images, Berlin',
      spec: '60 night-time street images from Berlin, exclusive, each with its sha256 and one label from: pedestrian, cyclist, scooter, curb, clear.',
      criteria: [
        { id: 'c1', text: 'All 60 images delivered', weight: 1, check: { type: 'count', at: '/labels', unit: 'items', min: 60 } },
        { id: 'c2', text: 'Every label comes from the agreed set', weight: 3, check: { type: 'regex', at: '/labels', keys: '*.class', pattern: '^(pedestrian|cyclist|scooter|curb|clear)$' } },
      ],
      deliverable: labeledImages(60, 12, streetClasses, 23, 'ber'),
      dispute: {
        claim: 'All 60 images arrived, but the last 12 are labeled "unsure", which is not in the agreed set. Paying for the images and the 48 usable labels.',
        offerBps: 7_500,
        answer: 'The 12 frames are motion-blurred; the agent declined to guess. Every image and hash is there and the rights are exclusive.',
        askBps: 9_500,
      },
    },
    {
      buyer: 'lumen', seller: 'patchwork', amount: '60', end: 'delivered',
      title: 'Fix the flaky checkout test and ship the patch',
      spec: 'Find why checkout/flow.spec.ts fails one run in five, fix the cause (not the test), and report the suite result.',
      criteria: [
        { id: 'c1', text: 'Reports the full suite result', weight: 1, check: { type: 'jsonKeys', keys: ['pr', 'files', 'tests.passed', 'tests.failed'] } },
        { id: 'c2', text: 'Names the root cause', weight: 1 },
      ],
      deliverable: patch,
    },
    {
      buyer: 'fieldnote', seller: 'kite', amount: '45', end: 'funded',
      title: 'Weekly competitor price scrape, 500 SKUs',
      spec: 'Current list price and stock status for the 500 SKUs on the attached list, from the three named retailers, as JSON.',
      criteria: [
        { id: 'c1', text: 'All 500 SKUs priced', weight: 2, check: { type: 'count', at: '/prices', unit: 'items', min: 500 } },
        { id: 'c2', text: 'Prices in EUR with two decimals', weight: 1, check: { type: 'regex', at: '/prices', keys: '*.price', pattern: '^\\d+\\.\\d{2}$' } },
      ],
      deliverable: '',
    },
    {
      buyer: 'lumen', seller: 'polyglot', amount: '80', end: 'settled',
      title: 'Transcribe 40 customer calls with speaker labels',
      spec: 'Verbatim transcripts of the 40 recorded support calls, each with both speakers labeled speaker_a and speaker_b.',
      criteria: [
        { id: 'c1', text: 'All 40 calls transcribed', weight: 2, check: { type: 'count', at: '/calls', unit: 'items', min: 40 } },
        { id: 'c2', text: 'Both speakers labeled', weight: 1, check: { type: 'contains', all: ['speaker_a', 'speaker_b'] } },
      ],
      deliverable: calls,
      dispute: {
        claim: 'Only 34 of the 40 calls were transcribed. Paying for 34.',
        offerBps: 8_000,
        answer: 'Six recordings were silent or corrupt on our side; the 34 delivered are complete and labeled.',
        askBps: 10_000,
      },
    },
    {
      buyer: 'northwind', seller: 'patchwork', amount: '15', end: 'accepted',
      title: 'Summarize 25 support tickets into tagged CSV rows',
      spec: 'One CSV row per ticket: ticket, tag (billing, shipping, login, refund, bug), one-line summary.',
      criteria: [
        { id: 'c1', text: 'All 25 tickets summarized', weight: 2, check: { type: 'count', unit: 'lines', min: 26 } },
        { id: 'c2', text: 'Has the agreed header', weight: 1, check: { type: 'contains', all: ['ticket,tag,summary'] } },
      ],
      deliverable: tickets,
    },
  ];
}

// ---------------------------------------------------------------- plumbing

type Wallets = Record<Persona, Hex>;

function loadWallets(): Wallets {
  if (existsSync(WALLET_FILE)) return JSON.parse(readFileSync(WALLET_FILE, 'utf8')) as Wallets;
  const personas: Persona[] = ['northwind', 'lumen', 'fieldnote', 'kite', 'polyglot', 'patchwork'];
  const wallets = Object.fromEntries(personas.map((p) => [p, generatePrivateKey()])) as Wallets;
  mkdirSync(dirname(WALLET_FILE), { recursive: true });
  writeFileSync(WALLET_FILE, `${JSON.stringify(wallets, null, 2)}\n`, { mode: 0o600 });
  return wallets;
}

function flag(argv: string[], name: string): string | true | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

const say = (line: string): void => void process.stdout.write(`${line}\n`);

async function fileDoc(site: string, kind: 'terms' | 'evidence' | 'response' | 'deliverable', doc: unknown): Promise<Hex> {
  const expected = kind === 'deliverable' ? hashText(doc as string) : hashCanonical(doc);
  const response = await fetch(`${site}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, doc }),
  });
  const body = (await response.json()) as { hash?: string; message?: string };
  if (!response.ok) throw new Error(`filing ${kind}: ${body.message ?? response.status}`);
  if (body.hash?.toLowerCase() !== expected.toLowerCase()) throw new Error(`the site filed ${kind} under a different hash`);
  return expected;
}

/// The award the settlement rule will sign, from the agreed checks alone:
/// verified credit plus half the unchecked weight, held inside the offers.
function predict(s: Scenario): { credits: string[]; bps: number } {
  let total = 0;
  let earned = 0;
  let open = 0;
  const credits: string[] = [];
  for (const raw of s.criteria) {
    const c = raw as { id: string; weight?: number; check?: Parameters<typeof runCheck>[0] };
    const weight = c.weight ?? 1;
    total += weight;
    if (!c.check) {
      open += weight;
      credits.push(`${c.id} unchecked`);
      continue;
    }
    const result = runCheck(c.check, s.deliverable);
    earned += weight * result.credit;
    credits.push(`${c.id} ${result.credit.toFixed(2)} (${result.evidence})`);
  }
  let bps = Math.round((10_000 * (earned + open / 2)) / total);
  if (s.dispute) bps = Math.min(Math.max(bps, Math.min(s.dispute.offerBps, s.dispute.askBps)), Math.max(s.dispute.offerBps, s.dispute.askBps));
  return { credits, bps };
}

// ---------------------------------------------------------------- the run

async function main(argv: string[]): Promise<void> {
  const site = String(flag(argv, 'site') === true || flag(argv, 'site') === undefined ? 'https://tempex-web.fly.dev' : flag(argv, 'site')).replace(/\/+$/, '');
  const dry = flag(argv, 'dry') === true;
  const only = flag(argv, 'only');
  const all = scenarios();
  const chosen = typeof only === 'string' ? only.split(',').map((n) => all[Number(n) - 1]!).filter(Boolean) : all;

  say(`seeding ${chosen.length} jobs on ${dry ? '(dry run)' : site}`);
  for (const [i, s] of chosen.entries()) {
    const p = predict(s);
    say(`  ${i + 1}. ${s.title} · ${s.amount} αUSD · ends ${s.end}${s.dispute ? ` · settles at ${(p.bps / 100).toFixed(2)}%` : ''}`);
    for (const line of p.credits) say(`       ${line}`);
  }
  if (dry) return;

  // Wallets: throwaway testnet keys, funded once from the faucet.
  const keys = loadWallets();
  const clients = Object.fromEntries(
    Object.entries(keys).map(([name, key]) => [name, new TempexClient({ account: accountFor(key), addresses: { escrow: ESCROW, token: TOKEN }, sponsorUrl: SPONSOR_URL })]),
  ) as Record<Persona, TempexClient>;
  for (const [name, client] of Object.entries(clients)) {
    const balance = await client.tokenBalance();
    if (balance >= tokenAmount('500')) continue;
    say(`funding ${name} ${client.address} from the faucet`);
    await client.fundWithFaucet();
    for (let tries = 0; tries < 30 && (await client.tokenBalance()) < tokenAmount('500'); tries++) await new Promise((r) => setTimeout(r, 1_000));
  }

  for (const s of chosen) {
    const buyer = clients[s.buyer];
    const seller = clients[s.seller];
    const terms: JobTerms = {
      title: s.title,
      deliverableSpec: s.spec,
      acceptanceCriteria: s.criteria,
      amount: s.amount,
      currency: 'αUSD',
      buyer: buyer.address,
      seller: seller.address,
    };
    const termsHash = await fileDoc(site, 'terms', terms);
    const now = Math.floor(Date.now() / 1000);
    const { jobId } = await buyer.createAndFundJob(
      { seller: seller.address as Address, amount: tokenAmount(s.amount), termsHash, deliveryDeadline: now + 3 * 86_400, reviewWindow: 86_400, approve: true },
      W,
    );
    say(`job ${jobId}: ${s.title} · opened and funded`);
    if (s.end === 'funded') continue;

    const deliverableHash = await fileDoc(site, 'deliverable', s.deliverable);
    const inline = `data:text/plain;charset=utf-8;base64,${Buffer.from(s.deliverable, 'utf8').toString('base64')}`;
    const uri = inline.length <= MAX_INLINE_URI ? inline : `${site}/api/docs/${deliverableHash}/raw`;
    await seller.deliver(jobId, deliverableHash, uri, W);
    say(`job ${jobId}: delivered`);
    if (s.end === 'delivered') continue;

    if (s.end === 'accepted') {
      await buyer.accept(jobId, W);
      say(`job ${jobId}: accepted, seller paid`);
      continue;
    }

    const d = s.dispute!;
    const bundle: EvidenceBundle = {
      version: 1,
      jobId: Number(jobId),
      termsHash,
      deliverableHash,
      claim: d.claim,
      deliverable: { content: s.deliverable, uri, contentHash: deliverableHash },
      artifacts: [],
      submittedAt: new Date().toISOString(),
    };
    const disputeHash = await fileDoc(site, 'evidence', bundle);
    await buyer.dispute(jobId, disputeHash, d.offerBps, W);
    const response: SellerResponse = {
      version: 1,
      jobId: Number(jobId),
      disputeHash,
      statement: d.answer,
      deliverable: { content: s.deliverable, uri, contentHash: deliverableHash },
      artifacts: [],
      submittedAt: new Date().toISOString(),
    };
    const responseHash = await fileDoc(site, 'response', response);
    if (responseHash !== responseHashOf(response)) throw new Error('response hash mismatch');
    await seller.respond(jobId, responseHash, d.askBps, W);
    say(`job ${jobId}: disputed at ${d.offerBps / 100}%, answered at ${d.askBps / 100}%`);

    const ruled = await fetch(`${site}/api/court/${jobId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terms, bundle, response }),
    });
    const body = (await ruled.json()) as { sellerAwardBps?: number; money?: { sellerAmount: string; buyerAmount: string }; message?: string; reasons?: string[] };
    if (!ruled.ok) {
      say(`job ${jobId}: the court did not settle it yet (${body.message ?? body.reasons?.join('; ') ?? ruled.status}); press "Send the case to the arbiter" on its page to retry`);
      continue;
    }
    say(`job ${jobId}: settled by rule at ${((body.sellerAwardBps ?? 0) / 100).toFixed(2)}% · seller ${formatToken(BigInt(body.money!.sellerAmount))} · buyer ${formatToken(BigInt(body.money!.buyerAmount))}`);
  }

  // Sellers collect what they earned, so dashboards show money in wallets.
  for (const name of ['kite', 'polyglot', 'patchwork'] as const) {
    const credit = await clients[name].credits();
    if (credit > 0n) {
      await clients[name].withdraw(W);
      say(`${name} withdrew ${formatToken(credit)} αUSD`);
    }
  }
  say('done');
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
