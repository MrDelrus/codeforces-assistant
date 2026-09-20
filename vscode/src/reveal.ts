import * as path from 'node:path';
import * as vscode from 'vscode';

import { CaptureResult } from './capture';
import * as config from './config';
import { markPositioned, place } from './cursor';
import { readTemplate } from './template';

/**
 * What a capture looks like once it has happened, which is the one part of
 * capturing that only an editor can do.
 *
 * It used to live in `capture.ts`, and was the sole reason that file imported
 * `vscode`. Splitting it out is what lets the same capture code run inside
 * `cfa-host`, where "open the file" is a message to whichever editor asked
 * rather than a call into this API.
 */

/** Open captured files according to `cfa.openOnCapture`, cursor placed on the marker. */
export async function revealCapture(result: CaptureResult): Promise<void> {
  const mode = config.openOnCapture();
  if (mode === 'none') {
    return;
  }

  const ordered = [...result.created, ...result.existing].sort((a, b) =>
    path.basename(a).localeCompare(path.basename(b))
  );
  const toOpen = mode === 'all' ? ordered : ordered.slice(0, 1);
  const template = await readTemplate();

  for (const file of toOpen) {
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    // Only a file we just created still has the template's cursor position.
    if (template.cursor && result.created.includes(file)) {
      place(editor, new vscode.Position(template.cursor.line, template.cursor.character));
    }
    // Whatever happened here counts as this session's placement for the file;
    // the open-file rule must not move the caret again a moment later.
    markPositioned(file);
  }
}
