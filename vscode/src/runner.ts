import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as config from './config';
import { log } from './log';
import { Sample, TestResult, TestStatus } from './types';

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
}

let binDirectory: string | undefined;

/** Compiled binaries live outside the contest folder, which stays source-only. */
export function setBinDirectory(dir: string): void {
  binDirectory = dir;
}

function binDir(): string {
  return binDirectory ?? path.join(os.tmpdir(), 'codeforces-assistant');
}

function fillPlaceholders(command: string, source: string, exe: string): string {
  return command
    .replaceAll('{src}', source)
    .replaceAll('{exe}', exe)
    .replaceAll('{dir}', path.dirname(source))
    .replaceAll('{name}', path.parse(source).name);
}

function exePathFor(source: string): string {
  const digest = crypto.createHash('sha1').update(path.resolve(source)).digest('hex').slice(0, 16);
  const name = `${path.parse(source).name}-${digest}${process.platform === 'win32' ? '.exe' : ''}`;
  return path.join(binDir(), name);
}

/**
 * Run a command with an optional stdin payload and a hard wall-clock limit.
 * The child gets its own process group so a timeout kills anything it spawned,
 * not just the shell in front of it.
 */
export function exec(
  command: string,
  options: { stdin?: string; timeoutMs: number; cwd?: string }
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, durationMs: Date.now() - startedAt });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') {
          child.kill();
        } else if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        // Already gone.
      }
      finish(null);
    }, options.timeoutMs);

    // Cap what we keep, so a runaway printing loop cannot exhaust memory.
    const CAP = 1024 * 1024;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < CAP) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < CAP) {
        stderr += chunk.toString('utf8');
      }
    });

    child.on('error', (error) => {
      stderr += `${stderr ? '\n' : ''}${error.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));

    if (options.stdin !== undefined) {
      child.stdin.on('error', () => {
        // A program that exits without reading stdin gives us EPIPE. Not an error.
      });
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export interface CompileOutcome {
  ok: boolean;
  output: string;
  /** What to run for each test. */
  runCommand: string;
}

export async function compile(source: string): Promise<CompileOutcome> {
  const language = config.language();
  const exe = exePathFor(source);
  const runCommand = fillPlaceholders(language.run, source, exe);

  if (!language.compile.trim()) {
    return { ok: true, output: '', runCommand };
  }

  await fs.mkdir(path.dirname(exe), { recursive: true });
  const command = fillPlaceholders(language.compile, source, exe);
  log(`compile: ${command}`);
  const outcome = await exec(command, {
    timeoutMs: config.compileTimeoutMs(),
    cwd: path.dirname(source)
  });

  const output = [outcome.stdout, outcome.stderr].filter(Boolean).join('\n').trim();
  if (outcome.timedOut) {
    return { ok: false, output: `${output}\n\nCompilation timed out.`.trim(), runCommand };
  }
  return { ok: outcome.code === 0, output, runCommand };
}

/** Trailing whitespace never decides a Codeforces verdict, so it does not decide ours. */
function canonical(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function compare(
  expected: string,
  actual: string
): { equal: boolean; firstDiffLine?: number } {
  const left = canonical(expected);
  const right = canonical(actual);
  const limit = Math.max(left.length, right.length);
  for (let i = 0; i < limit; i += 1) {
    if (left[i] !== right[i]) {
      return { equal: false, firstDiffLine: i + 1 };
    }
  }
  return { equal: true };
}

export async function runSample(
  runCommand: string,
  sample: Sample,
  number: number,
  cwd: string
): Promise<TestResult> {
  const outcome = await exec(runCommand, {
    stdin: sample.input.endsWith('\n') ? sample.input : `${sample.input}\n`,
    timeoutMs: config.runTimeoutMs(),
    cwd
  });

  let status: TestStatus;
  let firstDiffLine: number | undefined;

  if (outcome.timedOut) {
    status = 'timeout';
  } else if (outcome.code !== 0) {
    status = 'error';
  } else {
    const verdict = compare(sample.output, outcome.stdout);
    status = verdict.equal ? 'passed' : 'wrong';
    firstDiffLine = verdict.firstDiffLine;
  }

  return {
    number,
    status,
    input: sample.input,
    expected: sample.output,
    actual: outcome.stdout,
    stderr: outcome.stderr,
    durationMs: outcome.durationMs,
    exitCode: outcome.code,
    firstDiffLine
  };
}
