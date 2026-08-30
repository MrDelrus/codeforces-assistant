import * as config from './config';
import { log, logError } from './log';
import { ProblemStatus } from './types';

/**
 * Per-problem contest progress, so the tab strip can colour every problem of
 * the contest, not just the one that is open.
 *
 * This is a second consumer of the public API, next to `verdict.ts`. It is kept
 * separate on purpose: `verdict.ts` follows exactly one submission from queue to
 * final verdict, this one asks a much cruder question — has this handle solved
 * problem C yet — for a whole contest at once.
 *
 * `contest.status` is preferred because it answers with that contest only.
 * It refuses for contests the handle cannot see, so `user.status` is the
 * fallback; that one returns the handle's most recent submissions across all of
 * Codeforces and is filtered here.
 */

const CONTEST_API = 'https://codeforces.com/api/contest.status';
const USER_API = 'https://codeforces.com/api/user.status';
/** Enough to cover every submission of a single contest in practice. */
const COUNT = 200;

interface ApiSubmission {
  id: number;
  contestId?: number;
  problem: { contestId?: number; index: string };
  verdict?: string;
}

interface ApiResponse {
  status: string;
  comment?: string;
  result?: ApiSubmission[];
}

async function get(url: string): Promise<ApiSubmission[]> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Codeforces API returned ${response.status}`);
  }
  const body = (await response.json()) as ApiResponse;
  if (body.status !== 'OK' || !Array.isArray(body.result)) {
    throw new Error(body.comment ?? 'Codeforces API returned an error');
  }
  return body.result;
}

/** Later submissions must not downgrade an earlier accepted one. */
function fold(current: ProblemStatus | undefined, verdict: string | undefined): ProblemStatus {
  if (current === 'solved') {
    return 'solved';
  }
  if (verdict === 'OK') {
    return 'solved';
  }
  return 'attempted';
}

export async function fetchProgress(
  handle: string,
  contestId: number
): Promise<Map<string, ProblemStatus>> {
  const encoded = encodeURIComponent(handle);
  let submissions: ApiSubmission[];
  try {
    submissions = await get(
      `${CONTEST_API}?contestId=${contestId}&handle=${encoded}&from=1&count=${COUNT}`
    );
  } catch (error) {
    logError(`contest.status for ${contestId}`, error);
    submissions = (await get(`${USER_API}?handle=${encoded}&from=1&count=${COUNT}`)).filter(
      (entry) => (entry.contestId ?? entry.problem.contestId) === contestId
    );
  }

  const byIndex = new Map<string, ProblemStatus>();
  for (const submission of submissions) {
    const index = submission.problem?.index?.toUpperCase();
    if (!index) {
      continue;
    }
    byIndex.set(index, fold(byIndex.get(index), submission.verdict));
  }
  return byIndex;
}

export interface ProgressOptions {
  handle: string;
  contestId: number;
  onUpdate: (statuses: Map<string, ProblemStatus>) => void;
}

/**
 * Polls one contest on a timer. Only one contest is watched at a time — the one
 * the open file belongs to — so switching contests replaces the poll rather
 * than adding to it, and the API sees one request per interval.
 */
export class ProgressPoller {
  private timer: NodeJS.Timeout | undefined;
  private options: ProgressOptions | undefined;
  private failures = 0;

  /** No-op when the same contest and handle are already being polled. */
  start(options: ProgressOptions): void {
    if (
      this.options &&
      this.options.contestId === options.contestId &&
      this.options.handle === options.handle
    ) {
      this.options.onUpdate = options.onUpdate;
      return;
    }
    this.stop();
    this.options = options;
    this.failures = 0;
    log(`polling contest ${options.contestId} progress for ${options.handle}`);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.options = undefined;
  }

  /** Poll now, e.g. right after a verdict landed. */
  refresh(): void {
    if (this.options) {
      void this.tick();
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    const options = this.options;
    if (!options) {
      return;
    }
    try {
      const statuses = await fetchProgress(options.handle, options.contestId);
      this.failures = 0;
      if (this.options === options) {
        options.onUpdate(statuses);
      }
    } catch (error) {
      this.failures += 1;
      logError('polling contest progress', error);
    }
    if (this.options !== options) {
      return;
    }
    // Back off when Codeforces is unhappy rather than hammering it every 10s.
    const interval = config.progressPollIntervalMs();
    this.schedule(this.failures > 0 ? interval * Math.min(6, 2 ** this.failures) : interval);
  }
}
