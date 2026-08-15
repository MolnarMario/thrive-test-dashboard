'use strict';

/**
 * Cypress adapter.
 *
 * Cypress differs from Playwright in three ways that matter here:
 *
 *   - No "collect without running" mode, so the tree's test counts and the
 *     up-front `plan` come from a static scan of the specs (server/specscan.js).
 *   - Its reporters are plain mocha reporters, constructed once per spec file,
 *     so reporters/cypress-dashboard-reporter.cjs only emits per-test events and
 *     the orchestrator writes `begin`/`plan` from the scan.
 *   - No CLI equivalent of `--grep`; test selection is per spec file only.
 *
 * Everything else — live per-test progress, failure messages, screenshots on
 * failure — behaves like the Playwright suite from the dashboard's side.
 */

const fs = require('fs');
const path = require('path');

const specscan = require('../specscan');

const LAYOUTS = [
  { configFile: 'cypress.config.ts', testsRoot: 'cypress/e2e' },
  { configFile: 'cypress.config.js', testsRoot: 'cypress/e2e' },
  { configFile: 'cypress.config.mjs', testsRoot: 'cypress/e2e' },
];

const SPEC_RE = /\.cy\.[tj]sx?$/;

function detect(suiteDir) {
  for (const layout of LAYOUTS) {
    if (fs.existsSync(path.join(suiteDir, layout.configFile))) {
      // Honour an integration-style layout if that's what's on disk.
      const testsRoot = fs.existsSync(path.join(suiteDir, 'cypress', 'e2e'))
        ? 'cypress/e2e'
        : 'cypress/integration';
      return { ok: true, ...layout, testsRoot };
    }
  }
  return {
    ok: false,
    ...LAYOUTS[0],
    reason: `No cypress.config.ts found in ${suiteDir}`,
  };
}

function cliPath(suiteDir) {
  return path.join(suiteDir, 'node_modules', 'cypress', 'bin', 'cypress');
}

function checkTooling(suiteDir) {
  const cli = cliPath(suiteDir);
  return fs.existsSync(cli)
    ? { ok: true, message: 'Cypress CLI found', detail: cli }
    : {
        ok: false,
        message: 'Cypress CLI not found — run `npm install` in the suite',
        detail: cli,
      };
}

function discover(suiteDir, layout) {
  const testsRootAbs = path.join(suiteDir, layout.testsRoot);
  const files = specscan.findSpecFiles(testsRootAbs, SPEC_RE).map((file) => ({
    file,
    tests: specscan.scanFile(path.join(testsRootAbs, file)),
  }));
  return Promise.resolve({ files, exact: false });
}

/**
 * `--spec` takes comma-separated globs relative to the suite dir. A selected
 * directory becomes a recursive glob; nothing selected means the whole root.
 */
function specArg(layout, paths) {
  const root = layout.testsRoot.replace(/\\/g, '/');
  const globs = (paths.length ? paths : ['']).map((p) => {
    const rel = String(p || '').replace(/\\/g, '/');
    if (!rel) return `${root}/**/*.cy.{ts,js,tsx,jsx}`;
    return rel.endsWith('/')
      ? `${root}/${rel}**/*.cy.{ts,js,tsx,jsx}`
      : `${root}/${rel}`;
  });
  return globs.join(',');
}

function buildRun(ctx) {
  const { suiteDir, layout, paths, ndjsonFile, artifactsDir, siteKey, reporterPath } = ctx;

  return {
    command: process.execPath,
    args: [
      cliPath(suiteDir),
      'run',
      '--e2e',
      '--browser', 'chrome',
      '--config-file', layout.configFile,
      '--spec', specArg(layout, paths),
      '--reporter', reporterPath,
      // Keep this run's artifacts inside the run directory rather than in the
      // suite, so history stays reproducible and suites stay clean.
      '--config',
      [
        `screenshotsFolder=${artifactsDir}/screenshots`,
        `videosFolder=${artifactsDir}/videos`,
        `downloadsFolder=${artifactsDir}/downloads`,
        'video=false',
      ].join(','),
    ],
    cwd: suiteDir,
    env: {
      DASHBOARD_EVENTS_FILE: ndjsonFile,
      DASHBOARD_SITE: siteKey || '',
      CYPRESS_CRASH_REPORTS: '0',
    },
  };
}

module.exports = {
  id: 'cypress',
  label: 'Cypress',
  language: 'TypeScript',
  specLabel: '*.cy.ts',
  runner: 'Cypress (mocha)',
  specRe: SPEC_RE,
  // Cypress has no CLI title filter — selection is per spec file.
  supportsGrep: false,
  grepNote: 'Cypress has no CLI keyword filter — select specs instead.',
  emitsPlan: false,
  reportKind: 'artifacts',
  detect,
  checkTooling,
  discover,
  buildRun,
  buildAuth: () => null,
};
