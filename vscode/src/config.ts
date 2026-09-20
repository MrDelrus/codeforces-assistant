import * as os from 'node:os';
import * as path from 'node:path';

export interface LanguageConfig {
  key: string;
  extension: string;
  compile: string;
  run: string;
}

const SUPPORTED_LANGUAGES = ['cpp', 'python'] as const;
export type LanguageKey = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Where the `cfa.*` values come from.
 *
 * In VS Code that is `workspace.getConfiguration('cfa')` plus the open folder;
 * in `cfa-host` it is a JSON file and a `--dir` argument. The keys are the same
 * in both, deliberately — one settings reference, not two — so everything below
 * is written once and asks this interface rather than an editor.
 */
export interface SettingsSource {
  get<T>(key: string, fallback: T): T;
  /**
   * Folder contests are created inside when `cfa.contestsDir` is empty.
   * Undefined where the host has no such notion.
   */
  workspaceRoot(): string | undefined;
}

const DEFAULTS_ONLY: SettingsSource = {
  get<T>(_key: string, fallback: T): T {
    return fallback;
  },
  workspaceRoot(): undefined {
    return undefined;
  }
};

let source: SettingsSource = DEFAULTS_ONLY;

export function setSettingsSource(next: SettingsSource): void {
  source = next;
}

function cfg(): SettingsSource {
  return source;
}

export function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function port(): number {
  const raw = cfg().get<number>('port', 29617);
  return Number.isInteger(raw) && raw >= 1024 && raw <= 65535 ? raw : 29617;
}

export function autoStartServer(): boolean {
  return cfg().get<boolean>('autoStartServer', true);
}

export function openOnCapture(): 'first' | 'all' | 'none' {
  const raw = cfg().get<string>('openOnCapture', 'first');
  return raw === 'all' || raw === 'none' ? raw : 'first';
}

export function saveSamplesNextToSolution(): boolean {
  return cfg().get<boolean>('saveSamplesNextToSolution', false);
}

export function handle(): string {
  return cfg().get<string>('handle', '').trim();
}

export function runTimeoutMs(): number {
  return Math.max(200, cfg().get<number>('runTimeoutMs', 5000));
}

export function compileTimeoutMs(): number {
  return Math.max(1000, cfg().get<number>('compileTimeoutMs', 30000));
}

/**
 * The Codeforces API permits one call every two seconds. Clamp rather than
 * trust the setting, so a careless value cannot get the handle rate limited.
 */
export function verdictPollIntervalMs(): number {
  return Math.max(2000, cfg().get<number>('verdict.pollIntervalMs', 5000));
}

export function verdictTimeoutMs(): number {
  return Math.max(10000, cfg().get<number>('verdict.timeoutMs', 600000));
}

/** How often the tab strip re-asks Codeforces which problems are solved. */
export function progressPollIntervalMs(): number {
  return Math.max(2000, cfg().get<number>('progress.pollIntervalMs', 10000));
}

export function progressEnabled(): boolean {
  return cfg().get<boolean>('progress.enabled', true);
}

export type CursorMode = 'position' | 'template' | 'anchor' | 'start' | 'end' | 'none';

export function cursorOnOpen(): CursorMode {
  const raw = cfg().get<string>('cursorOnOpen', 'position');
  const modes: readonly string[] = ['position', 'template', 'anchor', 'start', 'end', 'none'];
  return modes.includes(raw) ? (raw as CursorMode) : 'position';
}

/**
 * Counted the way an editor's own gutter counts: the first line is 1.
 * The shift along that line is 0-based, because a shift of 0 is before the
 * first character and that is a position you actually want.
 */
export function cursorLine(): number {
  return Math.max(1, Math.floor(cfg().get<number>('cursorLine', 1)));
}

export function cursorCharacter(): number {
  return Math.max(0, Math.floor(cfg().get<number>('cursorCharacter', 0)));
}

/**
 * Regular expression the caret is parked after, when cursorOnOpen is 'anchor'
 * — and the fallback for 'template', which is what makes it the one that
 * actually runs: the user's template carries no `$0` marker.
 *
 * The default matches the opening of `void solve()` plus one newline past the
 * brace, which puts the caret on the second of the three blank lines in the
 * body — the middle of the room you have to write in.
 */
const DEFAULT_CURSOR_ANCHOR = 'void solve\\(\\)[^\\n]*\\{\\n\\n';

export function cursorAnchor(): string {
  const raw = cfg().get<string>('cursorAnchor', DEFAULT_CURSOR_ANCHOR);
  // An explicitly emptied setting means "no anchor", not "use the default".
  return typeof raw === 'string' ? raw.trim() : DEFAULT_CURSOR_ANCHOR;
}

export function cursorReveal(): 'center' | 'top' | 'default' {
  const raw = cfg().get<string>('cursorReveal', 'center');
  return raw === 'top' || raw === 'default' ? raw : 'center';
}

export function languageKey(): LanguageKey {
  const raw = cfg().get<string>('language', 'cpp');
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(raw)
    ? (raw as LanguageKey)
    : 'cpp';
}

export function language(key: LanguageKey = languageKey()): LanguageConfig {
  const fallback: Record<LanguageKey, LanguageConfig> = {
    cpp: {
      key: 'cpp',
      extension: 'cpp',
      compile: 'g++ -std=gnu++20 -O2 -pipe -Wall -Wextra -o "{exe}" "{src}"',
      run: '"{exe}"'
    },
    python: {
      key: 'python',
      extension: 'py',
      compile: '',
      run: 'python3 "{src}"'
    }
  };
  const defaults = fallback[key];
  return {
    key,
    extension: cfg().get<string>(`${key}.extension`, defaults.extension) || defaults.extension,
    compile: cfg().get<string>(`${key}.compile`, defaults.compile),
    run: cfg().get<string>(`${key}.run`, defaults.run) || defaults.run
  };
}

/** Root that contest folders are created inside. */
export function contestsDir(): string | undefined {
  const configured = cfg().get<string>('contestsDir', '').trim();
  if (configured) {
    return path.resolve(expandHome(configured));
  }
  return source.workspaceRoot();
}

/**
 * The template copied into the contests folder from a file the user picked.
 *
 * A copy, not a reference, and that is the point: the file you wrote the
 * template in goes on being edited, and a solution created a week later still
 * comes out of the template you chose. Replacing it is deliberate — pick a new
 * file, which refuses until the old copy is deleted.
 */
export function localTemplateFile(): string | undefined {
  const base = contestsDir();
  return base ? path.join(base, `.template.${language().extension}`) : undefined;
}

/** Where the user's solution template lives, when no local copy was taken. */
export function templateFile(): string {
  const configured = cfg().get<string>('templateFile', '').trim();
  if (configured) {
    return path.resolve(expandHome(configured));
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'cfa', `template.${language().extension}`);
}
