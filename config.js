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
    path.resolve(__dirname, '..', 'automated-tests'),
    path.resolve(__dirname, '..', 'automated-tests', 'automated-tests'),
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
 * test tree and as Playwright positional filters (e.g. "tests/site-a/").
 *
 * Loaded from sites.config.json in the dashboard root if present (gitignored —
 * that's where your real site list lives; copy sites.config.example.json to
 * get started). Falls back to a small generic example below so the dashboard
 * still runs out of the box.
 */
function loadSites() {
  const sitesConfigPath = path.join(__dirname, 'sites.config.json');
  if (fs.existsSync(sitesConfigPath)) {
    try {
      return JSON.parse(fs.readFileSync(sitesConfigPath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse sites.config.json: ${err.message}`);
    }
  }
  return {
    'site-a': {
      name: 'Site A',
      url: 'https://site-a.local',
      testDirs: ['site-a'],
    },
    'site-b': {
      name: 'Site B',
      url: 'https://site-b.local',
      testDirs: ['site-b'],
    },
    main: {
      name: 'Main (cross-site)',
      url: 'https://main.local',
      testDirs: ['cross-site'],
    },
  };
}

const SITES = loadSites();

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
 * not listed keeps its original relative order after these. List your
 * largest/longest suites first so they get the freest memory and most runway.
 */
const SITE_START_PRIORITY = (process.env.SITE_START_PRIORITY
  ? process.env.SITE_START_PRIORITY.split(',').map((s) => s.trim()).filter(Boolean)
  : []);

/* ----------------------------- PR Builder ------------------------------- */
/**
 * Config for the PR Builder tab — builds a GitHub PR for a configured WordPress
 * plugin/theme and installs it onto that project's Local site.
 *
 * *Which* repos can be built is declared per project in `pr-builder.config.json`
 * (see server/pr-projects.js). This block holds only the machine-level bits that
 * are the same for every project. Build history/logs live under data/.
 */
const PR_BUILDER = {
  // Per-project git checkouts live under here:
  //   <home>/<projectKey>/repo      — the clone (fetches PR heads)
  //   <home>/<projectKey>/worktree  — detached worktree reset to the PR head
  home: process.env.PR_BUILDER_HOME || path.join(os.homedir(), '.wp-pr-builder'),

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
  // single-site mode (PLAYWRIGHT_BASE_URL). The suite reads these env vars
  // (its own defaults are admin / 'Admin123!').
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
