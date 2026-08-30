// The bridge between the popup and the service worker.
//
// There is deliberately nothing in the page itself: no button, no toast. Every
// capture is started from the extension popup and reports there, so Codeforces
// pages are left exactly as Codeforces drew them.
//
// This script does no networking of its own — it cannot reach 127.0.0.1 and is
// not meant to. Everything goes through the worker, which owns the single
// connection to VS Code. That keeps loopback traffic off the page's origin, so
// nothing else running on codeforces.com can reach the editor, and the browser
// never has to ask you for local network access.
//
// Parsing lives in parse.js, which is loaded first and is covered by tests.

(function () {
  'use strict';

  const parse = window.CFAParse;
  if (!parse) {
    return;
  }

  let busy = false;
  /**
   * The payload for this page, fetching the contest's problemset page first if
   * the page you are on has no statements on it — the contest front page, the
   * standings, the submit form.
   *
   * The fetch is same-origin and carries your session, which is the whole
   * reason it happens in the page rather than in the service worker: a contest
   * you are registered for and nobody else can read still answers here.
   */
  async function resolvePayload() {
    const decided = parse.plan(document, location.pathname);
    if (!decided) {
      return null;
    }
    if (decided.kind === 'page') {
      return decided.payload;
    }

    const response = await fetch(decided.url, {
      credentials: 'same-origin',
      headers: { accept: 'text/html' }
    });
    if (!response.ok) {
      throw new Error('Codeforces answered ' + response.status + ' for this contest\u2019s problems');
    }
    const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
    const payload = parse.collect(parsed, '/contest/' + decided.contestId + '/problems');
    if (!payload) {
      throw new Error('the contest has no problems on it yet');
    }
    return payload;
  }

  /** What the button can say before it does anything. */
  function describeTarget() {
    const decided = parse.plan(document, location.pathname);
    if (!decided) {
      return null;
    }
    if (decided.kind === 'page') {
      return {
        contestId: decided.payload.contestId,
        contestName: decided.payload.contestName,
        count: decided.payload.problems.length,
        first: decided.payload.problems[0].index,
        deferred: false
      };
    }
    return {
      contestId: decided.contestId,
      contestName: 'Contest ' + decided.contestId,
      count: 0,
      first: '',
      // The problems are one fetch away; the count is not known until then.
      deferred: true
    };
  }

  function describeResult(response) {
    if (response.created > 0 && response.existing > 0) {
      return (
        'Captured ' + response.problems + ' problems — ' + response.created + ' new, ' +
        response.existing + ' already on disk'
      );
    }
    if (response.created > 0) {
      return 'Created ' + response.created + ' file(s) with ' + response.samples + ' sample(s)';
    }
    return 'Refreshed ' + response.problems + ' problem(s), ' + response.samples + ' sample(s)';
  }

  /** `done` is called with { ok, message }; the popup is what shows it. */
  function runCapture(done) {
    const finish = function (ok, message) {
      if (done) {
        done({ ok: ok, message: message });
      }
    };

    if (busy) {
      if (done) {
        done({ ok: false, message: 'A capture is already running.' });
      }
      return;
    }

    busy = true;
    const release = function () {
      busy = false;
    };

    resolvePayload()
      .then(function (payload) {
        if (!payload) {
          release();
          finish(false, 'Nothing to capture on this page.');
          return;
        }
        chrome.runtime.sendMessage({ type: 'capture', payload: payload }, function (response) {
          release();
          if (chrome.runtime.lastError) {
            finish(false, 'The extension is not responding — reload the page.');
            return;
          }
          if (!response || !response.ok) {
            finish(false, (response && response.error) || 'VS Code did not accept the capture.');
            return;
          }
          finish(true, describeResult(response));
        });
      })
      .catch(function (error) {
        release();
        finish(false, 'Could not read this contest: ' + (error && error.message ? error.message : error));
      });
  }

  // The popup drives both of these: `describe` to label its button for whatever
  // page you are on, `capture-command` to press it.
  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'describe') {
      const target = describeTarget();
      sendResponse(target ? Object.assign({ ok: true }, target) : { ok: false });
      return false;
    }

    if (message.type === 'capture-command') {
      runCapture(sendResponse);
      return true;
    }

    return false;
  });

})();
