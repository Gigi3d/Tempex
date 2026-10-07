import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import type { PanelCache } from './adjudicate.js';
import type { PanelVerdict } from './llm.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/// Walks up from this file to the workspace root so the arbiter finds `evidence/`
/// and `runs/` no matter which directory pnpm launched it from (pnpm runs package
/// scripts with the package directory as cwd).
export function repoRoot(start: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(start);
  for (let hops = 0; hops < 8; hops += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/// Cases the arbiter reads: terms + evidence bundle per job, written by the buyer.
export function evidenceDir(override?: string): string {
  if (override !== undefined) return resolve(override);
  const fromEnv = process.env['TEMPEX_EVIDENCE_DIR'];
  return fromEnv ? resolve(fromEnv) : join(repoRoot(), 'evidence');
}

/// Receipts the arbiter writes: the full ruling, the signature, and the digests.
export function runsDir(override?: string): string {
  if (override !== undefined) return resolve(override);
  const fromEnv = process.env['TEMPEX_RUNS_DIR'];
  return fromEnv ? resolve(fromEnv) : join(repoRoot(), 'runs');
}

/// Timestamp suffix that sorts chronologically and is safe as a filename.
export function runStamp(at: number = Date.now()): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

/// Receipts are full of token amounts and timestamps carried as bigint, which
/// JSON.stringify throws on. They are written as decimal strings: `BigInt(text)`
/// reads them back exactly, which a double would not.
function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, jsonSafe, 2)}\n`;
}

export function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jsonText(value));
  return path;
}

export function receiptPath(jobId: number | bigint, at: number = Date.now(), dir?: string): string {
  return join(runsDir(dir), `job-${jobId}-${runStamp(at)}.json`);
}

/// Panel verdicts on disk, one file per exact set of inputs, so a retry after a
/// crash or a failed relay re-signs the scores already paid for. Gitignored: the
/// receipt is the public record; this is only a memo.
export function filePanelCache(dir: string = join(runsDir(), 'panels')): PanelCache {
  const path = (key: string): string => join(dir, `${key.replace(/[^0-9a-f]/gi, '').slice(0, 64)}.json`);
  return {
    get(key) {
      try {
        return JSON.parse(readFileSync(path(key), 'utf8')) as PanelVerdict;
      } catch {
        return undefined;
      }
    },
    set(key, verdict) {
      writeJson(path(key), verdict);
    },
  };
}
