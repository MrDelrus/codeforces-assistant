import { promises as fs } from 'node:fs';

import * as config from './config';
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
      'No contests folder. Open a folder in the editor, or set "cfa.contestsDir" in settings.'
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
