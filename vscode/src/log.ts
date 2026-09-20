/**
 * Logging is a hole punched through the core, not a dependency of it.
 *
 * The same modules run in two places now — inside VS Code, where a line belongs
 * in an output channel, and inside `cfa-host`, where it belongs on stderr and
 * in a ring buffer the editor can ask for. Neither is knowable from
 * `server.ts`, so whoever owns the process installs a sink and the core goes on
 * calling `log()`.
 */

export interface LogSink {
  line(text: string): void;
  /** Put the log in front of the user, where the host has somewhere to show it. */
  reveal(): void;
}

const DISCARD: LogSink = {
  line(): void {
    // A host that installs no sink has said it does not want the lines.
  },
  reveal(): void {
    // Nothing to reveal.
  }
};

let sink: LogSink = DISCARD;

export function setLogSink(next: LogSink): void {
  sink = next;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function log(message: string): void {
  sink.line(`[${stamp()}] ${message}`);
}

export function logError(context: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  sink.line(`[${stamp()}] ${context}: ${detail}`);
}

export function showLog(): void {
  sink.reveal();
}
