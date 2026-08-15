'use strict';

/**
 * PR Builder project registry.
 *
 * A "project" is one WordPress plugin/theme repo the PR Builder knows how to
 * build and install onto a Local site. Projects are declared in
 * `pr-builder.config.json` at the dashboard root (gitignored — copy
 * `pr-builder.config.example.json` to get started).
 *
 * The config is read fresh on each lookup so editing it doesn't need a server
 * restart; it's a few hundred bytes, so the cost is irrelevant.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'pr-builder.config.json');
const EXAMPLE_PATH = path.join(ROOT, 'pr-builder.config.example.json');

/** Always excluded from the install copy, on top of a project's own list. */
const ALWAYS_EXCLUDE = ['.git'];

const DEFAULTS = {
  kind: 'plugin',
  build: null,
  distDir: null,
  exclude: ['.git', '.github', 'node_modules'],
  testAreas: [],
  versionStamp: true,
};

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/* --------------------------------- loading -------------------------------- */

function readConfigFile() {
  const file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_PATH;
  if (!fs.existsSync(file)) {
    throw new Error(
      'No PR Builder config found. Copy pr-builder.config.example.json to ' +
        'pr-builder.config.json and edit it.'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${path.basename(file)}: ${err.message}`);
  }
  const projects = parsed && parsed.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) {
    throw new Error(`${path.basename(file)} must contain a "projects" object.`);
  }
  return { projects, usingExample: file === EXAMPLE_PATH };
}

/** Fill defaults and validate one project entry. Throws on bad config. */
function normalize(key, raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Project "${key}" must be an object.`);
  }
  const p = { ...DEFAULTS, ...raw, key };

  if (!p.repo || !REPO_RE.test(String(p.repo))) {
    throw new Error(`Project "${key}": "repo" must be "owner/name" (got ${JSON.stringify(p.repo)}).`);
  }
  if (p.kind !== 'plugin' && p.kind !== 'theme') {
    throw new Error(`Project "${key}": "kind" must be "plugin" or "theme" (got ${JSON.stringify(p.kind)}).`);
  }
  if (!p.slug || typeof p.slug !== 'string') {
    throw new Error(`Project "${key}": "slug" (install folder name) is required.`);
  }
  if (!p.site || typeof p.site !== 'string') {
    throw new Error(`Project "${key}": "site" (Local site domain) is required.`);
  }
  if (p.build != null && typeof p.build !== 'string') {
    throw new Error(`Project "${key}": "build" must be a shell command string or null.`);
  }
  if (p.distDir != null && typeof p.distDir !== 'string') {
    throw new Error(`Project "${key}": "distDir" must be a path string or null.`);
  }
  if (!Array.isArray(p.exclude)) {
    throw new Error(`Project "${key}": "exclude" must be an array.`);
  }
  if (!Array.isArray(p.testAreas)) {
    throw new Error(`Project "${key}": "testAreas" must be an array of site keys.`);
  }

  p.name = p.name || key;
  p.exclude = [...new Set([...ALWAYS_EXCLUDE, ...p.exclude])];
  p.versionStamp = !!p.versionStamp;
  return p;
}

/** All configured projects, normalized. */
function listProjects() {
  const { projects, usingExample } = readConfigFile();
  return Object.entries(projects).map(([key, raw]) => ({
    ...normalize(key, raw),
    usingExample,
  }));
}

/** One project by key. Throws a clear error if unknown. */
function getProject(key) {
  const { projects } = readConfigFile();
  if (!key) {
    const keys = Object.keys(projects);
    if (keys.length === 1) return normalize(keys[0], projects[keys[0]]);
    throw new Error(`A project is required. Configured: ${keys.join(', ') || '(none)'}.`);
  }
  if (!projects[key]) {
    throw new Error(
      `Unknown project "${key}". Configured: ${Object.keys(projects).join(', ') || '(none)'}.`
    );
  }
  return normalize(key, projects[key]);
}

/** Find the project whose repo matches "owner/name", or null. */
function projectForRepo(repo) {
  if (!repo) return null;
  const { projects } = readConfigFile();
  const lower = String(repo).toLowerCase();
  for (const [key, raw] of Object.entries(projects)) {
    if (raw && String(raw.repo).toLowerCase() === lower) return normalize(key, raw);
  }
  return null;
}

/* ------------------------------- PR references ---------------------------- */

/**
 * Accept the shapes a user might paste:
 *   3752
 *   #3752
 *   owner/name#3752
 *   https://github.com/owner/name/pull/3752        (+ /files, #issuecomment-…)
 * Returns { prNumber, repo } where repo is null when not implied by the input.
 */
function parsePrRef(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new Error('Enter a PR number or URL.');

  const url = raw.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i);
  if (url) return { prNumber: url[2], repo: url[1] };

  const qualified = raw.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (qualified) return { prNumber: qualified[2], repo: qualified[1] };

  const bare = raw.match(/^#?(\d+)$/);
  if (bare) return { prNumber: bare[1], repo: null };

  throw new Error(
    `Could not read a PR from "${raw}". Use a number (3752) or a URL ` +
      `(https://github.com/owner/name/pull/3752).`
  );
}

/* --------------------------------- versions ------------------------------- */

const sanitizeSegment = (s) =>
  String(s).replace(/[^0-9A-Za-z.+-]/g, '-').replace(/-+/g, '-');

/**
 * Default version stamp. The 100. prefix is intentional — well above any real
 * release, so a test build can never be auto-updated past.
 */
function defaultVersion({ prNumber } = {}) {
  return prNumber ? `100.PR${sanitizeSegment(prNumber)}` : '100.0';
}

/* ---------------------------------- tests --------------------------------- */

/** Test-suite areas (scope keys of the project's suite) to run for a project. */
function testAreasFor(key) {
  return getProject(key).testAreas;
}

module.exports = {
  CONFIG_PATH,
  EXAMPLE_PATH,
  ALWAYS_EXCLUDE,
  DEFAULTS,
  listProjects,
  getProject,
  projectForRepo,
  parsePrRef,
  defaultVersion,
  sanitizeSegment,
  testAreasFor,
};
