import {
  caseIntegrity,
  disputeHashOf,
  readCase,
  tempexEscrowAbi,
  WS_URL,
  type EvidenceCase,
  type TempexClient,
  type WriteOptions,
} from '@tempex/sdk';
import { createClient } from 'viem/tempo';
import { http, webSocket, type Hex, type Transport } from 'viem';
import { tempoTestnet } from 'viem/tempo/chains';

import { adjudicate, type AdjudicationEngine, type AdjudicationResult } from './adjudicate.js';
import type { LlmConfig } from './llm.js';

export type WatchOptions = {
  client: TempexClient;
  evidenceDir: string;
  runsDir: string;
  engine?: AdjudicationEngine;
  llm?: LlmConfig | null;
  ttlSeconds?: number;
  /// First block scanned for disputes the arbiter missed while it was offline.
  fromBlock?: bigint;
  /// Relay the verdict as well as signing it.
  relay?: boolean;
  /// Poll for logs instead of subscribing over the WebSocket endpoint.
  poll?: boolean;
  pollIntervalMs?: number;
  /// Scan history once and exit. Cron-friendly: a keeper can run the arbiter for
  /// seconds at a time instead of holding a socket open.
  once?: boolean;
  /// How often a dispute whose evidence has not landed yet is retried.
  retryMs?: number;
  /// Tempo knobs for the relay transaction (nonce lane, validity window, sponsor).
  writeOptions?: WriteOptions;
  log?: (line: string) => void;
  /// Called for every ruling produced, before it is written to disk.
  onRuling?: (result: AdjudicationResult) => void;
};

export type WatchHandle = {
  stop: () => void;
  /// Disputes seen but not yet ruled on, keyed by job id.
  pending: () => string[];
  /// Jobs ruled on in this process, keyed by job id.
  settled: () => string[];
  /// Jobs the arbiter refused or failed on, with the reason.
  failures: () => Record<string, string>;
};

/// The agentic loop: watch the escrow for disputes and rule on them without a
/// human in the middle.
///
/// Two entry points into the same handler, because an agent that only hears about
/// disputes opened while it happens to be running is not an arbitration service:
/// a catch-up scan over past logs, then a live subscription.
export async function watchDisputes(options: WatchOptions): Promise<WatchHandle> {
  const log = options.log ?? (() => {});
  const escrow = options.client.addresses.escrow;
  const pending = new Map<string, { jobId: bigint }>();
  const settled = new Set<string>();
  const failures: Record<string, string> = {};
  const inFlight = new Set<string>();
  /// Rulings still running, so `once` can wait for the answer it promised.
  const running = new Set<Promise<void>>();
  let stopped = false;

  const retryMs = options.retryMs ?? 5_000;
  const poll = options.poll ?? false;

  // A dedicated read client: watching should not share a nonce lane or a fee
  // budget with the transactions the arbiter submits.
  const transport: Transport = poll ? http() : webSocket(WS_URL);
  const watcher = createClient({ chain: tempoTestnet, transport });

  async function rule(jobId: bigint): Promise<void> {
    const key = jobId.toString();
    if (inFlight.has(key) || settled.has(key) || stopped) return;
    inFlight.add(key);

    try {
      const job = await options.client.job(jobId);
      if (job.state !== 'Disputed') {
        log(`job ${key}: ${job.state}, nothing to rule on`);
        pending.delete(key);
        settled.add(key);
        return;
      }

      let evidenceCase: EvidenceCase;
      try {
        evidenceCase = readCase(options.evidenceDir, jobId);
      } catch {
        log(`job ${key}: disputed, waiting for the buyer's evidence bundle in ${options.evidenceDir}`);
        return;
      }

      const problems = caseIntegrity(evidenceCase);
      if (problems.length > 0) {
        failures[key] = problems.join('; ');
        pending.delete(key);
        log(`job ${key}: evidence case is inconsistent — ${failures[key]}`);
        return;
      }

      const disputeHash = disputeHashOf(evidenceCase);
      if (job.disputeHash.toLowerCase() !== disputeHash.toLowerCase()) {
        failures[key] = `bundle hashes to ${disputeHash}, on-chain dispute is ${job.disputeHash}`;
        pending.delete(key);
        log(`job ${key}: refusing — ${failures[key]}`);
        return;
      }

      const result = await adjudicate({
        client: options.client,
        jobId,
        evidenceCase,
        engine: options.engine,
        llm: options.llm,
        ttlSeconds: options.ttlSeconds,
        relay: options.relay,
        writeOptions: options.writeOptions,
        log: (line) => log(`job ${key}: ${line}`),
      });

      settled.add(key);
      pending.delete(key);
      log(
        `job ${key}: ruled ${result.ruling.sellerAwardBps} bps via ${result.model}${
          result.relay ? `, relayed in ${result.relay.hash}` : ' (signature only)'
        }`,
      );
      options.onRuling?.(result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures[key] = reason;
      pending.delete(key);
      log(`job ${key}: failed — ${reason}`);
    } finally {
      inFlight.delete(key);
    }
  }

  function enqueue(jobId: bigint, disputeHash: Hex, disputedAt: bigint): void {
    const key = jobId.toString();
    if (settled.has(key) || inFlight.has(key)) return;
    pending.set(key, { jobId });
    log(
      `DisputeRaised job ${key} at ${new Date(Number(disputedAt) * 1000).toISOString()} (${disputeHash.slice(0, 10)}…)`,
    );
    // Started, not awaited: the catch-up scan must not block on the first
    // dispute it finds. `running` is what lets a one-shot run wait for all of them.
    const task = rule(jobId);
    running.add(task);
    void task.finally(() => running.delete(task));
  }

  // ---- catch up on anything opened while the arbiter was not running ----
  const past = await watcher.getContractEvents({
    address: escrow,
    abi: tempexEscrowAbi,
    eventName: 'DisputeRaised',
    strict: true,
    fromBlock: options.fromBlock ?? 0n,
    toBlock: 'latest',
  });
  if (past.length > 0) log(`catch-up: ${past.length} dispute(s) in escrow history`);
  for (const entry of past) {
    enqueue(entry.args.jobId, entry.args.disputeHash, entry.args.disputedAt);
  }

  // ---- then live ----
  if (options.once === true) {
    while (running.size > 0) await Promise.allSettled([...running]);
    log(`catch-up only: ${settled.size} ruled, ${pending.size} still waiting for evidence`);
    return {
      stop: () => {
        stopped = true;
      },
      pending: () => [...pending.keys()],
      settled: () => [...settled],
      failures: () => ({ ...failures }),
    };
  }

  const unsubscribe = watcher.watchContractEvent({
    address: escrow,
    abi: tempexEscrowAbi,
    eventName: 'DisputeRaised',
    strict: true,
    ...(options.poll ? { poll: true, pollingInterval: options.pollIntervalMs ?? 4_000 } : {}),
    onLogs: (entries) => {
      for (const entry of entries) {
        enqueue(entry.args.jobId, entry.args.disputeHash, entry.args.disputedAt);
      }
    },
    onError: (error) => log(`subscription error: ${error.message}`),
  });

  const retry = setInterval(() => {
    for (const [, { jobId }] of pending) void rule(jobId);
  }, retryMs);

  log(
    `watching ${escrow} for DisputeRaised over ${poll ? 'http polling' : 'websocket'} — ${pending.size} pending`,
  );

  return {
    stop: () => {
      stopped = true;
      clearInterval(retry);
      unsubscribe();
    },
    pending: () => [...pending.keys()],
    settled: () => [...settled],
    failures: () => ({ ...failures }),
  };
}
