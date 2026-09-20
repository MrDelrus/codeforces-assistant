#!/usr/bin/env node
/**
 * Headless checks for the parts of the VS Code extension that decide what
 * touches the disk and who is allowed to talk to the socket.
 *
 * The extension host is not available outside VS Code, so `require('vscode')`
 * is answered with a stub below. Everything else is the real compiled code.
 *
 *   cd vscode && npm run compile
 *   node ../tools/selftest.js
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.dirname(__dirname);
const OUT = path.join(ROOT, 'vscode', 'out');

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfa-test-'));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfa-config-'));
process.env.XDG_CONFIG_HOME = configDir;

// ── the smallest `vscode` that this code needs ─────────────────────────────

const settings = new Map([
  ['port', 27199],
  ['language', 'cpp'],
  ['cpp.extension', 'cpp'],
  ['cpp.compile', 'g++ -std=gnu++20 -O2 -o "{exe}" "{src}"'],
  ['cpp.run', '"{exe}"'],
  ['contestsDir', ''],
  ['openOnCapture', 'none'],
  ['saveSamplesNextToSolution', false],
  ['runTimeoutMs', 5000],
  ['compileTimeoutMs', 30000]
]);

// Nothing loaded below may reach for the editor: the same files run inside
// `cfa-host`, where `require('vscode')` throws. This used to be a stub; making
// it an assertion is what keeps the boundary from drifting back, since a new
// import would fail here rather than only in production.
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    throw new Error(
      `the core must not require('vscode') — ${parent && parent.filename} does. ` +
        'Editor-only code belongs in extension.ts, adapters.ts or reveal.ts.'
    );
  }
  return load.call(this, request, parent, isMain);
};

const validate = require(path.join(OUT, 'validate.js'));
const paths = require(path.join(OUT, 'paths.js'));
const capture = require(path.join(OUT, 'capture.js'));
const runner = require(path.join(OUT, 'runner.js'));
const { CaptureServer } = require(path.join(OUT, 'server.js'));
const progress = require(path.join(OUT, 'progress.js'));
const store = require(path.join(OUT, 'store.js'));
const templates = require(path.join(OUT, 'template.js'));
const cfaConfig = require(path.join(OUT, 'config.js'));
const template = require(path.join(OUT, 'template.js'));

// Whoever owns the process supplies the settings. Here that is this file.
cfaConfig.setSettingsSource({
  get(key, fallback) {
    return settings.has(key) ? settings.get(key) : fallback;
  },
  workspaceRoot() {
    return workspaceDir;
  }
});

// ── test harness ───────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

async function test(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
    console.log(`       ${error && error.message}`);
  }
}

function throws(fn, why) {
  assert.throws(fn, why);
}

// ── input validation ───────────────────────────────────────────────────────

function sampleCapture(overrides) {
  return Object.assign(
    {
      contestId: 2050,
      contestName: 'Codeforces Round 993',
      url: 'https://codeforces.com/contest/2050',
      problems: [
        {
          index: 'A',
          name: 'Line Breaks',
          url: 'https://codeforces.com/contest/2050/problem/A',
          timeLimit: '2 seconds',
          memoryLimit: '256 megabytes',
          samples: [{ input: '3\n1 2 3', output: '6' }]
        }
      ]
    },
    overrides || {}
  );
}

async function main() {
  console.log('validation');

  await test('accepts a well formed capture', () => {
    const result = validate.validateCapture(sampleCapture());
    assert.equal(result.contestId, 2050);
    assert.equal(result.problems[0].index, 'A');
    assert.equal(result.problems[0].samples[0].output, '6');
  });

  await test('rejects a traversal disguised as a problem index', () => {
    throws(() =>
      validate.validateCapture(
        sampleCapture({ problems: [{ index: '../../etc', name: 'x', samples: [] }] })
      )
    );
  });

  await test('rejects a non numeric contest id', () => {
    throws(() => validate.validateCapture(sampleCapture({ contestId: '2050/../..' })));
  });

  await test('keeps a hostile problem name as text', () => {
    const result = validate.validateCapture(
      sampleCapture({
        problems: [{ index: 'B', name: '../../.ssh/authorized_keys', samples: [] }]
      })
    );
    assert.equal(result.problems[0].name, '../../.ssh/authorized_keys');
    assert.equal(result.problems[0].index, 'B');
  });

  await test('rejects a duplicate index', () => {
    throws(() =>
      validate.validateCapture(
        sampleCapture({
          problems: [
            { index: 'A', name: 'one', samples: [] },
            { index: 'A', name: 'two', samples: [] }
          ]
        })
      )
    );
  });

  await test('rejects an oversized sample', () => {
    throws(() =>
      validate.validateCapture(
        sampleCapture({
          problems: [
            { index: 'A', name: 'big', samples: [{ input: 'x'.repeat(300000), output: '' }] }
          ]
        })
      )
    );
  });

  await test('drops a url that is not on codeforces', () => {
    const result = validate.validateCapture(
      sampleCapture({
        problems: [{ index: 'A', name: 'x', url: 'https://evil.example/pwn', samples: [] }]
      })
    );
    assert.equal(result.problems[0].url, 'https://codeforces.com/contest/2050/problem/A');
  });

  console.log('paths');

  await test('builds the contest layout', () => {
    const file = paths.solutionPath(workspaceDir, 2050, 'C1', 'cpp');
    assert.equal(file, path.join(workspaceDir, '2050', '2050C1.cpp'));
  });

  await test('refuses a path outside the base', () => {
    throws(() => paths.assertInside(workspaceDir, path.join(workspaceDir, '..', 'escape')));
  });

  await test('parses a solution file name', () => {
    assert.deepEqual(paths.parseSolutionName('/x/2050/2050B.cpp'), {
      contestId: 2050,
      index: 'B'
    });
    assert.equal(paths.parseSolutionName('/x/notes.cpp'), undefined);
  });

  console.log('capture');

  await test('creates one file per problem and records samples', async () => {
    const valid = validate.validateCapture(
      sampleCapture({
        problems: [
          { index: 'A', name: 'A', samples: [{ input: '1', output: '1' }] },
          { index: 'B', name: 'B', samples: [{ input: '2', output: '2' }] }
        ]
      })
    );
    const result = await capture.applyCapture(valid);
    assert.equal(result.created.length, 2);
    assert.equal(result.totalSamples, 2);

    const folder = path.join(workspaceDir, '2050');
    assert.ok(fs.existsSync(path.join(folder, '2050A.cpp')));
    assert.ok(fs.existsSync(path.join(folder, '2050B.cpp')));

    const meta = JSON.parse(fs.readFileSync(path.join(folder, '.cfa', 'contest.json'), 'utf8'));
    assert.equal(meta.problems.length, 2);
    assert.equal(meta.problems[1].samples[0].input, '2');
  });

  await test('never overwrites an existing solution', async () => {
    const file = path.join(workspaceDir, '2050', '2050A.cpp');
    fs.writeFileSync(file, '// my work\n', 'utf8');

    const valid = validate.validateCapture(
      sampleCapture({ problems: [{ index: 'A', name: 'A', samples: [{ input: '9', output: '9' }] }] })
    );
    const result = await capture.applyCapture(valid);

    assert.equal(result.created.length, 0);
    assert.equal(result.existing.length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), '// my work\n');

    const meta = JSON.parse(
      fs.readFileSync(path.join(workspaceDir, '2050', '.cfa', 'contest.json'), 'utf8')
    );
    const problemA = meta.problems.find((p) => p.index === 'A');
    assert.equal(problemA.samples[0].input, '9', 'samples should still refresh');
    assert.ok(
      meta.problems.some((p) => p.index === 'B'),
      'a re-capture must not lose problems captured earlier'
    );
  });

  console.log('output comparison');

  await test('ignores trailing whitespace and blank lines', () => {
    assert.equal(runner.compare('1 2\n3\n', '1 2   \n3\n\n\n').equal, true);
  });

  await test('reports the first differing line', () => {
    const verdict = runner.compare('1\n2\n3', '1\n9\n3');
    assert.equal(verdict.equal, false);
    assert.equal(verdict.firstDiffLine, 2);
  });

  await test('a missing line is a difference', () => {
    assert.equal(runner.compare('1\n2', '1').firstDiffLine, 2);
  });

  console.log('compile and run');

  runner.setBinDirectory(path.join(workspaceDir, '.bin'));
  const program = path.join(workspaceDir, '2050', '2050B.cpp');
  fs.writeFileSync(
    program,
    '#include <bits/stdc++.h>\nint main(){int n;std::cin>>n;long long s=0,x;' +
      'for(int i=0;i<n;i++){std::cin>>x;s+=x;}std::cout<<s<<"\\n";}\n',
    'utf8'
  );

  let built;

  await test('compiles a real program', async () => {
    built = await runner.compile(program);
    assert.equal(built.ok, true, built.output);
  });

  await test('passes a correct sample', async () => {
    const result = await runner.runSample(
      built.runCommand,
      { input: '3\n1 2 3', output: '6' },
      1,
      path.dirname(program)
    );
    assert.equal(result.status, 'passed', JSON.stringify(result));
  });

  await test('marks a wrong answer and points at the line', async () => {
    const result = await runner.runSample(
      built.runCommand,
      { input: '3\n1 2 3', output: '7' },
      1,
      path.dirname(program)
    );
    assert.equal(result.status, 'wrong');
    assert.equal(result.firstDiffLine, 1);
    assert.equal(result.actual.trim(), '6');
  });

  await test('reports a compile error instead of throwing', async () => {
    const broken = path.join(workspaceDir, '2050', '2050C.cpp');
    fs.writeFileSync(broken, 'int main() { this is not c++ }\n', 'utf8');
    const outcome = await runner.compile(broken);
    assert.equal(outcome.ok, false);
    assert.ok(outcome.output.length > 0, 'should carry the compiler diagnostics');
  });

  await test('kills a program that runs past the limit', async () => {
    const spinner = path.join(workspaceDir, '2050', '2050D.cpp');
    fs.writeFileSync(spinner, 'int main(){for(;;){}}\n', 'utf8');
    const compiled = await runner.compile(spinner);
    assert.equal(compiled.ok, true, compiled.output);

    settings.set('runTimeoutMs', 700);
    const started = Date.now();
    const result = await runner.runSample(
      compiled.runCommand,
      { input: '', output: '' },
      1,
      path.dirname(spinner)
    );
    settings.set('runTimeoutMs', 5000);

    assert.equal(result.status, 'timeout');
    assert.ok(Date.now() - started < 4000, 'the kill should be prompt');
  });

  console.log('server origin policy');

  const trusted = new Set();
  let promptCount = 0;
  const server = new CaptureServer({
    applyCapture: async (body) => capture.applyCapture(body),
    peekPendingSubmit: () => undefined,
    markSubmitClaimed: () => {},
    onSubmitAck: () => {},
    onHandleSeen: () => {},
    isTrustedOrigin: (origin) => trusted.has(origin),
    requestTrust: async (origin) => {
      promptCount += 1;
      if (origin === 'chrome-extension://goodgoodgoodgoodgoodgoodgoodgood') {
        trusted.add(origin);
        return true;
      }
      return false;
    }
  });

  await server.start();
  const base = `http://127.0.0.1:${settings.get('port')}`;

  const call = (path, options) => fetch(base + path, options);

  await test('answers /health without an origin', async () => {
    const response = await call('/health');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.app, 'codeforces-assistant');
  });

  await test('refuses a web page origin outright', async () => {
    const response = await call('/health', { headers: { origin: 'https://codeforces.com' } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  await test('refuses an unapproved extension', async () => {
    const response = await call('/health', {
      headers: { origin: 'chrome-extension://badbadbadbadbadbadbadbadbadbadba' }
    });
    assert.equal(response.status, 403);
    assert.ok(promptCount > 0, 'should have asked once');
  });

  await test('does not ask twice about the same refused extension', async () => {
    const before = promptCount;
    await call('/health', {
      headers: { origin: 'chrome-extension://badbadbadbadbadbadbadbadbadbadba' }
    });
    assert.equal(promptCount, before);
  });

  await test('allows an approved extension and echoes its origin', async () => {
    const origin = 'chrome-extension://goodgoodgoodgoodgoodgoodgoodgood';
    const response = await call('/health', { headers: { origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  });

  await test('/pending-submit answers 200 when nothing is queued', async () => {
    const response = await call('/pending-submit');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.pending, null);
  });

  await test('refuses a body that is not JSON', async () => {
    const response = await call('/capture', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'contestId=1'
    });
    assert.equal(response.status, 400);
  });

  await test('captures over HTTP end to end', async () => {
    const response = await call('/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        sampleCapture({
          contestId: 1999,
          problems: [{ index: 'D', name: 'End to end', samples: [{ input: '5', output: '5' }] }]
        })
      )
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(fs.existsSync(path.join(workspaceDir, '1999', '1999D.cpp')));
  });

  await test('rejects a hostile index over HTTP', async () => {
    const response = await call('/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        sampleCapture({ problems: [{ index: '../../../tmp/x', name: 'nope', samples: [] }] })
      )
    });
    assert.equal(response.status, 400);
  });

  server.stop();

  // ── contest progress, the tab strip's colours ────────────────────────────

  /** Answer the next fetch calls in order, and record the URLs asked for. */
  function stubFetch(responses) {
    const asked = [];
    global.fetch = async (url) => {
      asked.push(String(url));
      const next = responses.shift();
      if (!next) {
        throw new Error('unexpected extra request');
      }
      if (next instanceof Error) {
        throw next;
      }
      return { ok: true, status: 200, async json() { return next; } };
    };
    return asked;
  }

  const realFetch = global.fetch;

  await test('reads solved and attempted problems out of contest.status', async () => {
    stubFetch([
      {
        status: 'OK',
        result: [
          { id: 3, problem: { index: 'A' }, verdict: 'OK' },
          { id: 2, problem: { index: 'A' }, verdict: 'WRONG_ANSWER' },
          { id: 1, problem: { index: 'C' }, verdict: 'TIME_LIMIT_EXCEEDED' }
        ]
      }
    ]);
    const statuses = await progress.fetchProgress('MrDelrus', 2050);
    assert.equal(statuses.get('A'), 'solved');
    assert.equal(statuses.get('C'), 'attempted');
    assert.equal(statuses.get('B'), undefined);
  });

  await test('an accepted submission is never downgraded by a later wrong one', async () => {
    stubFetch([
      {
        status: 'OK',
        result: [
          { id: 1, problem: { index: 'B' }, verdict: 'OK' },
          { id: 2, problem: { index: 'B' }, verdict: 'RUNTIME_ERROR' }
        ]
      }
    ]);
    const statuses = await progress.fetchProgress('MrDelrus', 2050);
    assert.equal(statuses.get('B'), 'solved');
  });

  await test('falls back to user.status and filters it by contest', async () => {
    const asked = stubFetch([
      { status: 'FAILED', comment: 'contestId: Contest with id 9999 not found' },
      {
        status: 'OK',
        result: [
          { id: 5, contestId: 9999, problem: { index: 'A' }, verdict: 'OK' },
          { id: 4, contestId: 1234, problem: { index: 'B' }, verdict: 'OK' }
        ]
      }
    ]);
    const statuses = await progress.fetchProgress('MrDelrus', 9999);
    assert.equal(asked.length, 2);
    assert.ok(asked[0].includes('contest.status'));
    assert.ok(asked[1].includes('user.status'));
    assert.equal(statuses.get('A'), 'solved');
    assert.equal(statuses.get('B'), undefined, 'another contest must not leak in');
  });

  global.fetch = realFetch;

  // ── cursor anchor in the template ────────────────────────────────────────

  await test('the template marker gives the line and column the caret wants', () => {
    const rendered = template.render('int main() {\n    $0\n}\n');
    assert.equal(rendered.text, 'int main() {\n    \n}\n');
    assert.deepEqual(rendered.cursor, { line: 1, character: 4 });
  });

  // ── the default caret anchor ─────────────────────────────────────────────

  await test('the default cursor anchor lands on the middle blank line of solve()', () => {
    const file = ['#include <bits/stdc++.h>', '', 'void solve() {', '', '', '', '}', ''].join('\n');
    const match = new RegExp(cfaConfig.cursorAnchor(), 'm').exec(file);
    assert.ok(match, 'the default anchor must match a solve() with a three-line body');
    const before = file.slice(0, match.index + match[0].length).split('\n');
    // solve() opens on line 3, so its blank lines are 4, 5 and 6.
    assert.equal(before.length, 5, 'the caret belongs on the second of the three blank lines');
    assert.equal(before[before.length - 1].length, 0);
  });

  // ── tests the user added by hand ─────────────────────────────────────────

  await test('a re-capture keeps the tests the user added', async () => {
    const folder = path.join(workspaceDir, 'merge-test');
    const problem = (extra) => ({
      contestId: 3000,
      index: 'A',
      id: '3000A',
      name: 'Alpha',
      url: 'https://codeforces.com/contest/3000/problem/A',
      samples: [{ input: '1\n', output: '1\n' }],
      file: path.join(folder, '3000A.cpp'),
      capturedAt: '2026-01-01T00:00:00.000Z',
      ...(extra ? { extraSamples: extra } : {})
    });

    await store.writeContest(folder, {
      contestId: 3000,
      name: 'Test round',
      url: 'https://codeforces.com/contest/3000',
      capturedAt: '2026-01-01T00:00:00.000Z',
      problems: [problem([{ input: '7\n', output: '7\n' }])]
    });

    const merged = await store.mergeContest(folder, {
      contestId: 3000,
      name: 'Test round',
      url: 'https://codeforces.com/contest/3000',
      capturedAt: '2026-01-02T00:00:00.000Z',
      // A capture carries the official samples only, and two of them this time.
      problems: [
        {
          ...problem(),
          samples: [
            { input: '1\n', output: '1\n' },
            { input: '2\n', output: '2\n' }
          ]
        }
      ]
    });

    const after = merged.problems[0];
    assert.equal(after.samples.length, 2, 'official samples must be refreshed');
    assert.deepEqual(after.extraSamples, [{ input: '7\n', output: '7\n' }]);
  });

  await test('updateProblem writes an added test through to disk', async () => {
    const folder = path.join(workspaceDir, 'merge-test');
    await store.updateProblem(folder, 'A', (entry) => ({
      ...entry,
      extraSamples: [...(entry.extraSamples ?? []), { input: '9\n', output: '9\n' }]
    }));
    const reread = await store.readContest(folder);
    assert.deepEqual(reread.problems[0].extraSamples, [
      { input: '7\n', output: '7\n' },
      { input: '9\n', output: '9\n' }
    ]);
  });

  // ── the template copy ────────────────────────────────────────────────────
  // Last, because adopting one changes what every later capture is made from.

  await test('choosing a template takes a copy, and the copy is what is used', async () => {
    const source = path.join(configDir, 'chosen.cpp');
    fs.writeFileSync(source, 'int main() {\n    $0\n}\n', 'utf8');

    const target = await templates.adoptTemplate(source);
    assert.equal(target, path.join(workspaceDir, '.template.cpp'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'int main() {\n    $0\n}\n');

    const active = await templates.activeTemplateFile();
    assert.equal(active.local, true);
    assert.equal(active.file, target);

    const rendered = await templates.readTemplate();
    assert.equal(rendered.text, 'int main() {\n    \n}\n');

    // Editing the file it came from must not reach the extension.
    fs.writeFileSync(source, 'something else entirely\n', 'utf8');
    assert.equal((await templates.readTemplate()).text, 'int main() {\n    \n}\n');
  });

  await test('a second template is refused rather than overwriting the first', async () => {
    const source = path.join(configDir, 'other.cpp');
    fs.writeFileSync(source, 'int main() { return 1; }\n', 'utf8');

    await assert.rejects(
      () => templates.adoptTemplate(source),
      (error) => {
        assert.ok(error instanceof templates.TemplateExistsError);
        assert.match(error.message, /\.template\.cpp already exists in/);
        assert.ok(error.message.includes(workspaceDir));
        return true;
      }
    );
    // And the first one is still there, untouched.
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, '.template.cpp'), 'utf8'),
      'int main() {\n    $0\n}\n'
    );
  });

  // ── the pieces the host relies on ────────────────────────────────────────

  await test('a run covers the official samples and the user-added ones, in that order', () => {
    const problem = {
      samples: [{ input: '1\n', output: 'a\n' }],
      extraSamples: [{ input: '2\n', output: 'b\n' }]
    };
    assert.deepEqual(store.allSamples(problem).map((s) => s.input), ['1\n', '2\n']);
    const results = store.pendingResults(problem);
    assert.deepEqual(
      results.map((r) => [r.number, r.status, r.custom]),
      [
        [1, 'pending', false],
        [2, 'pending', true]
      ]
    );
  });

  const hostSettings = path.join(ROOT, 'host', 'out', 'host', 'src', 'settings.js');
  await test('the host reads settings written flat or nested', async () => {
    assert.ok(
      fs.existsSync(hostSettings),
      'the host is not built — run "npm run compile" in host/ first'
    );
    const { FileSettings } = require(hostSettings);
    const file = path.join(configDir, 'host-settings.json');

    // The way the documentation writes a key.
    fs.writeFileSync(file, JSON.stringify({ 'cfa.port': 31000, 'cfa.handle': 'tourist' }));
    const flat = new FileSettings(undefined);
    await flat.load(file);
    assert.equal(flat.get('port', 29617), 31000);
    assert.equal(flat.get('handle', ''), 'tourist');

    // The way anyone who has edited VS Code's settings.json writes it.
    fs.writeFileSync(file, JSON.stringify({ cfa: { port: 31001, cpp: { run: 'x' } } }));
    const nested = new FileSettings(undefined);
    await nested.load(file);
    assert.equal(nested.get('port', 29617), 31001);
    assert.equal(nested.get('cpp.run', ''), 'x');

    // A key of the wrong type is a typo, and the default beats a crash later.
    fs.writeFileSync(file, JSON.stringify({ 'cfa.port': 'twenty nine thousand' }));
    const wrong = new FileSettings(undefined);
    await wrong.load(file);
    assert.equal(wrong.get('port', 29617), 29617);

    // A missing file is normal; a malformed one is not.
    const absent = new FileSettings(undefined);
    await absent.load(path.join(configDir, 'does-not-exist.json'));
    assert.equal(absent.get('port', 29617), 29617);
    fs.writeFileSync(file, '{ not json');
    await assert.rejects(() => new FileSettings(undefined).load(file), /not valid JSON/);
  });

  await test('--dir is what the host uses when cfa.contestsDir is empty', async () => {
    const { FileSettings } = require(hostSettings);
    const source = new FileSettings(workspaceDir);
    await source.load(path.join(configDir, 'does-not-exist.json'));
    assert.equal(source.workspaceRoot(), workspaceDir);
  });

  console.log('');
  console.log(`${passed} passed, ${failures.length} failed`);
  console.log(`workspace: ${workspaceDir}`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
