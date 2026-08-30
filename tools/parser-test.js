#!/usr/bin/env node
/**
 * Tests for browser/parse.js against Codeforces-shaped markup.
 *
 * The parser is the part most likely to break when Codeforces changes a page,
 * so it is kept free of chrome APIs and exercised here in jsdom.
 *
 *   cd tools && npm install && npm test
 */

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const parse = require(path.join(path.dirname(__dirname), 'browser', 'parse.js'));

let passed = 0;
const failures = [];

function test(name, body) {
  try {
    body();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${error && error.message}`);
  }
}

function dom(body, title) {
  return new JSDOM(
    `<!DOCTYPE html><html><head><title>${title || 'Codeforces'}</title></head>` +
      `<body>${body}</body></html>`
  ).window.document;
}

// ── fixtures ───────────────────────────────────────────────────────────────

/** A statement as Codeforces serves it: plain text inside <pre>. */
function statement(index, name, options) {
  const settings = options || {};
  const samples = settings.samples || [{ input: '3\n1 2 3', output: '6' }];
  const blocks = samples
    .map(
      (sample) =>
        `<div class="input"><div class="title">Input<button class="input-output-copier">Copy</button></div>` +
        `<pre>${sample.input}</pre></div>` +
        `<div class="output"><div class="title">Output</div><pre>${sample.output}</pre></div>`
    )
    .join('');

  return (
    `<div class="problemindexholder" problemindex="${index}">` +
    '<div class="ttypography"><div class="problem-statement">' +
    '<div class="header">' +
    `<div class="title">${index}. ${name}</div>` +
    '<div class="time-limit"><div class="property-title">time limit per test</div>2 seconds</div>' +
    '<div class="memory-limit"><div class="property-title">memory limit per test</div>256 megabytes</div>' +
    '</div>' +
    '<div class="sample-tests"><div class="section-title">Example</div>' +
    `<div class="sample-test">${blocks}</div></div>` +
    '<div class="note">In the first test case…</div>' +
    '</div></div></div>'
  );
}

const HEADER =
  '<div id="header"><div class="lang-chooser">' +
  '<a href="/profile/mrdelrus">mrdelrus</a> | <a href="/logout">Logout</a>' +
  '</div></div>';

// ── tests ──────────────────────────────────────────────────────────────────

console.log('single problem page');

test('parses index, name, limits and samples', () => {
  const doc = dom(HEADER + statement('A', 'Line Breaks'));
  const payload = parse.collect(doc, '/contest/2050/problem/A');

  assert.equal(payload.contestId, 2050);
  assert.equal(payload.problems.length, 1);

  const problem = payload.problems[0];
  assert.equal(problem.index, 'A');
  assert.equal(problem.name, 'Line Breaks');
  assert.equal(problem.timeLimit, '2 seconds');
  assert.equal(problem.memoryLimit, '256 megabytes');
  assert.equal(problem.url, 'https://codeforces.com/contest/2050/problem/A');
  assert.deepEqual(problem.samples, [{ input: '3\n1 2 3', output: '6' }]);
});

test('picks up the logged in handle', () => {
  const doc = dom(HEADER + statement('A', 'Line Breaks'));
  assert.equal(parse.collect(doc, '/contest/2050/problem/A').handle, 'mrdelrus');
});

test('omits the handle when signed out', () => {
  const doc = dom(statement('A', 'Line Breaks'));
  assert.equal(parse.collect(doc, '/contest/2050/problem/A').handle, undefined);
});

test('reads a problemset url', () => {
  const doc = dom(statement('C', 'Ice Cream'));
  const payload = parse.collect(doc, '/problemset/problem/1999/C');
  assert.equal(payload.contestId, 1999);
  assert.equal(payload.problems[0].index, 'C');
});

test('falls back to the title when problemindex is absent', () => {
  const raw = statement('B', 'Transfusion').replace(' problemindex="B"', '');
  const payload = parse.collect(dom(raw), '/contest/2050/problem/B');
  assert.equal(payload.problems[0].index, 'B');
  assert.equal(payload.problems[0].name, 'Transfusion');
});

test('handles a sub-indexed problem like C1', () => {
  const doc = dom(statement('C1', 'Easy Version'));
  assert.equal(parse.collect(doc, '/contest/2050/problem/C1').problems[0].index, 'C1');
});

console.log('complete problemset page');

test('parses every problem on the page in order', () => {
  const doc = dom(
    HEADER +
      statement('A', 'Alpha') +
      statement('B', 'Beta') +
      statement('C', 'Gamma') +
      statement('D', 'Delta'),
    'Problems - Codeforces Round 993 (Div. 4) - Codeforces'
  );
  const payload = parse.collect(doc, '/contest/2050/problems');

  assert.equal(payload.problems.length, 4);
  assert.deepEqual(
    payload.problems.map((p) => p.index),
    ['A', 'B', 'C', 'D']
  );
  assert.equal(payload.contestName, 'Codeforces Round 993 (Div. 4)');
});

test('prefers the sidebar contest name', () => {
  const doc = dom(
    '<div id="sidebar"><table class="rtable"><tr><th>' +
      '<a href="/contest/2050">Codeforces Round 993 (Div. 4)</a>' +
      '</th></tr></table></div>' +
      statement('A', 'Alpha'),
    'Problems - Codeforces'
  );
  assert.equal(parse.collect(doc, '/contest/2050/problems').contestName, 'Codeforces Round 993 (Div. 4)');
});

console.log('sample extraction');

test('keeps several examples for one problem', () => {
  const doc = dom(
    statement('A', 'Two examples', {
      samples: [
        { input: '1', output: 'one' },
        { input: '2', output: 'two' }
      ]
    })
  );
  const samples = parse.collect(doc, '/contest/2050/problem/A').problems[0].samples;
  assert.equal(samples.length, 2);
  assert.equal(samples[1].input, '2');
  assert.equal(samples[1].output, 'two');
});

test('reads the per-line markup used for multi-test files', () => {
  const pre =
    '<pre>' +
    '<div class="test-example-line test-example-line-0">4</div>' +
    '<div class="test-example-line test-example-line-odd test-example-line-1">1 2</div>' +
    '<div class="test-example-line test-example-line-even test-example-line-2">3 4</div>' +
    '<div class="test-example-line test-example-line-op">...</div>' +
    '<div class="test-example-line test-example-line-odd test-example-line-3">5 6</div>' +
    '</pre>';
  const doc = dom(`<div class="wrap">${pre}</div>`);
  const text = parse.preText(doc.querySelector('pre'));
  assert.equal(text, '4\n1 2\n3 4\n5 6', 'the "-op" ellipsis row must be dropped');
});

test('turns <br> into newlines', () => {
  const doc = dom('<pre>1 2<br>3 4<br>5 6</pre>');
  assert.equal(parse.preText(doc.querySelector('pre')), '1 2\n3 4\n5 6');
});

test('trims the leading newline Codeforces leaves in <pre>', () => {
  assert.equal(parse.tidy('\n\n3\n1 2 3\n\n  '), '3\n1 2 3');
});

test('a problem with no samples still parses', () => {
  const raw = statement('A', 'No examples').replace(
    /<div class="sample-tests">[\s\S]*?<\/div><\/div>/,
    ''
  );
  const payload = parse.collect(dom(raw), '/contest/2050/problem/A');
  assert.equal(payload.problems[0].samples.length, 0);
  assert.equal(payload.problems[0].index, 'A');
});

console.log('deciding what a page can capture');

test('captures from the page when the statements are on it', () => {
  const decided = parse.plan(dom(statement('A', 'Alpha')), '/contest/2050/problem/A');
  assert.equal(decided.kind, 'page');
  assert.equal(decided.payload.problems.length, 1);
});

test('captures a whole problemset page from the page', () => {
  const body = statement('A', 'Alpha') + statement('B', 'Beta');
  const decided = parse.plan(dom(body), '/contest/2050/problems');
  assert.equal(decided.kind, 'page');
  assert.equal(decided.payload.problems.length, 2);
});

['/contest/2050', '/contest/2050/standings', '/contest/2050/submit', '/contest/2050/my'].forEach(
  (pathname) => {
    test('falls back to the problemset page from ' + pathname, () => {
      const decided = parse.plan(dom('<div>no statements here</div>'), pathname);
      assert.equal(decided.kind, 'fetch');
      assert.equal(decided.contestId, 2050);
      assert.equal(decided.url, 'https://codeforces.com/contest/2050/problems');
    });
  }
);

test('an archive problem is captured from the page it is on', () => {
  const decided = parse.plan(dom(statement('C', 'Gamma')), '/problemset/problem/2050/C');
  assert.equal(decided.kind, 'page');
  assert.equal(decided.payload.contestId, 2050);
  assert.equal(decided.payload.problems[0].index, 'C');
});

test('no contest, no plan', () => {
  assert.equal(parse.plan(dom('<div>nothing</div>'), '/problemset'), null);
  assert.equal(parse.plan(dom('<div>nothing</div>'), '/blog/entry/123'), null);
});

console.log('rejections');

test('returns null off a problem page', () => {
  assert.equal(parse.collect(dom('<div>nothing here</div>'), '/contest/2050/standings'), null);
});

test('returns null without a contest id', () => {
  assert.equal(parse.collect(dom(statement('A', 'Alpha')), '/blog/entry/123'), null);
});

test('splits a title only on a real index', () => {
  assert.deepEqual(parse.splitTitle('A. Two Buttons'), { index: 'A', name: 'Two Buttons' });
  assert.deepEqual(parse.splitTitle('Some Heading'), { index: '', name: 'Some Heading' });
});

console.log('');
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
