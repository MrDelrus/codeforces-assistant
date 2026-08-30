import * as path from 'node:path';

/**
 * Layout produced by a capture:
 *
 *   <contestsDir>/
 *     2050/
 *       .cfa/contest.json     samples + problem metadata
 *       2050A.cpp
 *       2050B.cpp
 *
 * `contestId` and `index` reach here only after `validate.ts` has proven they
 * are a number and a short upper-case index, so no component can escape the
 * base directory. `assertInside` is the belt to that suspenders.
 */

export const META_DIR = '.cfa';
export const META_FILE = 'contest.json';

export function contestDir(base: string, contestId: number): string {
  return assertInside(base, path.join(base, String(contestId)));
}

export function metaPath(base: string, contestId: number): string {
  return path.join(contestDir(base, contestId), META_DIR, META_FILE);
}

export function problemId(contestId: number, index: string): string {
  return `${contestId}${index}`;
}

export function solutionPath(
  base: string,
  contestId: number,
  index: string,
  extension: string
): string {
  const dir = contestDir(base, contestId);
  const name = `${problemId(contestId, index)}.${extension.replace(/[^A-Za-z0-9]/g, '')}`;
  return assertInside(dir, path.join(dir, name));
}

/** Throws unless `candidate` really is inside `base`. */
export function assertInside(base: string, candidate: string): string {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedBase, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to write outside ${resolvedBase}: ${resolved}`);
  }
  return resolved;
}

/**
 * Walk up from a solution file looking for the contest folder that owns it.
 * Returns the directory holding `.cfa/contest.json`, or undefined.
 */
export function findContestRoot(filePath: string): string | undefined {
  let dir = path.dirname(path.resolve(filePath));
  for (let depth = 0; depth < 12; depth += 1) {
    if (/^\d+$/.test(path.basename(dir))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

/** "2050A.cpp" -> { contestId: 2050, index: "A" } */
export function parseSolutionName(
  fileName: string
): { contestId: number; index: string } | undefined {
  const base = path.parse(fileName).name;
  const match = /^(\d{1,7})([A-Za-z][0-9]{0,2})$/.exec(base);
  if (!match) {
    return undefined;
  }
  return { contestId: Number.parseInt(match[1], 10), index: match[2].toUpperCase() };
}
