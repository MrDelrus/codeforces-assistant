// Shared shapes. The browser extension speaks exactly these over loopback; see
// `validate.ts` for the guards that every inbound field goes through before it
// is allowed anywhere near the filesystem.

export interface Sample {
  input: string;
  output: string;
}

/** One problem, as stored in `<contest>/.cfa/contest.json`. */
export interface ProblemMeta {
  contestId: number;
  /** Codeforces problem index: "A", "B", "C1". Always upper case. */
  index: string;
  /** "2050A" — contestId + index, the file base name. */
  id: string;
  name: string;
  url: string;
  timeLimit?: string;
  memoryLimit?: string;
  samples: Sample[];
  /**
   * Tests the user typed into the panel. Kept apart from `samples` so a
   * re-capture can refresh the official ones without touching these, and so the
   * panel can label and delete them. Runs use both, in this order.
   */
  extraSamples?: Sample[];
  /** Absolute path of the solution file. Derived, never trusted from input. */
  file: string;
  capturedAt: string;
}

export interface ContestMeta {
  contestId: number;
  name: string;
  url: string;
  capturedAt: string;
  problems: ProblemMeta[];
}

/** A problem as it arrives from the browser, before validation. */
export interface RawProblem {
  index?: unknown;
  name?: unknown;
  url?: unknown;
  timeLimit?: unknown;
  memoryLimit?: unknown;
  samples?: unknown;
}

export interface RawCapture {
  contestId?: unknown;
  contestName?: unknown;
  url?: unknown;
  handle?: unknown;
  problems?: unknown;
}

/**
 * How a problem stands for this handle on Codeforces, as shown in the tab
 * strip. 'untouched' means no submission was found — not that the file is
 * empty; the panel deliberately reports Codeforces, not the disk.
 */
export type ProblemStatus = 'untouched' | 'attempted' | 'solved';

/** One entry of the problem tab strip at the top of the panel. */
export interface ProblemTab {
  index: string;
  id: string;
  name: string;
  /** Absolute path of the solution file, whether or not it exists yet. */
  file: string;
  status: ProblemStatus;
  /** True for the problem whose file is in the active editor. */
  active: boolean;
}

export type TestStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'wrong'
  | 'timeout'
  | 'error';

export interface TestResult {
  /** 1-based, matching how Codeforces numbers its tests. */
  number: number;
  status: TestStatus;
  input: string;
  expected: string;
  actual: string;
  stderr: string;
  durationMs: number;
  exitCode: number | null;
  /** 1-based line where output first diverged, when status is 'wrong'. */
  firstDiffLine?: number;
  /** True for a test the user added by hand, which the panel may delete. */
  custom?: boolean;
}

export interface RunState {
  phase: 'idle' | 'compiling' | 'running' | 'done' | 'failed';
  /** Compiler diagnostics, shown verbatim when the build fails. */
  compileOutput?: string;
  results: TestResult[];
  startedAt?: number;
  finishedAt?: number;
}

export interface PendingSubmit {
  /** Random id so an ack can be matched to the request that produced it. */
  id: string;
  contestId: number;
  index: string;
  /** Our language key ("cpp"), not a Codeforces programTypeId. */
  language: string;
  code: string;
  queuedAt: number;
}

export type VerdictPhase =
  | 'idle'
  | 'queued'
  /** The browser has taken the request and is opening the page. */
  | 'sent'
  /**
   * The form is filled and waiting for the user to press Submit. This is a
   * finished state, not a step on the way to one: nothing else happens until a
   * person acts, so it must not be drawn as work in progress.
   */
  | 'filled'
  | 'waiting'
  | 'judging'
  | 'final'
  | 'cancelled'
  | 'failed';

export interface VerdictState {
  phase: VerdictPhase;
  problemId?: string;
  /** Codeforces submission id, once we have matched one. */
  submissionId?: number;
  /** Raw API verdict: OK, WRONG_ANSWER, TIME_LIMIT_EXCEEDED, ... */
  verdict?: string;
  /** PRETESTS during a live contest, TESTS after system testing. */
  testset?: string;
  passedTestCount?: number;
  timeConsumedMillis?: number;
  memoryConsumedBytes?: number;
  /** Human readable line for the panel. */
  message?: string;
  /** Set when we could not get as far as a verdict. */
  error?: string;
  updatedAt: number;
}
