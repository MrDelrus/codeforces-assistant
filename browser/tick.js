// Keeps the service worker awake while a Codeforces tab is open.
//
// MV3 workers are suspended after ~30 seconds idle, and chrome.alarms cannot
// fire more often than once a minute — neither is fast enough for "I pressed
// Submit in VS Code and expect it to land now". A message from a content script
// revives the worker immediately, so this is the wake-up signal.

(function () {
  'use strict';

  const INTERVAL_MS = 2000;

  function tick() {
    try {
      chrome.runtime.sendMessage({ type: 'tick' }, function () {
        // The worker may be mid-restart; lastError is expected and ignored.
        void chrome.runtime.lastError;
      });
    } catch (error) {
      // Extension reloaded or disabled — nothing to do until the page reloads.
    }
  }

  setInterval(tick, INTERVAL_MS);
  tick();
})();
