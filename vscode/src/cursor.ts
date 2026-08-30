import * as vscode from 'vscode';

import * as config from './config';
import { log, logError } from './log';
import { readTemplate } from './template';

/**
 * Where the caret lands when a solution file is opened.
 *
 * Scrolling to the place you actually type is the first thing you do with every
 * problem file, so the extension does it. Modes, from `cfa.cursorOnOpen`:
 *
 *   position  the line and shift along it, from `cfa.cursorLine` and
 *             `cfa.cursorCharacter`. The line is 1-based, as a gutter counts;
 *             the shift is 0-based. `1` and `0` mean the start of the file.
 *   template  the position the template's `$0` marker held. A fresh file still
 *             has it exactly; an edited one has it approximately, because the
 *             code you write goes at or after the marker, not before it.
 *   anchor    the end of the first match of `cfa.cursorAnchor`, a regular
 *             expression, searched in the file itself. Survives any edit.
 *   start/end first or last line.
 *   none      leave the caret wherever VS Code put it.
 */

/** Positioning is done once per file per session — a tab switch must not yank the caret back. */
const positioned = new Set<string>();

export function forget(file?: string): void {
  if (file) {
    positioned.delete(file);
  } else {
    positioned.clear();
  }
}

/** Mark a file as already positioned, e.g. by the capture that created it. */
export function markPositioned(file: string): void {
  positioned.add(file);
}

function anchorPosition(document: vscode.TextDocument): vscode.Position | undefined {
  const source = config.cursorAnchor();
  if (!source) {
    return undefined;
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, 'm');
  } catch (error) {
    logError(`cfa.cursorAnchor is not a valid regular expression: ${source}`, error);
    return undefined;
  }
  const match = pattern.exec(document.getText());
  if (!match) {
    return undefined;
  }
  return document.positionAt(match.index + match[0].length);
}

async function templatePosition(document: vscode.TextDocument): Promise<vscode.Position | undefined> {
  const template = await readTemplate();
  if (!template.cursor) {
    return undefined;
  }
  const line = Math.min(template.cursor.line, Math.max(0, document.lineCount - 1));
  const length = document.lineAt(line).text.length;
  return new vscode.Position(line, Math.min(template.cursor.character, length));
}

export async function resolvePosition(
  document: vscode.TextDocument
): Promise<vscode.Position | undefined> {
  switch (config.cursorOnOpen()) {
    case 'none':
      return undefined;
    case 'position': {
      // vscode.Position counts lines from 0; the setting counts from 1.
      const line = Math.min(config.cursorLine() - 1, Math.max(0, document.lineCount - 1));
      return new vscode.Position(
        line,
        Math.min(config.cursorCharacter(), document.lineAt(line).text.length)
      );
    }
    case 'start':
      return new vscode.Position(0, 0);
    case 'end': {
      const last = Math.max(0, document.lineCount - 1);
      return new vscode.Position(last, document.lineAt(last).text.length);
    }
    case 'anchor':
      return anchorPosition(document);
    default:
      // Fall back to the anchor when the template carries no marker, so setting
      // only `cfa.cursorAnchor` is enough to get the behaviour.
      return (await templatePosition(document)) ?? anchorPosition(document);
  }
}

export function place(editor: vscode.TextEditor, position: vscode.Position): void {
  editor.selection = new vscode.Selection(position, position);
  const reveal = config.cursorReveal();
  editor.revealRange(
    new vscode.Range(position, position),
    reveal === 'top'
      ? vscode.TextEditorRevealType.AtTop
      : reveal === 'default'
        ? vscode.TextEditorRevealType.Default
        : vscode.TextEditorRevealType.InCenter
  );
}

/**
 * Position the caret in a freshly shown solution file. Returns false when
 * nothing was done — already positioned, disabled, or no position resolved.
 */
export async function positionOnOpen(editor: vscode.TextEditor, force = false): Promise<boolean> {
  const file = editor.document.uri.fsPath;
  if (!force && positioned.has(file)) {
    return false;
  }
  positioned.add(file);
  const position = await resolvePosition(editor.document);
  if (!position) {
    return false;
  }
  place(editor, position);
  log(`caret placed at ${position.line + 1}:${position.character + 1} in ${file}`);
  return true;
}
