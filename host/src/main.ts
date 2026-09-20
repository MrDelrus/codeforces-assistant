#!/usr/bin/env node
import * as os from 'node:os';
import * as path from 'node:path';

import * as config from '../../vscode/src/config';
import { LogSink, log, logError, setLogSink } from '../../vscode/src/log';
import { setBinDirectory } from '../../vscode/src/runner';
import { CaptureServer } from '../../vscode/src/server';

import { Rpc } from './rpc';
import { Session } from './session';
import { FileSettings, readState, settingsPath } from './settings';

/**
 * `cfa-host` — the capture server and the run/submit logic, with no editor
 * around them.
 *
 * The editor talks to this process over stdin/stdout (see [rpc.ts](rpc.ts));
 * the browser extension talks to it over the same loopback HTTP port it has
 * always used, so nothing in `browser/` changes. Running it by hand is a
 * reasonable way to debug: it answers JSON lines typed at a terminal.
 */

const USAGE = `cfa-host — Codeforces Assistant capture server

  --dir <path>       folder contests are created in (when cfa.contestsDir is unset)
  --port <number>    port the browser extension connects to (overrides cfa.port)
  --settings <path>  settings file to read (default: ${settingsPath()})
  --help             this text

The editor protocol is newline-delimited JSON on stdin and stdout.
`;

interface Args {
  dir?: string;
  port?: number;
  settings?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--dir':
        args.dir = value;
        i += 1;
        break;
      case '--settings':
        args.settings = value;
        i += 1;
        break;
      case '--port': {
        const parsed = Number(value);
        if (!Number.isInteger(parsed)) {
          throw new Error(`--port needs a number, got ${value ?? '(nothing)'}`);
        }
        args.port = parsed;
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

/**
 * Lines go to stderr — stdout is the editor channel and a stray line there
 * would be read as a malformed message — and into a ring buffer, so an editor
 * that attaches after something went wrong can still see what it was.
 */
const HISTORY = 500;

class HostLog implements LogSink {
  private readonly lines: string[] = [];

  line(text: string): void {
    this.lines.push(text);
    if (this.lines.length > HISTORY) {
      this.lines.shift();
    }
    process.stderr.write(`${text}\n`);
  }

  reveal(): void {
    // Nothing to reveal here; the editor asks for `log` when it wants the text.
  }

  recent(): string[] {
    return [...this.lines];
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const logs = new HostLog();
  setLogSink(logs);

  const settingsFile = args.settings ?? settingsPath();
  const settings = new FileSettings(args.dir);
  await settings.load(settingsFile);
  if (args.port !== undefined) {
    settings.set('port', args.port);
  }
  config.setSettingsSource(settings);

  // Contest folders stay source-only; binaries go under the cache directory,
  // which is the one place a user expects to be able to delete wholesale.
  const cache = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  setBinDirectory(path.join(cache, 'cfa', 'bin'));

  const state = await readState();
  const rpc = new Rpc(process.stdin, process.stdout);
  const session = new Session(rpc, state, settingsFile);
  const server = new CaptureServer(session);
  session.attach(server);

  rpc.on('status', () => session.status());
  rpc.on('problem', (params) => session.problem(params));
  rpc.on('test', (params) => session.test(params));
  rpc.on('submit', (params) => session.submit(params));
  rpc.on('cancel', () => session.cancelSubmit());
  rpc.on('trust', (params) => session.answerTrust(params));
  rpc.on('forget', () => session.forgetClients());
  rpc.on('log', () => ({ lines: logs.recent() }));

  let closing = false;
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    log('editor disconnected, shutting down');
    session.dispose();
    // Give the reply to whatever is still in flight a tick to drain.
    setTimeout(() => process.exit(0), 50).unref();
  };

  session.setEditorAttached(true);
  rpc.listen(shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.start();
  if (!server.isListening) {
    // Not fatal: the editor can still compile and run. Only submit needs the
    // browser, and `status` reports the conflict so the message says as much.
    log('capture server is not listening; submit will refuse until it is');
  }
  log(`host ready (settings: ${settingsFile})`);
  rpc.emit('ready', session.status());
}

main().catch((error) => {
  logError('cfa-host failed to start', error);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
