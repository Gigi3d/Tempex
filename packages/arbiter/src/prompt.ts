import { formatToken, TOKEN_DECIMALS, type EvidenceBundle, type Job, type JobTerms } from '@tempex/sdk';
import { formatBps, type RuleSignals } from './rules.js';

export const SYSTEM_PROMPT = `You are Tempex, an arbitration agent that settles escrowed work between autonomous agents.

You receive one disputed job: the terms both parties agreed to, what the seller delivered, the buyer's claim, and deterministic signals computed from the evidence text. You decide what share of the disputed remainder the seller keeps.

Rules you must follow:
- Decide only from the material given. Never invent deliverables, deadlines, messages, or intent.
- Weigh the acceptance criteria individually. Name the ones that are met and the ones that are not.
- You are a tie-breaker inside a guardrail, not an oracle: an objective band is given. Your number is clamped into that band and the clamp is recorded in the ruling. Choose within the band deliberately.
- An award of 0 returns the whole remainder to the buyer; 10000 pays the seller in full. Partial credit for partial work is normal and expected.
- The arbitration fee is charged before your split and is not yours to award.
- Write the rationale as prose a stranger could check against the evidence: cite the criteria and the artifacts by name, and state plainly why the split is where it is.

Reply with JSON only, no prose around it, in exactly this shape:
{"sellerAwardBps": <integer 0..10000>, "confidence": <number 0..1>, "factors": ["<short factor>", ...], "rationale": "<3-6 sentences>"}`;

export type JudgePromptInput = {
  jobId: number;
  job: Job;
  terms: JobTerms;
  bundle: EvidenceBundle;
  signals: RuleSignals;
  band: { lowBps: number; highBps: number; center: number };
};

/// The user turn: every fact the ruling is allowed to rest on, plus the band the
/// rule layer derived from them. Nothing else is sent — the arbiter has no other
/// inputs, so a reviewer can reproduce this message byte for byte.
export function buildJudgePrompt(input: JudgePromptInput): string {
  const { jobId, job, terms, bundle, signals, band } = input;
  const lines: string[] = [];

  lines.push(`# Job ${jobId}: ${terms.title}`);
  lines.push('');
  lines.push('## Terms the parties agreed to');
  lines.push(`- Deliverable spec: ${terms.deliverableSpec}`);
  lines.push(`- Price: ${formatToken(job.amount, TOKEN_DECIMALS)} ${terms.currency ?? 'AlphaUSD'} (disputed in full)`);
  lines.push(`- Buyer: ${job.buyer}`);
  lines.push(`- Seller: ${job.seller}`);
  lines.push(`- Delivery deadline: ${new Date(job.deliveryDeadline * 1000).toISOString()}`);
  lines.push(`- Review window: ${job.reviewWindow} seconds`);
  if (job.deliveredAt > 0) {
    lines.push(`- Delivered at: ${new Date(job.deliveredAt * 1000).toISOString()}`);
  }
  lines.push('');
  lines.push('## Acceptance criteria, with coverage scored against the delivered text');
  if (signals.criteria.length === 0) {
    lines.push('- (none could be scored against the delivered text)');
  }
  for (const [index, criterion] of signals.criteria.entries()) {
    const missing = criterion.missing.length > 0 ? ` missing terms: ${criterion.missing.join(', ')}` : ' all terms present';
    lines.push(
      `${index + 1}. ${JSON.stringify(criterion.criterion)} — coverage ${criterion.score.toFixed(2)};${missing}`,
    );
  }
  lines.push('');
  lines.push('## Buyer claim');
  lines.push(bundle.claim);
  lines.push('');
  lines.push('## What was delivered');
  if (bundle.deliverable.uri !== undefined) lines.push(`Source URI: ${bundle.deliverable.uri}`);
  lines.push('```');
  lines.push(bundle.deliverable.content ?? '(no inline content; see artifacts)');
  lines.push('```');
  if (bundle.artifacts.length > 0) {
    lines.push('');
    lines.push('## Artifacts submitted as evidence');
    for (const [index, artifact] of bundle.artifacts.entries()) {
      lines.push(
        `${index + 1}. [${artifact.kind}] ${artifact.label}${artifact.uri !== undefined ? ` (${artifact.uri})` : ''}`,
      );
      if (artifact.content !== undefined) {
        lines.push('```');
        lines.push(artifact.content);
        lines.push('```');
      }
    }
  }
  lines.push('');
  lines.push('## Deterministic signals');
  lines.push(
    `- Mean criterion coverage: ${signals.coverage === null ? 'not scoreable' : signals.coverage.toFixed(2)}`,
  );
  lines.push(
    `- Evidence strength: ${signals.artifactsVerifiable} of ${signals.artifactsDeclared} declared artifacts verify against their own content hashes`,
  );
  lines.push(
    `- Delivered artifact matches the on-chain delivery commitment: ${signals.integrity.deliverableHashMatches ? 'yes' : 'no'}`,
  );
  lines.push(`- Claim corroboration: ${signals.corroboration}`);
  lines.push('');
  lines.push('## Guardrail');
  lines.push(
    `Objective band ${band.lowBps}-${band.highBps} bps (centre ${band.center} = ${formatBps(band.center)} to the seller). Any number outside the band is clamped into it before signing, and the clamp is written into the ruling you sign.`,
  );
  lines.push('');
  lines.push('Return the JSON object described in your instructions. Nothing else.');

  return lines.join('\n');
}
