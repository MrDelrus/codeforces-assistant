// Codeforces DOM -> capture payload. Pure functions, no chrome APIs, no
// network: this file is loaded both as a content script and by the parser tests
// in tools/parser-test.js, which run it against saved markup.

(function (root) {
  'use strict';

  /**
   * Text of a <pre> holding sample data.
   *
   * Codeforces serves these two ways. Usually it is plain text with <br>. For
   * problems that pack several tests into one file it is one
   * <div class="test-example-line-N"> per line, plus "-op" rows that are an
   * ellipsis Codeforces draws between tests — presentation, not data.
   */
  function preText(pre) {
    const lineNodes = pre.querySelectorAll('.test-example-line');
    if (lineNodes.length > 0) {
      const lines = [];
      lineNodes.forEach(function (node) {
        if (/\btest-example-line-op\b/.test(node.className)) {
          return;
        }
        lines.push(node.textContent || '');
      });
      return lines.join('\n');
    }

    let out = '';
    pre.childNodes.forEach(function (node) {
      if (node.nodeType === 3) {
        out += node.textContent || '';
      } else if (node.nodeName === 'BR') {
        out += '\n';
      } else {
        out += node.textContent || '';
        if (node.nodeName === 'DIV' || node.nodeName === 'P') {
          out += '\n';
        }
      }
    });
    return out;
  }

  function tidy(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '');
  }

  /** A `.time-limit` block without its "time limit per test" label. */
  function propertyValue(root_, selector) {
    const node = root_.querySelector(selector);
    if (!node) {
      return '';
    }
    const clone = node.cloneNode(true);
    const label = clone.querySelector('.property-title');
    if (label) {
      label.remove();
    }
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function samplesFrom(statement) {
    const block = statement.querySelector('.sample-tests');
    if (!block) {
      return [];
    }
    const samples = [];
    block.querySelectorAll('.sample-test').forEach(function (group) {
      const inputs = group.querySelectorAll(':scope > .input > pre');
      const outputs = group.querySelectorAll(':scope > .output > pre');
      const pairs = Math.min(inputs.length, outputs.length);
      for (let i = 0; i < pairs; i += 1) {
        samples.push({
          input: tidy(preText(inputs[i])),
          output: tidy(preText(outputs[i]))
        });
      }
    });
    return samples;
  }

  /** "A. Two Buttons" -> { index: "A", name: "Two Buttons" } */
  function splitTitle(title) {
    const match = /^\s*([A-Za-z][0-9]{0,2})\s*\.\s*(.+)$/.exec(title || '');
    if (!match) {
      return { index: '', name: String(title || '').trim() };
    }
    return { index: match[1].toUpperCase(), name: match[2].trim() };
  }

  function parseProblem(holder) {
    const statement = holder.querySelector('.problem-statement') || holder;
    const titleNode = statement.querySelector('.header .title');
    const split = splitTitle(titleNode ? titleNode.textContent : '');

    const attribute = (holder.getAttribute('problemindex') || '').trim().toUpperCase();
    const index = /^[A-Z][0-9]{0,2}$/.test(attribute) ? attribute : split.index;
    if (!index) {
      return null;
    }

    return {
      index: index,
      name: split.name || index,
      timeLimit: propertyValue(statement, '.time-limit'),
      memoryLimit: propertyValue(statement, '.memory-limit'),
      samples: samplesFrom(statement)
    };
  }

  function contestIdFromPath(pathname) {
    const byContest = /\/contest\/(\d+)/.exec(pathname || '');
    if (byContest) {
      return Number(byContest[1]);
    }
    const byProblemset = /\/problemset\/problem\/(\d+)\//.exec(pathname || '');
    if (byProblemset) {
      return Number(byProblemset[1]);
    }
    return 0;
  }

  function contestName(doc, contestId) {
    const link = doc.querySelector('#sidebar .rtable th a[href^="/contest/"]');
    if (link && (link.textContent || '').trim()) {
      return link.textContent.trim();
    }
    const title = String(doc.title || '')
      .replace(/\s*-\s*Codeforces\s*$/i, '')
      .replace(/^\s*Problems\s*-\s*/i, '')
      .trim();
    return title || 'Contest ' + contestId;
  }

  function loggedInHandle(doc) {
    const link = doc.querySelector(
      '#header a[href^="/profile/"], .lang-chooser a[href^="/profile/"]'
    );
    if (!link) {
      return '';
    }
    const match = /\/profile\/([^/?#]+)/.exec(link.getAttribute('href') || '');
    return match ? decodeURIComponent(match[1]) : '';
  }

  /**
   * Build the payload for whatever this page is showing: a single problem, or
   * every problem on a `/contest/N/problems` page. Returns null when there is
   * nothing recognisable.
   */
  function collect(doc, pathname) {
    const contestId = contestIdFromPath(pathname);
    if (!contestId) {
      return null;
    }

    const holders = doc.querySelectorAll('.problemindexholder');
    const nodes = holders.length > 0 ? holders : doc.querySelectorAll('.problem-statement');

    const problems = [];
    nodes.forEach(function (node) {
      const parsed = parseProblem(node);
      if (parsed) {
        parsed.url = 'https://codeforces.com/contest/' + contestId + '/problem/' + parsed.index;
        problems.push(parsed);
      }
    });

    if (problems.length === 0) {
      return null;
    }

    const payload = {
      contestId: contestId,
      contestName: contestName(doc, contestId),
      url: 'https://codeforces.com/contest/' + contestId,
      problems: problems
    };
    const handle = loggedInHandle(doc);
    if (handle) {
      payload.handle = handle;
    }
    return payload;
  }

  /**
   * What to do about the page you are on.
   *
   *   page   the statements are right here — a problem page, or a contest's
   *          complete problemset page. Capture from what is loaded.
   *   fetch  a page inside a contest that carries no statements at all: the
   *          contest's own front page, standings, the submit form. The contest
   *          is known, the problems are not, so they have to be read off
   *          /contest/N/problems.
   *
   * Deciding this here, rather than in the content script, is what lets it be
   * tested: `plan` is pure, and the fetch it asks for is one line of caller.
   */
  function plan(doc, pathname) {
    const payload = collect(doc, pathname);
    if (payload) {
      return { kind: 'page', payload: payload };
    }
    const contestId = contestIdFromPath(pathname);
    if (!contestId) {
      return null;
    }
    return {
      kind: 'fetch',
      contestId: contestId,
      url: 'https://codeforces.com/contest/' + contestId + '/problems'
    };
  }

  const api = {
    collect: collect,
    plan: plan,
    parseProblem: parseProblem,
    preText: preText,
    splitTitle: splitTitle,
    contestIdFromPath: contestIdFromPath,
    tidy: tidy
  };

  root.CFAParse = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
