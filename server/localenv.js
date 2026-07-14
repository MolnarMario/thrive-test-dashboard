'use strict';

/**
 * Resolves the bits of "Local by Flywheel" that the PR Builder add-on normally
 * gets from Local's internal APIs, but which we must discover from disk because
 * the dashboard runs as a standalone process outside Local's Electron app:
 *
 *   - site → web root + MySQL port + PHP version   (from Local's sites.json)
 *   - the bundled PHP binary for a given PHP version (lightning-services)
 *   - a runnable wp-cli command (bundled PHP + vendored wp-cli.phar), with the
 *     site's MySQL TCP port injected via `mysqli.default_port` (wp-config uses
 *     bare `localhost`, which would otherwise hit the default 3306).
 *   - the awesomemotive/thrive-themes monorepo checkout path.
 *
 * All of this was verified against pr-builder-4platform: bundled PHP 8.2.29 +
 * mysqli connects to 127.0.0.1:<port> and wp-cli reads the live DB.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCAL_DATA_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Local'
);
const SITES_JSON = path.join(LOCAL_DATA_DIR, 'sites.json');
const LIGHTNING_DIR = path.join(LOCAL_DATA_DIR, 'lightning-services');

/** Expand a leading `~` (Local stores site paths as `~\Local Sites\...`). */
function expandHome(p) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function readSitesJson() {
  return JSON.parse(fs.readFileSync(SITES_JSON, 'utf8'));
}

/**
 * Look a Local site up by its domain (e.g. "pr-builder-4platform.local") and
 * return everything the build needs. Throws a clear error if not found.
 */
function getLocalSite(domain) {
  let sites;
  try {
    sites = readSitesJson();
  } catch (err) {
    throw new Error(`Could not read Local's sites.json at ${SITES_JSON}: ${err.message}`);
  }
  const s = Object.values(sites).find((x) => x && x.domain === domain);
  if (!s) {
    throw new Error(
      `Local site "${domain}" not found in sites.json. ` +
        `Open it once in Local so it's registered.`
    );
  }

  const webRoot =
    (s.paths && s.paths.webRoot) ||
    path.join(expandHome(s.path), 'app', 'public');
  const mysqlPort =
    s.services && s.services.mysql && s.services.mysql.ports &&
    s.services.mysql.ports.MYSQL && s.services.mysql.ports.MYSQL[0];
  const phpVersion = s.services && s.services.php && s.services.php.version;

  if (!mysqlPort) {
    throw new Error(
      `Local site "${domain}" has no MySQL port in sites.json — is it set up / has it been started at least once?`
    );
  }

  return {
    id: s.id,
    name: s.name,
    domain: s.domain,
    url: `http://${s.domain}`,
    webRoot,
    pluginsDir: path.join(webRoot, 'wp-content', 'plugins'),
    themesDir: path.join(webRoot, 'wp-content', 'themes'),
    mysqlPort,
    phpVersion,
  };
}

/**
 * Resolve Local's bundled PHP for a version (e.g. "8.2.29"). Picks the highest
 * matching build; falls back to the newest available PHP if the exact version
 * isn't installed. Returns the win64 binary + its extension dir.
 */
function resolvePhp(version) {
  let dirs;
  try {
    dirs = fs.readdirSync(LIGHTNING_DIR).filter((d) => d.startsWith('php-'));
  } catch (err) {
    throw new Error(`Could not read Local lightning-services at ${LIGHTNING_DIR}: ${err.message}`);
  }
  if (!dirs.length) throw new Error(`No bundled PHP found under ${LIGHTNING_DIR}.`);

  const sortDesc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);
  let match = version ? dirs.filter((d) => d.startsWith(`php-${version}`)) : [];
  if (!match.length) match = dirs.slice(); // fall back to any PHP
  match.sort(sortDesc);

  const base = path.join(LIGHTNING_DIR, match[0], 'bin', 'win64');
  const phpBin = path.join(base, 'php.exe');
  const extDir = path.join(base, 'ext');
  if (!fs.existsSync(phpBin)) {
    throw new Error(`Bundled PHP binary not found at ${phpBin}.`);
  }
  return { phpBin, extDir, dir: match[0] };
}

/**
 * Build a runnable wp-cli command (php binary + argv) for a site. We run PHP
 * with `-n` (ignore any ambient php.ini) and explicitly load the WP-relevant
 * extensions from Local's bundled ext dir, plus inject the site's MySQL port.
 *
 * skipPlugins/skipThemes default to true (matching Local's WpCliService); pass
 * false for plugin/theme activation, otherwise the command silently no-ops.
 */
function buildWpCli({ site, php, wpCliPhar, extensions, args, skipPlugins = true, skipThemes = true }) {
  const argv = ['-n', '-d', `extension_dir=${php.extDir}`];
  for (const ext of extensions) argv.push('-d', `extension=${ext}`);
  argv.push('-d', `mysqli.default_port=${site.mysqlPort}`);
  argv.push(wpCliPhar, `--path=${site.webRoot}`);
  if (skipPlugins) argv.push('--skip-plugins');
  if (skipThemes) argv.push('--skip-themes');
  argv.push(...args);
  return { file: php.phpBin, argv };
}

function looksLikeMonorepo(dir) {
  try {
    return (
      !!dir &&
      fs.existsSync(path.join(dir, '.git')) &&
      fs.existsSync(path.join(dir, 'tools', 'thrive-release', 'index.js'))
    );
  } catch (_) {
    return false;
  }
}

/**
 * Resolve the awesomemotive/thrive-themes checkout. Order: the add-on's saved
 * config (~/.local-addon-thrive-pr-builder/config.json) → a couple of common
 * locations → null (caller surfaces a clear setup error).
 */
function resolveMonorepoPath() {
  const addonConfig = path.join(os.homedir(), '.local-addon-thrive-pr-builder', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(addonConfig, 'utf8'));
    if (cfg && looksLikeMonorepo(cfg.monorepoPath)) return cfg.monorepoPath;
  } catch (_) {
    // no saved config — fall through to auto-detect
  }
  const candidates = [
    path.join(os.homedir(), 'thrive-themes-develop'),
    path.join(os.homedir(), 'development', 'thrive-themes'),
    path.join(os.homedir(), 'thrive-themes'),
  ];
  for (const c of candidates) if (looksLikeMonorepo(c)) return c;
  return null;
}

/** Git Bash on Windows (used to run git/gh/npm/unzip like the add-on does). */
function resolveBashPath() {
  if (process.platform !== 'win32') return '/bin/bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return 'bash.exe';
}

module.exports = {
  LOCAL_DATA_DIR,
  SITES_JSON,
  LIGHTNING_DIR,
  getLocalSite,
  resolvePhp,
  buildWpCli,
  looksLikeMonorepo,
  resolveMonorepoPath,
  resolveBashPath,
};
