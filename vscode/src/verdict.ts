import * as config from './config';
import { log, logError } from './log';
import { VerdictState } from './types';

/**
 * Verdicts come from the public Codeforces API, polled from here rather than
 * from the browser. The extension is awake for the whole judging window, the
 * API needs no cookies, and it keeps the browser side to what it is uniquely
 * able to do — driving the logged-in submit form.
 *
 * https://codeforces.com/apiHelp/methods#user.status
 */

const API = 'https://codeforces.com/api/user.status';

interface ApiSubmission {
  id: number;
  contestId?: number;
  creationTimeSeconds: number;
  relativeTimeSeconds?: number;
  problem: { contestId?: number; index: string; name?: string };
  verdict?: string;
  testset?: string;
  passedTestCount?: number;
  timeConsumedMillis?: number;
  memoryConsumedBytes?: number;
}

interface ApiResponse {
  status: string;
  comment?: string;
  result?: ApiSubmission[];
}

const FRIENDLY: Record<string, string> = {
  OK: 'Accepted',
  WRONG_ANSWER: 'Wrong answer',
  TIME_LIMIT_EXCEEDED: 'Time limit exceeded',
  MEMORY_LIMIT_EXCEEDED: 'Memory limit exceeded',
  RUNTIME_ERROR: 'Runtime error',
  COMPILATION_ERROR: 'Compilation error',
  IDLENESS_LIMIT_EXCEEDED: 'Idleness limit exceeded',
  PRESENTATION_ERROR: 'Presentation error',
  CHALLENGED: 'Hacked',
  SKIPPED: 'Skipped',
  PARTIAL: 'Partial',
  FAILED: 'Failed',
  TESTING: 'Judging',
  SECURITY_VIOLATED: 'Security violated',
  CRASHED: 'Crashed',
  INPUT_PREPARATION_CRASHED: 'Input preparation crashed'
};

export function friendlyVerdict(verdict: string | undefined): string {
  if (!verdict) {
    return 'In queue';
  }
  return FRIENDLY[verdict] ?? verdict.replaceAll('_', ' ').toLowerCase();
}

/** Codeforces counts tests from 1, and reports how many passed. */
export function failingTest(submission: {
  verdict?: string;
  passedTestCount?: number;
}): number | undefined {
  if (!submission.verdict || submission.verdict === 'OK' || submission.verdict === 'TESTING') {
    return undefined;
  }
  if (typeof submission.passedTestCount !== 'number') {
    return undefined;
  }
  return submission.passedTestCount + 1;
}

export function describe(state: VerdictState): string {
  if (state.error) {
    return state.error;
  }
  switch (state.phase) {
    case 'queued':
      return 'Opening the submit form in the browser';
    case 'sent':
      return 'Opening the submit form in the browser';
    case 'filled':
      // Pressing Submit is the user's to do; see driveSubmit in the browser
      // extension for why. Nothing is in flight until they do.
      return 'Form is filled, press Submit';
    case 'cancelled':
      return 'Cancelled';
    case 'waiting':
      return 'In queue on Codeforces';
    case 'judging': {
      const on = state.passedTestCount;
      return typeof on === 'number' ? `Judging — passed ${on} test(s)` : 'Judging';
    }
    case 'final': {
      const name = friendlyVerdict(state.verdict);
      const test = failingTest(state);
      const scope = state.testset === 'PRETESTS' ? ' (pretests)' : '';
      if (state.verdict === 'OK') {
        return state.testset === 'PRETESTS' ? 'Pretests passed' : 'Accepted';
      }
      return test ? `${name} on test ${test}${scope}` : `${name}${scope}`;
    }
    default:
      return '';
  }
}

async function fetchStatus(handle: string, count: number): Promise<ApiSubmission[]> {
  const url = `${API}?handle=${encodeURIComponent(handle)}&from=1&count=${count}`;
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

function matches(
  submission: ApiSubmission,
  contestId: number,
  index: string,
  notBefore: number
): boolean {
  const owningContest = submission.contestId ?? submission.problem.contestId;
  if (owningContest !== contestId) {
    return false;
  }
  if (submission.problem.index?.toUpperCase() !== index) {
    return false;
  }
  return submission.creationTimeSeconds * 1000 >= notBefore;
}

export interface WatchOptions {
  handle: string;
  contestId: number;
  index: string;
  /** When the submit was queued locally; used to ignore older submissions. */
  queuedAt: number;
  onUpdate: (state: VerdictState) => void;
}

/**
 * Poll until the submission reaches a final verdict, the timeout expires, or
 * `cancel()` is called. Only one watcher runs at a time.
 */
export class VerdictWatcher {
  private timer: NodeJS.Timeout | undefined;
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async watch(options: WatchOptions): Promise<void> {
    this.cancel();
    this.cancelled = false;

    const deadline = Date.now() + config.verdictTimeoutMs();
    // Allow for a clock skew between this machine and Codeforces.
    const notBefore = options.queuedAt - 60_000;
    const problemId = `${options.contestId}${options.index}`;
    let submissionId: number | undefined;
    let consecutiveErrors = 0;

    const emit = (state: Omit<VerdictState, 'updatedAt' | 'problemId'>): void => {
      options.onUpdate({ ...state, problemId, updatedAt: Date.now() });
    };

    const tick = async (): Promise<void> => {
      if (this.cancelled) {
        return;
      }
      if (Date.now() > deadline) {
        // Nothing was ever submitted, most likely: the form was filled and left.
        emit({
          phase: submissionId === undefined ? 'cancelled' : 'failed',
          submissionId,
          error:
            submissionId === undefined
              ? undefined
              : 'Gave up waiting for a verdict. Check Codeforces directly.'
        });
        return;
      }

      try {
        const submissions = await fetchStatus(options.handle, 20);
        consecutiveErrors = 0;
        const found = submissions
          .filter((entry) => matches(entry, options.contestId, options.index, notBefore))
          .sort((a, b) => b.id - a.id)[0];

        if (!found) {
          // Nothing submitted yet: the form is sitting there, filled.
          emit({ phase: 'filled', submissionId });
        } else {
          submissionId = found.id;
          const judging = !found.verdict || found.verdict === 'TESTING';
          emit({
            phase: judging ? 'judging' : 'final',
            submissionId: found.id,
            verdict: found.verdict,
            testset: found.testset,
            passedTestCount: found.passedTestCount,
            timeConsumedMillis: found.timeConsumedMillis,
            memoryConsumedBytes: found.memoryConsumedBytes
          });
          if (!judging) {
            log(
              `verdict ${problemId} #${found.id}: ${found.verdict}` +
                (typeof found.passedTestCount === 'number'
                  ? ` after ${found.passedTestCount} test(s)`
                  : '')
            );
            return;
          }
        }
      } catch (error) {
        consecutiveErrors += 1;
        logError('polling user.status', error);
        if (consecutiveErrors >= 5) {
          emit({
            phase: 'failed',
            submissionId,
            error: `Codeforces API is not answering: ${
              error instanceof Error ? error.message : String(error)
            }`
          });
          return;
        }
      }

      this.timer = setTimeout(() => void tick(), config.verdictPollIntervalMs());
    };

    emit({ phase: 'filled' });
    this.timer = setTimeout(() => void tick(), 1500);
  }
}
