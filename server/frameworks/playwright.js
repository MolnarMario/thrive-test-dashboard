'use strict';

/**
 * Playwright adapter.
 *
 * The reference implementation: Playwright can enumerate its own tests
 * (`--list`), emits its own NDJSON via reporters/dashboard-reporter.cjs, and
 * writes a rich HTML report we can serve for trace/screenshot drill-down. The
 * other adapters exist to make their frameworks look like this one.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const specscan = require('../specscan');

/** Suite layouts we know how to drive, most specific first. */
const LAYOUTS = [
  { configFile: '.playwright/playwright.config.ts', testsRoot: '.playwright/tests' },
  { configFile: 'playwright.config.ts', testsRoot: 'tests' },
  { configFile: 'playwright.config.js', testsRoot: 'tests' },
];

const SPEC_RE = /\.spec\.[tj]s$/;

// "… › <path>.spec.ts:<line>:<col> …" from `playwright test --list`.
const LIST_LINE_RE = /›\s+(.+?\.spec\.[tj]s):(\d+):\d+\s*›\s*(.*)$/;

function detect(suiteDir) {
  for (const layout of LAYOUTS) {
    if (fs.existsSync(path.join(suiteDir, layout.configFile))) {
      return { ok: true, ...layout };
    }
  }
  return {
    ok: false,
    ...LAYOUTS[1],
    reason: `No playwright.config.ts found in ${suiteDir}`,
  };
}

function cliPath(suiteDir) {
  return path.join(suiteDir, 'node_modules', '@playwright', 'test', 'cli.js');
}

function checkTooling(suiteDir) {
  const cli = cliPath(suiteDir);
  return fs.existsSync(cli)
    ? { ok: true, message: 'Playwright CLI found', detail: cli }
    : {
        ok: false,
        message: 'Playwright CLI not found — run `npm install` in the suite',
        detail: cli,
      };
}

/** Positional filter Playwright matches as a substring of the full spec path. */
function filterFor(layout, p) {
  const rel = String(p || '').replace(/\\/g, '/');
  const root = layout.testsRoot.replace(/\\/g, '/');
  return rel ? `${root}/${rel}` : `${root}/`;
}

/**
 * Enumerate tests with Playwright's own collection, which is authoritative:
 * it accounts for describe loops, parameterised tests and project matrices that
 * no static scan can resolve. Falls back to a static scan when the CLI is
 * missing or `--list` fails, so the tree still renders something useful.
 */
function discover(suiteDir, layout) {
  const cli = cliPath(suiteDir);
  const testsRootAbs = path.join(suiteDir, layout.testsRoot);

  if (!fs.existsSync(cli)) return Promise.resolve(staticDiscover(testsRootAbs));

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [cli, 'test', `--config=${layout.configFile}`, '--list'],
      { cwd: suiteDir, env: { ...process.env }, windowsHide: true }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(staticDiscover(testsRootAbs)));
    child.on('close', () => {
      const parsed = parseList(out, layout);
      resolve(parsed.length ? { files: parsed, exact: true } : staticDiscover(testsRootAbs));
    });
  });
}

function parseList(stdout, layout) {
  const root = layout.testsRoot.replace(/\\/g, '/') + '/';
  const byFile = new Map();
  for (const raw of stdout.split('\n')) {
    const m = raw.match(LIST_LINE_RE);
    if (!m) continue;
    let file = m[1].trim().replace(/\\/g, '/');
    if (file.startsWith(root)) file = file.slice(root.length);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ title: m[3].trim(), line: Number(m[2]) });
  }
  return [...byFile.entries()].map(([file, tests]) => ({ file, tests }));
}

function staticDiscover(testsRootAbs) {
  const files = specscan.findSpecFiles(testsRootAbs, SPEC_RE).map((file) => ({
    file,
    tests: specscan.scanFile(path.join(testsRootAbs, file)),
  }));
  return { files, exact: false };
}

function buildRun(ctx) {
  const { suiteDir, layout, paths, grep, ndjsonFile, reportDir, outputDir, reporterPath } = ctx;
  const args = [
    cliPath(suiteDir),
    'test',
    `--config=${layout.configFile}`,
    `--reporter=line,html,${reporterPath}`,
    `--output=${outputDir}`,
    ...(paths.length ? paths.map((p) => filterFor(layout, p)) : [filterFor(layout, '')]),
  ];
  if (grep) args.push(`--grep=${grep}`);

  return {
    command: process.execPath,
    args,
    cwd: suiteDir,
    env: {
      // Our CLI `--reporter=…,html,…` overrides the suite config's reporter
      // (including its `open:'never'`), and a CLI html reporter defaults to
      // `open:'on-failure'` — which serves the report and blocks on "Press
      // Ctrl+C to quit" forever, so a failed run would never finalize.
      // (Not CI=1 — that would also enable retries and break the
      // one-event-per-test assumption the live counts rely on.)
      PLAYWRIGHT_HTML_OPEN: 'never',
      PLAYWRIGHT_HTML_REPORT: reportDir,
      DASHBOARD_EVENTS_FILE: ndjsonFile,
    },
  };
}

/**
 * Suites that log in from Playwright's `globalSetup` have no auth.setup.ts, in
 * which case the orchestrator skips its auth phase entirely.
 */
function buildAuth(ctx) {
  const { suiteDir, layout, authLog, reporterPath } = ctx;
  const rel = path.join(layout.testsRoot, 'auth.setup.ts');
  if (!fs.existsSync(path.join(suiteDir, rel))) return null;
  void authLog;
  void reporterPath;
  return {
    command: process.execPath,
    args: [
      cliPath(suiteDir),
      'test',
      `--config=${layout.configFile}`,
      '--reporter=line',
      filterFor(layout, 'auth.setup.ts'),
    ],
    cwd: suiteDir,
    env: {},
  };
}

module.exports = {
  id: 'playwright',
  label: 'Playwright',
  language: 'TypeScript',
  specLabel: '*.spec.ts',
  runner: 'Playwright Test',
  specRe: SPEC_RE,
  supportsGrep: true,
  // Playwright's reporter writes `begin` + `plan` itself, from the real
  // collected test list.
  emitsPlan: true,
  reportKind: 'html',
  detect,
  checkTooling,
  discover,
  buildRun,
  buildAuth,
};
