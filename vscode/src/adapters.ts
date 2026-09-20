import * as vscode from 'vscode';

import { SettingsSource, setSettingsSource } from './config';
import { LogSink, setLogSink } from './log';

/**
 * The two places where the core asks its host a question, answered for VS Code.
 *
 * `config.ts` and `log.ts` were the only modules in the shared core that
 * imported `vscode`, and they imported it for exactly this much: a settings
 * reader and somewhere to put a line. Both now take an implementation, so the
 * editor-shaped answers live here and `cfa-host` supplies its own.
 */

let channel: vscode.OutputChannel | undefined;

export function installVsCodeLog(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Codeforces Assistant');
  const target = channel;
  const sink: LogSink = {
    line(text) {
      target.appendLine(text);
    },
    reveal() {
      target.show(true);
    }
  };
  setLogSink(sink);
  return channel;
}

export function installVsCodeSettings(): void {
  const source: SettingsSource = {
    get<T>(key: string, fallback: T): T {
      return vscode.workspace.getConfiguration('cfa').get<T>(key, fallback);
    },
    workspaceRoot(): string | undefined {
      const folders = vscode.workspace.workspaceFolders;
      return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
    }
  };
  setSettingsSource(source);
}
