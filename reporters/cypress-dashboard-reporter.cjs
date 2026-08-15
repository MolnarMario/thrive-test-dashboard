'use strict';

/**
 * Dashboard NDJSON reporter for Cypress (a plain mocha reporter).
 *
 * Writes the same one-JSON-object-per-line stream as the Playwright reporter,
 * to the file named in DASHBOARD_EVENTS_FILE, so the orchestrator can tail one
 * format regardless of which framework produced it.
 *
 * Two differences from the Playwright reporter, both forced by how Cypress
 * works:
 *
 *   - Cypress constructs a *new* reporter instance per spec file, so this class
 *     can't know the run's total or emit a single `begin`/`plan`. The
 *     orchestrator writes those up front from static discovery instead
 *     (see server/specscan.js). Appending (not truncating) is therefore
 *     essential — every instance writes to the same file.
 *
 *   - Test ids are the full title path rather than an engine-assigned id, which
 *     is what specscan mints for the plan so the two line up.
 *
 * Plain CommonJS, passed by absolute path via --reporter, so the suite under
 * test is never modified and needs no dependency on the dashboard.
 */

const fs = require('fs');

const ANSI = /\[[0-9;]*m/g;

function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI, '') : '';
}

function titleOf(test) {
  try {
    return test.titlePath().filter(Boolean).join(' > ');
  } catch (_) {
    return test.title || '(unknown test)';
  }
}

/** Spec path relative to the suite dir, for display in the UI. */
function fileOf(test) {
  let node = test;
  while (node && !node.file) node = node.parent;
  const file = (node && node.file) || process.env.DASHBOARD_SPEC_FILE || '';
  return String(file).replace(/\\/g, '/');
}

class CypressDashboardReporter {
  constructor(runner) {
    this.file = process.env.DASHBOARD_EVENTS_FILE || '';
    this.site = process.env.DASHBOARD_SITE || '';
    // A test that fails in a `before`/`beforeEach` hook is reported by mocha as
    // a failing *hook*, not a failing test, so track what's in flight to
    // attribute the failure to something the UI can show.
    this.current = null;

    runner.on('test', (test) => this._begin(test));
    runner.on('pass', (test) => this._end(test, 'passed'));
    runner.on('fail', (testOrHook, err) => this._fail(testOrHook, err));
    runner.on('pending', (test) => this._end(test, 'skipped'));
  }

  _write(obj) {
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, JSON.stringify(obj) + '\n');
    } catch (_) {
      // Never let reporting break the test run.
    }
  }

  _begin(test) {
    const title = titleOf(test);
    this.current = title;
    this._write({
      type: 'test-begin',
      site: this.site,
      id: title,
      title,
      file: fileOf(test),
      ts: Date.now(),
    });
  }

  _end(test, status, err) {
    const title = titleOf(test);
    this.current = null;
    this._write({
      type: 'test',
      site: this.site,
      id: title,
      title,
      file: fileOf(test),
      status,
      durationMs: test.duration || 0,
      retry: test.currentRetry ? test.currentRetry() : 0,
      error: err ? stripAnsi(err.message || String(err)).slice(0, 2000) : undefined,
      ts: Date.now(),
    });
  }

  /**
   * `fail` fires for hooks as well as tests. A hook failure aborts the rest of
   * its suite, so report it against the test that was running (if any) and
   * otherwise as a synthetic entry — silently dropping it would leave the Live
   * view showing a test stuck on "running" forever.
   */
  _fail(testOrHook, err) {
    if (testOrHook && testOrHook.type === 'test') {
      this._end(testOrHook, 'failed', err);
      return;
    }
    const hookTitle = titleOf(testOrHook);
    const id = this.current || hookTitle;
    this.current = null;
    this._write({
      type: 'test',
      site: this.site,
      id,
      title: id,
      file: fileOf(testOrHook),
      status: 'failed',
      durationMs: (testOrHook && testOrHook.duration) || 0,
      error:
        `Failed in hook "${hookTitle}":\n` +
        stripAnsi((err && err.message) || String(err)).slice(0, 2000),
      ts: Date.now(),
    });
  }
}

module.exports = CypressDashboardReporter;
