# Codeforces Assistant

Codeforces contests in VS Code: one button for the whole problemset, samples run
in the editor, verdicts land there too. Fills the submit form — you press
*Submit*.

## It needs both halves

This extension holds all of the logic, but it cannot read a Codeforces page or
reach the submit form by itself. That is the job of a companion **browser
extension**, which is loaded unpacked from the same repository:

> **https://github.com/MrDelrus/codeforces-assistant**

Download or clone it, open `chrome://extensions` (or `brave://extensions`,
`edge://extensions`), turn on *Developer mode*, choose *Load unpacked*, and pick
the `browser/` folder. The two halves talk over `127.0.0.1` only, on a port you
can change, and the first connection asks your permission.

## What it does

- **Capture a contest.** From any page of it. Every problem becomes a file made
  from your template, with the samples stored beside them.
- **Run the samples.** Compiles and runs each one, showing the first line where
  your output diverged. You can add tests of your own.
- **Switch problems.** One button per problem at the top of the panel, coloured
  by what Codeforces says: green solved, red attempted, grey untouched.
- **Submit.** Opens the Codeforces submit page with your language, your problem
  and your source already in it — then the verdict appears in the panel.

**The Submit button is yours to press.** The extension fills the form and stops.
Codeforces defends that form on purpose, and going around it would make this a
tool for defeating Codeforces rather than for writing code faster.

**Codeforces only.** No CSES, no AtCoder, no gym — gym submissions are absent
from the public API, so verdicts there could not be reported honestly.

## Requirements

A C++ compiler on your `PATH` for running samples locally, and the browser
extension above for capturing and submitting.

Full setup and usage: **https://github.com/MrDelrus/codeforces-assistant**

## License

MIT. Based on ideas from [CPOS](https://github.com/Soham109/cpos) by Soham
Aggarwal, also MIT — a rewrite of one workflow from it, not a fork.
