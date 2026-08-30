# Codeforces Assistant

Codeforces contests in VS Code: one button for the whole problemset, samples run
in the editor, verdicts land there too. Fills the submit form — you press
*Submit*.

## Overview

Two screens, one workflow: the statement in the browser, VS Code beside it. The
tool removes the parts of a round that are not thinking — creating files,
copying samples, retyping a solution into a web form.

It is deliberately small. It does not recommend problems, theme the site, track
your rating, or draw on statements.

**Two parts, and they do different jobs.**

- A **VS Code extension**, which holds all of the logic: it creates the files,
  runs the samples, and polls the public Codeforces API for verdicts. It listens
  on `127.0.0.1` for the browser.
- A **browser extension**, which reads the Codeforces page and drives the submit
  form. It makes no decisions of its own.

They talk over loopback only. The browser extension is allow-listed by a prompt
the first time it connects, and no endpoint executes code.

**Scope.** Codeforces only — no CSES, no AtCoder, no gym. Gym submissions are
absent from the public API, so verdicts there could not be reported honestly.

**The Submit button is yours to press.** The extension fills the form and stops.
Codeforces defends that form on purpose — handlers that ignore a synthetic
click, anti-automation fields written by its own scripts, a response delivered
into a hidden frame. Going around all that would make this a tool for defeating
Codeforces rather than for writing code faster, and the part worth having —
never retyping a solution into a browser — needs none of it.

## Setup

Requires VS Code 1.90+, Node 18+, and a C++ compiler on your `PATH` for running
samples locally.

**1. Build and install the VS Code extension.**

```bash
git clone https://github.com/MrDelrus/codeforces-assistant
cd codeforces-assistant/vscode
npm install
npm run compile
```

Then either symlink it into your extensions folder:

```bash
ln -s "$PWD" ~/.vscode/extensions/codeforces-assistant
```

or package it and install the result:

```bash
npm run package                 # produces codeforces-assistant-<version>.vsix
code --install-extension codeforces-assistant-*.vsix
```

Reload the VS Code window afterwards.

**2. Load the browser extension.** Open `chrome://extensions` (or
`brave://extensions`, `edge://extensions`), turn on *Developer mode*, choose
*Load unpacked*, and pick the `browser/` folder.

**3. Open your contests folder in VS Code.** Contest folders are created inside
the first workspace folder, or inside `cfa.contestsDir` if you set one.

**4. Pair them.** The first capture asks VS Code for permission to accept
requests from the browser extension. Approve it once.

The two halves meet on port `29617`. It is configurable — through the gear in
the panel, or `cfa.port` — and the number in the browser extension popup has to
match.

**One window owns the port.** If you keep several VS Code windows open, set
`cfa.autoStartServer` to `false` in your user settings and to `true` in the
workspace settings of your contests folder, so only that window listens.

**Running the tests** (optional):

```bash
cd vscode && npm run compile && node ../tools/selftest.js
cd tools && npm install && npm test
```

## Usage

### Capture a contest

Open any page of a contest and press *Capture* in the extension popup. Every
problem becomes a file — `contests/2050/2050A.cpp` — created from your template,
with the samples stored beside them in `contests/2050/.cfa/contest.json`.

An existing solution is never overwritten. Re-capturing a contest you have
already started refreshes the samples and leaves your code exactly as it was.

| Page you are on | What is captured |
|---|---|
| `/contest/2050/problems` | every problem, straight off the page |
| `/contest/2050/problem/A` | that problem |
| `/problemset/problem/2050/A` | that problem |
| `/contest/2050`, `/standings`, any other contest page | every problem — the statements are not on these pages, so the extension reads `/contest/2050/problems` itself, in the page, with your session |

### Work through the problems

The panel opens with one button per problem: `A B C D …`. Clicking one opens
that solution file, so switching problems never means a trip to the explorer.

Their colour is what Codeforces says about your handle, re-asked every ten
seconds: **green** accepted, **red** submitted but not accepted, **grey** no
submission yet, **purple** the problem open in the editor. It reports the site,
not the disk — a file full of code you have not submitted is still grey.

### Run the samples

*Run All* compiles and runs every sample, showing the first line where your
output diverged, the time each test took, and the compiler's own message when a
build fails.

**+ Add test** takes a test of your own: input in the top box, expected output
in the bottom one. Added tests run after the contest's own, are labelled
`yours`, and carry a `×` that deletes them. They live in `contest.json`
separately from the official samples, so re-capturing never disturbs them.

### Submit

*Submit* opens the Codeforces submit page in a tab with your language, your
problem and your source already in it. **Press Submit there yourself.**

The panel then says *Form is filled, press Submit* and follows the public API
for a verdict: `Accepted`, or `Wrong answer on test 4`, with time and memory.
The `×` on that banner calls the whole thing off without touching the tab —
your solution is sitting in it.

*Close the submit tab when it lands*, in the browser popup, closes the tab once
the submission really appears on Codeforces.

### Settings

The gear in the panel's title bar. *Done* writes what you typed; *Cancel* and
the gear both throw it away.

- **Solution template** — *Choose template file…* takes a **copy** of the file
  you pick, into `.template.cpp` beside your contest folders, and new solutions
  are made from that copy. The copy is the point: the file you wrote the
  template in goes on being edited, and none of that reaches a solution created
  a week later. Choosing a second template is refused while the copy exists, so
  replacing it is deliberate — delete the copy first.
- **Cursor line and shift** — where the caret lands the first time a solution is
  opened in a session, so you start where you actually type instead of at line 1
  of a template you then have to scroll past. Lines count from `1`, the shift
  along the line from `0`. Returning to a file you have already visited leaves
  your caret and scroll position alone.
- **Capture port** — must match the port in the browser extension popup.

Everything else lives in VS Code's settings under `cfa.*`: the compile and run
commands, the local time limit, the language, the contests folder, your handle,
and how often verdicts are polled.

## License

MIT — see [LICENSE](LICENSE).

This project began as a study of [CPOS](https://github.com/Soham109/cpos) by
Soham Aggarwal, also MIT licensed. CPOS is a much larger tool, covering several
judges and shipping a terminal application, an in-page editor, a statement
viewer, rating prediction and more. None of that is here: this is a rewrite of
one idea from it — a browser extension that reads the page and an editor
extension that does the work — and not a fork of its tree. No CPOS file is
copied here.
