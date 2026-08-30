import * as http from 'node:http';

import * as config from './config';
import { log, logError } from './log';
import { CaptureResult } from './capture';
import { PendingSubmit } from './types';
import { LIMITS, ValidationError, asHandle, validateCapture } from './validate';

/**
 * A loopback-only HTTP server, bound to 127.0.0.1, that the browser extension
 * talks to.
 *
 * Two design decisions are worth stating plainly, because they are what keeps a
 * local port from becoming a liability:
 *
 * 1. There is no endpoint that runs code. Compiling and running happens only
 *    when you ask for it inside VS Code. Nothing reachable over this socket can
 *    cause a process to be spawned.
 *
 * 2. Browser origins are allow-listed, and only extension origins can ever be
 *    on the list. A page on the open web cannot forge its `Origin` header, so
 *    `https://example.com` is refused before its body is read — no matter what
 *    it claims to be. A pairing prompt in VS Code is the only way an extension
 *    id gets added.
 *
 * A request with no `Origin` at all is allowed: that is curl on your own
 * machine, which already has your files. Browsers always attach `Origin` to the
 * cross-origin requests this rule exists to stop.
 */

const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\/[a-z0-9-]+$/i;

export interface ServerHost {
  applyCapture(body: unknown): Promise<CaptureResult>;
  peekPendingSubmit(): PendingSubmit | undefined;
  markSubmitClaimed(id: string): void;
  onSubmitAck(payload: { id: string; ok: boolean; reason?: string }): void;
  onHandleSeen(handle: string): void;
  isTrustedOrigin(origin: string): boolean;
  requestTrust(origin: string): Promise<boolean>;
}

export class CaptureServer {
  private server: http.Server | undefined;
  private listeningPort: number | undefined;
  private conflicted = false;
  /** Origins we have already asked about, so a refusal is not asked twice. */
  private readonly pendingPrompts = new Set<string>();

  constructor(private readonly host: ServerHost) {}

  get isListening(): boolean {
    return this.server !== undefined;
  }

  get hasPortConflict(): boolean {
    return this.conflicted;
  }

  get port(): number | undefined {
    return this.listeningPort;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const wanted = config.port();
    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    server.on('clientError', (_error, socket) => {
      socket.destroy();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(wanted, '127.0.0.1', () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        this.conflicted = true;
        log(
          `port ${wanted} is already taken — another VS Code window owns capture. ` +
            'Run "Codeforces: Stop Capture Server" there, or change "cfa.port".'
        );
        return;
      }
      throw error;
    }

    this.server = server;
    this.listeningPort = wanted;
    this.conflicted = false;
    log(`listening on http://127.0.0.1:${wanted}`);
  }

  stop(): void {
    if (!this.server) {
      return;
    }
    this.server.close();
    this.server = undefined;
    this.listeningPort = undefined;
    this.conflicted = false;
    log('capture server stopped');
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const origin = request.headers.origin;
    const decision = await this.checkOrigin(typeof origin === 'string' ? origin : undefined);

    if (!decision.allowed) {
      this.send(response, 403, { ok: false, error: 'origin not allowed' }, decision.echoOrigin);
      return;
    }

    if (request.method === 'OPTIONS') {
      this.preflight(request, response, decision.echoOrigin);
      return;
    }

    const url = (request.url ?? '/').split('?')[0];

    try {
      if (request.method === 'GET' && url === '/health') {
        this.send(
          response,
          200,
          { ok: true, app: 'codeforces-assistant', port: this.listeningPort },
          decision.echoOrigin
        );
        return;
      }

      if (request.method === 'GET' && url === '/pending-submit') {
        // Always 200. "Nothing queued" is an answer, not a failure — a 404 here
        // is indistinguishable from "server is down" on the client side.
        const pending = this.host.peekPendingSubmit();
        if (pending) {
          this.host.markSubmitClaimed(pending.id);
        }
        this.send(response, 200, { ok: true, pending: pending ?? null }, decision.echoOrigin);
        return;
      }

      if (request.method === 'POST' && url === '/capture') {
        const body = await this.readJson(request);
        const capture = validateCapture(body);
        if (capture.handle) {
          this.host.onHandleSeen(capture.handle);
        }
        const result = await this.host.applyCapture(capture);
        this.send(
          response,
          200,
          {
            ok: true,
            contestId: result.contestId,
            folder: result.contestFolder,
            created: result.created.length,
            existing: result.existing.length,
            problems: result.created.length + result.existing.length,
            samples: result.totalSamples
          },
          decision.echoOrigin
        );
        return;
      }

      if (request.method === 'POST' && url === '/submit-ack') {
        const body = (await this.readJson(request)) as Record<string, unknown>;
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) {
          this.send(response, 400, { ok: false, error: 'missing id' }, decision.echoOrigin);
          return;
        }
        const handle = asHandle(body.handle);
        if (handle) {
          this.host.onHandleSeen(handle);
        }
        this.host.onSubmitAck({
          id,
          ok: body.ok === true,
          reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined
        });
        this.send(response, 200, { ok: true }, decision.echoOrigin);
        return;
      }

      if (request.method === 'POST' && url === '/handle') {
        const body = (await this.readJson(request)) as Record<string, unknown>;
        const handle = asHandle(body.handle);
        if (!handle) {
          this.send(response, 400, { ok: false, error: 'bad handle' }, decision.echoOrigin);
          return;
        }
        this.host.onHandleSeen(handle);
        this.send(response, 200, { ok: true }, decision.echoOrigin);
        return;
      }

      this.send(response, 404, { ok: false, error: 'unknown endpoint' }, decision.echoOrigin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof ValidationError)) {
        logError(`handling ${request.method} ${url}`, error);
      } else {
        log(`rejected ${request.method} ${url}: ${message}`);
      }
      this.send(response, 400, { ok: false, error: message }, decision.echoOrigin);
    }
  }

  private async checkOrigin(
    origin: string | undefined
  ): Promise<{ allowed: boolean; echoOrigin?: string }> {
    if (!origin || origin === 'null') {
      return { allowed: true };
    }
    if (!EXTENSION_ORIGIN.test(origin)) {
      log(`refused request from ${origin} — only browser extensions may connect`);
      return { allowed: false };
    }
    if (this.host.isTrustedOrigin(origin)) {
      return { allowed: true, echoOrigin: origin };
    }
    if (!this.pendingPrompts.has(origin)) {
      this.pendingPrompts.add(origin);
      const granted = await this.host.requestTrust(origin);
      if (granted) {
        return { allowed: true, echoOrigin: origin };
      }
    }
    return { allowed: false };
  }

  private preflight(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    echoOrigin: string | undefined
  ): void {
    const headers: Record<string, string> = {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin'
    };
    if (echoOrigin) {
      headers['access-control-allow-origin'] = echoOrigin;
      // Only ever granted to an approved extension origin, never to a web page.
      if (request.headers['access-control-request-private-network'] === 'true') {
        headers['access-control-allow-private-network'] = 'true';
      }
    }
    response.writeHead(204, headers);
    response.end();
  }

  private send(
    response: http.ServerResponse,
    status: number,
    body: unknown,
    echoOrigin?: string
  ): void {
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      vary: 'Origin'
    };
    if (echoOrigin) {
      headers['access-control-allow-origin'] = echoOrigin;
    }
    response.writeHead(status, headers);
    response.end(payload);
  }

  private readJson(request: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const type = String(request.headers['content-type'] ?? '');
      if (!type.includes('application/json')) {
        reject(new ValidationError('expected application/json'));
        request.resume();
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > LIMITS.bodyBytes) {
          reject(new ValidationError('request body too large'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('error', reject);
      request.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new ValidationError('body is not valid JSON'));
        }
      });
    });
  }
}
