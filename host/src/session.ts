import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { CaptureResult, applyCapture } from '../../vscode/src/capture';
import * as config from '../../vscode/src/config';
import { log, logError } from '../../vscode/src/log';
import { CaptureServer, ServerHost } from '../../vscode/src/server';
import { allSamples, lookupByFile, pendingResults } from '../../vscode/src/store';
import { PendingSubmit, RunState, TestResult, VerdictState } from '../../vscode/src/types';
import { compile, runSample } from '../../vscode/src/runner';
import { VerdictWatcher, describe } from '../../vscode/src/verdict';
import { ValidCapture } from '../../vscode/src/validate';

import { HostState, writeState } from './settings';

/**
 * Everything the VS Code `Application` does that is not drawing.
 *
 * The flows are the ones already proven in the extension — a submit is queued,
 * claimed, acknowledged, then polled — and the timings are the same constants,
 * because they were chosen against the real browser and the real API rather
 * than picked to look round.
 */

/** How long a claimed submit stays hidden before it is offered again. */
const CLAIM_WINDOW_MS = 45_000;
/**
 * How long we wait for the browser to pick a submit up. An open Codeforces tab
 * answers within two seconds; with no tab open the only thing left is the
 * service worker's alarm, which Chrome will not run more than once a minute.
 */
const PICKUP_TIMEOUT_MS = 75_000;
/** How long the browser gets to report back once it has taken one. */
const ACK_TIMEOUT_MS = 90_000;
/** How long a pairing question waits for the editor before it is refused. */
const TRUST_TIMEOUT_MS = 120_000;

export interface Events {
  emit(event: string, payload: Record<string, unknown>): void;
}

export class Session implements ServerHost {
  private server: CaptureServer | undefined;
  private readonly watcher = new VerdictWatcher();

  private pendingSubmit: PendingSubmit | undefined;
  private pendingClaimedAt = 0;
  private pickupTimer: NodeJS.Timeout | undefined;

  /** File the queued submit came from, so its verdict lands on the right one. */
  private submitFile: string | undefined;
  private busyFile: string | undefined;

  private readonly pendingTrust = new Map<string, (allowed: boolean) => void>();
  private editorAttached = false;

  constructor(
    private readonly events: Events,
    private readonly state: HostState,
    /** The file settings were actually read from, which `status` reports. */
    private readonly settingsFile: string
  ) {}

  attach(server: CaptureServer): void {
    this.server = server;
  }

  setEditorAttached(attached: boolean): void {
    this.editorAttached = attached;
    if (!attached) {
      // Nobody left to answer a pairing question; refuse the ones in flight
      // rather than leave the browser hanging on a promise that cannot settle.
      for (const resolve of this.pendingTrust.values()) {
        resolve(false);
      }
      this.pendingTrust.clear();
    }
  }

  dispose(): void {
    this.watcher.cancel();
    this.clearPickupTimer();
    this.server?.stop();
  }

  // ── ServerHost: what the browser reaches ────────────────────────────────

  async applyCapture(body: unknown): Promise<CaptureResult> {
    const result = await applyCapture(body as ValidCapture);
    this.events.emit('capture', {
      contestId: result.contestId,
      folder: result.contestFolder,
      created: result.created,
      existing: result.existing,
      samples: result.totalSamples
    });
    return result;
  }

  peekPendingSubmit(): PendingSubmit | undefined {
    if (!this.pendingSubmit) {
      return undefined;
    }
    if (this.pendingClaimedAt && Date.now() - this.pendingClaimedAt < CLAIM_WINDOW_MS) {
      // Already handed to a browser that has not reported back yet. Handing it
      // out again here is how a double submit happens.
      return undefined;
    }
    return this.pendingSubmit;
  }

  markSubmitClaimed(id: string): void {
    if (this.pendingSubmit?.id !== id) {
      return;
    }
    this.pendingClaimedAt = Date.now();
    this.clearPickupTimer();
    const problemId = `${this.pendingSubmit.contestId}${this.pendingSubmit.index}`;
    this.pushVerdict({ phase: 'sent', problemId, updatedAt: Date.now() });

    // The browser has it. If it never reports back — a closed tab, a crashed
    // worker — the editor must not sit on "Submitted" for ever.
    this.pickupTimer = setTimeout(() => {
      if (this.pendingSubmit?.id !== id) {
        return;
      }
      this.pendingSubmit = undefined;
      this.pushVerdict({
        phase: 'failed',
        problemId,
        error: 'The browser took this submit but never reported back. Check Codeforces.',
        updatedAt: Date.now()
      });
    }, ACK_TIMEOUT_MS);
  }

  onSubmitAck(payload: { id: string; ok: boolean; reason?: string }): void {
    const pending = this.pendingSubmit;
    if (!pending || pending.id !== payload.id) {
      log(`ignoring ack for unknown submit ${payload.id}`);
      return;
    }
    this.pendingSubmit = undefined;
    this.clearPickupTimer();

    const problemId = `${pending.contestId}${pending.index}`;

    if (!payload.ok) {
      log(
        `could not open the submit form for ${problemId}: ${payload.reason ?? 'no reason given'}`
      );
      this.pushVerdict({
        phase: 'failed',
        problemId,
        error: `Could not fill the submit form: ${payload.reason ?? 'unknown reason'}`,
        updatedAt: Date.now()
      });
      return;
    }

    log(`submit form ready for ${problemId}; watching for the submission`);
    const handle = this.handle();
    if (!handle) {
      this.pushVerdict({
        phase: 'failed',
        problemId,
        error:
          'Submitted, but no Codeforces handle is set, so the verdict cannot be polled. ' +
          `Set "cfa.handle" in ${this.settingsFile}.`,
        updatedAt: Date.now()
      });
      return;
    }

    void this.watcher.watch({
      handle,
      contestId: pending.contestId,
      index: pending.index,
      queuedAt: pending.queuedAt,
      onUpdate: (state) => this.pushVerdict(state)
    });
  }

  onHandleSeen(handle: string): void {
    if (this.state.handle === handle) {
      return;
    }
    this.state.handle = handle;
    log(`learned Codeforces handle from the browser: ${handle}`);
    void writeState(this.state).catch((error) => logError('saving host state', error));
  }

  isTrustedOrigin(origin: string): boolean {
    return this.state.trustedOrigins.includes(origin);
  }

  /**
   * Ask the editor whether a browser extension may talk to this host.
   *
   * With no editor attached the answer is no. That is the whole point of the
   * prompt: pairing is a decision a person makes, and a headless process has
   * nobody to ask — so it must refuse rather than quietly widen the allow-list.
   */
  requestTrust(origin: string): Promise<boolean> {
    if (!this.editorAttached) {
      log(`pairing request from ${origin} refused: no editor attached to ask`);
      return Promise.resolve(false);
    }
    log(`pairing request from ${origin}`);
    this.events.emit('trust', { origin });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingTrust.delete(origin)) {
          log(`pairing request from ${origin} timed out`);
          resolve(false);
        }
      }, TRUST_TIMEOUT_MS);

      this.pendingTrust.set(origin, (allowed) => {
        clearTimeout(timer);
        resolve(allowed);
      });
    });
  }

  // ── editor methods ──────────────────────────────────────────────────────

  status(): Record<string, unknown> {
    return {
      listening: this.server?.isListening ?? false,
      portConflict: this.server?.hasPortConflict ?? false,
      port: this.server?.port ?? config.port(),
      contestsDir: config.contestsDir() ?? null,
      language: config.languageKey(),
      handle: this.handle() ?? null,
      trustedOrigins: [...this.state.trustedOrigins],
      settingsFile: this.settingsFile,
      templateFile: config.templateFile(),
      pendingSubmit: this.pendingSubmit
        ? `${this.pendingSubmit.contestId}${this.pendingSubmit.index}`
        : null
    };
  }

  async problem(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const found = await this.require(params);
    return {
      contestId: found.contest.contestId,
      contestName: found.contest.name,
      folder: found.contestFolder,
      index: found.problem.index,
      id: found.problem.id,
      name: found.problem.name,
      url: found.problem.url,
      timeLimit: found.problem.timeLimit ?? null,
      memoryLimit: found.problem.memoryLimit ?? null,
      samples: found.problem.samples.length,
      extraSamples: found.problem.extraSamples?.length ?? 0,
      problems: found.contest.problems.map((entry) => ({
        index: entry.index,
        id: entry.id,
        name: entry.name,
        file: entry.file
      }))
    };
  }

  /**
   * Compile and run every sample, reporting each result as it lands.
   *
   * The editor gets `run` events so a long test does not look like a hang, and
   * the same state again as the reply — a client that only wants the answer can
   * ignore the events entirely.
   */
  async test(params: Record<string, unknown>): Promise<RunState> {
    const found = await this.require(params);
    const file = found.problem.file;
    if (this.busyFile === file) {
      throw new Error(`${found.problem.id} is already running.`);
    }

    const samples = allSamples(found.problem);
    if (samples.length === 0) {
      throw new Error(
        `${found.problem.id} has no samples. Re-capture the contest to fetch them.`
      );
    }

    const results: TestResult[] = pendingResults(found.problem);
    const state: RunState = { phase: 'compiling', results, startedAt: Date.now() };
    this.busyFile = file;
    this.emitRun(file, state);

    try {
      const built = await compile(file);
      if (!built.ok) {
        state.phase = 'failed';
        state.compileOutput = built.output || 'The compiler reported an error.';
        state.finishedAt = Date.now();
        this.emitRun(file, state);
        return state;
      }
      if (built.output) {
        log(`compiler output for ${path.basename(file)}:\n${built.output}`);
      }

      state.phase = 'running';
      this.emitRun(file, state);

      const cwd = path.dirname(file);
      for (let i = 0; i < samples.length; i += 1) {
        results[i] = { ...results[i], status: 'running' };
        this.emitRun(file, state);
        const ran = await runSample(built.runCommand, samples[i], i + 1, cwd);
        results[i] = { ...ran, custom: results[i].custom };
        this.emitRun(file, state);
      }

      state.phase = 'done';
      state.finishedAt = Date.now();
      const passed = results.filter((result) => result.status === 'passed').length;
      log(`ran ${found.problem.id}: ${passed}/${results.length} passed`);
      this.emitRun(file, state);
      return state;
    } catch (error) {
      logError(`running ${file}`, error);
      state.phase = 'failed';
      state.compileOutput = error instanceof Error ? error.message : String(error);
      state.finishedAt = Date.now();
      this.emitRun(file, state);
      return state;
    } finally {
      this.busyFile = undefined;
    }
  }

  /**
   * Queue a solution for the browser to put into the submit form.
   *
   * Nothing here presses anything: the browser fills the form and stops, which
   * is a decision recorded in README.md and SECURITY.md and not one to undo
   * because a command-line client would find it convenient.
   */
  async submit(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const found = await this.require(params);
    if (!this.server?.isListening) {
      throw new Error(
        'The capture server is not listening, so the browser cannot pick the submit up.'
      );
    }

    const file = found.problem.file;
    const code = await fs.readFile(file, 'utf8');
    if (!code.trim()) {
      throw new Error('Nothing to submit — the file is empty.');
    }

    this.watcher.cancel();
    this.clearPickupTimer();

    this.pendingSubmit = {
      id: crypto.randomUUID(),
      contestId: found.problem.contestId,
      index: found.problem.index,
      language: config.languageKey(),
      code,
      queuedAt: Date.now()
    };
    this.pendingClaimedAt = 0;
    this.submitFile = file;

    this.pushVerdict({ phase: 'queued', problemId: found.problem.id, updatedAt: Date.now() });
    log(`queued submit for ${found.problem.id} (${code.length} bytes)`);

    this.pickupTimer = setTimeout(() => {
      if (!this.pendingSubmit) {
        return;
      }
      this.pendingSubmit = undefined;
      this.pushVerdict({
        phase: 'failed',
        problemId: found.problem.id,
        error: 'The browser never picked this up. Open a Codeforces tab and try again.',
        updatedAt: Date.now()
      });
    }, PICKUP_TIMEOUT_MS);

    return { problemId: found.problem.id, bytes: code.length };
  }

  /**
   * Stop waiting on a submit that is in the user's hands. The browser tab is
   * left alone on purpose — it is where the solution is sitting.
   */
  cancelSubmit(): Record<string, unknown> {
    const pending = this.pendingSubmit;
    this.pendingSubmit = undefined;
    this.pendingClaimedAt = 0;
    this.clearPickupTimer();
    this.watcher.cancel();
    if (pending) {
      this.pushVerdict({
        phase: 'cancelled',
        problemId: `${pending.contestId}${pending.index}`,
        updatedAt: Date.now()
      });
    }
    log('submit cancelled from the editor');
    return { cancelled: pending !== undefined };
  }

  answerTrust(params: Record<string, unknown>): Record<string, unknown> {
    const origin = typeof params.origin === 'string' ? params.origin : '';
    const allow = params.allow === true;
    const resolve = this.pendingTrust.get(origin);
    if (!resolve) {
      return { answered: false };
    }
    this.pendingTrust.delete(origin);

    if (allow) {
      this.state.trustedOrigins = [...this.state.trustedOrigins, origin];
      void writeState(this.state).catch((error) => logError('saving host state', error));
      log(`paired with ${origin}`);
    } else {
      log(`pairing refused for ${origin}`);
    }
    resolve(allow);
    return { answered: true, allowed: allow };
  }

  async forgetClients(): Promise<Record<string, unknown>> {
    const count = this.state.trustedOrigins.length;
    this.state.trustedOrigins = [];
    await writeState(this.state);
    log('paired browser extensions forgotten');
    return { forgotten: count };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private handle(): string | undefined {
    return config.handle() || this.state.handle || undefined;
  }

  private async require(params: Record<string, unknown>) {
    const file = typeof params.file === 'string' ? params.file : '';
    if (!file) {
      throw new Error('No file given.');
    }
    const found = await lookupByFile(path.resolve(file));
    if (!found) {
      throw new Error(
        `${path.basename(file)} is not a captured solution. ` +
          'Capture the contest from its Codeforces page first.'
      );
    }
    return found;
  }

  private emitRun(file: string, state: RunState): void {
    // A copy, because the caller keeps mutating `results` as tests finish.
    this.events.emit('run', {
      file,
      state: { ...state, results: state.results.map((result) => ({ ...result })) }
    });
  }

  private pushVerdict(state: VerdictState): void {
    this.events.emit('verdict', {
      file: this.submitFile ?? null,
      state: { ...state, message: describe(state) }
    });
  }

  private clearPickupTimer(): void {
    if (this.pickupTimer) {
      clearTimeout(this.pickupTimer);
      this.pickupTimer = undefined;
    }
  }
}
