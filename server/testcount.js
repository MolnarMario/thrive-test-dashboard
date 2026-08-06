'use strict';

/**
 * Per-spec test counts via Playwright's own collection (`playwright test --list`).
 *
 * A spec file can hold many tests (describe blocks, multiple test() calls,
 * etc.), so the file count ≠ the number of tests that will run. `--list`
 * collects every test without running anything (~6s for the whole ~1000-file
 * suite), which is the authoritative count. We parse one line per test:
 *
 *   [chromium] › site-a\Admin\foo.spec.ts:9:6 › Suite › test title
 *
 * and bucket by file. Keys are normalised to match the tree's file `filter`
 * (`tests/<dir>/.../<file>.spec.ts`) so the tree can attach counts directly.
 *
 * Cached; recomputed on refresh (the UI's "Rescan" button), so adding/removing
 * spec files re-counts on the next rescan.
 */

const { spawn } = require('child_process');
const { SUITE_DIR, PLAYWRIGHT_CONFIG, PLAYWRIGHT_CLI, SITES } = require('../config');

// Matches "… › <path>.spec.ts:<line>:<col> …" and captures the file path.
const LINE_RE = /›\s+(.+?\.spec\.[tj]s):\d+:\d+/;

let cache = null;     // { counts, total, ok, builtAt }
let inflight = null;

function parse(stdout) {
  const counts = Object.create(null);
  let total = 0;
  for (const raw of stdout.split('\n')) {
    const m = raw.match(LINE_RE);
    if (!m) continue;
    // Path is relative to the tests root (e.g. "site-a\Admin\foo.spec.ts");
    // the tree's file filter is "tests/" + that, with forward slashes.
    const key = 'tests/' + m[1].trim().replace(/\\/g, '/');
    counts[key] = (counts[key] || 0) + 1;
    total += 1;
  }
  return { counts, total, ok: total > 0 };
}

function runList() {
  return new Promise((resolve) => {
    // TEST_SITE just satisfies the suite config during collection; which
    // tests exist doesn't depend on it, so one list covers every site.
    const site = Object.keys(SITES)[0] || 'site-a';
    const child = spawn(
      process.execPath,
      [PLAYWRIGHT_CLI, 'test', `--config=${PLAYWRIGHT_CONFIG}`, '--list'],
      { cwd: SUITE_DIR, env: { ...process.env, TEST_SITE: site }, windowsHide: true }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve({ counts: Object.create(null), total: 0, ok: false }));
    child.on('close', () => resolve(parse(out)));
  });
}

/** Get the file→testCount map (cached). Pass {refresh:true} to recompute. */
async function getCounts({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  if (inflight && !refresh) return inflight;
  inflight = runList()
    .then((r) => { cache = { ...r, builtAt: Date.now() }; inflight = null; return cache; })
    .catch(() => { inflight = null; return { counts: Object.create(null), total: 0, ok: false }; });
  return inflight;
}

module.exports = { getCounts, _parse: parse };
