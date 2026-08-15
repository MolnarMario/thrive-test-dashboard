'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const frameworks = require('./server/frameworks');

/**
 * Dashboard configuration.
 *
 * Two independent things are configured, and the run matrix is their product:
 *
 *   sites  — the environments you can run against (a URL + admin credentials).
 *   suites — the test suites you can run (a directory + which framework it is).
 *
 * That separation is what makes the platform framework-agnostic: a suite says
 * *how* to run, a site says *where*, and any suite can be pointed at any site
 * it lists. See sites.config.example.json.
 *
 * The older single-suite shape ({ suiteDir, sites: { …, testDirs } }) is still
 * accepted and upgraded in memory, so existing installs keep working.
 */

const CONFIG_PATH = path.join(__dirname, 'sites.config.json');
const EXAMPLE_PATH = path.join(__dirname, 'sites.config.example.json');
const DATA_DIR = path.join(__dirname, 'data');
const CUSTOM_SITES_PATH = path.join(DATA_DIR, 'custom-sites.json');

function readConfigFile() {
  for (const file of [CONFIG_PATH, EXAMPLE_PATH]) {
    if (!fs.existsSync(file)) continue;
    try {
      return { parsed: JSON.parse(fs.readFileSync(file, 'utf8')), file };
    } catch (err) {
      throw new Error(`Failed to parse ${path.basename(file)}: ${err.message}`);
    }
  }
  return { parsed: null, file: null };
}

/**
 * Sites added from the dashboard UI ("+ Add site"), kept separate from
 * sites.config.json so that file stays hand-edited/checked-in-by-convention
 * while UI-added sites persist to the gitignored data/ dir like everything
 * else the server writes itself (runs, schedules).
 */
function readCustomSites() {
  try {
    return JSON.parse(fs.readFileSync(CUSTOM_SITES_PATH, 'utf8'));
  } catch (_) {
    return [];
  }
}

function writeCustomSites(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CUSTOM_SITES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, CUSTOM_SITES_PATH); // atomic-ish replace
}

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

function uniqueKey(base, existingKeys) {
  if (!existingKeys.includes(base)) return base;
  let i = 2;
  while (existingKeys.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/* --------------------------------- sites ---------------------------------- */

/** Keys starting with `//` are comments in the JSON config, not entries. */
function isComment(key) {
  return key.startsWith('//');
}

function normaliseSites(raw) {
  const sites = {};
  for (const [key, cfg] of Object.entries(raw || {})) {
    if (isComment(key)) continue;
    sites[key] = {
      key,
      name: cfg.name || key,
      url: String(cfg.url || '').replace(/\/$/, ''),
      adminUser: cfg.adminUser || cfg.user || 'admin',
      adminPass: cfg.adminPass || cfg.pass || 'admin',
      // Kept only so the legacy shape can be upgraded into suite scopes.
      testDirs: Array.isArray(cfg.testDirs) ? cfg.testDirs : null,
    };
  }
  return sites;
}

/* --------------------------------- suites --------------------------------- */

/**
 * Resolve one suite entry into everything the rest of the server needs:
 * absolute dir, framework adapter, detected layout, and the set of sites it may
 * be pointed at.
 */
function normaliseSuite(key, cfg, allSiteKeys) {
  const dir = path.resolve(__dirname, cfg.dir || cfg.suiteDir || '.');

  // Explicit combination: `"framework": ["playwright", "cypress"]`.
  if (Array.isArray(cfg.framework)) {
    return normaliseCompositeSuite(key, cfg, dir, allSiteKeys, cfg.framework);
  }

  // Nothing explicit → auto-detect. Check for *every* framework present, not
  // just the first: a directory holding both playwright.config.ts and
  // cypress.config.ts is a composite suite, not a single-framework one that
  // happens to also have stray files.
  let framework = cfg.framework;
  if (!framework) {
    const detected = frameworks.detectAll(dir);
    if (detected.length > 1) {
      return normaliseCompositeSuite(key, cfg, dir, allSiteKeys, detected.map((d) => d.id));
    }
    framework = detected.length === 1 ? detected[0].id : null;
  }

  if (!framework) {
    return {
      key,
      name: cfg.name || key,
      dir,
      framework: null,
      ok: false,
      reason:
        `Could not tell which framework "${key}" uses. Set "framework" to one of: ` +
        `${frameworks.IDS.join(', ')}.`,
      sites: [],
      layout: null,
      scopes: [],
    };
  }
  if (!frameworks.has(framework)) {
    return {
      key,
      name: cfg.name || key,
      dir,
      framework,
      ok: false,
      reason: `Unknown framework "${framework}" for suite "${key}". Known: ${frameworks.IDS.join(', ')}.`,
      sites: [],
      layout: null,
      scopes: [],
    };
  }

  const adapter = frameworks.get(framework);
  const layout = adapter.detect(dir);
  const { sites, defaultSite } = resolveSites(cfg, allSiteKeys);

  return {
    key,
    name: cfg.name || key,
    dir,
    framework,
    ok: layout.ok,
    reason: layout.ok ? null : layout.reason,
    layout,
    sites,
    defaultSite,
    // Optional named sub-selections within one suite (a suite whose specs are
    // split per product/tenant). Empty = the whole suite is one scope.
    scopes: normaliseScopes(cfg.scopes),
    env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
  };
}

/** Which registered sites a suite may target. Default: all of them, so a
 *  one-site install needs no wiring at all. */
function resolveSites(cfg, allSiteKeys) {
  const sites = Array.isArray(cfg.sites) && cfg.sites.length
    ? cfg.sites.filter((s) => allSiteKeys.includes(s))
    : allSiteKeys.slice();
  const defaultSite =
    (cfg.defaultSite && sites.includes(cfg.defaultSite) && cfg.defaultSite) || sites[0] || null;
  return { sites, defaultSite };
}

/**
 * A suite whose directory holds more than one framework — either because
 * `cfg.framework` explicitly lists several, or because auto-detection found
 * several. Represented as `frameworks: [{id, layout}, ...]` instead of the
 * single `framework`/`layout` pair, so the rest of the server (tree.js,
 * orchestrator.js) can tell a composite suite apart from a plain one and
 * treat each member framework with its own adapter, independently.
 *
 * `ok` is true as long as at least one member is runnable — a suite with a
 * broken Selenium leg still runs its Playwright and Cypress tests fully.
 */
function normaliseCompositeSuite(key, cfg, dir, allSiteKeys, ids) {
  const uniqueIds = ids.filter((id, i) => ids.indexOf(id) === i);
  const members = uniqueIds.map((id) => {
    if (!frameworks.has(id)) {
      return {
        id,
        layout: {
          ok: false,
          reason: `Unknown framework "${id}" for suite "${key}". Known: ${frameworks.IDS.join(', ')}.`,
        },
      };
    }
    return { id, layout: frameworks.get(id).detect(dir) };
  });

  const runnable = members.filter((m) => m.layout.ok);
  const { sites, defaultSite } = resolveSites(cfg, allSiteKeys);

  return {
    key,
    name: cfg.name || key,
    dir,
    framework: null,
    frameworks: members,
    ok: runnable.length > 0,
    reason: runnable.length ? null : members.map((m) => m.layout.reason).join('; '),
    sites,
    defaultSite,
    scopes: normaliseScopes(cfg.scopes),
    env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
  };
}

function normaliseScopes(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([key, cfg]) => ({
    key,
    name: (cfg && cfg.name) || key,
    dirs: Array.isArray(cfg && cfg.dirs) ? cfg.dirs : Array.isArray(cfg) ? cfg : ['.'],
    defaultSite: (cfg && cfg.defaultSite) || null,
  }));
}

/**
 * Upgrade the legacy single-suite config in memory.
 *
 * Old shape: one Playwright suite, with each *site* owning a slice of the tests
 * via `testDirs`. New shape: one suite with a named scope per slice, so the same
 * "pick a product, run its tests against its site" flow survives intact.
 */
function upgradeLegacy(parsed, sites) {
  const scopes = {};
  for (const [key, cfg] of Object.entries(sites)) {
    if (cfg.testDirs && cfg.testDirs.length) {
      scopes[key] = { name: cfg.name, dirs: cfg.testDirs, defaultSite: key };
    }
  }
  return {
    legacy: {
      name: 'Test suite',
      dir: parsed.suiteDir || '..',
      framework: process.env.DASHBOARD_FRAMEWORK || undefined,
      scopes: Object.keys(scopes).length > 1 ? scopes : undefined,
    },
  };
}

/** Merge UI-added sites on top of the config-file sites and mark them `custom`. */
function withCustomSites(sites) {
  const custom = readCustomSites();
  for (const c of custom) {
    sites[c.key] = { ...normaliseSites({ [c.key]: c })[c.key], custom: true };
  }
  return sites;
}

function loadConfig() {
  const { parsed, file } = readConfigFile();

  if (!parsed) {
    return {
      sites: withCustomSites(normaliseSites({
        local: { name: 'Local site', url: 'http://localhost' },
      })),
      rawSuites: { local: { name: 'Test suite', dir: '..' } },
      usingExample: false,
      file: null,
    };
  }

  // Flat `{ <siteKey>: {...} }` map (the oldest shape).
  const rawSites = parsed.sites || (parsed.suites ? {} : parsed);
  const sites = withCustomSites(normaliseSites(rawSites));

  const rawSuites = parsed.suites || upgradeLegacy(parsed, sites);

  return {
    sites,
    rawSuites,
    usingExample: file === EXAMPLE_PATH,
    file,
  };
}

let LOADED = loadConfig();

/** Site key -> { key, name, url, adminUser, adminPass, custom? }. Mutated in
 *  place (not reassigned) by reload(), so every module that destructured this
 *  reference at require time keeps seeing live data — no restart needed. */
const SITES = {};

/** Suite key -> resolved suite (see normaliseSuite). Also mutated in place. */
const SUITES = {};

/** Repopulate SITES/SUITES from a loadConfig() result without changing their
 *  object identity (see the comments above). */
function applyLoaded(loaded) {
  for (const k of Object.keys(SITES)) delete SITES[k];
  Object.assign(SITES, loaded.sites);

  for (const k of Object.keys(SUITES)) delete SUITES[k];
  const siteKeys = Object.keys(SITES);
  for (const [key, cfg] of Object.entries(loaded.rawSuites)) {
    if (isComment(key)) continue;
    SUITES[key] = normaliseSuite(key, cfg, siteKeys);
  }
}

applyLoaded(LOADED);

/** Re-read sites.config.json + data/custom-sites.json and refresh SITES/SUITES. */
function reload() {
  LOADED = loadConfig();
  applyLoaded(LOADED);
}

/** The suite a site-only request (e.g. the PR builder) should default to. */
const DEFAULT_SUITE = Object.keys(SUITES)[0] || null;

/**
 * Add a site from the dashboard UI. Persists to data/custom-sites.json and
 * makes it selectable immediately (no restart) via reload().
 */
function addSite({ name, url, adminUser, adminPass } = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Name is required.');
  const cleanUrl = String(url || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(cleanUrl)) throw new Error('URL must start with http:// or https://.');

  const custom = readCustomSites();
  const key = uniqueKey(slugify(cleanName), [...Object.keys(SITES), ...custom.map((c) => c.key)]);
  const entry = {
    key,
    name: cleanName,
    url: cleanUrl,
    adminUser: adminUser ? String(adminUser) : 'admin',
    adminPass: adminPass ? String(adminPass) : 'admin',
    createdAt: new Date().toISOString(),
  };
  custom.push(entry);
  writeCustomSites(custom);
  reload();
  return SITES[key];
}

/** Remove a site previously added via addSite(). Config-file sites can't be
 *  removed here by design — sites.config.json stays the source of truth for
 *  anything checked into a team's local setup. */
function removeSite(key) {
  const custom = readCustomSites();
  const next = custom.filter((c) => c.key !== key);
  if (next.length === custom.length) {
    throw new Error('Only sites added through the dashboard can be removed here.');
  }
  writeCustomSites(next);
  reload();
}

function getSuite(key) {
  const suite = SUITES[key || DEFAULT_SUITE];
  if (!suite) throw new Error(`Unknown suite: ${key}`);
  return suite;
}

function getSite(key) {
  return SITES[key] || null;
}

/** Environment a suite needs to point itself at a given site. */
function siteEnv(site) {
  if (!site) return {};
  return {
    E2E_BASE_URL: site.url,
    E2E_ADMIN_USER: site.adminUser,
    E2E_ADMIN_PASS: site.adminPass,
    // Kept for suites still reading Playwright's own variable names.
    PLAYWRIGHT_BASE_URL: site.url,
    WP_ADMIN_USERNAME: site.adminUser,
    WP_ADMIN_PASSWORD: site.adminPass,
  };
}

/**
 * Stable identity for one (suite, site) pair — used for files, URLs and locks.
 * A composite suite runs one process per member framework against the same
 * site, so `frameworkKey` disambiguates those into distinct targets/files.
 */
function targetKey(suiteKey, siteKey, frameworkKey) {
  const base = `${suiteKey}__${siteKey}`;
  return (frameworkKey ? `${base}__${frameworkKey}` : base).replace(/[^\w.-]+/g, '-');
}

const RUNS_DIR = path.join(DATA_DIR, 'runs');
const REPORTERS_DIR = path.join(__dirname, 'reporters');
const REPORTER_PATHS = {
  playwright: path.join(REPORTERS_DIR, 'dashboard-reporter.cjs'),
  cypress: path.join(REPORTERS_DIR, 'cypress-dashboard-reporter.cjs'),
  selenium: null, // results are read from Surefire's XML, not a reporter
};

const PORT = Number(process.env.PORT || 4400);

/* --------------------------- Launch pacing ----------------------------- */
/**
 * Targets are spawned one at a time with this delay between starts to avoid
 * PHP/MySQL memory contention (simultaneous spawns caused OOM on the machine).
 */
const SITE_START_STAGGER_MS = Number(process.env.SITE_START_STAGGER_MS ?? 45000);

/**
 * Optional hard cap on targets running tests at once (0 = unlimited).
 * Complementary safeguard to the stagger; a freed slot lets the next one launch.
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

  // Credentials for running a suite against the PR-built site.
  testEnv: {
    E2E_ADMIN_USER: process.env.PR_BUILDER_WP_USER || 'admin',
    E2E_ADMIN_PASS: process.env.PR_BUILDER_WP_PASS || 'admin',
    WP_ADMIN_USERNAME: process.env.PR_BUILDER_WP_USER || 'admin',
    WP_ADMIN_PASSWORD: process.env.PR_BUILDER_WP_PASS || 'admin',
  },
};

module.exports = {
  SITES,
  SUITES,
  DEFAULT_SUITE,
  getSuite,
  getSite,
  siteEnv,
  targetKey,
  addSite,
  removeSite,
  get usingExampleConfig() { return LOADED.usingExample; },
  get configFile() { return LOADED.file; },
  DATA_DIR,
  RUNS_DIR,
  REPORTER_PATHS,
  PORT,
  PR_BUILDER,
  SITE_START_STAGGER_MS,
  MAX_CONCURRENT_SITES,
  SITE_START_PRIORITY,
};
