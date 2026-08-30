// Everything the browser sends passes through here before it reaches the disk.
//
// The rule this file exists to enforce: paths are built only from a validated
// contest id and problem index, never from a name, url, or anything else the
// page supplied. A problem titled "../../.ssh/authorized_keys" is a title, not
// a path component, and cannot become one.

import { RawCapture, RawProblem, Sample } from './types';

export const LIMITS = {
  /** Refuse request bodies larger than this outright. */
  bodyBytes: 4 * 1024 * 1024,
  problemsPerCapture: 40,
  samplesPerProblem: 30,
  sampleBytes: 256 * 1024,
  nameChars: 200,
  urlChars: 500,
  /** A source file we are willing to queue for submission. */
  sourceBytes: 512 * 1024
} as const;

export class ValidationError extends Error {}

function fail(message: string): never {
  throw new ValidationError(message);
}

export function asContestId(value: unknown): number {
  // `parseInt` is deliberately not used: it reads "2050/../.." as 2050 and
  // throws the rest away, which is exactly the kind of quiet coercion this file
  // exists to refuse. A string id must be digits and nothing else.
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^[0-9]{1,7}$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    fail(`bad contestId: ${JSON.stringify(value)}`);
  }
  if (!Number.isInteger(n) || n < 1 || n > 9_999_999) {
    fail(`bad contestId: ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * Codeforces problem indices are a letter, sometimes with a digit: A, B, C1, F2.
 * Anything else is rejected — this string becomes part of a file name.
 */
export function asProblemIndex(value: unknown): string {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][0-9]{0,2}$/.test(raw)) {
    fail(`bad problem index: ${JSON.stringify(value)}`);
  }
  return raw;
}

function asText(value: unknown, limit: number, field: string): string {
  const raw = typeof value === 'string' ? value : '';
  if (raw.length > limit) {
    fail(`${field} exceeds ${limit} characters`);
  }
  // These fields are single-line labels rendered into a webview and an output
  // channel, so control characters and newlines collapse to plain spaces.
  return raw.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Only ever an https Codeforces URL, and only used for display and opening. */
export function asCodeforcesUrl(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return fallback;
  }
  if (raw.length > LIMITS.urlChars) {
    return fallback;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fallback;
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = host === 'codeforces.com' || host.endsWith('.codeforces.com');
  if (parsed.protocol !== 'https:' || !allowed) {
    return fallback;
  }
  return parsed.toString();
}

function asSamples(value: unknown): Sample[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail('samples must be an array');
  }
  if (value.length > LIMITS.samplesPerProblem) {
    fail(`too many samples (${value.length})`);
  }
  return value.map((entry, i) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const input = typeof record.input === 'string' ? record.input : '';
    const output = typeof record.output === 'string' ? record.output : '';
    if (input.length > LIMITS.sampleBytes || output.length > LIMITS.sampleBytes) {
      fail(`sample ${i + 1} is too large`);
    }
    return { input: normalizeIo(input), output: normalizeIo(output) };
  });
}

/** Codeforces serves CRLF in places; a trailing newline is added at run time. */
export function normalizeIo(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

export interface ValidProblem {
  index: string;
  name: string;
  url: string;
  timeLimit?: string;
  memoryLimit?: string;
  samples: Sample[];
}

export interface ValidCapture {
  contestId: number;
  contestName: string;
  url: string;
  handle?: string;
  problems: ValidProblem[];
}

export function asHandle(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  // Codeforces handles: letters, digits, underscore, dot, hyphen; 3-24 chars.
  return /^[A-Za-z0-9_.-]{3,24}$/.test(raw) ? raw : undefined;
}

export function validateCapture(body: unknown): ValidCapture {
  const raw = (body ?? {}) as RawCapture;
  const contestId = asContestId(raw.contestId);

  if (!Array.isArray(raw.problems) || raw.problems.length === 0) {
    fail('capture contains no problems');
  }
  if (raw.problems.length > LIMITS.problemsPerCapture) {
    fail(`too many problems (${raw.problems.length})`);
  }

  const seen = new Set<string>();
  const problems: ValidProblem[] = raw.problems.map((entry) => {
    const problem = (entry ?? {}) as RawProblem;
    const index = asProblemIndex(problem.index);
    if (seen.has(index)) {
      fail(`duplicate problem index ${index}`);
    }
    seen.add(index);
    const fallbackUrl = `https://codeforces.com/contest/${contestId}/problem/${index}`;
    return {
      index,
      name: asText(problem.name, LIMITS.nameChars, 'name') || index,
      url: asCodeforcesUrl(problem.url, fallbackUrl),
      timeLimit: asText(problem.timeLimit, 60, 'timeLimit') || undefined,
      memoryLimit: asText(problem.memoryLimit, 60, 'memoryLimit') || undefined,
      samples: asSamples(problem.samples)
    };
  });

  return {
    contestId,
    contestName: asText(raw.contestName, LIMITS.nameChars, 'contestName') || `Contest ${contestId}`,
    url: asCodeforcesUrl(raw.url, `https://codeforces.com/contest/${contestId}`),
    handle: asHandle(raw.handle),
    problems
  };
}
