// Service worker: the only part of this extension that talks to VS Code.
//
// It does two jobs.
//   1. Forwards a parsed contest from the page to VS Code.
//   2. Picks up submits queued in VS Code and drives the Codeforces form.
//
// Job 2 is the reason a browser is involved at all. Submitting needs your
// logged-in session, and the anti-automation fields on the form are produced by
// Codeforces' own JavaScript — so we fill the real form in a real page and let
// their code do its part, rather than forging a POST.

'use strict';

const DEFAULTS = {
  port: 29617,
  closeAfterSubmit: true
};

/** How long the user gets to press Submit before the tab is left to them. */
const WAIT_FOR_USER_MS = 10 * 60 * 1000;
/** Kept well above the API's one-call-per-two-seconds limit. */
const SUBMIT_POLL_MS = 5000;

/** Submit ids we have already driven, so a retry cannot open two tabs. */
const handled = new Set();
let inFlight = null;
let lastPoll = 0;

// ── settings ───────────────────────────────────────────────────────────────

async function settings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  const port = Number(stored.port);
  return {
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULTS.port,
    closeAfterSubmit: stored.closeAfterSubmit !== false
  };
}

async function baseUrl() {
  const { port } = await settings();
  return 'http://127.0.0.1:' + port;
}

async function api(path, options) {
  const base = await baseUrl();
  const response = await fetch(base + path, Object.assign({ cache: 'no-store' }, options || {}));
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error('VS Code returned something that is not JSON');
  }
  if (!response.ok) {
    throw new Error(body.error || 'VS Code returned ' + response.status);
  }
  return body;
}

function postJson(path, payload) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// ── tab plumbing ───────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function waitForComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(function () {
      return null;
    });
    if (!tab) {
      throw new Error('the submit tab was closed');
    }
    if (tab.status === 'complete') {
      return tab;
    }
    await sleep(150);
  }
  throw new Error('the Codeforces submit page did not finish loading');
}

// ── injected into the page ─────────────────────────────────────────────────

/**
 * Runs in the page's own JavaScript context, where Codeforces' editor lives.
 *
 * Two details decided by trial and error, and both non-obvious: the source
 * lives in an Ace editor that has to be set through its own API rather than by
 * writing to the textarea, and firing `change` on the selects resets that
 * editor — so values are assigned quietly.
 */
function fillSubmitForm(code, problemIndex, languageKey) {
  const RANKS = {
    cpp: [/GNU G\+\+23/i, /GNU G\+\+20/i, /GNU G\+\+17/i, /G\+\+23/i, /G\+\+20/i, /G\+\+17/i, /G\+\+/i],
    python: [/^Python 3/i, /Python 3\.\d/i, /\bPython 3\b/i, /PyPy 3/i]
  };

  function pickLanguage(select) {
    const ranks = RANKS[languageKey] || RANKS.cpp;
    for (const pattern of ranks) {
      for (const option of select.options) {
        if (pattern.test(option.textContent || '')) {
          select.value = option.value;
          return option.textContent.trim();
        }
      }
    }
    return null;
  }

  function pickProblem(select, index) {
    const want = String(index).toUpperCase();
    for (const option of select.options) {
      const value = (option.value || '').toUpperCase();
      const text = (option.textContent || '').trim().toUpperCase();
      if (value === want || text === want || /^[A-Z][0-9]?[.\-— ]/.test(text) && text.indexOf(want) === 0) {
        select.value = option.value;
        return true;
      }
    }
    return false;
  }

  function syncEditor(value) {
    if (typeof window.ace === 'undefined' || typeof window.ace.edit !== 'function') {
      return;
    }
    try {
      const editor = window.ace.edit('editor');
      if (editor && typeof editor.setValue === 'function') {
        editor.setValue(value, -1);
        editor.clearSelection();
      }
    } catch (error) {
      // No Ace editor on this page layout; the textarea alone will do.
    }
  }

  const source = document.getElementById('sourceCodeTextarea');
  const language = document.getElementsByName('programTypeId')[0];
  if (!source || !language || language.options.length <= 1) {
    return { ok: false, reason: 'submit form is not ready' };
  }

  const chosen = pickLanguage(language);
  if (!chosen) {
    return { ok: false, reason: 'no matching language in the submit form' };
  }

  const problemSelect = document.getElementsByName('submittedProblemIndex')[0];
  if (problemSelect && !pickProblem(problemSelect, problemIndex)) {
    return { ok: false, reason: 'problem ' + problemIndex + ' is not on this submit page' };
  }

  // The archive's own submit page names the problem in a text field instead of
  // a select — "141A", not "A". It is filled from the URL when there is one,
  // but setting it makes this work from a bare /problemset/submit as well.
  const problemCode = document.getElementsByName('submittedProblemCode')[0];
  if (problemCode && !problemCode.value) {
    const owning = /\/(?:contest|problemset\/submit|problemset\/problem)\/(\d+)/.exec(
      location.pathname
    );
    if (owning) {
      problemCode.value = owning[1] + String(problemIndex).toUpperCase();
    }
  }

  source.value = code;
  syncEditor(code);

  const fileInput = document.querySelector('input[type="file"][name="sourceFile"]');
  if (fileInput) {
    fileInput.value = '';
  }

  // Read the form back. If Codeforces refuses the submission, the first
  // question is always whether the fields actually took the values we assigned,
  // and guessing about that wastes an evening.
  const form = source.form || document.querySelector('form.submit-form');
  const named = function (name) {
    const field = form ? form.querySelector('input[name="' + name + '"]') : null;
    return field ? (field.value ? 'set' : 'empty') : 'absent';
  };

  const profile = document.querySelector(
    '#header a[href^="/profile/"], .lang-chooser a[href^="/profile/"]'
  );
  const whose = profile ? /\/profile\/([^/?#]+)/.exec(profile.getAttribute('href') || '') : null;

  return {
    ok: true,
    handle: whose ? decodeURIComponent(whose[1]) : '',
    readback: {
      sourceLength: (source.value || '').length,
      language: chosen,
      problem: problemSelect ? problemSelect.value : '(no problem select)',
      // Codeforces fills these from its own scripts and refuses a form that
      // reaches it without them. Which is exactly what filling and pressing in
      // the same tick used to produce.
      csrf: named('csrf_token'),
      ftaa: named('ftaa'),
      bfaa: named('bfaa')
    }
  };
}

/**
 * Did a submission for this problem actually appear?
 *
 * The page cannot answer this. Codeforces' submit form posts into a hidden
 * frame — the class on it is literally `submitFrameForm` — so the tab never
 * navigates, whether the submission was taken or thrown away. Watching the DOM
 * therefore cannot tell success from silence, and this is the only thing that
 * can. The API is public and needs no session.
 */
async function landed(handle, contestId, index, notBefore) {
  if (!handle) {
    return false;
  }
  try {
    const response = await fetch(
      'https://codeforces.com/api/user.status?handle=' +
        encodeURIComponent(handle) +
        '&from=1&count=10',
      { cache: 'no-store', signal: AbortSignal.timeout(10000) }
    );
    const body = await response.json();
    if (!body || body.status !== 'OK' || !Array.isArray(body.result)) {
      return false;
    }
    return body.result.some(function (entry) {
      const owning = entry.contestId || (entry.problem && entry.problem.contestId);
      const at = (entry.problem && entry.problem.index) || '';
      return (
        owning === contestId &&
        at.toUpperCase() === String(index).toUpperCase() &&
        entry.creationTimeSeconds * 1000 >= notBefore
      );
    });
  } catch (error) {
    console.log('[cfa] could not check user.status:', error && error.message);
    return false;
  }
}

// ── submit orchestration ───────────────────────────────────────────────────

async function activeTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.length > 0 ? tabs[0].id : undefined;
}

/**
 * Open the submit page and fill it in. Pressing Submit is the user's.
 *
 * The tool used to press the button itself, through three escalating ways in,
 * and every one of them ran into something Codeforces put there on purpose:
 * handlers that cancel a synthetic submit, a form that posts into a hidden
 * frame so nothing can be read back, anti-automation fields filled by their
 * own scripts. Working around that is a losing game and not a fair one. What
 * is left is the part that was always the point — never retyping a solution
 * into a browser — and it is the part that nothing objects to.
 */
async function driveSubmit(pending) {
  const { closeAfterSubmit } = await settings();
  const previousTab = await activeTabId();
  /**
   * `/contest/N/submit` is the right page during a contest and for one you took
   * part in. For an old contest you never entered it is not, and the archive's
   * own page is where practice submissions go. Whichever fills, wins.
   */
  const urls = [
    'https://codeforces.com/contest/' + pending.contestId + '/submit',
    'https://codeforces.com/problemset/submit/' + pending.contestId + '/' + pending.index
  ];

  let tabId;
  let result = { ok: false, reason: 'submit did not start' };

  try {
    const tab = await chrome.tabs.create({ url: urls[0], active: true });
    tabId = tab.id;
    await waitForComplete(tabId, 20000);

    const fill = async function () {
      const injected = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: fillSubmitForm,
        args: [pending.code, pending.index, pending.language]
      });
      const outcome = injected && injected[0] ? injected[0].result : null;
      console.log('[cfa] filled form:', JSON.stringify(outcome));
      return outcome;
    };

    let filled = await fill();
    for (let next = 1; next < urls.length && (!filled || !filled.ok); next += 1) {
      console.log('[cfa] no usable form; trying', urls[next]);
      await chrome.tabs.update(tabId, { url: urls[next] });
      // The tab reports the old page as 'complete' for a moment after a
      // navigation is asked for; filling that page would fill the wrong one.
      await sleep(500);
      await waitForComplete(tabId, 20000);
      filled = await fill();
    }

    if (!filled || !filled.ok) {
      throw new Error((filled && filled.reason) || 'could not fill the submit form');
    }

    result = { ok: true, handle: filled.handle || undefined };

    // The tab stays open and focused: the user is about to press Submit in it.
    if (closeAfterSubmit) {
      void closeWhenSubmitted(tabId, previousTab, pending, filled.handle);
    }
  } catch (error) {
    result = { ok: false, reason: error && error.message ? error.message : String(error) };
    if (tabId !== undefined) {
      // Nothing to fill means nothing to press; do not leave a tab behind.
      await chrome.tabs.remove(tabId).catch(function () {});
      if (previousTab !== undefined) {
        await chrome.tabs.update(previousTab, { active: true }).catch(function () {});
      }
    }
  }

  await postJson('/submit-ack', {
    id: pending.id,
    ok: result.ok === true,
    reason: result.reason,
    handle: result.handle || undefined
  }).catch(function () {
    // VS Code went away mid-submit. Nothing useful left to do.
  });
}

/**
 * Close the submit tab once the solution is actually on Codeforces.
 *
 * Watched through the API rather than the page, because the form posts into a
 * hidden frame: the tab looks exactly the same before and after a successful
 * submit. Gives up quietly — a tab left open is a much smaller problem than a
 * tab closed while someone is still typing in it.
 */
async function closeWhenSubmitted(tabId, previousTab, pending, handle) {
  if (!handle) {
    return;
  }
  const notBefore = (pending.queuedAt || Date.now()) - 60000;
  const deadline = Date.now() + WAIT_FOR_USER_MS;

  while (Date.now() < deadline) {
    await sleep(SUBMIT_POLL_MS);
    const stillOpen = await chrome.tabs.get(tabId).catch(function () {
      return null;
    });
    if (!stillOpen) {
      return; // The user closed it, which answers the question.
    }
    if (await landed(handle, pending.contestId, pending.index, notBefore)) {
      console.log('[cfa] submission seen; closing the submit tab');
      await chrome.tabs.remove(tabId).catch(function () {});
      if (previousTab !== undefined) {
        await chrome.tabs.update(previousTab, { active: true }).catch(function () {});
      }
      return;
    }
  }
  console.log('[cfa] no submission after', WAIT_FOR_USER_MS / 1000, 's; leaving the tab open');
}

async function checkPending(force) {
  const now = Date.now();
  if (!force && now - lastPoll < 1500) {
    return;
  }
  lastPoll = now;
  if (inFlight) {
    return;
  }

  let body;
  try {
    body = await api('/pending-submit');
  } catch (error) {
    return; // VS Code is not listening; nothing to do.
  }

  const pending = body && body.pending;
  if (!pending || !pending.id || handled.has(pending.id)) {
    return;
  }

  handled.add(pending.id);
  if (handled.size > 50) {
    handled.clear();
    handled.add(pending.id);
  }

  inFlight = pending.id;
  try {
    await driveSubmit(pending);
  } finally {
    inFlight = null;
  }
}

// ── wiring ─────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  if (message.type === 'tick') {
    void checkPending(false);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'capture') {
    postJson('/capture', message.payload)
      .then(function (body) {
        sendResponse(Object.assign({ ok: true }, body));
      })
      .catch(function (error) {
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === 'status') {
    api('/health')
      .then(function (body) {
        sendResponse({ ok: true, health: body });
      })
      .catch(function (error) {
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  return false;
});

// A slow backstop for the case where no Codeforces tab is open to tick.
chrome.alarms.create('cfa-poll', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'cfa-poll') {
    void checkPending(true);
  }
});
