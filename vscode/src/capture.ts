import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import * as config from './config';
import { markPositioned, place } from './cursor';
import { log } from './log';
import { contestDir, problemId, solutionPath } from './paths';
import { mergeContest } from './store';
import { readTemplate } from './template';
import { ContestMeta, ProblemMeta } from './types';
import { ValidCapture } from './validate';

export interface CaptureResult {
  contestId: number;
  contestFolder: string;
  created: string[];
  existing: string[];
  totalSamples: number;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn a validated capture into files on disk.
 *
 * An existing solution is never touched. Re-capturing a contest you have
 * already started is a normal thing to do — samples get refreshed, your code
 * stays exactly as you left it.
 */
export async function applyCapture(capture: ValidCapture): Promise<CaptureResult> {
  const base = config.contestsDir();
  if (!base) {
    throw new Error(
      'No contests folder. Open a folder in VS Code, or set "cfa.contestsDir" in settings.'
    );
  }

  const language = config.language();
  const folder = contestDir(base, capture.contestId);
  await fs.mkdir(folder, { recursive: true });

  const template = await readTemplate();
  const created: string[] = [];
  const existing: string[] = [];
  const problems: ProblemMeta[] = [];
  const capturedAt = new Date().toISOString();

  for (const problem of capture.problems) {
    const file = solutionPath(base, capture.contestId, problem.index, language.extension);
    if (await fileExists(file)) {
      existing.push(file);
    } else {
      await fs.writeFile(file, template.text, 'utf8');
      created.push(file);
    }

    problems.push({
      contestId: capture.contestId,
      index: problem.index,
      id: problemId(capture.contestId, problem.index),
      name: problem.name,
      url: problem.url,
      timeLimit: problem.timeLimit,
      memoryLimit: problem.memoryLimit,
      samples: problem.samples,
      file,
      capturedAt
    });

    if (config.saveSamplesNextToSolution()) {
      await fs.writeFile(
        `${file}.samples.json`,
        `${JSON.stringify(problem.samples, null, 2)}\n`,
        'utf8'
      );
    }
  }

  const meta: ContestMeta = {
    contestId: capture.contestId,
    name: capture.contestName,
    url: capture.url,
    capturedAt,
    problems
  };
  await mergeContest(folder, meta);

  const totalSamples = problems.reduce((sum, problem) => sum + problem.samples.length, 0);
  log(
    `captured contest ${capture.contestId}: ${problems.length} problem(s), ` +
      `${created.length} file(s) created, ${existing.length} kept, ${totalSamples} sample(s) -> ${folder}`
  );

  return {
    contestId: capture.contestId,
    contestFolder: folder,
    created,
    existing,
    totalSamples
  };
}

/** Open captured files according to `cfa.openOnCapture`, cursor placed on the marker. */
export async function revealCapture(result: CaptureResult): Promise<void> {
  const mode = config.openOnCapture();
  if (mode === 'none') {
    return;
  }

  const ordered = [...result.created, ...result.existing].sort((a, b) =>
    path.basename(a).localeCompare(path.basename(b))
  );
  const toOpen = mode === 'all' ? ordered : ordered.slice(0, 1);
  const template = await readTemplate();

  for (const file of toOpen) {
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    // Only a file we just created still has the template's cursor position.
    if (template.cursor && result.created.includes(file)) {
      place(editor, new vscode.Position(template.cursor.line, template.cursor.character));
    }
    // Whatever happened here counts as this session's placement for the file;
    // the open-file rule must not move the caret again a moment later.
    markPositioned(file);
  }
}
