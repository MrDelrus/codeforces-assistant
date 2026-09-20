import { Readable, Writable } from 'node:stream';

/**
 * The editor channel: newline-delimited JSON over this process's own stdin and
 * stdout.
 *
 * It is deliberately *not* the HTTP server. That socket is reachable by
 * anything on the machine, and [SECURITY.md](../../SECURITY.md) promises that
 * no endpoint on it runs code — a promise that would be worth nothing if
 * "compile and run this file" were added next to `/capture`. The editor already
 * has the strongest credential there is, having started this process, so it
 * gets its own private pipe and the socket keeps its narrow job.
 *
 * Editor to host:   {"id":1,"method":"test","params":{"file":"/…/2050A.cpp"}}
 * Host to editor:   {"id":1,"ok":true,"result":{…}}
 *                   {"id":1,"ok":false,"error":"…"}
 * Host to editor:   {"event":"run","file":"…","state":{…}}      (unsolicited)
 */

export interface Request {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

export type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export class Rpc {
  private readonly handlers = new Map<string, Handler>();
  private buffer = '';

  constructor(
    private readonly input: Readable,
    private readonly output: Writable
  ) {}

  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  listen(onClose: () => void): void {
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk: string) => this.feed(chunk));
    this.input.on('end', onClose);
    this.input.on('close', onClose);
  }

  /** An unsolicited message: progress, a verdict, a pairing question. */
  emit(event: string, payload: Record<string, unknown>): void {
    this.write({ event, ...payload });
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    // A partial line is normal — a pipe splits wherever it likes.
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        void this.dispatch(line);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private async dispatch(line: string): Promise<void> {
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      this.write({ event: 'error', error: 'request was not valid JSON' });
      return;
    }

    const handler = this.handlers.get(request.method);
    if (!handler) {
      this.reply(request.id, false, undefined, `unknown method: ${request.method}`);
      return;
    }

    try {
      const result = await handler(request.params ?? {});
      this.reply(request.id, true, result);
    } catch (error) {
      this.reply(
        request.id,
        false,
        undefined,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private reply(id: number | undefined, ok: boolean, result?: unknown, error?: string): void {
    if (id === undefined) {
      // A notification. Nothing to answer, but a failure still deserves a line.
      if (!ok) {
        this.write({ event: 'error', error });
      }
      return;
    }
    this.write(ok ? { id, ok, result } : { id, ok, error });
  }

  private write(payload: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify(payload)}\n`);
  }
}
