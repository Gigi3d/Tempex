/// OpenAI-compatible chat completions over plain fetch, and the judge panel built
/// on them. No SDK dependency: the arbiter talks to one endpoint and this keeps the
/// dependency surface of a component that signs money-moving verdicts small.
///
/// The model never proposes an award. Each panel member scores only the
/// criteria code could not decide, each score must cite the delivered work, and
/// the arbiter keeps the median of the scores whose citations it could verify.

export type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  /// Models to seat on the panel, in order. One model is seated repeatedly with
  /// sampling on, so its members are independent draws rather than one answer
  /// copied three times.
  models: string[];
  /// How many judges sit on the panel.
  panelSize: number;
  timeoutMs: number;
};

export class LlmError extends Error {
  override readonly name = 'LlmError';
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PANEL_SIZE = 3;
/// Sampling temperature for a model seated more than once. Distinct draws are
/// the point of a panel; at temperature 0 they would all be the same draw.
const REPEAT_TEMPERATURE = 0.7;
/// A score at or above this claims the criterion was (mostly) met, and is only
/// counted with a citation the arbiter can find in the delivered work. Absence
/// cannot be quoted, so lower scores need none.
const CREDIT_NEEDS_EVIDENCE = 0.5;
/// Neutral score for an open criterion no judge could support: neither awarded
/// nor refused, the same rule the escrow uses for a lapsed dispute.
const NEUTRAL_SCORE = 0.5;
const MIN_QUOTE_CHARS = 3;

/// Returns null when no key is configured. The arbiter reads this and falls back
/// to the rule engine rather than failing: an unconfigured judge must never be
/// able to stall a dispute.
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = env['OPENAI_API_KEY']?.trim();
  if (!apiKey) return null;
  const timeout = Number(env['OPENAI_TIMEOUT_MS'] ?? DEFAULT_TIMEOUT_MS);
  const models = (env['OPENAI_MODEL']?.trim() || DEFAULT_MODEL)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const panel = Number(env['TEMPEX_JUDGE_PANEL'] ?? DEFAULT_PANEL_SIZE);
  return {
    apiKey,
    baseUrl: (env['OPENAI_BASE_URL']?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    models,
    panelSize: Number.isInteger(panel) && panel >= 1 && panel <= 9 ? panel : DEFAULT_PANEL_SIZE,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

async function post(
  config: LlmConfig,
  body: Record<string, unknown>,
): Promise<{ content: string; raw: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new LlmError(
        `judge endpoint returned ${response.status}: ${text.slice(0, 400)}`,
        response.status,
      );
    }

    const parsed = JSON.parse(text) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new LlmError('judge endpoint returned no message content');
    }
    return { content, raw: text };
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new LlmError(`judge endpoint timed out after ${config.timeoutMs}ms`);
    }
    throw new LlmError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

/// Models wrap JSON in prose or fences often enough that a tolerant extractor is
/// cheaper than a retry loop. Validated hard afterwards either way.
function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new LlmError(`no JSON object in judge reply: ${trimmed.slice(0, 200)}`);
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new LlmError(
      `judge reply was not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/// One chat completion. JSON mode first; only a rejected request shape earns a
/// retry without it, since a bad key or a timeout would fail the same way twice.
export async function complete(
  config: LlmConfig,
  request: { model: string; system: string; user: string; temperature: number },
): Promise<string> {
  const base: Record<string, unknown> = {
    model: request.model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    temperature: request.temperature,
  };
  try {
    return (await post(config, { ...base, response_format: { type: 'json_object' } })).content;
  } catch (error) {
    const status = error instanceof LlmError ? error.status : undefined;
    if (status !== 400 && status !== 422) throw error;
    return (await post(config, base)).content;
  }
}

/// What one panel member said about one open criterion.
export type MemberScore = {
  id: string;
  score: number;
  quotes: string[];
  /// quotes found verbatim in the delivered work
  verifiedQuotes: string[];
  /// counted toward the median: below the evidence bar, or above it with at
  /// least one verified quote
  accepted: boolean;
};

export type PanelMember = {
  seat: number;
  model: string;
  temperature: number;
  /// null when the member failed (endpoint error, unusable reply)
  scores: MemberScore[] | null;
  rationale: string;
  error?: string;
};

export type PanelCriterion = {
  id: string;
  /// median of the accepted scores, or the neutral score when none was accepted
  score: number;
  accepted: number;
  discarded: number;
  neutral: boolean;
};

export type PanelVerdict = {
  members: PanelMember[];
  criteria: PanelCriterion[];
  /// e.g. "panel 3×gpt-4o-mini"
  label: string;
};

/// Whitespace-insensitive, Unicode-normalized, case-sensitive containment. A
/// quote must really be in the work; reflowed line breaks should not void it.
function normalizeForQuote(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/// JSON escapes in a raw JSON deliverable (\" \n é) are decoded before a
/// quote is looked up, so a judge quoting a string value as it reads is found.
function quoteHaystack(deliverable: string): string {
  let decoded = deliverable;
  try {
    const values: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') values.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          values.push(key);
          walk(value);
        }
      }
    };
    walk(JSON.parse(deliverable));
    decoded = `${deliverable}\n${values.join('\n')}`;
  } catch {
    // not JSON: the raw text is the haystack
  }
  return normalizeForQuote(decoded);
}

function parseMemberReply(content: string, openIds: readonly string[], haystack: string): {
  scores: MemberScore[];
  rationale: string;
} {
  const value = extractJson(content);
  if (typeof value !== 'object' || value === null) throw new LlmError('judge reply was not a JSON object');
  const record = value as Record<string, unknown>;
  const list = record['criteria'];
  if (!Array.isArray(list)) throw new LlmError('judge reply has no "criteria" list');
  const byId = new Map<string, MemberScore>();
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = e['id'];
    const raw = e['score'];
    if (typeof id !== 'string' || !openIds.includes(id) || byId.has(id)) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const score = Math.max(0, Math.min(1, raw));
    const quotes = Array.isArray(e['quotes'])
      ? e['quotes'].filter((q): q is string => typeof q === 'string').slice(0, 8)
      : [];
    const verifiedQuotes = quotes.filter((quote) => {
      const needle = normalizeForQuote(quote);
      return needle.length >= MIN_QUOTE_CHARS && haystack.includes(needle);
    });
    byId.set(id, {
      id,
      score,
      quotes,
      verifiedQuotes,
      accepted: score < CREDIT_NEEDS_EVIDENCE || verifiedQuotes.length > 0,
    });
  }
  const rationale = typeof record['rationale'] === 'string' ? record['rationale'].trim() : '';
  return { scores: openIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])), rationale };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/// Seats the panel and asks every member, in parallel, to score the open
/// criteria. Throws only if every member fails; otherwise the verdict records
/// which members failed and which scores were discarded, and why.
///
/// `completeFn` is the model call, injectable so the panel's arithmetic and its
/// evidence rule can be tested without a network.
export async function judgePanel(params: {
  config: LlmConfig;
  system: string;
  user: string;
  openIds: readonly string[];
  /// the verified delivered text quotes are checked against; undefined when no
  /// copy verified, in which case no credit-claiming score can be accepted
  deliverable: string | undefined;
  completeFn?: typeof complete;
}): Promise<PanelVerdict> {
  const { config, openIds } = params;
  const call = params.completeFn ?? complete;
  const haystack = params.deliverable === undefined ? '' : quoteHaystack(params.deliverable);
  const models = config.models.length > 0 ? config.models : [DEFAULT_MODEL];
  const seats = Array.from({ length: config.panelSize }, (_, seat) => {
    const model = models[seat % models.length]!;
    const repeated = config.panelSize > models.length;
    return { seat, model, temperature: repeated ? REPEAT_TEMPERATURE : 0 };
  });

  const members: PanelMember[] = await Promise.all(
    seats.map(async (seat): Promise<PanelMember> => {
      try {
        const content = await call(config, {
          model: seat.model,
          system: params.system,
          user: params.user,
          temperature: seat.temperature,
        });
        const parsed = parseMemberReply(content, openIds, haystack);
        return { ...seat, scores: parsed.scores, rationale: parsed.rationale };
      } catch (error) {
        return { ...seat, scores: null, rationale: '', error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  if (members.every((member) => member.scores === null)) {
    throw new LlmError(`every judge on the panel failed: ${members.map((m) => m.error).join('; ')}`);
  }

  const criteria: PanelCriterion[] = openIds.map((id) => {
    const said = members.flatMap((member) => member.scores?.filter((s) => s.id === id) ?? []);
    const accepted = said.filter((s) => s.accepted).map((s) => s.score);
    return {
      id,
      // Rounded so receipts read 0.85, not 0.8500000000000001; 1e-4 of a
      // criterion's weight is far below a basis point of the award.
      score: accepted.length > 0 ? Math.round(median(accepted) * 10_000) / 10_000 : NEUTRAL_SCORE,
      accepted: accepted.length,
      discarded: said.length - accepted.length,
      neutral: accepted.length === 0,
    };
  });

  const counts = new Map<string, number>();
  for (const seat of seats) counts.set(seat.model, (counts.get(seat.model) ?? 0) + 1);
  const label = `panel ${[...counts].map(([model, n]) => `${n}×${model}`).join(' + ')}`;
  return { members, criteria, label };
}
