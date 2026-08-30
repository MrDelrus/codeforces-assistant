import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Codeforces Assistant');
  return channel;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function log(message: string): void {
  initLog().appendLine(`[${stamp()}] ${message}`);
}

export function logError(context: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  initLog().appendLine(`[${stamp()}] ${context}: ${detail}`);
}

export function showLog(): void {
  initLog().show(true);
}
