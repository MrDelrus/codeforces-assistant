// Panel renderer. Everything the extension sends is inserted with textContent,
// never innerHTML — problem names and program output are untrusted text.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  /** Test cards the user expanded, kept across re-renders. */
  const opened = new Set();
  /** Tests we auto-expanded, so a later pass can close them again. */
  let autoOpened = -1;
  let state = null;
  /** The "add test" form, kept across re-renders so typing is never thrown away. */
  const draft = { open: false, input: '', expected: '' };
  /** The gear screen. Opened and closed from the gear in the title bar. */
  let settingsOpen = false;
  /**
   * Edits made in the settings screen, held here until Done.
   *
   * Nothing is written while you type. Done applies it; Cancel and the gear
   * both throw it away, so a half-considered number never survives to greet you
   * the next time the screen is opened.
   */
  let draftSettings = null;

  const STATUS_TEXT = {
    pending: 'not run',
    running: 'running…',
    passed: 'passed',
    wrong: 'wrong answer',
    timeout: 'time limit',
    error: 'runtime error'
  };

  const TAB_TITLE = {
    solved: 'solved',
    attempted: 'submitted, not accepted',
    untouched: 'no submission yet'
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function send(type, extra) {
    vscode.postMessage(Object.assign({ type }, extra || {}));
  }

  /** Codeforces reports bytes; nobody reads a memory limit in bytes. */
  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) {
      return '';
    }
    if (bytes < 1024) {
      return bytes + ' B';
    }
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return (value >= 100 ? Math.round(value) : Number(value.toFixed(1))) + ' ' + units[unit];
  }

  function formatMs(ms) {
    if (typeof ms !== 'number') {
      return '';
    }
    return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s';
  }

  // Tab strip: one small square per problem of the contest, coloured by what
  // Codeforces says about this handle. Clicking one opens that solution file,
  // which is the whole point — no trip to the explorer.
  function renderTabs(tabs) {
    if (!tabs || tabs.length === 0) {
      return null;
    }
    const strip = el('div', 'tabs');
    tabs.forEach(function (tab) {
      const button = el('button', 'tab ' + tab.status, tab.index);
      if (tab.active) {
        button.classList.add('active');
      }
      button.title = tab.id + (tab.name ? ' \u2014 ' + tab.name : '') + '\n' + TAB_TITLE[tab.status];
      button.addEventListener('click', function () {
        send('openIndex', { index: tab.index });
      });
      strip.append(button);
    });
    return strip;
  }

  function renderHeader(problem) {
    const header = el('div', 'header');

    const titleRow = el('div', 'title-row');
    titleRow.append(el('span', 'pid', problem.id));
    titleRow.append(el('span', 'pname', problem.name));
    header.append(titleRow);

    const chips = el('div', 'chips');
    if (problem.timeLimit) {
      chips.append(el('span', 'chip', problem.timeLimit));
    }
    if (problem.memoryLimit) {
      chips.append(el('span', 'chip', problem.memoryLimit));
    }
    header.append(chips);

    return header;
  }

  function renderToolbar(run, verdict, hasProblem) {
    const bar = el('div', 'toolbar');

    const busy = run.phase === 'compiling' || run.phase === 'running';
    const runBtn = el('button', 'primary', busy ? 'Running…' : 'Run All');
    runBtn.disabled = !hasProblem || busy;
    runBtn.addEventListener('click', () => send('run'));

    // 'filled' counts as busy: the form is already open in the browser, and a
    // second Submit here would open a second tab.
    const submitting = isWorking(verdict.phase) || verdict.phase === 'filled';
    const submitBtn = el('button', 'ghost', submitting ? 'In browser…' : 'Submit');
    submitBtn.disabled = !hasProblem || submitting;
    submitBtn.addEventListener('click', () => send('submit'));

    bar.append(runBtn, submitBtn);
    return bar;
  }

  function verdictTone(verdict) {
    if (verdict.phase === 'failed') {
      return 'bad';
    }
    if (verdict.phase === 'cancelled') {
      return 'quiet';
    }
    if (verdict.phase === 'final') {
      return verdict.verdict === 'OK' ? 'ok' : 'bad';
    }
    if (verdict.phase === 'filled') {
      return 'ready';
    }
    return 'busy';
  }

  /**
   * Phases where something is actually happening. 'filled' is not one of them:
   * the form is sitting in the browser waiting for a person, and a spinner
   * there would promise progress that is not coming.
   */
  function isWorking(phase) {
    return phase === 'queued' || phase === 'sent' || phase === 'waiting' || phase === 'judging';
  }

  function renderVerdict(verdict) {
    if (!verdict || verdict.phase === 'idle') {
      return null;
    }

    const banner = el('div', 'banner ' + verdictTone(verdict));
    if (isWorking(verdict.phase)) {
      banner.append(el('div', 'spinner'));
    }

    // One line: verdict, time, memory. The submission id was noise — the panel
    // is not where you look one up, and it pushed the numbers onto a second row.
    const bits = [verdict.message || 'Submitted'];
    if (verdict.phase === 'final') {
      if (typeof verdict.timeConsumedMillis === 'number') {
        bits.push(verdict.timeConsumedMillis + ' ms');
      }
      if (typeof verdict.memoryConsumedBytes === 'number') {
        bits.push(formatBytes(verdict.memoryConsumedBytes));
      }
    }

    const body = el('div', 'banner-body');
    body.append(el('div', 'banner-title', bits.join(' · ')));
    banner.append(body);

    // A submit waiting on the browser can be called off from here, which is the
    // only way to get the Submit button back without restarting anything.
    if (isWorking(verdict.phase) || verdict.phase === 'filled') {
      const cancel = el('span', 'remove', '×');
      cancel.title = 'Cancel this submit';
      cancel.addEventListener('click', function () {
        send('cancelSubmit');
      });
      banner.append(cancel);
    }

    return banner;
  }

  function renderCompile(run) {
    if (run.phase !== 'failed' || !run.compileOutput) {
      return null;
    }
    const box = el('div', 'compile');
    box.append(el('div', 'compile-head', 'Compilation failed'));
    box.append(el('pre', null, run.compileOutput));
    return box;
  }

  function ioBlock(label, text, bad) {
    const wrap = el('div');
    wrap.append(el('div', 'io-label', label));
    wrap.append(el('pre', 'io' + (bad ? ' bad' : ''), text && text.length ? text : '(empty)'));
    return wrap;
  }

  function textarea(key, value, placeholder) {
    const box = document.createElement('textarea');
    box.className = 'draft-box';
    box.rows = 4;
    box.spellcheck = false;
    box.value = value;
    box.placeholder = placeholder;
    // Re-rendering rebuilds every node, so the caret has to be put back by
    // hand; this key is how the new node is matched to the old one.
    box.dataset.key = key;
    return box;
  }

  // Add-test form: input on top, expected output below, the same way a
  // Codeforces sample reads.
  function renderDraft() {
    const wrap = el('div', 'draft');

    if (!draft.open) {
      const add = el('button', 'ghost wide', '+ Add test');
      add.addEventListener('click', function () {
        draft.open = true;
        render();
        focus('draft-input');
      });
      wrap.append(add);
      return wrap;
    }

    const input = textarea('draft-input', draft.input, 'Input');
    const expected = textarea('draft-expected', draft.expected, 'Expected output');
    input.addEventListener('input', function () {
      draft.input = input.value;
    });
    expected.addEventListener('input', function () {
      draft.expected = expected.value;
    });

    wrap.append(el('div', 'io-label', 'Input'));
    wrap.append(input);
    wrap.append(el('div', 'io-label', 'Expected'));
    wrap.append(expected);

    const buttons = el('div', 'toolbar');
    const save = el('button', 'primary', 'Add test');
    save.disabled = draft.input.trim() === '' && draft.expected.trim() === '';
    save.addEventListener('click', function () {
      send('addTest', { input: draft.input, expected: draft.expected });
      draft.open = false;
      draft.input = '';
      draft.expected = '';
      render();
    });
    const cancel = el('button', 'ghost', 'Cancel');
    cancel.addEventListener('click', function () {
      draft.open = false;
      draft.input = '';
      draft.expected = '';
      render();
    });
    buttons.append(save, cancel);
    wrap.append(buttons);

    return wrap;
  }

  function renderTest(result) {
    const card = el('div', 'test');
    if (opened.has(result.number)) {
      card.classList.add('open');
    }

    const head = el('div', 'test-head');
    head.append(el('span', 'dot ' + result.status));
    head.append(el('span', 'test-name', 'Test ' + result.number));
    if (result.custom) {
      head.append(el('span', 'chip', 'yours'));
    }
    head.append(el('span', 'test-status', STATUS_TEXT[result.status] || result.status));
    if (result.status !== 'pending') {
      head.append(el('span', 'test-time', formatMs(result.durationMs)));
    }
    if (result.custom) {
      const remove = el('span', 'remove', '×');
      remove.title = 'Delete this test';
      remove.addEventListener('click', function (event) {
        // Without this the click would also toggle the card open.
        event.stopPropagation();
        send('removeTest', { number: result.number });
      });
      head.append(remove);
    }
    head.append(el('span', 'caret', '▸'));
    head.addEventListener('click', () => {
      if (opened.has(result.number)) {
        opened.delete(result.number);
      } else {
        opened.add(result.number);
      }
      render();
    });
    card.append(head);

    const body = el('div', 'test-body');
    body.append(ioBlock('Input', result.input));

    const pair = el('div', 'io-pair');
    pair.append(ioBlock('Expected', result.expected));
    pair.append(ioBlock('Received', result.actual, result.status === 'wrong'));
    body.append(pair);

    if (result.status === 'wrong' && result.firstDiffLine) {
      body.append(el('div', 'diff-note', 'First difference on line ' + result.firstDiffLine));
    }
    if (result.status === 'timeout') {
      body.append(el('div', 'diff-note', 'Killed at the local time limit.'));
    }
    if (result.status === 'error' && result.exitCode !== null) {
      body.append(el('div', 'diff-note', 'Exited with code ' + result.exitCode));
    }
    if (result.stderr) {
      body.append(ioBlock('stderr', result.stderr, true));
    }

    card.append(body);
    return card;
  }

  function numberField(key, value, least, placeholder, onCommit) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'field';
    input.min = String(least);
    input.value = String(value);
    input.placeholder = placeholder || '';
    input.title = placeholder || '';
    input.dataset.key = key;
    // Straight into the draft, which is not saved anywhere until Done — so a
    // half-typed "3" of "312" costs nothing.
    input.addEventListener('input', function () {
      const value = Number(input.value);
      onCommit(Number.isFinite(value) ? value : 0);
    });
    return input;
  }

  function settingsRow(label, control, note) {
    const row = el('div', 'set-row');
    row.append(el('div', 'set-label', label));
    row.append(control);
    if (note) {
      row.append(el('div', 'set-note', note));
    }
    return row;
  }

  function renderSettings(settings) {
    if (!draftSettings) {
      draftSettings = {
        cursorLine: settings.cursorLine || 0,
        cursorCharacter: settings.cursorCharacter || 0,
        port: settings.port || 0
      };
    }
    const draft = draftSettings;
    const box = el('div', 'settings');

    box.append(el('div', 'section-label', 'Settings'));

    // ── template ──────────────────────────────────────────────────────────
    // An action, not a field: it opens a dialog and takes the copy there and
    // then, so there is nothing about it for Done or Cancel to decide.
    const browse = el('button', 'ghost wide', 'Choose template file…');
    browse.addEventListener('click', function () {
      send('browseTemplate');
    });
    box.append(
      settingsRow(
        'Solution template',
        browse,
        settings.template
          ? (settings.templateLocal ? 'Using the copy: ' : 'Using: ') + settings.template
          : 'None chosen — new files start from the built-in starter.'
      )
    );
    if (settings.templateError) {
      box.append(el('div', 'set-error', settings.templateError));
    } else if (settings.templateLocal) {
      box.append(
        el(
          'div',
          'set-note',
          'This is a copy. Editing the file it came from changes nothing here — ' +
            'delete the copy and choose again to replace it.'
        )
      );
    }

    // ── cursor ────────────────────────────────────────────────────────────
    const cursor = el('div', 'set-pair');
    cursor.append(
      numberField('cursor-line', draft.cursorLine, 1, 'Line', function (value) {
        draft.cursorLine = value;
      })
    );
    cursor.append(
      numberField('cursor-character', draft.cursorCharacter, 0, 'Shift', function (value) {
        draft.cursorCharacter = value;
      })
    );
    box.append(
      settingsRow(
        'Cursor line and shift',
        cursor,
        'Where the caret lands when a solution is opened. Lines count from 1, ' +
          'the shift along the line from 0.'
      )
    );

    // ── port ──────────────────────────────────────────────────────────────
    box.append(
      settingsRow(
        'Capture port',
        numberField('port', draft.port, 1024, 'Port', function (value) {
          draft.port = value;
        }),
        'Must match the port in the browser extension popup.'
      )
    );

    const buttons = el('div', 'toolbar');
    const cancel = el('button', 'ghost', 'Cancel');
    cancel.addEventListener('click', function () {
      draftSettings = null;
      settingsOpen = false;
      render();
    });
    const done = el('button', 'primary', 'Done');
    done.addEventListener('click', function () {
      send('applySettings', {
        line: draft.cursorLine,
        character: draft.cursorCharacter,
        port: draft.port
      });
      draftSettings = null;
      settingsOpen = false;
      render();
    });
    buttons.append(cancel, done);
    box.append(buttons);

    return box;
  }

  function renderFooter(server, handle) {
    const footer = el('div', 'footer');
    const dot = el('span', 'status-dot' + (server.listening ? ' on' : ''));
    footer.append(dot);

    let text;
    if (server.listening) {
      text = 'Listening on 127.0.0.1:' + server.port;
    } else if (server.conflict) {
      text = 'Port busy — another window owns capture';
    } else {
      text = 'Capture server stopped';
    }
    footer.append(el('span', null, text));
    footer.append(el('span', 'grow'));

    const handleLink = el('a', null, handle ? '@' + handle : 'set handle');
    handleLink.title = 'Codeforces handle used to poll verdicts';
    handleLink.addEventListener('click', () => send('handle'));
    footer.append(handleLink);

    return footer;
  }

  function autoExpandFailure(results) {
    const failed = results.find(function (r) {
      return r.status === 'wrong' || r.status === 'timeout' || r.status === 'error';
    });
    if (!failed) {
      if (autoOpened >= 0) {
        opened.delete(autoOpened);
        autoOpened = -1;
      }
      return;
    }
    if (autoOpened !== failed.number) {
      if (autoOpened >= 0) {
        opened.delete(autoOpened);
      }
      opened.add(failed.number);
      autoOpened = failed.number;
    }
  }

  /** Which textarea had the caret, and where, before the tree was rebuilt. */
  function captureFocus() {
    const active = document.activeElement;
    if (!active || !active.dataset || !active.dataset.key) {
      return null;
    }
    return {
      key: active.dataset.key,
      start: active.selectionStart,
      end: active.selectionEnd
    };
  }

  function restoreFocus(saved) {
    if (!saved) {
      return;
    }
    const node = root.querySelector('[data-key="' + saved.key + '"]');
    if (!node) {
      return;
    }
    node.focus();
    if (typeof saved.start === 'number') {
      node.setSelectionRange(saved.start, saved.end);
    }
  }

  function focus(key) {
    const node = root.querySelector('[data-key="' + key + '"]');
    if (node) {
      node.focus();
    }
  }

  function render() {
    if (!state) {
      return;
    }
    // The progress poll re-renders every ten seconds. Without this, typing a
    // test would lose the caret mid-word.
    const saved = captureFocus();
    root.textContent = '';

    const { problem, tabs, run, verdict, server, handle, hint, settings } = state;

    if (settingsOpen) {
      root.append(renderSettings(settings || {}));
      root.append(renderFooter(server, handle));
      restoreFocus(saved);
      return;
    }

    const strip = renderTabs(tabs);
    if (strip) {
      root.append(strip);
    }

    if (!problem) {
      const empty = el('div', 'empty');
      empty.append(document.createTextNode(hint || 'No problem selected.'));
      empty.append(document.createElement('br'));
      const code = el('code', null, 'contests/2050/2050A.cpp');
      empty.append(document.createTextNode('Open a captured solution, such as '));
      empty.append(code);
      empty.append(document.createTextNode('.'));
      root.append(empty);
      root.append(renderFooter(server, handle));
      restoreFocus(saved);
      return;
    }

    root.append(renderHeader(problem));
    root.append(renderToolbar(run, verdict, true));

    const banner = renderVerdict(verdict);
    if (banner) {
      root.append(banner);
    }

    const compile = renderCompile(run);
    if (compile) {
      root.append(compile);
    }

    const results = run.results || [];
    const label = el('div', 'section-label');
    label.append(el('span', null, 'Samples'));
    if (results.length > 0) {
      const passed = results.filter(function (r) {
        return r.status === 'passed';
      }).length;
      label.append(el('span', null, passed + ' / ' + results.length + ' passed'));
    }
    root.append(label);

    if (results.length === 0) {
      root.append(
        el(
          'div',
          'empty',
          'No samples were captured for this problem. Re-capture from the contest page.'
        )
      );
    } else {
      autoExpandFailure(results);
      const list = el('div', 'tests');
      results.forEach(function (result) {
        list.append(renderTest(result));
      });
      root.append(list);
    }

    root.append(renderDraft());
    root.append(renderFooter(server, handle));
    restoreFocus(saved);
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message && message.type === 'state') {
      state = message.state;
      render();
      return;
    }
    if (message && message.type === 'toggleSettings') {
      // The same gear closes it again, and closing keeps nothing: an unapplied
      // edit must not be waiting there the next time it is opened.
      settingsOpen = !settingsOpen;
      draftSettings = null;
      render();
    }
  });

  send('ready');
})();
