'use strict';

/**
 * Dashboard NDJSON reporter for Playwright.
 *
 * Writes one JSON object per line to the file named in DASHBOARD_EVENTS_FILE.
 * The dashboard server tails this file for live progress and reads it for
 * history. Plain CommonJS so it loads regardless of the suite's TS setup, and
 * is passed by absolute path via --reporter so the suite is never modified.
 *
 * Setup tests (*.setup.ts/js) are excluded so counts reflect real specs only.
 */

const fs = require('fs');

const ANSI = /\[[0-9;]*m/g;
const SETUP_FILE = /\.setup\.[tj]s$/;

function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI, '') : '';
}

function titleOf(test) {
  try {
    return test.titlePath().filter(Boolean).join(' › ');
  } catch (_) {
    return test.title || '(unknown test)';
  }
}

class DashboardReporter {
  constructor() {
    this.file = process.env.DASHBOARD_EVENTS_FILE || '';
    this.site = process.env.THRIVE_SITE || '';
    this.startTs = Date.now();
  }

  _write(obj) {
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, JSON.stringify(obj) + '\n');
    } catch (_) {
      // Never let reporting break the test run.
    }
  }

  onBegin(_config, suite) {
    let tests = [];
    try {
      tests = suite
        .allTests()
        .filter((t) => !SETUP_FILE.test(t.location ? t.location.file : ''))
        .map((t) => ({
          id: t.id,
          title: titleOf(t),
          file: t.location ? t.location.file : '',
          line: t.location ? t.location.line : 0,
        }));
    } catch (_) {
      tests = [];
    }
    this.startTs = Date.now();
    this._write({ type: 'begin', site: this.site, totalTests: tests.length, ts: this.startTs });
    // Full planned list so the UI can show every test up front (pending →
    // running → result) rather than only revealing tests as they finish.
    this._write({ type: 'plan', site: this.site, tests, ts: this.startTs });
  }

  onTestBegin(test) {
    const file = test.location ? test.location.file : '';
    if (SETUP_FILE.test(file)) return;
    this._write({
      type: 'test-begin',
      site: this.site,
      id: test.id,
      title: titleOf(test),
      file,
      line: test.location ? test.location.line : 0,
      ts: Date.now(),
    });
  }

  onTestEnd(test, result) {
    const file = test.location ? test.location.file : '';
    if (SETUP_FILE.test(file)) return;

    const err =
      result.error && result.error.message
        ? stripAnsi(result.error.message).slice(0, 2000)
        : undefined;

    this._write({
      type: 'test',
      site: this.site,
      id: test.id,
      title: titleOf(test),
      file,
      line: test.location ? test.location.line : 0,
      status: result.status, // passed | failed | timedOut | skipped | interrupted
      durationMs: result.duration || 0,
      retry: result.retry || 0,
      error: err,
      ts: Date.now(),
    });
  }

  onEnd(result) {
    this._write({
      type: 'end',
      site: this.site,
      status: result ? result.status : 'unknown',
      durationMs: Date.now() - this.startTs,
      ts: Date.now(),
    });
  }

  // Quieter stdout; the dashboard reads NDJSON, not console output.
  printsToStdio() {
    return false;
  }
}

module.exports = DashboardReporter;
