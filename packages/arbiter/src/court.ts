import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { caseIntegrity, writeCase, type EvidenceCase, type TempexClient } from '@tempex/sdk';

import { RefusalError, adjudicate, type AdjudicationEngine, type AdjudicationResult } from './adjudicate.js';

/// The arbiter as an HTTP service: anyone may hand it the evidence for a
/// disputed job, and it rules only if that evidence is exactly what the parties
/// pinned on chain. Every check lives in `adjudicate`: the bundle must hash to
/// the job's disputeHash, the terms to the bundle's termsHash, the job must name
/// this key as its arbiter, and the seller must have responded or run out of time.
/// The key never leaves this process; callers receive the verdict and the relay
/// transaction, nothing they could sign with.
export type CourtOptions = {
  client: TempexClient;
  port: number;
  host?: string;
  engine?: AdjudicationEngine;
  /// Origins allowed to call from a browser. Empty allows none; '*' allows any.
  origins: string[];
  evidenceDir: string;
  sponsored: boolean;
  log?: (line: string) => void;
  onRuling?: (result: AdjudicationResult) => void;
};

const MAX_BODY_BYTES = 256 * 1024;

function send(response: ServerResponse, status: number, body: unknown, origin: string | null): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}),
  });
  response.end(JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error(`the evidence is larger than ${MAX_BODY_BYTES / 1024} KiB`);
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isCase(value: unknown): value is EvidenceCase {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['terms'] === 'object' && v['terms'] !== null && typeof v['bundle'] === 'object' && v['bundle'] !== null;
}

export function startCourt(options: CourtOptions): { close: () => Promise<void>; url: string } {
  const log = options.log ?? (() => {});
  // One ruling per job at a time: a second request while the first is relaying
  // would only race it to the same verdict.
  const inFlight = new Set<string>();

  const server = createServer(async (request, response) => {
    const requestOrigin = request.headers.origin ?? null;
    const origin =
      requestOrigin && (options.origins.includes('*') || options.origins.includes(requestOrigin)) ? requestOrigin : null;
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}),
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
      response.end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://court');
    if (request.method === 'GET' && url.pathname === '/health') {
      send(response, 200, { ok: true, arbiter: options.client.address, escrow: options.client.addresses.escrow, sponsored: options.sponsored }, origin);
      return;
    }
    const match = /^\/rule\/(\d+)$/.exec(url.pathname);
    if (request.method !== 'POST' || !match) {
      send(response, 404, { error: 'not_found', message: 'POST /rule/:jobId with { terms, bundle, response? }, or GET /health' }, origin);
      return;
    }
    const jobId = match[1]!;
    if (inFlight.has(jobId)) {
      send(response, 409, { error: 'busy', message: `job ${jobId} is already being ruled; fetch it again in a few seconds` }, origin);
      return;
    }
    let evidenceCase: unknown;
    try {
      evidenceCase = await readBody(request);
    } catch (error) {
      send(response, 400, { error: 'bad_request', message: (error as Error).message }, origin);
      return;
    }
    if (!isCase(evidenceCase)) {
      send(response, 400, { error: 'bad_request', message: 'the body must be an evidence case: { terms, bundle, response? }' }, origin);
      return;
    }
    const problems = caseIntegrity(evidenceCase);
    if (problems.length > 0) {
      send(response, 422, { error: 'inconsistent_case', problems }, origin);
      return;
    }

    inFlight.add(jobId);
    try {
      log(`job ${jobId}: evidence received, adjudicating`);
      const result = await adjudicate({
        client: options.client,
        jobId: BigInt(jobId),
        evidenceCase,
        engine: options.engine,
        relay: true,
        writeOptions: options.sponsored ? { sponsored: true } : {},
        log: (line) => log(`job ${jobId}: ${line}`),
      });
      // The case files are the record a stranger re-derives the ruling from.
      writeCase(options.evidenceDir, BigInt(jobId), evidenceCase);
      options.onRuling?.(result);
      log(`job ${jobId}: ruled ${result.ruling.sellerAwardBps} bps${result.relay ? `, relayed in ${result.relay.hash}` : ''}`);
      send(
        response,
        200,
        {
          jobId,
          engine: result.engine,
          model: result.ruling.model,
          sellerAwardBps: result.ruling.sellerAwardBps,
          rationale: result.ruling.rationale,
          band: result.band,
          boundedBand: result.boundedBand,
          clamped: result.clamped,
          money: result.money,
          digest: result.digest,
          signature: result.signature,
          relay: result.relay ?? null,
        },
        origin,
      );
    } catch (error) {
      if (error instanceof RefusalError) {
        send(response, 409, { error: 'refused', reasons: error.reasons }, origin);
      } else {
        log(`job ${jobId}: ${(error as Error).message}`);
        send(response, 502, { error: 'failed', message: (error as Error).message }, origin);
      }
    } finally {
      inFlight.delete(jobId);
    }
  });

  server.listen(options.port, options.host ?? '0.0.0.0');
  return {
    url: `http://${options.host ?? '0.0.0.0'}:${options.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
