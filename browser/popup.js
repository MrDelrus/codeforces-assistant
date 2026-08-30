'use strict';

const DEFAULTS = { port: 29617, closeAfterSubmit: true };

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const portInput = document.getElementById('port');
const closeInput = document.getElementById('close');
const captureButton = document.getElementById('capture');
const hint = document.getElementById('hint');
const footer = document.getElementById('footer');

let activeTabId;
let activeTabUrl = '';

/**
 * Talk to the content script, injecting it first if it is not there.
 *
 * A tab that was already open when the extension was installed or reloaded has
 * no content script in it — Chrome only injects on navigation — and every
 * button here then fails with "the page did not answer" for no visible reason.
 * Rather than telling you to reload the page, put the script in and carry on.
 */
function sendToPage(message, done, retried) {
  chrome.tabs.sendMessage(activeTabId, message, function (response) {
    if (!chrome.runtime.lastError) {
      done(response);
      return;
    }
    void chrome.runtime.lastError;

    if (retried || !/^https:\/\/codeforces\.com\//.test(activeTabUrl)) {
      done(null);
      return;
    }
    chrome.scripting.executeScript(
      { target: { tabId: activeTabId }, files: ['parse.js', 'capture.js'] },
      function () {
        if (chrome.runtime.lastError) {
          void chrome.runtime.lastError;
          done(null);
          return;
        }
        sendToPage(message, done, true);
      }
    );
  });
}

function setStatus(state, text, detail) {
  dot.className = 'dot' + (state ? ' ' + state : '');
  statusText.textContent = text;
  footer.textContent = detail || '';
  footer.className = state === 'off' ? 'bad' : '';
}

function refresh() {
  setStatus('', 'Checking…');
  chrome.runtime.sendMessage({ type: 'status' }, function (response) {
    if (chrome.runtime.lastError) {
      setStatus('off', 'Extension not ready', 'Reload the extension.');
      return;
    }
    if (response && response.ok) {
      setStatus('on', 'Connected to VS Code');
      return;
    }
    const reason = (response && response.error) || 'no answer';
    setStatus(
      'off',
      'VS Code not reachable',
      reason + ' — open VS Code and run "Codeforces: Start Capture Server".'
    );
  });
}

// ── the capture button ─────────────────────────────────────────────────────

/**
 * Ask the page what it is showing, so the button can say what it will do
 * before it does it. No answer means no content script on this tab, which is
 * every page that is not a Codeforces problem page.
 */
function describeActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs.length === 0 || tabs[0].id === undefined) {
      return;
    }
    activeTabId = tabs[0].id;
    activeTabUrl = tabs[0].url || '';
    sendToPage({ type: 'describe' }, function (response) {
      if (!response || !response.ok) {
        captureButton.disabled = true;
        captureButton.textContent = 'No contest to capture';
        return;
      }

      captureButton.disabled = false;
      // A contest is captured whole; a bare problem page, only that problem.
      captureButton.textContent =
        response.deferred || response.count > 1
          ? 'Capture contest ' + response.contestId
          : 'Capture problem ' + response.contestId + response.first;
    });
  });
}

captureButton.addEventListener('click', function () {
  if (activeTabId === undefined) {
    return;
  }
  const label = captureButton.textContent;
  captureButton.disabled = true;
  captureButton.textContent = 'Capturing…';

  sendToPage({ type: 'capture-command' }, function (response) {
    captureButton.textContent = label;
    captureButton.disabled = false;

    if (!response) {
      hint.textContent = 'The page did not answer. Reload it and try again.';
      hint.className = 'hint bad';
      return;
    }
    hint.textContent = (response && response.message) || 'Done.';
    hint.className = response && response.ok ? 'hint good' : 'hint bad';
  });
});

// ── settings ───────────────────────────────────────────────────────────────

chrome.storage.local.get(DEFAULTS, function (stored) {
  portInput.value = stored.port;
  closeInput.checked = stored.closeAfterSubmit !== false;
  describeActiveTab();
  refresh();
});

portInput.addEventListener('change', function () {
  const value = Number(portInput.value);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    portInput.value = DEFAULTS.port;
    return;
  }
  chrome.storage.local.set({ port: value }, refresh);
});

closeInput.addEventListener('change', function () {
  chrome.storage.local.set({ closeAfterSubmit: closeInput.checked });
});
