import Ajv from 'ajv';
import { franc } from 'franc';

import type { CriterionCheck } from '@tempex/sdk';

/// What one check concluded about the delivered work.
///
/// `credit` is the share of the criterion's weight the work earned, 0..1: binary
/// for yes/no checks, fractional for coverage checks (411 of 412 keys is not a
/// zero). `evidence` says exactly what was measured, in terms a reader can
/// re-check by hand.
export type CheckResult = {
  credit: number;
  passed: boolean;
  evidence: string;
};

/// Hard ceilings on what one check will read, so a hostile deliverable cannot
/// turn a ruling into a denial of service. Patterns come from terms both parties
/// signed, but the deliverable does not.
const MAX_VALUES = 5_000;
const MAX_VALUE_CHARS = 10_000;
const ALLOWED_REGEX_FLAGS = /^[imsu]*$/;

/// Candidate languages for detection. Restricting the detector to widely used
/// languages keeps short UI strings from being read as a rare neighbour (plain
/// English menu text otherwise comes back as Scots), and keeps the answer
/// deterministic. The target language is always added.
const LANGUAGE_CANDIDATES = [
  'eng', 'fra', 'deu', 'spa', 'ita', 'por', 'nld', 'pol', 'swe', 'dan', 'nob', 'fin',
  'ces', 'ron', 'hun', 'tur', 'rus', 'ukr', 'jpn', 'cmn', 'kor', 'arb', 'hin', 'ind',
  'vie', 'tha', 'ell', 'heb',
];
const ISO_639_1_TO_3: Record<string, string> = {
  en: 'eng', fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', pl: 'pol',
  sv: 'swe', da: 'dan', no: 'nob', nb: 'nob', fi: 'fin', cs: 'ces', ro: 'ron', hu: 'hun',
  tr: 'tur', ru: 'rus', uk: 'ukr', ja: 'jpn', zh: 'cmn', ko: 'kor', ar: 'arb', hi: 'hin',
  id: 'ind', vi: 'vie', th: 'tha', el: 'ell', he: 'heb',
};

const ajv = new (Ajv as unknown as new (options: Record<string, unknown>) => {
  validate: (schema: unknown, data: unknown) => boolean;
  errorsText: () => string;
})({ strict: false, allErrors: false });

const result = (credit: number, evidence: string): CheckResult => {
  const bounded = Math.max(0, Math.min(1, credit));
  return { credit: bounded, passed: bounded === 1, evidence };
};

/// The part of the deliverable a check reads.
type Selection = { ok: true; value: unknown; asText: string } | { ok: false; reason: string };

/// RFC 6901: "" or "/" is the whole document, "/a/b" walks keys, "~1" is "/" and
/// "~0" is "~".
function resolvePointer(document: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointer === '' || pointer === '/') return { found: true, value: document };
  if (!pointer.startsWith('/')) return { found: false, value: undefined };
  let current: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current !== null && typeof current === 'object' && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

function select(text: string, at: string | undefined, needJson: boolean): Selection {
  if (at === undefined && !needJson) return { ok: true, value: text, asText: text };
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the deliverable is not JSON, so nothing can be selected from it' };
  }
  const { found, value } = resolvePointer(document, at ?? '');
  if (!found) return { ok: false, reason: `the deliverable has nothing at ${at}` };
  return { ok: true, value, asText: stringValues(value).map(([, v]) => v).join('\n') };
}

/// Every string in a JSON value, keyed by its dotted path: {"a":{"b":"x"}} gives
/// [["a.b","x"]]. A bare string is keyed "". Capped in count and length.
function stringValues(value: unknown, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  const walk = (node: unknown, path: string): void => {
    if (out.length >= MAX_VALUES) return;
    if (typeof node === 'string') {
      out.push([path, node.slice(0, MAX_VALUE_CHARS)]);
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, path === '' ? String(index) : `${path}.${index}`));
    } else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(child, path === '' ? key : `${path}.${key}`);
    }
  };
  walk(value, prefix);
  return out;
}

/// Every leaf of a JSON value by dotted path, strings and otherwise.
function leaves(value: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (node: unknown, path: string): void => {
    if (out.size >= MAX_VALUES) return;
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, child] of Object.entries(node)) walk(child, path === '' ? key : `${path}.${key}`);
    } else {
      out.set(path, node);
    }
  };
  walk(value, '');
  return out;
}

/// `*` matches any run of characters (dots included); everything else is literal.
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

const share = (hit: number, total: number): string => `${hit} of ${total}`;

/// Runs one check against the delivered text. Never throws: a check that cannot
/// even be applied (the deliverable is not JSON, the pointer leads nowhere) is a
/// check the work failed, and the evidence says why.
export function runCheck(check: CriterionCheck, deliverable: string): CheckResult {
  switch (check.type) {
    case 'json': {
      const selection = select(deliverable, check.at, true);
      if (!selection.ok) return result(0, selection.reason);
      if (check.schema === undefined) return result(1, `parses as JSON${check.at ? ` at ${check.at}` : ''}`);
      let valid: boolean;
      try {
        valid = ajv.validate(check.schema, selection.value);
      } catch (error) {
        return result(0, `the agreed schema could not be compiled: ${error instanceof Error ? error.message : String(error)}`);
      }
      return valid ? result(1, 'satisfies the agreed JSON Schema') : result(0, `fails the agreed JSON Schema: ${ajv.errorsText()}`);
    }

    case 'jsonKeys': {
      const selection = select(deliverable, check.at, true);
      if (!selection.ok) return result(0, selection.reason);
      if (check.keys.length === 0) return result(1, 'no keys were required');
      const found = leaves(selection.value);
      const nonEmpty = check.nonEmpty ?? true;
      const missing = check.keys.filter((key) => {
        if (!found.has(key)) return true;
        const value = found.get(key);
        return nonEmpty && (value === null || value === undefined || (typeof value === 'string' && value.trim() === ''));
      });
      const present = check.keys.length - missing.length;
      return result(
        present / check.keys.length,
        `${share(present, check.keys.length)} required keys present${missing.length > 0 ? `; missing ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}` : ''}`,
      );
    }

    case 'count': {
      const selection = select(deliverable, check.at, false);
      if (!selection.ok) return result(0, selection.reason);
      let count: number;
      if (check.unit === 'items') {
        const value = selection.value;
        if (Array.isArray(value)) count = value.length;
        else if (value !== null && typeof value === 'object') count = Object.keys(value).length;
        else return result(0, 'the selection is neither a list nor an object, so it has no items');
      } else if (check.unit === 'lines') {
        count = selection.asText.split(/\r?\n/).filter((line) => line.trim() !== '').length;
      } else {
        count = selection.asText.split(/\s+/).filter(Boolean).length;
      }
      const range = `${check.min ?? 0}${check.max !== undefined ? `..${check.max}` : '+'}`;
      if (check.max !== undefined && count > check.max) return result(0, `${count} ${check.unit}, over the agreed ${range}`);
      if (check.min !== undefined && count < check.min) {
        return result(count / check.min, `${count} ${check.unit} of the agreed ${range}`);
      }
      return result(1, `${count} ${check.unit}, within the agreed ${range}`);
    }

    case 'language': {
      const selection = select(deliverable, check.at, false);
      if (!selection.ok) return result(0, selection.reason);
      const target = ISO_639_1_TO_3[check.is.toLowerCase()] ?? check.is.toLowerCase();
      const text = selection.asText;
      const minLength = check.minLength ?? 20;
      if (text.trim().length < minLength) {
        return result(0, `only ${text.trim().length} characters of text, under the ${minLength} needed to tell the language`);
      }
      const only = LANGUAGE_CANDIDATES.includes(target) ? LANGUAGE_CANDIDATES : [...LANGUAGE_CANDIDATES, target];
      const detected = franc(text, { minLength: 10, only });
      return detected === target
        ? result(1, `written in ${target}`)
        : result(0, `written in ${detected === 'und' ? 'an undetermined language' : detected}, not ${target}`);
    }

    case 'regex': {
      if (!ALLOWED_REGEX_FLAGS.test(check.flags ?? '')) {
        return result(0, `the agreed pattern uses flags "${check.flags}"; only i, m, s and u are allowed`);
      }
      let pattern: RegExp;
      try {
        pattern = new RegExp(check.pattern, check.flags ?? '');
      } catch (error) {
        return result(0, `the agreed pattern does not compile: ${error instanceof Error ? error.message : String(error)}`);
      }
      const selection = select(deliverable, check.at, check.keys !== undefined);
      if (!selection.ok) return result(0, selection.reason);
      const keyFilter = check.keys !== undefined ? globToRegExp(check.keys) : null;
      const values = stringValues(selection.value).filter(([key]) => keyFilter === null || keyFilter.test(key));
      if (values.length === 0) return result(0, `no values${check.keys ? ` under keys ${check.keys}` : ''} to match`);
      const failing = values.filter(([, value]) => !pattern.test(value));
      const hit = values.length - failing.length;
      return result(
        hit / values.length,
        `${share(hit, values.length)} values match /${check.pattern}/${failing.length > 0 ? `; first miss ${failing[0]![0] || 'value'} = ${JSON.stringify(failing[0]![1].slice(0, 60))}` : ''}`,
      );
    }

    case 'contains': {
      const selection = select(deliverable, check.at, false);
      if (!selection.ok) return result(0, selection.reason);
      if (check.all.length === 0) return result(1, 'no strings were required');
      const caseSensitive = check.caseSensitive ?? false;
      const haystack = caseSensitive ? selection.asText : selection.asText.toLowerCase();
      const missing = check.all.filter((needle) => !haystack.includes(caseSensitive ? needle : needle.toLowerCase()));
      const hit = check.all.length - missing.length;
      return result(
        hit / check.all.length,
        `${share(hit, check.all.length)} required strings present${missing.length > 0 ? `; missing ${missing.map((m) => JSON.stringify(m)).join(', ')}` : ''}`,
      );
    }

    default: {
      const unknown = check as { type?: unknown };
      return result(0, `unknown check type ${JSON.stringify(unknown.type)}`);
    }
  }
}

/// Why a check from the terms cannot be applied at all, or null when it can. A
/// defect here is in what both parties signed, not in the work, so the criterion
/// falls back to judgement instead of costing the seller its weight.
export function checkProblem(check: unknown): string | null {
  if (check === null || typeof check !== 'object') return 'the check is not an object';
  const c = check as Record<string, unknown>;
  const isStringList = (value: unknown): boolean =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (c['at'] !== undefined && (typeof c['at'] !== 'string' || (c['at'] !== '' && !c['at'].startsWith('/')))) {
    return '"at" must be a JSON pointer such as "/strings"';
  }
  switch (c['type']) {
    case 'json':
      if (c['schema'] === undefined) return null;
      try {
        (ajv as unknown as { compile: (schema: unknown) => unknown }).compile(c['schema']);
        return null;
      } catch (error) {
        return `the JSON Schema does not compile: ${error instanceof Error ? error.message : String(error)}`;
      }
    case 'jsonKeys':
      return isStringList(c['keys']) ? null : '"keys" must be a list of dotted key paths';
    case 'count':
      if (!['words', 'lines', 'items'].includes(String(c['unit']))) return '"unit" must be words, lines or items';
      for (const bound of ['min', 'max']) {
        if (c[bound] !== undefined && (typeof c[bound] !== 'number' || !Number.isFinite(c[bound]) || (c[bound] as number) < 0)) {
          return `"${bound}" must be a non-negative number`;
        }
      }
      if (typeof c['min'] === 'number' && typeof c['max'] === 'number' && c['min'] > c['max']) return '"min" is above "max"';
      return null;
    case 'language':
      return typeof c['is'] === 'string' && /^[a-z]{2,3}$/i.test(c['is']) ? null : '"is" must be an ISO 639-1 or 639-3 code';
    case 'regex':
      if (typeof c['pattern'] !== 'string') return '"pattern" must be a string';
      if (c['flags'] !== undefined && (typeof c['flags'] !== 'string' || !ALLOWED_REGEX_FLAGS.test(c['flags']))) {
        return 'only the i, m, s and u flags are allowed';
      }
      if (c['keys'] !== undefined && typeof c['keys'] !== 'string') return '"keys" must be a glob such as "price.*"';
      try {
        new RegExp(c['pattern'], (c['flags'] as string | undefined) ?? '');
        return null;
      } catch (error) {
        return `the pattern does not compile: ${error instanceof Error ? error.message : String(error)}`;
      }
    case 'contains':
      return isStringList(c['all']) ? null : '"all" must be a list of strings';
    default:
      return `unknown check type ${JSON.stringify(c['type'])}`;
  }
}
