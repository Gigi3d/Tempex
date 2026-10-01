import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  adjudicate,
  decodeVerdictResolved,
  escrowArbiterConfig,
  evidenceDir as resolveEvidenceDir,
  repoRoot,
  runStamp,
  runsDir as resolveRunsDir,
  writeJson,
  type AdjudicationEngine,
  type AdjudicationResult,
  type VerdictMoney,
} from '@tempex/arbiter';
import {
  CHAIN_ID,
  SPONSOR_URL,
  SELLER_RESPONSE_WINDOW_SECONDS,
  TempexClient,
  accountFor,
  addressesFromEnv,
  caseIntegrity,
  disputeHashOf,
  explorerAddress,
  feePaid,
  formatToken,
  hashCanonical,
  hashText,
  loadEnv,
  memoTransfers,
  privateKeyFor,
  readCase,
  responseHashOf,
  tempexEscrowAbi,
  tokenAmount,
  writeCase,
  writeResponse,
  type EvidenceCase,
  type Role,
  type SellerResponse,
  type TempexAddresses,
  type VerdictStruct,
  type WriteOptions,
} from '@tempex/sdk';
import type { Address, Hex } from 'viem';

import { ARBITRATION_FEE_BPS } from './predict.js';
import { caseFor, type DemoParties, type Scenario, type ScenarioId } from './scenarios.js';
import { DEMO_STAGES, Transcript, type DemoStage } from './transcript.js';

/// The four identities the demo drives. The relayer is the point of having four
/// rather than three: `resolve` is permissionless, and a demo where the arbiter
/// relays its own verdict does not show that.
export type DemoRole = 'buyer' | 'seller' | 'arbiter' | 'relayer';

const ROLE_KEY: Record<DemoRole, Role> = {
  buyer: 'buyer',
  seller: 'seller',
  arbiter: 'arbiter',
  /// Any funded account can relay. The deployer key is used because it is
  /// demonstrably not the arbiter, and it already holds testnet AlphaUSD.
  relayer: 'deployer',
};

/// bytes32("tempex.withdraw"). Mirrors `TempexEscrow.WITHDRAW_MEMO`; the demo
/// asserts the payout transaction actually carries it, because a memo the escrow
/// stopped emitting would be a silent loss of reconciliation.
const WITHDRAW_MEMO = `0x${Buffer.from('tempex.withdraw').toString('hex').padEnd(64, '0')}` as Hex;

/// The log shape `reportFeePayer` reads, taken from the SDK's own parser so the
/// two cannot drift apart.
type ReceiptLogs = Parameters<typeof feePaid>[0];

/// The demo's scratchpad: one job's journey, stage by stage.
///
/// Every value is a string, because this file is JSON and a resumed run has to
/// read back exactly what the last one wrote. The ruling is kept in full —
/// verdict and signature included — so a crash between signing and relaying does
/// not cost the escrowed money, only a re-run.
export type DemoSession = {
  tempex: 'demo-session/1';
  scenario: ScenarioId;
  title: string;
  session: string;
  startedAt: string;
  updatedAt: string;
  /// Fixed when the session is created. The bundle carries it and the bundle is
  /// hashed, so a resumed run must reproduce it rather than read the clock again.
  submittedAt: string;
  predictedJobId: string | null;
  jobId: string | null;
  termsHash: string | null;
  deliverableHash: string | null;
  disputeHash: string | null;
  amount: string;
  stages: Partial<Record<DemoStage, Record<string, string>>>;
};

export type DemoOptions = {
  scenario: Scenario;
  from?: DemoStage;
  upto?: DemoStage;
  /// Wrap every client in the hosted fee-payer transport and mark each write
  /// sponsored, so the transcript can report who actually paid.
  sponsored?: boolean;
  /// Re-run stages the session already recorded.
  force?: boolean;
  /// Discard the recorded session and start over.
  fresh?: boolean;
  /// Session name; `runs/demo-<session>.json`. Defaults to the scenario id.
  session?: string;
  engine?: AdjudicationEngine;
  evidenceDir?: string;
  runsDir?: string;
  write?: (line: string) => void;
};

export type ExpectationCheck = {
  check: string;
  expected: string;
  actual: string;
  passed: boolean;
};

export type DemoResult = {
  ok: boolean;
  failures: string[];
  expectations: ExpectationCheck[];
  session: DemoSession;
  sessionPath: string;
  receiptPath: string;
  ran: DemoStage[];
  skipped: DemoStage[];
  adjudication: AdjudicationResult | null;
  /// The receipt, JSON-safe: bigints as decimal strings.
  receipt: Record<string, unknown>;
};

type ResolvedOptions = {
  scenario: Scenario;
  from: DemoStage;
  upto: DemoStage;
  sponsored: boolean;
  force: boolean;
  fresh: boolean;
  engine: AdjudicationEngine;
  session: string;
  evidenceDir: string;
  runsDir: string;
  write: ((line: string) => void) | undefined;
};

function stageIndex(stage: DemoStage): number {
  return DEMO_STAGES.indexOf(stage);
}

/// Rebuilds the signed struct and the money from a session record.
///
/// The record is strings; the contract wants a struct of bigints. This is the one
/// place the conversion happens, so a resumed relay sends exactly what the
/// original signing produced.
function relayableFromRecord(
  record: Record<string, string>,
  jobId: bigint,
): {
  verdict: VerdictStruct;
  signature: Hex;
  digest: Hex;
  money: VerdictMoney;
  recovered: Address;
  registeredArbiter: Address;
  rationale: string;
} {
  const need = (key: string): string => {
    const value = record[key];
    if (value === undefined) throw new Error(`the recorded ruling is missing "${key}"`);
    return value;
  };
  return {
    verdict: {
      jobId,
      sellerAwardBps: Number(need('sellerAwardBps')),
      evidenceHash: need('evidenceHash') as Hex,
      rationaleHash: need('rationaleHash') as Hex,
      issuedAt: BigInt(need('issuedAt')),
      validUntil: BigInt(need('validUntil')),
    },
    signature: need('signature') as Hex,
    digest: need('digest') as Hex,
    money: {
      amount: BigInt(need('amount')),
      arbitrationFee: BigInt(need('arbitrationFee')),
      arbitrationFeeBps: Number(need('arbitrationFeeBps')),
      sellerAmount: BigInt(need('sellerAmount')),
      buyerAmount: BigInt(need('buyerAmount')),
    },
    recovered: need('recovered') as Address,
    registeredArbiter: need('registeredArbiter') as Address,
    rationale: record['rationale'] ?? '',
  };
}

class DemoRun {
  readonly transcript: Transcript;

  private readonly scenario: Scenario;
  private readonly options: ResolvedOptions;
  private readonly addresses: TempexAddresses;
  private readonly clients: Record<DemoRole, TempexClient>;
  private readonly sessionPath: string;
  private session: DemoSession;

  private evidenceCase: EvidenceCase | null = null;
  private adjudication: AdjudicationResult | null = null;

  private readonly failures: string[] = [];
  private readonly expectations: ExpectationCheck[] = [];
  private readonly ran: DemoStage[] = [];
  private readonly skipped: DemoStage[] = [];

  constructor(input: {
    scenario: Scenario;
    options: ResolvedOptions;
    addresses: TempexAddresses;
    clients: Record<DemoRole, TempexClient>;
    sessionPath: string;
    session: DemoSession;
  }) {
    this.scenario = input.scenario;
    this.options = input.options;
    this.addresses = input.addresses;
    this.clients = input.clients;
    this.sessionPath = input.sessionPath;
    this.session = input.session;
    this.transcript = new Transcript(input.options.write);
  }

  private get writeOptions(): WriteOptions {
    return this.options.sponsored ? { sponsored: true } : {};
  }

  private parties(): DemoParties {
    return { buyer: this.clients.buyer.address, seller: this.clients.seller.address };
  }

  private jobId(): bigint {
    const raw = this.session.jobId ?? this.session.predictedJobId;
    if (raw === null) throw new Error('this session has no job id yet: run with --from case');
    return BigInt(raw);
  }

  private inRange(stage: DemoStage): boolean {
    const index = stageIndex(stage);
    return index >= stageIndex(this.options.from) && index <= stageIndex(this.options.upto);
  }

  private recorded(stage: DemoStage): boolean {
    return this.session.stages[stage] !== undefined;
  }

  private pending(stage: DemoStage): boolean {
    return this.inRange(stage) && (this.options.force || !this.recorded(stage));
  }

  /// One corpus expectation, checked against what actually happened.
  ///
  /// These are the only opinions in the repository that the demo is allowed to
  /// fail on: `scenarios.ts` states by hand what the engine must conclude, and a
  /// run whose numbers differ reports the drift instead of narrating it away.
  private expect(check: string, expected: string, actual: string): void {
    const passed = expected === actual;
    this.expectations.push({ check, expected, actual, passed });
    if (passed) return;
    this.failures.push(`${check}: got ${actual}, the corpus predicted ${expected}`);
    this.transcript.row('MISMATCH', `${check} — got ${actual}, corpus says ${expected}`);
  }

  private record(stage: DemoStage, fields: Record<string, string>): void {
    this.session.stages[stage] = fields;
    this.session.updatedAt = new Date().toISOString();
    writeJson(this.sessionPath, this.session);
  }

  /// The case files as the chain and the arbiter will see them.
  ///
  /// Rebuilt from the session rather than held across stages, so a resumed run
  /// produces byte-identical files. Anything that would change the hash — the
  /// job id, the submission time — comes from the recorded session, never from
  /// the clock.
  private async case(): Promise<EvidenceCase> {
    if (this.evidenceCase !== null) return this.evidenceCase;

    if (this.session.jobId === null && this.session.predictedJobId === null) {
      this.session.predictedJobId = (await this.clients.buyer.nextJobId()).toString();
    }
    const built = caseFor(this.scenario, {
      jobId: Number(this.jobId()),
      parties: this.parties(),
      submittedAt: this.session.submittedAt,
    });
    const termsHash = hashCanonical(built.terms);
    const disputeHash = disputeHashOf(built);
    if (this.session.termsHash !== null && this.session.termsHash !== termsHash) {
      throw new Error(
        `rebuilt terms hash ${termsHash} but this session recorded ${this.session.termsHash}; the corpus changed under a live session`,
      );
    }
    if (this.session.disputeHash !== null && this.session.disputeHash !== disputeHash) {
      throw new Error(
        `rebuilt bundle hash ${disputeHash} but job ${this.jobId()} pinned ${this.session.disputeHash}`,
      );
    }
    this.session.termsHash = termsHash;
    this.session.deliverableHash = built.bundle.deliverableHash;
    this.session.disputeHash = disputeHash;
    this.evidenceCase = built;
    return built;
  }

  // ------------------------------------------------------------------ stages

  private async stageCase(): Promise<void> {
    this.transcript.stage('case');
    const parties = this.parties();
    const evidenceCase = await this.case();
    const jobId = this.jobId();
    const paths = writeCase(this.options.evidenceDir, jobId, evidenceCase);

    const problems = caseIntegrity(evidenceCase);
    if (problems.length > 0) {
      throw new Error(`the generated case is inconsistent: ${problems.join('; ')}`);
    }

    const termsHash = hashCanonical(evidenceCase.terms);
    const deliverableHash = evidenceCase.bundle.deliverableHash;
    const disputeHash = disputeHashOf(evidenceCase);

    this.transcript.row('buyer', parties.buyer);
    this.transcript.row('seller', parties.seller);
    this.transcript.row(
      'predicted',
      `job ${jobId} — read from nextJobId() before the batch, because batched calls cannot see each other's return values`,
    );
    this.transcript.row('terms', `${termsHash}  ${paths.terms}`);
    this.transcript.row('deliverable', `${deliverableHash}  ${paths.bundle}`);
    this.transcript.row('bundle', `${disputeHash} — what the buyer will pin at dispute time`);

    const rehearsal = this.scenario.expect;
    this.transcript.prose(
      `the offline rehearsal already knows this case: coverage ${rehearsal.coverage.toFixed(3)}, ` +
        `claim ${rehearsal.corroboration}, band ${rehearsal.band[0]}-${rehearsal.band[1]} bps. ` +
        'The live run below has to reproduce it.',
      'corpus',
    );

    this.record('case', {
      predictedJobId: jobId.toString(),
      jobId: this.session.jobId ?? '',
      submittedAt: this.session.submittedAt,
      termsHash,
      deliverableHash,
      disputeHash,
      amount: this.session.amount,
      termsPath: paths.terms,
      bundlePath: paths.bundle,
    });
  }

  private async stageApprove(): Promise<void> {
    this.transcript.stage('approve');
    const amount = tokenAmount(this.scenario.amount);

    this.transcript.row(
      'amount',
      `${formatToken(amount)} alphaUSD — the escrow pulls this with transferFromWithMemo, so the allowance comes first`,
    );
    const receipt = await this.clients.buyer.approveEscrow(amount, this.writeOptions);
    this.transcript.tx('tx', receipt.transactionHash);
    this.reportFeePayer(receipt, this.clients.buyer.address);

    this.record('approve', { hash: receipt.transactionHash, amount: amount.toString() });
  }

  private async stageOpen(): Promise<void> {
    this.transcript.stage('open');
    const jobId = this.jobId();
    const amount = tokenAmount(this.scenario.amount);
    const evidenceCase = await this.case();
    const now = Math.floor(Date.now() / 1000);

    const created = await this.clients.buyer.createAndFundJob(
      {
        seller: this.clients.seller.address,
        amount,
        termsHash: hashCanonical(evidenceCase.terms),
        deliveryDeadline: now + this.scenario.deliveryDeadlineSeconds,
        reviewWindow: this.scenario.reviewWindowSeconds,
      },
      this.writeOptions,
    );
    if (created.jobId !== jobId) {
      throw new Error(
        `createJob minted job ${created.jobId} but the evidence bundle is pinned to ${jobId}; start a fresh session with --fresh`,
      );
    }
    this.transcript.tx('tx', created.hash);
    const receipt = await this.clients.buyer.viem.getTransactionReceipt({ hash: created.hash });
    this.reportFeePayer(receipt, this.clients.buyer.address);

    const onChain = await this.clients.buyer.job(jobId);
    if (onChain.state !== 'Funded') {
      this.failures.push(`job ${jobId} is ${onChain.state} after create+fund, expected Funded`);
    }
    this.expect('job amount', amount.toString(), onChain.amount.toString());
    this.expect('job termsHash', hashCanonical(evidenceCase.terms), onChain.termsHash);
    this.transcript.row('job', `${jobId} — ${onChain.state}, ${formatToken(onChain.amount)} escrowed`);

    const funding = memoTransfers(receipt.logs).find((entry) => entry.jobId === jobId);
    if (funding === undefined) {
      this.failures.push(`the funding transaction carried no TransferWithMemo naming job ${jobId}`);
    } else {
      this.transcript.row(
        'memo',
        `bytes32(${jobId}) on the TIP-20 transfer — the stablecoin payment names the job itself`,
      );
    }

    this.session.jobId = jobId.toString();
    this.record('open', {
      hash: created.hash,
      jobId: jobId.toString(),
      deliveryDeadline: String(onChain.deliveryDeadline),
      reviewWindow: String(onChain.reviewWindow),
    });
  }

  private async stageDeliver(): Promise<void> {
    this.transcript.stage('deliver');
    const jobId = this.jobId();
    const evidenceCase = await this.case();
    const deliverableHash = evidenceCase.bundle.deliverableHash;

    const receipt = await this.clients.seller.deliver(jobId, deliverableHash, this.writeOptions);
    this.transcript.tx('tx', receipt.transactionHash);
    this.reportFeePayer(receipt, this.clients.seller.address);

    const onChain = await this.clients.seller.job(jobId);
    if (onChain.state !== 'Delivered') {
      this.failures.push(`job ${jobId} is ${onChain.state} after deliver, expected Delivered`);
    }
    this.expect('job deliverableHash', deliverableHash, onChain.deliverableHash);
    this.transcript.row(
      'committed',
      `${onChain.deliverableHash} — the hash only; the artifact stays off chain`,
    );

    this.record('deliver', { hash: receipt.transactionHash, deliverableHash });
  }

  private async stageDispute(): Promise<void> {
    this.transcript.stage('dispute');
    const jobId = this.jobId();
    const evidenceCase = await this.case();
    const disputeHash = disputeHashOf(evidenceCase);

    this.transcript.prose(
      `"${this.scenario.claim}"`,
      'claim',
    );
    const receipt = await this.clients.buyer.dispute(jobId, disputeHash, this.writeOptions);
    this.transcript.tx('tx', receipt.transactionHash);
    this.reportFeePayer(receipt, this.clients.buyer.address);

    const onChain = await this.clients.buyer.job(jobId);
    if (onChain.state !== 'Disputed') {
      this.failures.push(`job ${jobId} is ${onChain.state} after dispute, expected Disputed`);
    }
    this.expect('job disputeHash', disputeHash, onChain.disputeHash);

    // Re-derive the pin from the files on disk, which is what the arbiter does.
    const fromDisk = readCase(this.options.evidenceDir, jobId);
    const rederived = disputeHashOf(fromDisk);
    this.expect('disputeHash from disk', onChain.disputeHash, rederived);
    this.transcript.row(
      'pinned',
      `${onChain.disputeHash} — re-derived from the files on disk, so the arbiter cannot rule on anything else`,
    );

    // The dispute notifies the seller, which has 7 days to pin its own evidence.
    // The demo seller answers at once with its copy of the deliverable, so the
    // arbiter can rule without waiting out the window.
    const responseDeadline = onChain.disputedAt + SELLER_RESPONSE_WINDOW_SECONDS;
    this.transcript.row(
      'notified',
      `seller ${onChain.seller} has until ${new Date(responseDeadline * 1000).toISOString()} to respond`,
    );
    const response: SellerResponse = {
      version: 1,
      jobId: Number(jobId),
      disputeHash,
      statement:
        this.scenario.sellerStatement ??
        'The attached deliverable is the work committed on chain at delivery; it is submitted as delivered.',
      deliverable: {
        content: this.scenario.deliverable,
        contentHash: hashText(this.scenario.deliverable),
      },
      artifacts: [],
      submittedAt: this.session.submittedAt,
    };
    writeResponse(this.options.evidenceDir, jobId, response);
    const responseHash = responseHashOf(response);
    const answered = await this.clients.seller.respond(jobId, responseHash, this.writeOptions);
    this.transcript.tx('response', answered.transactionHash);
    this.reportFeePayer(answered, this.clients.seller.address);
    const afterResponse = await this.clients.seller.job(jobId);
    this.expect('job responseHash', responseHash, afterResponse.responseHash);

    this.record('dispute', {
      hash: receipt.transactionHash,
      disputeHash,
      rederived,
      response: answered.transactionHash,
      responseHash,
    });
  }

  private async stageRule(): Promise<void> {
    this.transcript.stage('rule');
    const jobId = this.jobId();
    const evidenceCase = await this.case();

    const config = await escrowArbiterConfig(this.clients.arbiter);
    this.transcript.row('signer', `${this.clients.arbiter.address} — the arbiter's own key`);
    if (config.arbiter.toLowerCase() !== this.clients.arbiter.address.toLowerCase()) {
      this.failures.push(
        `the signing key ${this.clients.arbiter.address} is not the escrow's arbiter ${config.arbiter}`,
      );
    }
    if (config.arbitrationFeeBps !== ARBITRATION_FEE_BPS) {
      this.failures.push(
        `the escrow charges ${config.arbitrationFeeBps} bps arbitration fee; the corpus predicts money at ${ARBITRATION_FEE_BPS} bps`,
      );
    }
    this.transcript.row(
      'fee schedule',
      `${config.arbitrationFeeBps} bps arbitration fee, read from the escrow (the corpus assumes ${ARBITRATION_FEE_BPS})`,
    );

    // The seller's response lives on disk next to the buyer's bundle, exactly
    // where the arbiter's watcher would read it.
    const response = readCase(this.options.evidenceDir, jobId).response;
    const result = await adjudicate({
      client: this.clients.arbiter,
      jobId,
      evidenceCase: response === undefined ? evidenceCase : { ...evidenceCase, response },
      engine: this.options.engine,
      dryRun: false,
      relay: false,
      writeOptions: this.writeOptions,
      log: (line) => this.transcript.trace(line),
    });
    this.adjudication = result;

    const { band, signals, ruling, money } = result;
    const expected = this.scenario.expect;
    this.expect(
      'coverage',
      expected.coverage.toFixed(6),
      (signals.coverage ?? Number.NaN).toFixed(6),
    );
    this.expect('claim reading', expected.corroboration, signals.corroboration);
    this.expect('admitted terms', expected.admitted.join(','), signals.admitted.join(','));
    this.expect(
      'band',
      `${expected.band[0]}-${expected.band[1]}`,
      `${band.lowBps}-${band.highBps}`,
    );
    this.expect('band centre', String(expected.center), String(band.center));
    this.expect('certified', 'true', String(result.certified));

    this.transcript.row(
      'engine',
      result.engine === 'llm'
        ? `${result.model} — a model judged inside the band`
        : `${result.model} — deterministic, no model in the loop`,
    );
    this.transcript.row(
      'signals',
      `coverage ${signals.coverage === null ? 'n/a' : signals.coverage.toFixed(3)} · ` +
        `evidence ${signals.evidenceStrength.toFixed(2)} · claim ${signals.corroboration}`,
    );
    if (signals.admitted.length > 0) {
      this.transcript.row('admitted', `${signals.admitted.join(', ')} — named only to say they are absent`);
    }
    this.transcript.prose(ruling.rationale, 'rationale');
    this.transcript.row('band', `${band.lowBps}-${band.highBps} bps around ${band.center}`);
    this.transcript.row(
      'ruling',
      `${ruling.sellerAwardBps} bps to the seller (${formatToken(money.sellerAmount)}), ` +
        `${formatToken(money.buyerAmount)} back to the buyer`,
    );
    this.transcript.row(
      'arbitration fee',
      `${formatToken(money.arbitrationFee)} — ${money.arbitrationFeeBps} bps of ${formatToken(money.amount)}, to the treasury`,
    );
    this.transcript.row('rationaleHash', `${ruling.rationaleHash} — the text stays off chain`);
    this.transcript.row('evidenceHash', `${ruling.evidenceHash} — the hash pinned at dispute time`);
    this.transcript.row(
      'digest',
      `${result.digest} ${result.certified ? '== the deployed escrow' : '!= THE DEPLOYED ESCROW'}`,
    );
    this.transcript.row(
      'recovers to',
      `${result.recovered}${result.recovered.toLowerCase() === result.registeredArbiter.toLowerCase() ? ' — the registered arbiter' : ' — NOT the registered arbiter'}`,
    );
    this.transcript.row('signature', result.signature);
    for (const note of result.notes) this.transcript.row('note', note);
    for (const flag of result.flags) this.transcript.row('flag', flag);

    this.record('rule', {
      digest: result.digest,
      signature: result.signature,
      recovered: result.recovered,
      registeredArbiter: result.registeredArbiter,
      certified: String(result.certified),
      engine: result.engine,
      model: result.model,
      sellerAwardBps: String(ruling.sellerAwardBps),
      evidenceHash: ruling.evidenceHash,
      rationaleHash: ruling.rationaleHash,
      rationale: ruling.rationale,
      issuedAt: String(ruling.issuedAt),
      validUntil: String(ruling.validUntil),
      amount: money.amount.toString(),
      arbitrationFee: money.arbitrationFee.toString(),
      arbitrationFeeBps: String(money.arbitrationFeeBps),
      sellerAmount: money.sellerAmount.toString(),
      buyerAmount: money.buyerAmount.toString(),
      band: `${band.lowBps}-${band.highBps}`,
    });
  }

  private async stageRelay(): Promise<void> {
    this.transcript.stage('relay');
    if (this.session.stages.rule === undefined) {
      this.transcript.row('note', 'this session holds no ruling yet; deriving one now — signing costs nothing');
      await this.stageRule();
    }
    const record = this.session.stages.rule;
    if (record === undefined) throw new Error('the rule stage produced no record');

    const jobId = this.jobId();
    const relayable = relayableFromRecord(record, jobId);
    const relayer = this.clients.relayer;

    this.transcript.row(
      'relayer',
      `${relayer.address} — pays for this transaction, and is not the arbiter (${relayable.registeredArbiter})`,
    );
    if (relayer.address.toLowerCase() === relayable.registeredArbiter.toLowerCase()) {
      this.failures.push('the relayer key is the arbiter key, so this stage proves nothing about permissionless relay');
    }

    const receipt = await relayer.resolve(
      jobId,
      relayable.verdict,
      relayable.signature,
      this.writeOptions,
    );
    this.transcript.tx('tx', receipt.transactionHash);
    this.reportFeePayer(receipt, relayer.address);

    const decoded = decodeVerdictResolved(receipt.logs, this.addresses.escrow);
    if (decoded === null) {
      throw new Error(`resolve tx ${receipt.transactionHash} emitted no VerdictResolved event`);
    }
    this.expect('escrow digest', relayable.digest, decoded.digest);
    this.expect('escrow awardBps', String(relayable.verdict.sellerAwardBps), String(decoded.sellerAwardBps));
    this.expect('escrow sellerAmount', relayable.money.sellerAmount.toString(), decoded.sellerAmount.toString());
    this.expect('escrow buyerAmount', relayable.money.buyerAmount.toString(), decoded.buyerAmount.toString());
    this.expect('escrow arbitrationFee', relayable.money.arbitrationFee.toString(), decoded.arbitrationFee.toString());

    const onChain = await relayer.job(jobId);
    if (onChain.state !== 'Settled') {
      this.failures.push(`job ${jobId} is ${onChain.state} after the relay, expected Settled`);
    }
    this.expect('job verdictHash', relayable.digest, onChain.verdictHash);
    this.transcript.row('settled', `${onChain.state} — verdictHash ${onChain.verdictHash}`);

    const [sellerCredit, buyerCredit] = await Promise.all([
      relayer.credits(this.parties().seller),
      relayer.credits(this.parties().buyer),
    ]);
    this.transcript.row(
      'credited',
      `seller ${formatToken(sellerCredit)} · buyer ${formatToken(buyerCredit)} — claims on the escrow, not transfers yet`,
    );

    this.record('relay', {
      hash: receipt.transactionHash,
      relayer: relayer.address,
      digest: decoded.digest,
      sellerAmount: decoded.sellerAmount.toString(),
      buyerAmount: decoded.buyerAmount.toString(),
      arbitrationFee: decoded.arbitrationFee.toString(),
      verdictHash: onChain.verdictHash,
    });
  }

  private async stageSettle(): Promise<void> {
    this.transcript.stage('settle');
    await this.withdrawCredit('seller', this.clients.seller);

    const treasury = await this.treasuryAddress();
    const holder = [this.clients.relayer, this.clients.buyer, this.clients.seller, this.clients.arbiter].find(
      (client) => client.address.toLowerCase() === treasury.toLowerCase(),
    );
    await this.withdrawCredit('buyer', this.clients.buyer);
    if (holder === undefined) {
      this.transcript.row(
        'treasury',
        `${treasury} holds the arbitration fee; no key for it in this demo, so it stays credited`,
      );
    } else {
      await this.withdrawCredit('treasury', holder);
    }
    this.record('settle', { at: new Date().toISOString() });
  }

  private async withdrawCredit(who: string, client: TempexClient): Promise<void> {
    const credit = await client.credits();
    if (credit === 0n) {
      this.transcript.row(who, 'holds no credit — nothing to withdraw');
      return;
    }
    const before = await client.tokenBalance();
    const receipt = await client.withdraw(this.writeOptions);
    const after = await client.tokenBalance();

    this.transcript.row(who, `${client.address} withdraws ${formatToken(credit)} alphaUSD`);
    this.transcript.tx('tx', receipt.transactionHash);
    this.reportFeePayer(receipt, client.address);

    const tagged = memoTransfers(receipt.logs).find(
      (entry) => entry.memo.toLowerCase() === WITHDRAW_MEMO.toLowerCase(),
    );
    if (tagged === undefined) {
      this.failures.push(`the ${who}'s payout carried no tempex.withdraw memo on the token transfer`);
    } else {
      this.transcript.row('memo', '"tempex.withdraw" on the TIP-20 transfer itself');
      this.expect(`${who} payout`, credit.toString(), tagged.amount.toString());
    }

    // The fee comes out of the same stablecoin balance as the payout, so a wallet
    // delta of exactly the credit only holds when someone else paid the fee.
    const fee = feePaid(receipt.logs);
    const selfPaid =
      fee !== null && fee.payer.toLowerCase() === client.address.toLowerCase() ? fee.amount : 0n;
    this.expect(`${who} wallet delta`, (credit - selfPaid).toString(), (after - before).toString());
    this.transcript.row('wallet', `${formatToken(before)} → ${formatToken(after)} alphaUSD`);
  }

  private async treasuryAddress(): Promise<Address> {
    return this.clients.arbiter.viem.readContract({
      address: this.addresses.escrow,
      abi: tempexEscrowAbi,
      functionName: 'treasury',
    });
  }

  /// Tempo writes the fee payer into every receipt. Printing it is how the demo
  /// shows who actually paid: the sending role, or a sponsor. `feePayer` being
  /// present is not itself sponsorship — an unsponsored transaction names its own
  /// sender — so the comparison against `sender` is the whole check.
  private reportFeePayer(
    receipt: { logs: ReceiptLogs; feePayer?: Address; feeToken?: Address },
    sender: Address,
  ): void {
    const fee = feePaid(receipt.logs);
    const payer = receipt.feePayer;
    const sponsored = payer !== undefined && payer.toLowerCase() !== sender.toLowerCase();
    const amount =
      fee === null ? 'a fee' : `${formatToken(fee.amount)} alphaUSD`;
    const mechanics = 'charged as a TIP-20 transfer, because Tempo has no gas token';

    if (sponsored) {
      this.transcript.row('fee', `sponsored by ${payer} — it paid ${amount}, ${mechanics}`);
      return;
    }
    this.transcript.row('fee', `the sender paid ${amount} — ${mechanics}`);
  }

  // -------------------------------------------------------------------- run

  async execute(): Promise<DemoResult> {
    const parties = this.parties();
    const [arbiterConfig, buyerBalance, sellerBalance] = await Promise.all([
      escrowArbiterConfig(this.clients.arbiter),
      this.clients.buyer.tokenBalance(),
      this.clients.seller.tokenBalance(),
    ]);

    this.transcript.setup([
      ['scenario', `${this.scenario.id} — ${this.scenario.title}`],
      ['premise', this.scenario.premise],
      ['chain', `${CHAIN_ID} Moderato · escrow ${this.addresses.escrow}`],
      ['explorer', explorerAddress(this.addresses.escrow)],
      ['buyer', `${parties.buyer} · ${formatToken(buyerBalance)} alphaUSD`],
      ['seller', `${parties.seller} · ${formatToken(sellerBalance)} alphaUSD`],
      ['arbiter', `${arbiterConfig.arbiter} · ${arbiterConfig.arbitrationFeeBps} bps arbitration fee`],
      ['relayer', `${this.clients.relayer.address} — a fourth key, so the relay below is not self-signed`],
      [
        'fees',
        this.options.sponsored
          ? `sponsored: every write is routed through ${SPONSOR_URL}, which pays the fee`
          : 'each role pays its own fee in alphaUSD — no gas token exists on this chain',
      ],
      ['session', this.sessionPath],
      ['stages', `${this.options.from} → ${this.options.upto} of ${DEMO_STAGES.join(' → ')}`],
    ]);

    for (const stage of DEMO_STAGES) {
      if (!this.inRange(stage)) {
        this.skipped.push(stage);
        continue;
      }
      if (!this.pending(stage)) {
        this.transcript.stage(stage);
        this.transcript.row('skip', 'already in this session — pass --force to repeat it');
        this.skipped.push(stage);
        continue;
      }
      await this.runStage(stage);
      this.ran.push(stage);
    }

    const passed = this.expectations.filter((entry) => entry.passed).length;
    this.transcript.blank();
    this.transcript.row(
      'corpus',
      `${passed}/${this.expectations.length} expectations from scenarios.ts held against the live chain`,
    );
    for (const failure of this.failures) this.transcript.row('FAILURE', failure);

    const receipt = this.buildReceipt();
    const receiptPath = writeJson(
      join(this.options.runsDir, `demo-${this.scenario.id}-${runStamp()}.json`),
      receipt,
    );
    this.transcript.row('receipt', receiptPath);

    return {
      ok: this.failures.length === 0,
      failures: this.failures,
      expectations: this.expectations,
      session: this.session,
      sessionPath: this.sessionPath,
      receiptPath,
      ran: this.ran,
      skipped: this.skipped,
      adjudication: this.adjudication,
      receipt,
    };
  }

  private async runStage(stage: DemoStage): Promise<void> {
    switch (stage) {
      case 'case':
        return this.stageCase();
      case 'approve':
        return this.stageApprove();
      case 'open':
        return this.stageOpen();
      case 'deliver':
        return this.stageDeliver();
      case 'dispute':
        return this.stageDispute();
      case 'rule':
        return this.stageRule();
      case 'relay':
        return this.stageRelay();
      case 'settle':
        return this.stageSettle();
    }
  }

  private buildReceipt(): Record<string, unknown> {
    return {
      tempex: 'demo-receipt/1',
      scenario: this.scenario.id,
      title: this.scenario.title,
      premise: this.scenario.premise,
      at: new Date().toISOString(),
      chainId: CHAIN_ID,
      escrow: this.addresses.escrow,
      escrowExplorer: explorerAddress(this.addresses.escrow),
      sponsored: this.options.sponsored,
      ran: this.ran,
      skipped: this.skipped,
      ok: this.failures.length === 0,
      failures: this.failures,
      expectations: this.expectations,
      parties: this.parties(),
      session: this.session,
      sessionPath: this.sessionPath,
      corpus: this.scenario.expect,
      transcript: this.transcript.recorded(),
      ...(this.adjudication !== null ? { adjudication: this.adjudication } : {}),
    };
  }
}

function sessionFile(dir: string, name: string): string {
  return join(dir, `demo-${name}.json`);
}

function freshSession(scenario: Scenario, name: string): DemoSession {
  const at = new Date().toISOString();
  return {
    tempex: 'demo-session/1',
    scenario: scenario.id,
    title: scenario.title,
    session: name,
    startedAt: at,
    updatedAt: at,
    submittedAt: at,
    predictedJobId: null,
    jobId: null,
    termsHash: null,
    deliverableHash: null,
    disputeHash: null,
    amount: tokenAmount(scenario.amount).toString(),
    stages: {},
  };
}

function loadSession(path: string, scenario: Scenario, name: string, fresh: boolean): DemoSession {
  if (fresh) return freshSession(scenario, name);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DemoSession;
  } catch {
    return freshSession(scenario, name);
  }
}

function runClients(addresses: TempexAddresses, sponsored: boolean): Record<DemoRole, TempexClient> {
  const build = (role: DemoRole): TempexClient =>
    new TempexClient({
      account: accountFor(privateKeyFor(ROLE_KEY[role])),
      addresses,
      ...(sponsored ? { sponsorUrl: SPONSOR_URL } : {}),
    });
  return {
    buyer: build('buyer'),
    seller: build('seller'),
    arbiter: build('arbiter'),
    relayer: build('relayer'),
  };
}

/// Runs the demo end to end, or the slice of it the caller asked for.
export async function runDemo(options: DemoOptions): Promise<DemoResult> {
  loadEnv(repoRoot());
  const scenarios = options.scenario;
  const from = options.from ?? 'case';
  const upto = options.upto ?? 'settle';
  if (stageIndex(from) > stageIndex(upto)) {
    throw new Error(`--from ${from} comes after --upto ${upto}; the stages only run in order`);
  }

  const runsDir = resolveRunsDir(options.runsDir);
  const evidenceDir = resolveEvidenceDir(options.evidenceDir);
  const name = options.session ?? scenarios.id;
  const sessionPath = sessionFile(runsDir, name);
  const resolved: ResolvedOptions = {
    scenario: scenarios,
    from,
    upto,
    sponsored: options.sponsored ?? false,
    force: options.force ?? false,
    fresh: options.fresh ?? false,
    engine: options.engine ?? 'auto',
    session: name,
    evidenceDir,
    runsDir,
    write: options.write,
  };

  const addresses = addressesFromEnv();
  const clients = runClients(addresses, resolved.sponsored);
  const session = loadSession(sessionPath, scenarios, name, resolved.fresh);

  return new DemoRun({
    scenario: scenarios,
    options: resolved,
    addresses,
    clients,
    sessionPath,
    session,
  }).execute();
}
