import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

import { ProblemMeta, ProblemTab, RunState, VerdictState } from './types';

export interface PanelActions {
  run(): void;
  submit(): void;
  setHandle(): void;
  revealFile(file: string): void;
  openIndex(index: string): void;
  addTest(input: string, expected: string): void;
  removeTest(number: number): void;
  cancelSubmit(): void;
  browseTemplate(): void;
  applySettings(line: number, character: number, port: number): void;
}

/** The fields the gear opens. Mirrors the settings, read back for display. */
export interface SettingsState {
  /** Absolute path of the template in force, or undefined for the built-in. */
  template?: string;
  /** True when that template is the copy taken into the contests folder. */
  templateLocal: boolean;
  cursorLine: number;
  cursorCharacter: number;
  port: number;
  /** Set after a failed browse, shown next to the template row. */
  templateError?: string;
}

export interface PanelState {
  problem?: ProblemMeta;
  /** Every problem of the contest in view, for the tab strip. */
  tabs?: ProblemTab[];
  contest?: { id: number; name: string };
  file?: string;
  run: RunState;
  verdict: VerdictState;
  server: { listening: boolean; port?: number; conflict: boolean };
  handle?: string;
  /** How many of the tests are the contest's own; the rest were added by hand. */
  officialCount?: number;
  settings: SettingsState;
  /** Set when the active editor is not a captured solution. */
  hint?: string;
}

/** Everything the webview is allowed to say. Untrusted: it is a web page. */
interface PanelMessage {
  type?: string;
  file?: string;
  index?: string;
  input?: string;
  expected?: string;
  number?: number;
  line?: number;
  character?: number;
  port?: number;
}

export class TestsPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'cfa.tests';

  private view: vscode.WebviewView | undefined;
  private state: PanelState;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: PanelActions,
    private readonly version: string
  ) {
    this.state = {
      run: { phase: 'idle', results: [] },
      verdict: { phase: 'idle', updatedAt: 0 },
      server: { listening: false, conflict: false },
      settings: { templateLocal: false, cursorLine: 0, cursorCharacter: 0, port: 0 }
    };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // Shown dimmed beside the view title, which is where a version belongs:
    // one glance tells you whether the window is running what you just built.
    view.description = this.version;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: PanelMessage) => {
      switch (message?.type) {
        case 'ready':
          this.post();
          break;
        case 'run':
          this.actions.run();
          break;
        case 'submit':
          this.actions.submit();
          break;
        case 'handle':
          this.actions.setHandle();
          break;
        case 'cancelSubmit':
          this.actions.cancelSubmit();
          break;
        case 'browseTemplate':
          this.actions.browseTemplate();
          break;
        case 'applySettings':
          this.actions.applySettings(
            Number(message.line ?? 0),
            Number(message.character ?? 0),
            Number(message.port ?? 0)
          );
          break;
        case 'addTest':
          this.actions.addTest(String(message.input ?? ''), String(message.expected ?? ''));
          break;
        case 'removeTest':
          if (typeof message.number === 'number') {
            this.actions.removeTest(message.number);
          }
          break;
        case 'openIndex':
          if (typeof message.index === 'string') {
            this.actions.openIndex(message.index);
          }
          break;
        case 'reveal':
          if (message.file) {
            this.actions.revealFile(message.file);
          }
          break;
        default:
          break;
      }
    });
    this.post();
  }

  /** The gear in the title bar: shows the settings screen, or hides it again. */
  toggleSettings(): void {
    this.view?.show?.(true);
    this.view?.webview.postMessage({ type: 'toggleSettings' });
  }

  update(patch: Partial<PanelState>): void {
    this.state = { ...this.state, ...patch };
    this.post();
  }

  get current(): PanelState {
    return this.state;
  }

  private post(): void {
    this.view?.webview.postMessage({ type: 'state', state: this.state });
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (name: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${asset('panel.css')}" />
<title>Tests</title>
</head>
<body>
<div id="root">
  <div class="empty" id="boot">Loading…</div>
</div>
<script nonce="${nonce}" src="${asset('panel.js')}"></script>
</body>
</html>`;
  }
}
