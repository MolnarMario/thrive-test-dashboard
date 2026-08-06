'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Dashboard configuration.
 *
 * Everything here is discovered or read from `sites.config.json` (gitignored —
 * copy sites.config.example.json to get started), so the dashboard adapts to
 * whatever layout a Playwright suite happens to use. Two are supported without
 * any configuration:
 *
 *   <suite>/playwright.config.ts            + <suite>/tests/…
 *   <suite>/.playwright/playwright.config.ts + <suite>/.playwright/tests/…
 *
 * Every value can be overridden with an env var if auto-detection guesses wrong.
 */

/**
 * Read sites.config.json. Accepts either the flat `{ <key>: {...} }` map or the
 * richer `{ suiteDir, sites: { … } }` shape that also pins the suite location.
 */
function loadSitesConfig() {
  const sitesConfigPath = path.join(__dirname, 'sites.config.json');
  if (fs.existsSync(sitesConfigPath)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(sitesConfigPath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse sites.config.json: ${err.message}`);
    }
    if (parsed && typeof parsed === 'object' && parsed.sites) {
      return { suiteDir: parsed.suiteDir || null, sites: parsed.sites };
    }
    return { suiteDir: null, sites: parsed };
  }
  return {
    suiteDir: null,
    sites: {
      'site-a': { name: 'Site A', url: 'https://site-a.local', testDirs: ['site-a'] },
      'site-b': { name: 'Site B', url: 'https://site-b.local', testDirs: ['site-b'] },
      main: { name: 'Main (cross-site)', url: 'https://main.local', testDirs: ['cross-site'] },
    },
  };
}

const SITES_CONFIG = loadSitesConfig();

/**
 * Site key -> { name, url, testDirs }
 * testDirs are relative to the tests root and are used both for building the
 * test tree and as Playwright positional filters (e.g. "tests/site-a/"). Use
 * ["."] when the specs sit directly in the tests root rather than in per-site
 * subfolders.
 */
const SITES = SITES_CONFIG.sites;

/** Layouts we know how to drive, most specific first. */
const SUITE_LAYOUTS = [
  { config: '.playwright/playwright.config.ts', tests: '.playwright/tests' },
  { config: 'playwright.config.ts', tests: 'tests' },
];

/** Which layout (if any) a directory uses. */
function detectLayout(dir) {
  for (const layout of SUITE_LAYOUTS) {
    if (fs.existsSync(path.join(dir, layout.config))) return layout;
  }
  return null;
}

/**
 * Locate the Playwright suite: DASHBOARD_SUITE_DIR → sites.config.json
 * `suiteDir` → a directory next to (or above) the dashboard that looks like a
 * Playwright suite.
 */
function resolveSuiteDir() {
  if (process.env.DASHBOARD_SUITE_DIR) return process.env.DASHBOARD_SUITE_DIR;
  if (SITES_CONFIG.suiteDir) return path.resolve(__dirname, SITES_CONFIG.suiteDir);
  const candidates = [
    path.resolve(__dirname, '..', 'automated-tests'),
    path.resolve(__dirname, '..', 'automated-tests', 'automated-tests'),
    path.resolve(__dirname, '..'),
  ];
  for (const c of candidates) {
    if (detectLayout(c)) return c;
  }
  return candidates[0];
}

const SUITE_DIR = resolveSuiteDir();
const LAYOUT = detectLayout(SUITE_DIR) || SUITE_LAYOUTS[0];

// Playwright config path, relative to SUITE_DIR.
const PLAYWRIGHT_CONFIG = process.env.DASHBOARD_PLAYWRIGHT_CONFIG || LAYOUT.config;

// Where the actual spec files live on disk, relative to SUITE_DIR.
const TESTS_ROOT_REL = process.env.DASHBOARD_TESTS_ROOT || LAYOUT.tests;

/**
 * Playwright matches positional filters as a substring of the full spec path,
 * so "tests/" is the prefix regardless of whether the tests root is `tests` or
 * `.playwright/tests`. A dir of "." (or empty) means the whole tests root.
 */
function testFilter(dir) {
  return !dir || dir === '.' ? 'tests/' : `tests/${dir}/`;
}

/**
 * Positional filter for the auth step, or null when the suite has no
 * `auth.setup.ts` (suites that log in via Playwright's `globalSetup` don't need
 * one — the orchestrator then skips its auth phase entirely). Set
 * DASHBOARD_AUTH_SETUP='' to force-skip, or to a path to point it elsewhere.
 */
function resolveAuthSetup() {
  if (process.env.DASHBOARD_AUTH_SETUP !== undefined) {
    return process.env.DASHBOARD_AUTH_SETUP || null;
  }
  return fs.existsSync(path.join(SUITE_DIR, TESTS_ROOT_REL, 'auth.setup.ts'))
    ? 'tests/auth.setup.ts'
    : null;
}

const AUTH_SETUP = resolveAuthSetup();

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
  AUTH_SETUP,
  testFilter,
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
