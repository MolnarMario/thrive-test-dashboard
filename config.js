'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Dashboard configuration.
 *
 * SUITE_DIR points at the Playwright suite root (the folder containing
 * package.json + .playwright/). Override with DASHBOARD_SUITE_DIR if needed.
 *
 * The SITES map mirrors the suite's `.playwright/sites.config.ts` and the
 * SITE_TEST_DIRS map in `scripts/run-parallel.sh`. Keep them in sync — if a
 * site is added there, add it here too.
 */

/**
 * Locate the Playwright suite. We identify it by `.playwright/sites.config.ts`,
 * which uniquely marks the suite root. Candidates cover the dashboard living
 * inside the repo (next to the suite folder), running as a standalone sibling
 * of the repo, or living inside the suite itself.
 */
function resolveSuiteDir() {
  if (process.env.DASHBOARD_SUITE_DIR) return process.env.DASHBOARD_SUITE_DIR;
  const marker = path.join('.playwright', 'sites.config.ts');
  const candidates = [
    path.resolve(__dirname, '..', 'thrive-themes-automated-tests'),
    path.resolve(__dirname, '..', 'thrive-themes-automated-tests', 'thrive-themes-automated-tests'),
    path.resolve(__dirname, '..'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, marker))) return c;
  }
  return candidates[0];
}

const SUITE_DIR = resolveSuiteDir();

// Playwright config path, relative to SUITE_DIR (matches the npm scripts).
const PLAYWRIGHT_CONFIG = '.playwright/playwright.config.ts';

// Where the actual spec files live on disk, relative to SUITE_DIR.
const TESTS_ROOT_REL = '.playwright/tests';

/**
 * Site key -> { name, url, testDirs }
 * testDirs are relative to the tests root and are used both for building the
 * test tree and as Playwright positional filters (e.g. "tests/thrive-architect/").
 */
const SITES = {
  architect: {
    name: 'Thrive Architect',
    url: 'https://for-automation-testing-tcb.local',
    testDirs: ['thrive-architect'],
  },
  apprentice: {
    name: 'Thrive Apprentice',
    url: 'https://for-automation-testing-tva.local',
    testDirs: ['thrive-apprentice'],
  },
  ttb: {
    name: 'Thrive Theme Builder',
    url: 'https://for-automation-testing-ttb.local',
    testDirs: ['thrive-theme-builder'],
  },
  leads: {
    name: 'Thrive Leads',
    url: 'https://for-automation-testing-tl.local',
    testDirs: ['thrive-leads'],
  },
  quiz: {
    name: 'Thrive Quiz Builder',
    url: 'https://for-automation-testing-tqb.local',
    testDirs: ['thrive-quiz-builder'],
  },
  optimize: {
    name: 'Thrive Optimize',
    url: 'https://for-automation-testing-tab.local',
    testDirs: ['thrive-ab-page-testing'],
  },
  ultimatum: {
    name: 'Thrive Ultimatum',
    url: 'https://for-automation-testing-tu.local',
    testDirs: ['thrive-ultimatum'],
  },
  comments: {
    name: 'Thrive Comments',
    url: 'https://for-automation-testing-tcm.local',
    testDirs: ['thrive-comments'],
  },
  ovation: {
    name: 'Thrive Ovation',
    url: 'https://for-automation-testing-tvo.local',
    testDirs: ['thrive-ovation'],
  },
  tpm: {
    name: 'Thrive Product Manager',
    url: 'https://for-automation-testing-tpm.local',
    testDirs: ['thrive-product-manager'],
  },
  main: {
    name: 'Main (WordPress + cross-plugin)',
    url: 'https://for-automation-testing.local',
    testDirs: ['WordPress-specific', 'cross-plugin'],
  },
};

// Playwright CLI entry point inside the suite (spawned via `node <cli.js>`).
const PLAYWRIGHT_CLI = path.join(
  SUITE_DIR,
  'node_modules',
  '@playwright',
  'test',
  'cli.js'
);

const DATA_DIR = path.join(__dirname, 'data');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const REPORTER_PATH = path.join(__dirname, 'reporters', 'dashboard-reporter.cjs');

const PORT = Number(process.env.PORT || 4400);

/* --------------------------- Launch pacing ----------------------------- */
/**
 * Sites are spawned one at a time with this delay between starts to avoid
 * PHP/MySQL memory contention (simultaneous spawns caused OOM on the machine).
 */
const SITE_START_STAGGER_MS = Number(process.env.SITE_START_STAGGER_MS ?? 45000);

/**
 * Optional hard cap on sites running tests at once (0 = unlimited). Complementary
 * safeguard to the stagger; a freed slot lets the next queued site launch.
 */
const MAX_CONCURRENT_SITES = Number(process.env.MAX_CONCURRENT_SITES ?? 0);

/**
 * Sites started first (in this order), regardless of selection order. Any site
 * not listed keeps its original relative order after these. The listed four are
 * the largest/longest suites, so they get the freest memory and the most runway.
 */
const SITE_START_PRIORITY = (process.env.SITE_START_PRIORITY
  ? process.env.SITE_START_PRIORITY.split(',').map((s) => s.trim()).filter(Boolean)
  : ['apprentice', 'architect', 'ttb', 'quiz']);

/* ----------------------------- PR Builder ------------------------------- */
/**
 * Config for the PR Builder tab — builds an awesomemotive/thrive-themes PR and
 * installs it onto a designated Local site, mirroring the LocalWP add-on.
 *
 * The worktree + release-tool cache are shared with the add-on's home dir so
 * warm builds reuse its node_modules/.cache (no multi-minute cold install).
 * Build history/logs live under the dashboard's own data/ dir.
 */
const PR_BUILDER = {
  // The single designated target site (per project decision). Resolved to its
  // web root + MySQL port from Local's sites.json at build time (localenv.js).
  siteDomain: process.env.PR_BUILDER_SITE || 'pr-builder-4platform.local',

  // Shared with the add-on so its warm worktree/cache are reused.
  home: path.join(os.homedir(), '.local-addon-thrive-pr-builder'),
  get worktree() {
    return path.join(this.home, 'worktree');
  },
  releaseToolRel: 'tools/thrive-release',

  // Vendored wp-cli, run under Local's bundled PHP (see localenv.buildWpCli).
  wpCliPhar: path.join(__dirname, 'vendor', 'wp-cli.phar'),

  // WP-relevant PHP extensions to load from Local's bundled ext dir.
  phpExtensions: [
    'mysqli', 'mbstring', 'curl', 'openssl', 'gd',
    'exif', 'intl', 'zip', 'fileinfo', 'sodium',
  ],

  // Where PR build records + logs are persisted (parallels RUNS_DIR).
  buildsDir: path.join(DATA_DIR, 'pr-builds'),

  // Credentials for running the test suite against the PR-built site in
  // single-site mode (PLAYWRIGHT_BASE_URL). pr-builder-4platform uses admin/admin;
  // the suite reads these env vars (defaults admin / 'Admin123!').
  testEnv: {
    WP_ADMIN_USERNAME: process.env.PR_BUILDER_WP_USER || 'admin',
    WP_ADMIN_PASSWORD: process.env.PR_BUILDER_WP_PASS || 'admin',
  },
};

module.exports = {
  SUITE_DIR,
  PLAYWRIGHT_CONFIG,
  PLAYWRIGHT_CLI,
  TESTS_ROOT_REL,
  SITES,
  DATA_DIR,
  RUNS_DIR,
  REPORTER_PATH,
  PORT,
  PR_BUILDER,
  SITE_START_STAGGER_MS,
  MAX_CONCURRENT_SITES,
  SITE_START_PRIORITY,
};
