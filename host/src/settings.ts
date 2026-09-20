import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SettingsSource, expandHome } from '../../vscode/src/config';

/**
 * Settings for a host with no editor behind it.
 *
 * The keys are exactly the ones VS Code shows in its settings UI — `cfa.port`,
 * `cfa.templateFile`, `cfa.cpp.compile` and the rest — because there is one
 * settings reference for this tool and splitting it in two would make both
 * halves wrong within a month. The file is flat, so a key is written the way it
 * is documented:
 *
 *   { "cfa.port": 29617, "cfa.contestsDir": "~/workspace/codeforces" }
 *
 * A nested `{ "cfa": { "port": ... } }` is accepted too, since that is what
 * anyone who has edited VS Code's own settings.json will reach for first.
 */

export function configHome(): string {
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
}

export function settingsPath(): string {
  return path.join(configHome(), 'cfa', 'settings.json');
}

export function statePath(): string {
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'cfa', 'host.json');
}

type Bag = Record<string, unknown>;

/** Flatten `{ cfa: { port: 1 } }` into `{ "cfa.port": 1 }`, leaving flat keys alone. */
function flatten(raw: Bag, prefix = '', into: Bag = {}): Bag {
  for (const [key, value] of Object.entries(raw)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as Bag, full, into);
    } else {
      into[full] = value;
    }
  }
  return into;
}

export class FileSettings implements SettingsSource {
  private values: Bag = {};

  constructor(private readonly root: string | undefined) {}

  /**
   * Read the settings file. A missing file is normal — every key has a default
   * — but a malformed one is not, and is reported rather than ignored: silently
   * falling back to defaults would look exactly like the settings not applying.
   */
  async load(file = settingsPath()): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.values = {};
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file} must contain a JSON object`);
    }
    this.values = flatten(parsed as Bag);
  }

  /**
   * Override one key from the command line. Arguments beat the file, so a
   * second host can be started on another port without editing settings that
   * the first one is also reading.
   */
  set(key: string, value: unknown): void {
    this.values[`cfa.${key}`] = value;
  }

  get<T>(key: string, fallback: T): T {
    const value = this.values[`cfa.${key}`];
    if (value === undefined) {
      return fallback;
    }
    // A key of the wrong type is a typo in a hand-edited file, and the default
    // is a better answer than a crash three calls later.
    if (typeof fallback === 'number' && typeof value !== 'number') {
      return fallback;
    }
    if (typeof fallback === 'boolean' && typeof value !== 'boolean') {
      return fallback;
    }
    if (typeof fallback === 'string' && typeof value !== 'string') {
      return fallback;
    }
    return value as T;
  }

  workspaceRoot(): string | undefined {
    return this.root ? path.resolve(expandHome(this.root)) : undefined;
  }
}

export interface HostState {
  trustedOrigins: string[];
  /** Handle the browser reported, when `cfa.handle` is not set by hand. */
  handle?: string;
}

const EMPTY_STATE: HostState = { trustedOrigins: [] };

export async function readState(file = statePath()): Promise<HostState> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<HostState>;
    return {
      trustedOrigins: Array.isArray(parsed.trustedOrigins)
        ? parsed.trustedOrigins.filter((entry): entry is string => typeof entry === 'string')
        : [],
      handle: typeof parsed.handle === 'string' ? parsed.handle : undefined
    };
  } catch {
    // Unreadable state is state we can rebuild: the user pairs again and the
    // handle is learned from the next capture.
    return { ...EMPTY_STATE };
  }
}

export async function writeState(state: HostState, file = statePath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
