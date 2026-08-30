import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { applyCapture, revealCapture, CaptureResult } from './capture';
import * as config from './config';
import * as cursor from './cursor';
import { initLog, log, logError, showLog } from './log';
import { PanelState, SettingsState, TestsPanel } from './panel';
import { CaptureServer } from './server';
import { ProgressPoller } from './progress';
import { lookupByFile, updateProblem, ProblemLookup } from './store';
import { activeTemplateFile, adoptTemplate, seedTemplate, TemplateExistsError } from './template';
import {
  ContestMeta,
  PendingSubmit,
  ProblemMeta,
  ProblemStatus,
  ProblemTab,
  Sample,
  RunState,
  TestResult,
  VerdictState
} from './types';
import { compile, runSample, setBinDirectory } from './runner';
import { VerdictWatcher, describe } from './verdict';
import { ValidCapture } from './validate';

const TRUSTED_ORIGINS_KEY = 'cfa.trustedOrigins';
const HANDLE_KEY = 'cfa.handle.seen';
/** How long a claimed submit stays hidden before it is offered again. */
const CLAIM_WINDOW_MS = 45_000;
/**
 * How long we wait for the browser to pick a submit up.
 *
 * An open Codeforces tab answers within two seconds. With no tab open at all,
 * the only thing left is the service worker's alarm, and Chrome will not run an
 * alarm more often than once a minute — so this has to outlast one.
 */
const PICKUP_TIMEOUT_MS = 75_000;
/** How long the browser gets to report back once it has taken one. */
const ACK_TIMEOUT_MS = 90_000;

const IDLE_RUN: RunState = { phase: 'idle', results: [] };

/** Codeforces sample files end in a newline; hand-typed tests should too. */
function endWithNewline(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  return trimmed.length === 0 ? '' : `${trimmed}\n`;
}
const IDLE_VERDICT: VerdictState = { phase: 'idle', updatedAt: 0 };

export function activate(context: vscode.ExtensionContext): void {
  initLog();
  const app = new Application(context);
  context.subscriptions.push(app);
  void app.start();
}

export function deactivate(): void {
  // Disposal is handled through context.subscriptions.
}

class Application implements vscode.Disposable {
  private readonly panel: TestsPanel;
  private readonly server: CaptureServer;
  private readonly watcher = new VerdictWatcher();
  private readonly progress = new ProgressPoller();

  /** Contest the tab strip shows. Kept when the active editor moves away, so
   *  the strip does not blink out every time a non-solution file is focused. */
  private shown: { folder: string; contest: ContestMeta } | undefined;
  /** Codeforces' answer for `shown`, by problem index. */
  private statuses = new Map<string, ProblemStatus>();

  /** Per-file state, so switching tabs does not throw results away. */
  private readonly runs = new Map<string, RunState>();
  private readonly verdicts = new Map<string, VerdictState>();

  private pendingSubmit: PendingSubmit | undefined;
  private pendingClaimedAt = 0;
  private pickupTimer: NodeJS.Timeout | undefined;

  private current: ProblemLookup | undefined;
  private busyFile: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const version = String(
      (context.extension.packageJSON as { version?: string }).version ?? ''
    );
    this.panel = new TestsPanel(
      context.extensionUri,
      {
        run: () => void this.runSamples(),
        submit: () => void this.submit(),
        setHandle: () => void this.promptHandle(),
        revealFile: (file) => void vscode.window.showTextDocument(vscode.Uri.file(file)),
        openIndex: (index) => void this.openIndex(index),
        addTest: (input, expected) => void this.addTest(input, expected),
        removeTest: (number) => void this.removeTest(number),
        cancelSubmit: () => this.cancelSubmit(),
        browseTemplate: () => void this.browseTemplate(),
        applySettings: (line, character, port) =>
          void this.applySettings(line, character, port)
      },
      version ? `v${version}` : ''
    );

    this.server = new CaptureServer({
      applyCapture: (capture) => this.handleCapture(capture as ValidCapture),
      peekPendingSubmit: () => this.peekPendingSubmit(),
      markSubmitClaimed: (id) => this.markSubmitClaimed(id),
      onSubmitAck: (payload) => this.handleSubmitAck(payload),
      onHandleSeen: (handle) => void this.rememberHandle(handle),
      isTrustedOrigin: (origin) => this.trustedOrigins().includes(origin),
      requestTrust: (origin) => this.requestTrust(origin)
    });

    setBinDirectory(path.join(context.globalStorageUri.fsPath, 'bin'));
  }

  async start(): Promise<void> {
    const { context } = this;

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(TestsPanel.viewId, this.panel, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      vscode.commands.registerCommand('cfa.runSamples', () => this.runSamples()),
      vscode.commands.registerCommand('cfa.submit', () => this.submit()),
      vscode.commands.registerCommand('cfa.startServer', () => this.startServer(true)),
      vscode.commands.registerCommand('cfa.stopServer', () => this.stopServer()),
      vscode.commands.registerCommand('cfa.openProblem', () => this.openProblem()),
      vscode.commands.registerCommand('cfa.setHandle', () => this.promptHandle()),
      vscode.commands.registerCommand('cfa.showLog', () => showLog()),
      vscode.commands.registerCommand('cfa.openSettings', () => this.panel.toggleSettings()),
      vscode.commands.registerCommand('cfa.forgetClients', () => this.forgetClients()),
      vscode.commands.registerCommand('cfa.editTemplate', () => this.editTemplate()),
      vscode.window.onDidChangeActiveTextEditor(() => void this.refreshProblem()),
      vscode.commands.registerCommand('cfa.placeCursor', () => this.placeCursorNow()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('cfa.port')) {
          this.stopServer();
          void this.startServer(false);
        }
        if (
          event.affectsConfiguration('cfa.handle') ||
          event.affectsConfiguration('cfa.progress')
        ) {
          this.syncProgress();
        }
        if (event.affectsConfiguration('cfa')) {
          void this.refreshSettings();
        }
        if (event.affectsConfiguration('cfa.cursorOnOpen') || event.affectsConfiguration('cfa.cursorAnchor')) {
          // Let the new setting take effect on files already visited.
          cursor.forget();
        }
      })
    );

    await seedTemplate();
    await this.refreshSettings();
    if (config.autoStartServer()) {
      await this.startServer(false);
    }
    await this.refreshProblem();
  }

  dispose(): void {
    this.watcher.cancel();
    this.progress.stop();
    this.clearPickupTimer();
    this.server.stop();
  }

  // ── server lifecycle ────────────────────────────────────────────────────

  private async startServer(interactive: boolean): Promise<void> {
    try {
      await this.server.start();
    } catch (error) {
      logError('starting capture server', error);
      void vscode.window.showErrorMessage(
        `Codeforces Assistant could not start its capture server: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (interactive && this.server.hasPortConflict) {
      void vscode.window.showWarningMessage(
        `Port ${config.port()} is already in use — another VS Code window owns capture. ` +
          'Run "Codeforces: Stop Capture Server" there first.'
      );
    }
    this.pushState();
  }

  private stopServer(): void {
    this.server.stop();
    this.pushState();
  }

  // ── capture ─────────────────────────────────────────────────────────────

  private async handleCapture(capture: ValidCapture): Promise<CaptureResult> {
    const result = await applyCapture(capture);
    await revealCapture(result);
    await this.refreshProblem();

    const summary =
      `${capture.contestId}: ${result.created.length + result.existing.length} problem(s), ` +
      `${result.created.length} new file(s), ${result.totalSamples} sample(s)`;
    void vscode.window.setStatusBarMessage(`$(check) Codeforces ${summary}`, 6000);
    return result;
  }

  // ── settings ────────────────────────────────────────────────────────────

  /** Set after a failed browse, cleared as soon as the next one is attempted. */
  private templateError: string | undefined;

  private async settingsState(): Promise<SettingsState> {
    const active = await activeTemplateFile();
    return {
      template: active?.file,
      templateLocal: active?.local ?? false,
      cursorLine: config.cursorLine(),
      cursorCharacter: config.cursorCharacter(),
      port: config.port(),
      templateError: this.templateError
    };
  }

  private async refreshSettings(): Promise<void> {
    this.panel.update({ settings: await this.settingsState() });
  }

  private async browseTemplate(): Promise<void> {
    const extension = config.language().extension;
    const picked = await vscode.window.showOpenDialog({
      title: 'Choose a solution template',
      openLabel: 'Use as template',
      canSelectMany: false,
      filters: { Source: [extension, 'cpp', 'cc', 'py', 'txt'], 'All files': ['*'] }
    });
    if (!picked || picked.length === 0) {
      return;
    }

    this.templateError = undefined;
    try {
      const target = await adoptTemplate(picked[0].fsPath);
      void vscode.window.showInformationMessage(
        `Template copied to ${path.basename(target)}. Solutions are created from this copy.`
      );
    } catch (error) {
      this.templateError =
        error instanceof TemplateExistsError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      logError('adopting a template', error);
      void vscode.window.showErrorMessage(this.templateError);
    }
    await this.refreshSettings();
  }

  /** Everything the gear screen edits, written in one go when Done is pressed. */
  private async applySettings(line: number, character: number, port: number): Promise<void> {
    const settings = vscode.workspace.getConfiguration('cfa');
    const whole = (value: number, least: number): number =>
      Number.isFinite(value) ? Math.max(least, Math.floor(value)) : least;

    // Lines from 1, columns from 0.
    await settings.update('cursorLine', whole(line, 1), vscode.ConfigurationTarget.Global);
    await settings.update(
      'cursorCharacter',
      whole(character, 0),
      vscode.ConfigurationTarget.Global
    );
    // The rule changed, so files already visited should follow the new one.
    cursor.forget();

    if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
      await settings.update('port', port, vscode.ConfigurationTarget.Global);
    } else if (port !== config.port()) {
      void vscode.window.showWarningMessage(
        'The port was left alone: it has to be a whole number between 1024 and 65535.'
      );
    }

    await this.refreshSettings();
  }

  // ── tests ───────────────────────────────────────────────────────────────

  /** Official samples first, then the user's own, which is the order they run in. */
  private static tests(problem: ProblemMeta): Sample[] {
    return [...problem.samples, ...(problem.extraSamples ?? [])];
  }

  private static toResults(problem: ProblemMeta): TestResult[] {
    const official = problem.samples.length;
    return Application.tests(problem).map((sample, i) => ({
      number: i + 1,
      status: 'pending',
      input: sample.input,
      expected: sample.output,
      actual: '',
      stderr: '',
      durationMs: 0,
      exitCode: null,
      custom: i >= official
    }));
  }

  private async addTest(input: string, expected: string): Promise<void> {
    const found = this.current;
    if (!found) {
      return;
    }
    if (!input.trim() && !expected.trim()) {
      void vscode.window.showWarningMessage('Nothing to add — both boxes are empty.');
      return;
    }
    await this.mutateTests(found, (extra) => [
      ...extra,
      // Codeforces samples always end in a newline; a hand-typed one that does
      // not would fail against a program that prints one, for no real reason.
      { input: endWithNewline(input), output: endWithNewline(expected) }
    ]);
    log(`added a test to ${found.problem.id}`);
  }

  private async removeTest(number: number): Promise<void> {
    const found = this.current;
    if (!found) {
      return;
    }
    const position = number - 1 - found.problem.samples.length;
    if (position < 0) {
      // The contest's own samples are not ours to delete; re-capture owns them.
      return;
    }
    await this.mutateTests(found, (extra) => extra.filter((_, i) => i !== position));
    log(`removed test ${number} from ${found.problem.id}`);
  }

  private async mutateTests(
    found: ProblemLookup,
    mutate: (extra: Sample[]) => Sample[]
  ): Promise<void> {
    await updateProblem(found.contestFolder, found.problem.index, (problem) => ({
      ...problem,
      extraSamples: mutate(problem.extraSamples ?? [])
    }));
    // Editing the test list invalidates the results shown against it.
    this.runs.delete(found.problem.file);
    await this.refreshProblem();
  }

  // ── problem resolution ──────────────────────────────────────────────────

  private activeFile(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme === 'file') {
      return editor.document.uri.fsPath;
    }
    return undefined;
  }

  private async refreshProblem(): Promise<void> {
    const file = this.activeFile();

    // No active editor is not the same as no problem. VS Code reports one
    // whenever focus leaves the editor grid — clicking this panel does it, and
    // so does a moment mid-way through switching tabs. Dropping the problem
    // there is what made the panel flash "No file open" over an open file.
    if (!file) {
      this.pushState();
      return;
    }

    this.current = await lookupByFile(file);

    if (this.current) {
      if (this.shown?.contest.contestId !== this.current.contest.contestId) {
        // A different contest: the old colours say nothing about this one.
        this.statuses = new Map();
      }
      this.shown = { folder: this.current.contestFolder, contest: this.current.contest };
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.fsPath === this.current.problem.file) {
        await cursor.positionOnOpen(editor);
      }
    }

    this.syncProgress();
    this.pushState();
  }

  // ── contest progress (the tab strip's colours) ──────────────────────────

  private syncProgress(): void {
    const contestId = this.shown?.contest.contestId;
    const handle = this.handle();
    if (!config.progressEnabled() || !contestId || !handle) {
      this.progress.stop();
      return;
    }
    this.progress.start({
      handle,
      contestId,
      onUpdate: (statuses) => {
        if (this.shown?.contest.contestId !== contestId) {
          return;
        }
        this.statuses = statuses;
        this.pushState();
      }
    });
  }

  private tabs(): ProblemTab[] | undefined {
    const shown = this.shown;
    if (!shown) {
      return undefined;
    }
    const extension = config.language().extension;
    const openId = this.current?.problem.id;
    return shown.contest.problems.map((problem) => ({
      index: problem.index,
      id: problem.id,
      name: problem.name,
      // Built from the folder we actually found, not the recorded path, which
      // is stale as soon as the contest folder is moved.
      file: path.join(
        shown.folder,
        problem.file ? path.basename(problem.file) : `${problem.id}.${extension}`
      ),
      status: this.statuses.get(problem.index) ?? 'untouched',
      active: problem.id === openId
    }));
  }

  private async openIndex(index: string): Promise<void> {
    const tab = this.tabs()?.find((entry) => entry.index === index);
    if (!tab) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(tab.file);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      await cursor.positionOnOpen(editor);
    } catch (error) {
      logError(`opening ${tab.file}`, error);
      void vscode.window.showWarningMessage(
        `${tab.id} has no solution file yet. Re-capture the contest to create it.`
      );
    }
  }

  /** Manual re-run of the open-file caret placement, for a file already open. */
  private async placeCursorNow(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await cursor.positionOnOpen(editor, true);
    }
  }

  private pushState(): void {
    const file = this.current?.problem.file;
    const patch: Partial<PanelState> = {
      problem: this.current?.problem,
      tabs: this.tabs(),
      contest: this.shown
        ? { id: this.shown.contest.contestId, name: this.shown.contest.name }
        : undefined,
      file,
      // With no run yet, list the tests as pending rather than showing nothing:
      // the user has to see a test to decide to add another one.
      run:
        (file ? this.runs.get(file) : undefined) ??
        (this.current ? { phase: 'idle', results: Application.toResults(this.current.problem) } : IDLE_RUN),
      officialCount: this.current?.problem.samples.length,
      verdict: (file ? this.verdicts.get(file) : undefined) ?? IDLE_VERDICT,
      server: {
        listening: this.server.isListening,
        port: this.server.port,
        conflict: this.server.hasPortConflict
      },
      handle: this.handle()
    };
    if (!this.current) {
      patch.hint = this.activeFile()
        ? 'This file is not a captured Codeforces solution.'
        : 'Open a captured solution.';
    }
    this.panel.update(patch);
  }

  private async requireProblem(): Promise<ProblemLookup | undefined> {
    await this.refreshProblem();
    if (!this.current) {
      void vscode.window.showWarningMessage(
        'Open a captured solution first — capture a contest from the Codeforces page.'
      );
      return undefined;
    }
    return this.current;
  }

  // ── running samples ─────────────────────────────────────────────────────

  private async runSamples(): Promise<void> {
    const found = await this.requireProblem();
    if (!found) {
      return;
    }
    const file = found.problem.file;
    if (this.busyFile === file) {
      return;
    }

    const samples = Application.tests(found.problem);
    if (samples.length === 0) {
      void vscode.window.showWarningMessage(
        `${found.problem.id} has no samples. Re-capture the contest to fetch them.`
      );
      return;
    }

    await vscode.workspace.save(vscode.Uri.file(file));
    this.busyFile = file;

    const results: TestResult[] = Application.toResults(found.problem);

    const state: RunState = {
      phase: 'compiling',
      results,
      startedAt: Date.now()
    };
    this.runs.set(file, state);
    this.pushState();

    try {
      const built = await compile(file);
      if (!built.ok) {
        state.phase = 'failed';
        state.compileOutput = built.output || 'The compiler reported an error.';
        state.finishedAt = Date.now();
        this.pushState();
        return;
      }
      if (built.output) {
        log(`compiler output for ${path.basename(file)}:\n${built.output}`);
      }

      state.phase = 'running';
      this.pushState();

      const cwd = path.dirname(file);
      for (let i = 0; i < samples.length; i += 1) {
        results[i] = { ...results[i], status: 'running' };
        this.runs.set(file, { ...state, results: [...results] });
        this.pushState();

        const ran = await runSample(built.runCommand, samples[i], i + 1, cwd);
        results[i] = { ...ran, custom: results[i].custom };
        this.runs.set(file, { ...state, results: [...results] });
        this.pushState();
      }

      state.phase = 'done';
      state.finishedAt = Date.now();
      this.runs.set(file, { ...state, results: [...results] });

      const passed = results.filter((r) => r.status === 'passed').length;
      log(`ran ${found.problem.id}: ${passed}/${results.length} passed`);
    } catch (error) {
      logError(`running ${file}`, error);
      state.phase = 'failed';
      state.compileOutput = error instanceof Error ? error.message : String(error);
    } finally {
      this.busyFile = undefined;
      this.pushState();
    }
  }

  // ── submitting ──────────────────────────────────────────────────────────

  private async submit(): Promise<void> {
    const found = await this.requireProblem();
    if (!found) {
      return;
    }
    if (!this.server.isListening) {
      void vscode.window.showWarningMessage(
        'The capture server is not running, so the browser cannot pick the submit up. ' +
          'Run "Codeforces: Start Capture Server".'
      );
      return;
    }

    const file = found.problem.file;
    await vscode.workspace.save(vscode.Uri.file(file));
    const document = await vscode.workspace.openTextDocument(file);
    const code = document.getText();
    if (!code.trim()) {
      void vscode.window.showWarningMessage('Nothing to submit — the file is empty.');
      return;
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

    this.setVerdict(file, {
      phase: 'queued',
      problemId: found.problem.id,
      updatedAt: Date.now()
    });
    log(`queued submit for ${found.problem.id} (${code.length} bytes)`);

    this.pickupTimer = setTimeout(() => {
      if (!this.pendingSubmit) {
        return;
      }
      this.pendingSubmit = undefined;
      this.setVerdict(file, {
        phase: 'failed',
        problemId: found.problem.id,
        error: 'The browser never picked this up. Open a Codeforces tab and try again.',
        updatedAt: Date.now()
      });
    }, PICKUP_TIMEOUT_MS);
  }

  /**
   * Stop waiting on a submit that is in the user's hands.
   *
   * The browser tab is left alone on purpose — it is where the solution is
   * sitting, and closing it would throw away the thing being cancelled. What
   * this ends is the extension's part: the queued request, the pickup timer and
   * the verdict poll, so Submit can be pressed again from here.
   */
  private cancelSubmit(): void {
    const pending = this.pendingSubmit;
    const file = this.fileForPending() ?? this.current?.problem.file;
    this.pendingSubmit = undefined;
    this.pendingClaimedAt = 0;
    this.clearPickupTimer();
    this.watcher.cancel();

    if (file) {
      this.setVerdict(file, {
        phase: 'cancelled',
        problemId: pending
          ? `${pending.contestId}${pending.index}`
          : this.current?.problem.id,
        updatedAt: Date.now()
      });
    }
    log('submit cancelled from the panel');
  }

  private peekPendingSubmit(): PendingSubmit | undefined {
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

  private markSubmitClaimed(id: string): void {
    if (this.pendingSubmit?.id !== id) {
      return;
    }
    this.pendingClaimedAt = Date.now();
    this.clearPickupTimer();

    const problemId = `${this.pendingSubmit.contestId}${this.pendingSubmit.index}`;
    const file = this.fileForPending();
    if (file) {
      this.setVerdict(file, { phase: 'sent', problemId, updatedAt: Date.now() });
    }

    // The browser has it. If it never reports back — a closed tab, a crashed
    // worker — the panel must not sit on "Submitted" for ever.
    this.pickupTimer = setTimeout(() => {
      if (this.pendingSubmit?.id !== id) {
        return;
      }
      this.pendingSubmit = undefined;
      if (file) {
        this.setVerdict(file, {
          phase: 'failed',
          problemId,
          error: 'The browser took this submit but never reported back. Check Codeforces.',
          updatedAt: Date.now()
        });
      }
    }, ACK_TIMEOUT_MS);
  }

  private handleSubmitAck(payload: { id: string; ok: boolean; reason?: string }): void {
    const pending = this.pendingSubmit;
    if (!pending || pending.id !== payload.id) {
      log(`ignoring ack for unknown submit ${payload.id}`);
      return;
    }
    this.pendingSubmit = undefined;
    this.clearPickupTimer();

    const file = this.fileForPending(pending);
    const problemId = `${pending.contestId}${pending.index}`;

    if (!payload.ok) {
      log(`could not open the submit form for ${problemId}: ${payload.reason ?? 'no reason given'}`);
      if (file) {
        this.setVerdict(file, {
          phase: 'failed',
          problemId,
          error: `Could not fill the submit form: ${payload.reason ?? 'unknown reason'}`,
          updatedAt: Date.now()
        });
      }
      return;
    }

    log(`submit form ready for ${problemId}; watching for the submission`);
    const handle = this.handle();
    if (!handle) {
      if (file) {
        this.setVerdict(file, {
          phase: 'failed',
          problemId,
          error: 'Submitted, but no Codeforces handle is set, so the verdict cannot be polled.',
          updatedAt: Date.now()
        });
      }
      void this.promptHandle();
      return;
    }

    void this.watcher.watch({
      handle,
      contestId: pending.contestId,
      index: pending.index,
      queuedAt: pending.queuedAt,
      onUpdate: (state) => {
        if (file) {
          this.setVerdict(file, state);
        }
      }
    });
  }

  private fileForPending(pending = this.pendingSubmit): string | undefined {
    if (!pending) {
      return undefined;
    }
    const id = `${pending.contestId}${pending.index}`;
    if (this.current?.problem.id === id) {
      return this.current.problem.file;
    }
    for (const file of this.verdicts.keys()) {
      if (path.parse(file).name === id) {
        return file;
      }
    }
    return undefined;
  }

  private setVerdict(file: string, state: VerdictState): void {
    const enriched: VerdictState = { ...state, message: describe(state) };
    this.verdicts.set(file, enriched);
    if (state.phase === 'final') {
      // Recolour the tab now rather than up to ten seconds from now.
      this.progress.refresh();
    }
    this.pushState();
  }

  private clearPickupTimer(): void {
    if (this.pickupTimer) {
      clearTimeout(this.pickupTimer);
      this.pickupTimer = undefined;
    }
  }

  // ── handle ──────────────────────────────────────────────────────────────

  private handle(): string | undefined {
    return config.handle() || this.context.globalState.get<string>(HANDLE_KEY) || undefined;
  }

  private async rememberHandle(handle: string): Promise<void> {
    if (this.context.globalState.get<string>(HANDLE_KEY) === handle) {
      return;
    }
    await this.context.globalState.update(HANDLE_KEY, handle);
    log(`learned Codeforces handle from the browser: ${handle}`);
    this.syncProgress();
    this.pushState();
  }

  private async promptHandle(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: 'Codeforces handle',
      prompt: 'Used to poll the public Codeforces API for verdicts.',
      value: this.handle() ?? '',
      validateInput: (input) =>
        /^[A-Za-z0-9_.-]{3,24}$/.test(input.trim()) ? undefined : 'That is not a Codeforces handle.'
    });
    if (value === undefined) {
      return;
    }
    await vscode.workspace
      .getConfiguration('cfa')
      .update('handle', value.trim(), vscode.ConfigurationTarget.Global);
    this.syncProgress();
    this.pushState();
  }

  // ── browser pairing ─────────────────────────────────────────────────────

  private trustedOrigins(): string[] {
    return this.context.globalState.get<string[]>(TRUSTED_ORIGINS_KEY, []);
  }

  private async requestTrust(origin: string): Promise<boolean> {
    log(`pairing request from ${origin}`);
    const allow = 'Allow';
    const choice = await vscode.window.showWarningMessage(
      `Allow the browser extension ${origin} to create files and queue submits for this window?`,
      { modal: true, detail: 'Only approve this if you just installed the Codeforces Assistant browser extension.' },
      allow
    );
    if (choice !== allow) {
      log(`pairing refused for ${origin}`);
      return false;
    }
    await this.context.globalState.update(TRUSTED_ORIGINS_KEY, [...this.trustedOrigins(), origin]);
    log(`paired with ${origin}`);
    return true;
  }

  private async forgetClients(): Promise<void> {
    await this.context.globalState.update(TRUSTED_ORIGINS_KEY, []);
    void vscode.window.showInformationMessage(
      'Paired browser extensions forgotten. The next request will ask again.'
    );
  }

  // ── misc commands ───────────────────────────────────────────────────────

  private async openProblem(): Promise<void> {
    const found = await this.requireProblem();
    if (found) {
      await vscode.env.openExternal(vscode.Uri.parse(found.problem.url));
    }
  }

  private async editTemplate(): Promise<void> {
    await seedTemplate();
    const document = await vscode.workspace.openTextDocument(config.templateFile());
    await vscode.window.showTextDocument(document);
  }
}
