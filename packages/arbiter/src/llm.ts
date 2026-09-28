/// OpenAI-compatible chat completions over plain fetch. No SDK dependency: the
/// arbiter talks to one endpoint and this keeps the dependency surface of a
/// component that signs money-moving verdicts as small as possible.

export type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

export type LlmRuling = {
  sellerAwardBps: number;
  confidence?: number;
  factors: string[];
  rationale: string;
};

export type LlmOutcome = {
  ruling: LlmRuling;
  model: string;
  raw: string;
  /// True when the endpoint rejected `response_format` and the retry succeeded.
  unconstrainedFormat: boolean;
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

/// Returns null when no key is configured. The arbiter reads this and falls back
/// to the deterministic rule engine rather than failing: an unconfigured judge
/// must never be able to stall a dispute.
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = env['OPENAI_API_KEY']?.trim();
  if (!apiKey) return null;
  const timeout = Number(env['OPENAI_TIMEOUT_MS'] ?? DEFAULT_TIMEOUT_MS);
  return {
    apiKey,
    baseUrl: (env['OPENAI_BASE_URL']?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: env['OPENAI_MODEL']?.trim() || DEFAULT_MODEL,
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
      body: JSON.stringify({ model: config.model, ...body }),
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

function validate(value: unknown): LlmRuling {
  if (typeof value !== 'object' || value === null) {
    throw new LlmError('judge reply was not a JSON object');
  }
  const record = value as Record<string, unknown>;
  const award = record['sellerAwardBps'];
  if (typeof award !== 'number' || !Number.isFinite(award)) {
    throw new LlmError('judge reply is missing a numeric sellerAwardBps');
  }
  const rationale = record['rationale'];
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    throw new LlmError('judge reply is missing a rationale');
  }
  const factors = Array.isArray(record['factors'])
    ? record['factors'].filter((f): f is string => typeof f === 'string')
    : [];
  const confidence = record['confidence'];
  return {
    sellerAwardBps: Math.max(0, Math.min(10_000, Math.round(award))),
    ...(typeof confidence === 'number' && Number.isFinite(confidence)
      ? { confidence: Math.max(0, Math.min(1, confidence)) }
      : {}),
    factors,
    rationale: rationale.trim(),
  };
}

/// Asks the judge for a ruling. Throws LlmError on any failure; the caller decides
/// whether to degrade to the rule engine, and records that it did.
export async function judgeWithLlm(params: {
  config: LlmConfig;
  system: string;
  user: string;
  temperature?: number;
}): Promise<LlmOutcome> {
  const { config, system, user } = params;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const base: Record<string, unknown> = {
    messages,
    temperature: params.temperature ?? 0,
  };

  let unconstrainedFormat = false;
  let result: { content: string; raw: string };
  try {
    // Structured output keeps the parse honest when the endpoint supports it.
    result = await post(config, { ...base, response_format: { type: 'json_object' } });
  } catch (error) {
    // Only a rejected request shape earns a retry; a bad key or a broken parse
    // will fail the same way twice and the caller needs to hear about it.
    const status = error instanceof LlmError ? error.status : undefined;
    if (status !== 400 && status !== 422) throw error;
    unconstrainedFormat = true;
    result = await post(config, base);
  }

  return {
    ruling: validate(extractJson(result.content)),
    model: config.model,
    raw: result.raw,
    unconstrainedFormat,
  };
}
