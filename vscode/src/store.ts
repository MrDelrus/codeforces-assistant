import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { log, logError } from './log';
import { META_DIR, META_FILE, findContestRoot, parseSolutionName } from './paths';
import { ContestMeta, ProblemMeta, Sample, TestResult } from './types';

/**
 * Contest metadata lives with the contest, not in a global database:
 *
 *   contests/2050/.cfa/contest.json
 *
 * One readable file per contest. It survives a VS Code reinstall, moves with
 * the folder, and can be inspected by hand when a capture looks wrong — which
 * matters a great deal more than saving a few bytes.
 */

export async function readContest(contestFolder: string): Promise<ContestMeta | undefined> {
  const file = path.join(contestFolder, META_DIR, META_FILE);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as ContestMeta;
    if (!parsed || typeof parsed.contestId !== 'number' || !Array.isArray(parsed.problems)) {
      return undefined;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(`reading ${file}`, error);
    }
    return undefined;
  }
}

export async function writeContest(contestFolder: string, meta: ContestMeta): Promise<void> {
  const dir = path.join(contestFolder, META_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

/**
 * Merge a fresh capture into whatever is already recorded for the contest.
 * Re-capturing a contest must not lose problems that were captured earlier and
 * are missing this time (a page that failed to parse, say).
 */
export async function mergeContest(
  contestFolder: string,
  incoming: ContestMeta
): Promise<ContestMeta> {
  const existing = await readContest(contestFolder);
  if (!existing) {
    await writeContest(contestFolder, incoming);
    return incoming;
  }
  const byIndex = new Map<string, ProblemMeta>();
  for (const problem of existing.problems) {
    byIndex.set(problem.index, problem);
  }
  for (const problem of incoming.problems) {
    // A capture only ever knows about the official samples. Tests the user
    // typed in are ours to keep — losing them to a re-capture would be the
    // worst kind of quiet data loss.
    const previous = byIndex.get(problem.index);
    byIndex.set(
      problem.index,
      previous?.extraSamples?.length
        ? { ...problem, extraSamples: previous.extraSamples }
        : problem
    );
  }
  const merged: ContestMeta = {
    ...existing,
    name: incoming.name || existing.name,
    url: incoming.url || existing.url,
    capturedAt: incoming.capturedAt,
    problems: [...byIndex.values()].sort((a, b) => a.index.localeCompare(b.index))
  };
  await writeContest(contestFolder, merged);
  return merged;
}

/**
 * Every test a run covers, official samples first.
 *
 * The order is load-bearing: `TestResult.number` is the position in this list,
 * and `pendingResults` marks everything past the official count as the user's
 * own — so a run's numbering matches what the panel and the editor label.
 */
export function allSamples(problem: ProblemMeta): Sample[] {
  return [...problem.samples, ...(problem.extraSamples ?? [])];
}

/** The same list as results that have not run yet. */
export function pendingResults(problem: ProblemMeta): TestResult[] {
  const official = problem.samples.length;
  return allSamples(problem).map((sample, i) => ({
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

export interface ProblemLookup {
  contestFolder: string;
  contest: ContestMeta;
  problem: ProblemMeta;
}

/**
 * Resolve the problem a source file belongs to. The file name is authoritative
 * ("2050A.cpp" -> contest 2050, problem A); metadata is then read from the
 * contest folder above it. Renaming a file therefore detaches it, which is the
 * behaviour that is easiest to reason about.
 */
export async function lookupByFile(filePath: string): Promise<ProblemLookup | undefined> {
  const named = parseSolutionName(filePath);
  if (!named) {
    return undefined;
  }
  const folder = findContestRoot(filePath) ?? path.dirname(path.resolve(filePath));
  const contest = await readContest(folder);
  if (!contest) {
    return undefined;
  }
  const problem = contest.problems.find((entry) => entry.index === named.index);
  if (!problem || contest.contestId !== named.contestId) {
    return undefined;
  }
  // The recorded path can be stale if the folder was moved; trust the file we
  // were actually given.
  return {
    contestFolder: folder,
    contest,
    problem: { ...problem, file: path.resolve(filePath) }
  };
}

/** Replace one problem's samples, e.g. after the user edits them in the panel. */
export async function updateProblem(
  contestFolder: string,
  index: string,
  mutate: (problem: ProblemMeta) => ProblemMeta
): Promise<ContestMeta | undefined> {
  const contest = await readContest(contestFolder);
  if (!contest) {
    return undefined;
  }
  const position = contest.problems.findIndex((entry) => entry.index === index);
  if (position < 0) {
    return undefined;
  }
  contest.problems[position] = mutate(contest.problems[position]);
  await writeContest(contestFolder, contest);
  log(`updated ${contest.contestId}${index} in ${contestFolder}`);
  return contest;
}
