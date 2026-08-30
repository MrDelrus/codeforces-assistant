import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as config from './config';
import { log, logError } from './log';

/** Where the cursor should land in a freshly created file. */
export interface CursorAnchor {
  line: number;
  character: number;
}

export interface RenderedTemplate {
  text: string;
  cursor?: CursorAnchor;
}

const CURSOR_MARKER = '$0';

const BUILTIN_CPP = `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int tests = 1;
    // cin >> tests;
    while (tests--) {
        $0
    }
    return 0;
}
`;

const BUILTIN_PYTHON = `import sys

input = sys.stdin.readline


def solve() -> None:
    $0


def main() -> None:
    tests = 1
    # tests = int(input())
    for _ in range(tests):
        solve()


main()
`;

function builtinFor(languageKey: string): string {
  return languageKey === 'python' ? BUILTIN_PYTHON : BUILTIN_CPP;
}

/**
 * Split a template on its cursor marker. The marker is removed; the position it
 * occupied is returned so the caller can place the caret there. Without a
 * marker the caret is left wherever the editor puts it.
 */
export function render(raw: string): RenderedTemplate {
  const at = raw.indexOf(CURSOR_MARKER);
  if (at < 0) {
    return { text: raw };
  }
  const before = raw.slice(0, at);
  const text = before + raw.slice(at + CURSOR_MARKER.length);
  const lines = before.split('\n');
  return {
    text,
    cursor: { line: lines.length - 1, character: lines[lines.length - 1].length }
  };
}

/**
 * The template in force, and where it came from.
 *
 * A copy taken into the contests folder wins over everything else. It is the
 * one the user chose by hand, and it is deliberately frozen: edits to the file
 * it was copied from do not reach here until a new one is picked.
 */
export async function activeTemplateFile(): Promise<{ file: string; local: boolean } | undefined> {
  const local = config.localTemplateFile();
  if (local) {
    try {
      await fs.access(local);
      return { file: local, local: true };
    } catch {
      // No copy taken yet; fall through to the configured template.
    }
  }
  const file = config.templateFile();
  try {
    await fs.access(file);
    return { file, local: false };
  } catch {
    return undefined;
  }
}

export async function readTemplate(): Promise<RenderedTemplate> {
  const active = await activeTemplateFile();
  if (!active) {
    return render(builtinFor(config.languageKey()));
  }
  try {
    return render(await fs.readFile(active.file, 'utf8'));
  } catch (error) {
    logError(`reading template ${active.file}`, error);
    return render(builtinFor(config.languageKey()));
  }
}

export class TemplateExistsError extends Error {
  constructor(public readonly file: string) {
    super(`Could not save the template — ${path.basename(file)} already exists in ${path.dirname(file)}`);
  }
}

/**
 * Copy a chosen file in as the template. Refuses to overwrite: a template that
 * can be replaced silently is a template you cannot trust, and the copy is the
 * only record of what your solutions were made from.
 */
export async function adoptTemplate(source: string): Promise<string> {
  const target = config.localTemplateFile();
  if (!target) {
    throw new Error('No contests folder. Open a folder in VS Code, or set "cfa.contestsDir".');
  }
  try {
    await fs.access(target);
    throw new TemplateExistsError(target);
  } catch (error) {
    if (error instanceof TemplateExistsError) {
      throw error;
    }
    // ENOENT is the good case: nothing to overwrite.
  }
  const contents = await fs.readFile(source, 'utf8');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
  log(`template copied from ${source} to ${target}`);
  return target;
}

/**
 * Create the template file on first run so there is something concrete to edit.
 * If a CPOS template is sitting in the old location it is copied over, because
 * that is almost certainly the template the user actually wants — the copy is
 * logged rather than done silently.
 */
export async function seedTemplate(): Promise<void> {
  const target = config.templateFile();
  try {
    await fs.access(target);
    return;
  } catch {
    // Not there yet — carry on and create it.
  }

  const language = config.language();
  const configBase = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  const inherited = path.join(configBase, 'cpos', 'templates', `template.${language.extension}`);

  let contents = builtinFor(language.key);
  let origin = 'the built-in starter';
  try {
    contents = await fs.readFile(inherited, 'utf8');
    origin = inherited;
  } catch {
    // No CPOS template to inherit; the starter it is.
  }

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
    log(`seeded template ${target} from ${origin}`);
    if (!contents.includes(CURSOR_MARKER)) {
      log(`template has no ${CURSOR_MARKER} marker — add one to control where the cursor lands`);
    }
  } catch (error) {
    logError(`seeding template ${target}`, error);
  }
}
