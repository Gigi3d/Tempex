import { explorerTx } from '@tempex/sdk';
import type { Hex } from 'viem';

/// The demo's spine, in the order the stages must happen. A later stage consumes
/// what an earlier one wrote, so this list is also the dependency graph: `--from`
/// and `--upto` may only slice it, never reorder it.
export const DEMO_STAGES = [
  'case',
  'approve',
  'open',
  'deliver',
  'dispute',
  'rule',
  'relay',
  'settle',
] as const;

export type DemoStage = (typeof DEMO_STAGES)[number];

/// What each stage is for, in the words the presenter can read off the screen.
/// Kept next to the stage list so the CLI's help and the live transcript cannot
/// describe the demo differently.
export const STAGE_META: Record<DemoStage, { title: string; point: string }> = {
  case: {
    title: 'pin the case',
    point:
      'terms, deliverable and claim are hashed before anything is written to the chain; the same files go to the arbiter',
  },
  approve: {
    title: 'buyer approves the escrow',
    point:
      'the escrow pulls the money later, so the allowance comes first — one approval covers every job this buyer opens',
  },
  open: {
    title: 'create and fund in one transaction',
    point:
      'two calls in a single Tempo transaction: a job can never exist without the money behind it',
  },
  deliver: {
    title: 'seller delivers',
    point:
      'only the hash is committed on chain; the artifact itself stays off chain and is handed to the arbiter with the claim',
  },
  dispute: {
    title: 'buyer disputes',
    point:
      'the bundle hash is pinned here, so the arbiter is later forced to rule on exactly these bytes',
  },
  rule: {
    title: 'arbiter rules',
    point:
      'the text signals fix a band first, the ruling is derived, then certified against the deployed escrow before anything is broadcast',
  },
  relay: {
    title: 'an unrelated key relays',
    point:
      'settlement is permissionless: the key paying for this transaction is not the arbiter, and the escrow still pays out',
  },
  settle: {
    title: 'parties withdraw',
    point:
      'payments land as TIP-20 transfers tagged tempex.withdraw, so the settlement is reconcilable on the token itself',
  },
};

export type Beat = {
  stage: DemoStage | 'setup';
  label: string;
  value: string;
  tx?: Hex;
  link?: string;
};

const TOTAL_WIDTH = 88;
const LABEL_WIDTH = 11;
const WRAP_WIDTH = TOTAL_WIDTH - LABEL_WIDTH;

function wrap(text: string, width: number = WRAP_WIDTH): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line.length === 0) line = word;
    else if (`${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else line += ` ${word}`;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/// Records what the demo says while it says it.
///
/// Every line goes through here, so the transcript on screen and the JSON
/// receipt are one artifact read twice. A presenter narrating from the screen
/// cannot claim more than the run did, because there is nowhere else to write
/// the sentences.
export class Transcript {
  private readonly beats: Beat[] = [];
  private current: DemoStage | 'setup' = 'setup';

  constructor(
    private readonly write: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
  ) {}

  /// The header: who the parties are, which chain, and how the run is configured.
  setup(rows: readonly (readonly [string, string])[]): void {
    for (const [label, value] of rows) {
      const parts = wrap(value);
      parts.forEach((part, index) => {
        this.beats.push({ stage: 'setup', label, value: part });
        this.write(`${(index === 0 ? label : '').padEnd(LABEL_WIDTH)}${part}`);
      });
    }
  }

  /// Opens a stage: a rule, then the one line that says what to notice here.
  stage(stage: DemoStage): void {
    this.current = stage;
    const meta = STAGE_META[stage];
    const head = `── ${stage} `;
    this.write('');
    this.write(`${head}${'─'.repeat(Math.max(0, TOTAL_WIDTH - head.length))}`);
    const line = `${meta.title} — ${meta.point}`;
    for (const [index, part] of wrap(line).entries()) {
      this.beats.push({ stage, label: index === 0 ? 'point' : '', value: part });
      this.write(`${(index === 0 ? 'point' : '').padEnd(LABEL_WIDTH)}${part}`);
    }
  }

  /// A labelled fact, padded into a column.
  row(label: string, value: string): void {
    this.beats.push({ stage: this.current, label, value });
    this.write(`${label.padEnd(LABEL_WIDTH)}${value}`);
  }

  /// A transaction hash plus the explorer permalink that proves it. The link is
  /// printed in full because the presenter opens it in front of the room.
  tx(label: string, hash: Hex): void {
    const link = explorerTx(hash);
    this.beats.push({ stage: this.current, label, value: hash, tx: hash, link });
    this.write(`${label.padEnd(LABEL_WIDTH)}${hash}`);
    this.write(`${''.padEnd(LABEL_WIDTH)}${link}`);
  }

  /// Free prose, wrapped, attributed to a label on the first line only.
  prose(text: string, label = ''): void {
    this.beats.push({ stage: this.current, label, value: text });
    for (const [index, line] of wrap(text).entries()) {
      this.write(`${(index === 0 ? label : '').padEnd(LABEL_WIDTH)}${line}`);
    }
  }

  /// A line one of the engines logged. Visually subordinate to the demo's own
  /// rows — it is the machine talking — but recorded just the same.
  trace(line: string, label = '·'): void {
    this.beats.push({ stage: this.current, label, value: line });
    this.write(`${label.padEnd(LABEL_WIDTH)}${line}`);
  }

  blank(): void {
    this.write('');
  }

  recorded(): readonly Beat[] {
    return this.beats;
  }
}
