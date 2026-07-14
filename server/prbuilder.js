'use strict';

/**
 * PR Builder engine — standalone port of the Thrive PR Builder LocalWP add-on.
 *
 * Builds an awesomemotive/thrive-themes PR in the shared detached worktree and
 * installs the resulting ZIPs onto the designated Local site, then activates
 * via wp-cli (Local's bundled PHP + vendored wp-cli.phar, see localenv.js) and
 * verifies the PR's changed files landed on disk.
 *
 * Mirrors the add-on's build flow (docs/ARCHITECTURE.md §3) with three Local
 * APIs replaced: site→disk (sites.json), wp-cli (bundled php), and site-start
 * (we can't start a Local site standalone — we probe and fail fast instead).
 *
 * Like orchestrator.js: one build at a time, child processes tracked for
 * cancel, progress streamed over an EventEmitter for SSE, records persisted.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const { PR_BUILDER, SITES } = require('../config');
const localenv = require('./localenv');
const P = require('./pr-products');

const events = new EventEmitter();
const BASH = localenv.resolveBashPath();

/** Child env with NODE_ENV stripped — Local-equivalent: production NODE_ENV
 *  makes the release tool's `npm install` drop devDeps (webpack) and the build
 *  fails with ENOENT webpack. */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_ENV;
  return env;
}

/* --------------------------------- state ---------------------------------- */

/** The single in-flight build, or null. (One designated site → one at a time.) */
let current = null; // { build, child, cancelled, logStream }

/* --------------------------------- store ---------------------------------- */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function buildDir(id) {
  return path.join(PR_BUILDER.buildsDir, id);
}
function buildJsonPath(id) {
  return path.join(buildDir(id), 'build.json');
}
function logPath(id) {
  return path.join(buildDir(id), 'build.log');
}
function saveBuild(build) {
  const dir = buildDir(build.id);
  ensureDir(dir);
  const tmp = buildJsonPath(build.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(build, null, 2));
  fs.renameSync(tmp, buildJsonPath(build.id));
}
function loadBuild(id) {
  try {
    return JSON.parse(fs.readFileSync(buildJsonPath(id), 'utf8'));
  } catch (_) {
    return null;
  }
}
function listBuilds({ limit = 100 } = {}) {
  ensureDir(PR_BUILDER.buildsDir);
  let ids;
  try {
    ids = fs.readdirSync(PR_BUILDER.buildsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const b = loadBuild(id);
    if (b) out.push(summarize(b));
  }
  out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out.slice(0, limit);
}
function summarize(b) {
  return {
    id: b.id, prNumber: b.prNumber, version: b.version, status: b.status,
    products: b.products, createdAt: b.createdAt, startedAt: b.startedAt,
    finishedAt: b.finishedAt, durationMs: b.durationMs,
    site: b.site, verification: b.verification, adminUrl: b.adminUrl, error: b.error,
  };
}
function readLogLines(id) {
  try {
    return fs.readFileSync(logPath(id), 'utf8').split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
}

/* --------------------------------- logging -------------------------------- */

function emit(id, payload) {
  events.emit('update', id, payload);
}
function stamp(line) {
  return `[${new Date().toISOString()}] ${line}`;
}
function sendLog(line) {
  if (!current) return;
  const text = stamp(line);
  try { current.logStream.write(text + '\n'); } catch (_) {}
  emit(current.build.id, { kind: 'log', line: text });
}

/* ------------------------------ process helpers --------------------------- */

/** Run a command via Git Bash, buffering stdout. Used for gh/git queries that
 *  need parsed output. Rejects with stderr on non-zero exit. */
function sh(cmd, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(BASH, ['-c', cmd], {
      cwd: cwd || undefined,
      env: { ...childEnv(), ...(env || {}) },
      windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}: ${cmd}`))
    );
  });
}

/** Run a build/git/npm/unzip command via Git Bash, streaming output to the log
 *  and tracking the child for cancellation. Rejects on non-zero / cancel. */
function runCmd(cmd, cwd) {
  return new Promise((resolve, reject) => {
    if (current && current.cancelled) return reject(new Error('cancelled'));
    sendLog(`$ ${cmd}`);
    const c = current; // capture this build so a late close can't touch a later one
    const child = spawn(BASH, ['-c', cmd], {
      cwd: cwd || undefined,
      env: childEnv(),
      windowsHide: true,
    });
    if (c) c.child = child;
    const clearChild = () => { if (c && c.child === child) c.child = null; };

    let buf = '';
    const onData = (prefix) => (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        sendLog(prefix + line);
      }
    };
    child.stdout.on('data', onData(''));
    child.stderr.on('data', onData('[stderr] '));

    child.on('error', (err) => {
      clearChild();
      reject(err);
    });
    child.on('close', (code) => {
      if (buf.trim()) sendLog(buf);
      clearChild();
      if (c && c.cancelled) return reject(new Error('cancelled'));
      if (code === 0) resolve();
      else reject(new Error(`Command failed (exit ${code}): ${cmd}`));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** runCmd with retries — for network git fetches that can fail on a transient
 *  DNS/connection blip. The fetches are idempotent, so retrying is safe. */
async function runCmdRetry(cmd, cwd, { tries = 3, delayMs = 3000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runCmd(cmd, cwd);
    } catch (err) {
      if ((current && current.cancelled) || attempt >= tries) throw err;
      sendLog(`[retry] attempt ${attempt}/${tries} failed (${err.message}); retrying in ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }
  }
}

/** sh() with retries — for `gh` API calls that can fail on a transient
 *  api.github.com blip. Retries cost nothing on the happy path. */
async function shRetry(cmd, opts = {}) {
  const { tries = 3, delayMs = 3000, ...rest } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      return await sh(cmd, rest);
    } catch (err) {
      if ((current && current.cancelled) || attempt >= tries) throw err;
      if (current) sendLog(`[retry] gh call failed (${String(err.message).split('\n')[0]}); retrying in ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }
  }
}

/** Run wp-cli (bundled PHP + vendored phar) directly, streaming to the log. */
function runWpCli(site, php, args, { skipPlugins = true, skipThemes = true } = {}) {
  return new Promise((resolve, reject) => {
    if (current && current.cancelled) return reject(new Error('cancelled'));
    const { file, argv } = localenv.buildWpCli({
      site, php, wpCliPhar: PR_BUILDER.wpCliPhar,
      extensions: PR_BUILDER.phpExtensions, args, skipPlugins, skipThemes,
    });
    sendLog(`$ wp ${args.join(' ')}`);
    const c = current;
    const child = spawn(file, argv, { env: childEnv(), windowsHide: true });
    if (c) c.child = child;
    const clearChild = () => { if (c && c.child === child) c.child = null; };
    let buf = '';
    const onData = (prefix) => (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        sendLog(prefix + buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    };
    child.stdout.on('data', onData(''));
    child.stderr.on('data', onData('[wp] '));
    child.on('error', (err) => { clearChild(); reject(err); });
    child.on('close', (code) => {
      if (buf.trim()) sendLog(buf);
      clearChild();
      if (c && c.cancelled) return reject(new Error('cancelled'));
      code === 0 ? resolve() : reject(new Error(`wp ${args.join(' ')} exited ${code}`));
    });
  });
}

/** Quiet wp-cli probe (no streaming) — returns true if WordPress/DB answers. */
function probeSite(site, php) {
  const { file, argv } = localenv.buildWpCli({
    site, php, wpCliPhar: PR_BUILDER.wpCliPhar,
    extensions: PR_BUILDER.phpExtensions,
    args: ['option', 'get', 'siteurl'], skipPlugins: true, skipThemes: true,
  });
  const r = spawnSync(file, argv, { env: childEnv(), windowsHide: true, encoding: 'utf8' });
  return r.status === 0 && /^https?:\/\//.test((r.stdout || '').trim());
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); }
    catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
  } else {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}

function md5File(p) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
  } catch (_) {
    return null;
  }
}

/* ------------------------------ GitHub queries ---------------------------- */

async function listMilestones() {
  const out = await shRetry(
    `gh api 'repos/${P.REPO}/milestones?state=open&per_page=100&sort=due_on&direction=asc'`
  );
  return JSON.parse(out).map((m) => ({
    number: m.number, title: m.title, openIssues: m.open_issues, dueOn: m.due_on,
  }));
}

async function listPRs({ milestoneTitle, limit } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const state = milestoneTitle ? 'all' : 'open';
  // Pass the milestone title via env var so titles with spaces/quotes can't
  // break the shell command.
  const searchFlag = milestoneTitle ? `--search "milestone:\\"$MS_TITLE\\""` : '';
  const cmd =
    `gh pr list --repo ${P.REPO} --state ${state} ${searchFlag} --limit ${n} ` +
    `--json number,title,headRefName,author,updatedAt,state,mergedAt,closedAt`;
  const out = await shRetry(cmd, { env: milestoneTitle ? { MS_TITLE: milestoneTitle } : undefined });
  return JSON.parse(out).map((p) => ({
    number: p.number, title: p.title, headRefName: p.headRefName,
    author: p.author && p.author.login, updatedAt: p.updatedAt,
    state: p.state, mergedAt: p.mergedAt, closedAt: p.closedAt,
  }));
}

async function recommend(prNumber) {
  if (!/^\d+$/.test(String(prNumber))) throw new Error('PR number must be digits.');
  const out = await shRetry(
    `gh api repos/${P.REPO}/pulls/${prNumber}/files --paginate --jq '.[].filename'`
  );
  const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
  const { directlyImpacted, products } = P.recommendProducts(files);
  return { totalFiles: files.length, directlyImpacted, products };
}

/* ------------------------- run tests on the built site -------------------- */

/**
 * Resolve a "run the suite against the PR-built site" request into an
 * orchestrator custom target (single-site mode: PLAYWRIGHT_BASE_URL + admin
 * creds, no THRIVE_SITE). Scope:
 *   - all: true            → every test (`tests/`)
 *   - products: [slug]     → built products mapped to their test areas
 *   - areas: [siteKey]     → explicit test areas (config.SITES keys)
 *   - grep: string         → keyword filter (e.g. a bug number)
 * Returns { target, label } for orchestrator.startRun([target], label).
 */
function buildTestTarget({ all = false, areas = [], products = [], grep } = {}) {
  const site = localenv.getLocalSite(PR_BUILDER.siteDomain);

  let paths;
  let scopeLabel;
  if (all) {
    paths = ['tests/'];
    scopeLabel = 'all tests';
  } else {
    const areaSet = new Set();
    for (const a of areas) if (SITES[a]) areaSet.add(a);
    for (const p of products) {
      const a = P.PRODUCT_TO_TEST_AREA[p];
      if (a && SITES[a]) areaSet.add(a);
    }
    if (!areaSet.size) {
      throw new Error('Select at least one product/area to test, or choose "all tests".');
    }
    paths = [];
    for (const a of areaSet) for (const d of SITES[a].testDirs) paths.push(`tests/${d}/`);
    scopeLabel = [...areaSet].map((a) => SITES[a].name).join(', ');
  }

  const label = `🧪 ${site.name} · ${scopeLabel}` + (grep ? ` · grep:${grep}` : '');
  const target = {
    site: 'pr-builder-4platform',
    name: site.name,
    url: site.url,
    baseUrl: site.url,
    env: { ...PR_BUILDER.testEnv },
    paths,
    grep: grep || undefined,
  };
  return { target, label };
}

/* --------------------------- worktree source patches ---------------------- */

/** 3c. Rewrite relative `../tools/` refs in package.json to absolute worktree
 *  paths (the release tool copies products into .tmp-build, breaking relatives). */
async function patchToolsRefs(dir, worktreePath, depth = 0) {
  if (depth > 3) return 0;
  let touched = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      touched += await patchToolsRefs(full, worktreePath, depth + 1);
    } else if (ent.name === 'package.json') {
      try {
        const raw = await fsp.readFile(full, 'utf8');
        const fwd = worktreePath.replace(/\\/g, '/');
        const next = raw.replace(/(\.\.\/)+tools\//g, `${fwd}/tools/`);
        if (next !== raw) { await fsp.writeFile(full, next); touched++; }
      } catch (_) {}
    }
  }
  return touched;
}

/** 3d + 3e: fix the theme version-injection target and loosen the version
 *  validator (our `100.PR<N>` stamps contain letters the default regex rejects). */
async function patchReleaseTool(worktreePath) {
  const cfgPath = path.join(worktreePath, 'tools/thrive-release/config.js');
  if (fs.existsSync(cfgPath)) {
    let cfg = await fsp.readFile(cfgPath, 'utf8');
    cfg = cfg.replace(
      "{ file: 'style.css', pattern: /Version: 0\\.dev/, replacement: 'Version: $VERSION$' }",
      () => `{ file: 'webpack.config.js', pattern: /const themeVersion = '0\\.dev';/, replacement: "const themeVersion = '$VERSION$';" }`
    );
    await fsp.writeFile(cfgPath, cfg);
  }
  const idxPath = path.join(worktreePath, 'tools/thrive-release/index.js');
  if (fs.existsSync(idxPath)) {
    let idx = await fsp.readFile(idxPath, 'utf8');
    idx = idx.replace(
      'if (!options.version.match(/^\\d+\\.\\d+(\\.\\d+)?(\\.\\d+)?(-\\w+)?$/)) {',
      'if (!options.version.match(/^[\\w.+-]+$/)) {'
    );
    await fsp.writeFile(idxPath, idx);
  }
}

/** Patch the release tool's builder.js so it skips POSIX nvm on Windows and
 *  runs builds under the current Node. Ported from the add-on's
 *  windowsBuilderPatch.js (git reset restores the file each run, so reapply). */
function patchBuilderForWindows(worktreePath) {
  const MARKER = "const hasNvm = process.platform !== 'win32' && fs.existsSync(nvmScript);";
  const SEARCH = [
    'const nvmDir = process.env.NVM_DIR || `${process.env.HOME}/.nvm`;',
    '    const nvmScript = `${nvmDir}/nvm.sh`;',
    '',
    '    // Extract nodeVersion from options if provided',
    '    const nodeVersion = options.nodeVersion;',
    '    delete options.nodeVersion; // Remove from options to avoid passing to execSync',
    '',
    '    // Build the command with proper nvm setup and version switching',
    '    let wrappedCommand = `source ${nvmScript}`;',
  ];
  const REPLACE = [
    'const nvmDir = process.env.NVM_DIR || `${process.env.HOME || process.env.USERPROFILE}/.nvm`;',
    '    const nvmScript = `${nvmDir}/nvm.sh`;',
    '    ' + MARKER,
    '',
    '    // Extract nodeVersion from options if provided',
    '    const nodeVersion = options.nodeVersion;',
    '    delete options.nodeVersion; // Remove from options to avoid passing to execSync',
    '',
    '    // No POSIX nvm available (Windows). Run under the current Node version.',
    '    if (!hasNvm) {',
    '      try {',
    '        return execSync(command, options);',
    '      } catch (error) {',
    '        const enhancedError = new Error(`Command failed: ${command}`);',
    '        enhancedError.originalError = error;',
    '        enhancedError.command = command;',
    '        enhancedError.stdout = error.stdout ? error.stdout.toString() : "";',
    '        enhancedError.stderr = error.stderr ? error.stderr.toString() : "";',
    '        throw enhancedError;',
    '      }',
    '    }',
    '',
    '    // Build the command with proper nvm setup and version switching',
    '    let wrappedCommand = `source ${nvmScript}`;',
  ];
  try {
    const builderPath = path.join(worktreePath, 'tools', 'thrive-release', 'lib', 'builder.js');
    if (!fs.existsSync(builderPath)) { sendLog('[warn] builder.js not found; skipping Windows nvm patch.'); return; }
    let src = fs.readFileSync(builderPath, 'utf8');
    if (src.indexOf(MARKER) !== -1) { sendLog('builder.js already patched for Windows nvm.'); return; }
    const eol = src.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
    const search = SEARCH.join(eol);
    if (src.indexOf(search) === -1) { sendLog('[warn] builder.js shape unexpected; skipping Windows nvm patch.'); return; }
    src = src.replace(search, REPLACE.join(eol));
    fs.writeFileSync(builderPath, src);
    sendLog('Patched builder.js for Windows nvm compatibility.');
  } catch (e) {
    sendLog('[warn] could not patch builder.js: ' + (e && e.message ? e.message : e));
  }
}

/* --------------------------------- build ---------------------------------- */

function makeBuildId(prNumber) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${s}_pr${prNumber}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Start a PR build. Fire-and-forget; progress via the events emitter.
 * @param {{prNumber:string, version?:string, products?:string[], scope?:string,
 *          cleanWP?:boolean, keepTPM?:boolean, forceClean?:boolean}} payload
 */
function startBuild(payload) {
  if (current) throw new Error('A build is already in progress. Wait for it to finish or cancel it.');
  const prNumber = String((payload && payload.prNumber) || '').trim();
  if (!/^\d+$/.test(prNumber)) throw new Error('A numeric PR number is required.');

  // Resolve products: explicit selection → closeDeps; else full suite.
  const scope = payload.scope || (payload.products && payload.products.length ? 'custom' : 'all');
  let products;
  if (scope === 'all') {
    products = P.ALL_PRODUCTS.slice();
  } else {
    const valid = (payload.products || []).filter((s) => P.ALL_PRODUCTS.includes(s));
    if (!valid.length) {
      // Smart-pick found nothing buildable — don't silently fall back to the
      // full 12-product suite (a surprising, very slow build).
      throw new Error(
        'This PR touches no buildable product (e.g. only docs/CI/tooling changed). ' +
        'Choose the "All 12 products" scope if you want to build the full suite anyway.'
      );
    }
    products = P.closeDeps(valid);
  }
  const cleanWP = !!payload.cleanWP;
  const keepTPM = payload.keepTPM !== false; // preserve TPM on clean unless told otherwise
  if (cleanWP && !products.includes('product-manager')) {
    products = P.closeDeps([...products, 'product-manager']);
  }

  const version = String(payload.version || P.buildDefaultVersion({ prNumber })).trim();
  const id = makeBuildId(prNumber);

  const build = {
    id, prNumber, version, products, cleanWP, keepTPM,
    forceClean: payload.forceClean !== false, // default on, like the add-on
    status: 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null, durationMs: null,
    site: { domain: PR_BUILDER.siteDomain },
    verification: null, adminUrl: null, error: null,
  };

  ensureDir(buildDir(id));
  const logStream = fs.createWriteStream(logPath(id), { flags: 'w' });
  current = { build, child: null, cancelled: false, logStream };
  saveBuild(build);

  executeBuild().catch((err) => {
    if (!current) return;
    const b = current.build;
    b.status = current.cancelled ? 'cancelled' : 'error';
    b.error = String(err && err.message ? err.message : err);
    sendLog(b.status === 'cancelled' ? 'Build cancelled.' : `ERROR: ${b.error}`);
    finalize();
  });

  return { id };
}

async function executeBuild() {
  const build = current.build;
  emit(build.id, { kind: 'build-start', build: summarize(build) });
  sendLog(`PR Builder — building PR #${build.prNumber} (version ${build.version})`);

  // 0. Resolve environment.
  const repoPath = localenv.resolveMonorepoPath();
  if (!repoPath) {
    throw new Error(
      'thrive-themes monorepo not found. Expected the add-on config at ' +
      '~/.local-addon-thrive-pr-builder/config.json or a checkout under your home dir.'
    );
  }
  sendLog(`Monorepo: ${repoPath}`);
  const site = localenv.getLocalSite(PR_BUILDER.siteDomain);
  build.site = { domain: site.domain, name: site.name, url: site.url, webRoot: site.webRoot };
  build.adminUrl = `${site.url.replace(/\/$/, '')}/wp-admin/`;
  const php = localenv.resolvePhp(site.phpVersion);
  sendLog(`Target site: ${site.name} (${site.domain}) — ${site.webRoot}`);
  sendLog(`PHP: ${php.dir}  ·  MySQL port: ${site.mysqlPort}`);
  saveBuild(build);

  // 0a. The add-on starts the site via Local's API; we can't, so fail fast with
  //     a clear message if the site DB isn't answering.
  sendLog('Checking the site is running...');
  if (!probeSite(site, php)) {
    throw new Error(
      `Site "${site.domain}" isn't responding (DB on port ${site.mysqlPort}). ` +
      `Start it in Local first, then re-run the build.`
    );
  }
  sendLog('Site is running.');

  const worktreePath = PR_BUILDER.worktree;
  const releaseToolPath = path.join(worktreePath, 'tools/thrive-release');

  // 1. Ensure dedicated worktree.
  if (!fs.existsSync(path.join(worktreePath, '.git'))) {
    sendLog(`Creating dedicated git worktree at ${worktreePath}...`);
    ensureDir(path.dirname(worktreePath));
    await runCmd('git worktree prune', repoPath);
    await runCmd(`git worktree add --detach "${worktreePath}" HEAD`, repoPath);
  }

  // 2. Fetch the PR head and hard-reset the worktree to it.
  sendLog(`Fetching PR #${build.prNumber}...`);
  await runCmdRetry(`git fetch origin "pull/${build.prNumber}/head"`, worktreePath);
  await runCmd('git reset --hard FETCH_HEAD', worktreePath);

  // 2a. Merge the PR's base branch (so base-only fixes are in scope), exactly
  //     like CI builds the merge commit. A genuine conflict is fatal with a
  //     clear "rebase" message; other merge failures are fatal too (a poisoned
  //     worktree would ruin the build); only failing to *resolve* the base ref
  //     (gh down) is a soft warning that builds the PR head as-is.
  let baseRef = null;
  try {
    baseRef = (await shRetry(
      `gh pr view ${build.prNumber} --repo ${P.REPO} --json baseRefName --jq .baseRefName`
    )).trim();
  } catch (e) {
    sendLog(`[warn] could not resolve base branch (building PR head as-is): ${e.message}`);
  }
  if (baseRef) {
    sendLog(`Merging origin/${baseRef} into PR head...`);
    await runCmdRetry(`git fetch origin ${baseRef}`, worktreePath);
    try {
      await runCmd(
        `git -c user.name=pr-builder -c user.email=pr-builder@local merge --no-edit --no-ff origin/${baseRef}`,
        worktreePath
      );
    } catch (mergeErr) {
      // `git ls-files -u` lists unmerged (conflicted) paths — non-empty ⇒ a
      // real content conflict, as opposed to e.g. a locked/dirty worktree.
      let conflict = false;
      try { conflict = (await sh(`git -C "${worktreePath}" ls-files -u`)).trim().length > 0; } catch (_) {}
      await runCmd('git merge --abort', worktreePath).catch(() => {});
      throw new Error(
        conflict
          ? `PR #${build.prNumber} has merge conflicts with origin/${baseRef}. ` +
            `Rebase the PR locally and push before re-running.`
          : `Failed to merge origin/${baseRef} into PR #${build.prNumber}: ${mergeErr.message}`
      );
    }
  }

  // 3. Release-tool deps (idempotent).
  if (!fs.existsSync(path.join(releaseToolPath, 'node_modules'))) {
    sendLog('Installing thrive-release dependencies...');
    await runCmd('npm install --no-fund --no-audit', releaseToolPath);
  }

  // 3a. forceClean → wipe the release cache; always wipe release/ and .tmp-build.
  if (build.forceClean) {
    sendLog('Force clean: removing release tool .cache/ ...');
    await fsp.rm(path.join(releaseToolPath, '.cache'), { recursive: true, force: true });
  }
  await fsp.rm(path.join(releaseToolPath, 'release'), { recursive: true, force: true });
  await fsp.rm(path.join(worktreePath, '.tmp-build'), { recursive: true, force: true });

  // 3c–3e + Windows nvm patch (worktree was reset, so reapply each run).
  sendLog('Patching relative tool paths for isolated build...');
  const n = await patchToolsRefs(worktreePath, worktreePath, 0);
  sendLog(`  rewrote ../tools/ references in ${n} package.json file(s).`);
  await patchReleaseTool(worktreePath);
  patchBuilderForWindows(worktreePath);

  // 4. Build.
  sendLog(`Building ${build.products.length} product(s): ${build.products.join(', ')}`);
  await runCmd(
    `node index.js build -v ${build.version} --products ${build.products.join(',')} --verbose`,
    releaseToolPath
  );

  // 4b. Optional wp-content cleanup.
  const pluginsDir = site.pluginsDir;
  const themesDir = site.themesDir;
  if (build.cleanWP) {
    sendLog('Cleaning plugins folder...');
    const keep = new Set(['index.php']);
    if (build.keepTPM) keep.add('thrive-product-manager');
    for (const entry of await fsp.readdir(pluginsDir)) {
      if (keep.has(entry)) continue;
      await fsp.rm(path.join(pluginsDir, entry), { recursive: true, force: true });
      sendLog(`  removed ${entry}`);
    }
    const themePath = path.join(themesDir, 'thrive-theme');
    if (fs.existsSync(themePath)) {
      await fsp.rm(themePath, { recursive: true, force: true });
      sendLog('  removed themes/thrive-theme');
    }
    // Ensure a fallback theme so validate_current_theme() doesn't fatal.
    try {
      const remaining = (await fsp.readdir(themesDir)).filter((e) => !e.startsWith('.') && e !== 'index.php');
      if (!remaining.includes('twentytwentyfive')) {
        sendLog('Installing Twenty Twenty-Five as fallback theme...');
        await runWpCli(site, php, ['theme', 'install', 'twentytwentyfive', '--activate'], { skipThemes: false });
      } else {
        sendLog('Activating Twenty Twenty-Five as fallback theme...');
        await runWpCli(site, php, ['theme', 'activate', 'twentytwentyfive'], { skipThemes: false });
      }
    } catch (e) {
      sendLog(`[warn] could not switch fallback theme: ${e.message}`);
    }
  }

  // 5. Install built ZIPs (TPM first, others, dashboard last).
  sendLog('Installing built plugins...');
  const releaseDir = path.join(releaseToolPath, 'release');
  const allFiles = await fsp.readdir(releaseDir);
  const expectedPrefixes = build.products.map((s) => P.PRODUCT_ZIP_PREFIX[s]).filter(Boolean);
  const zips = allFiles.filter((f) =>
    f.endsWith('.zip') && f.includes(build.version) &&
    expectedPrefixes.some((prefix) => f.startsWith(`${prefix}-`))
  );
  if (zips.length === 0) {
    throw new Error(`No ZIPs matching version ${build.version} for built products [${build.products.join(', ')}] in ${releaseDir}`);
  }
  const tpmZip = zips.find((z) => z.includes('thrive-product-manager'));
  const dashboardZip = zips.find((z) => z.includes('thrive-dashboard'));
  const otherZips = zips.filter((z) => z !== tpmZip && z !== dashboardZip);
  const targetDirFor = (zipFile) => {
    const slug = zipFile.replace(/-\d.*\.zip$/, '');
    return P.THEME_ZIPS.has(slug) ? themesDir : pluginsDir;
  };
  const extractZip = async (zipFile) => {
    const dest = targetDirFor(zipFile);
    sendLog(`  extracting ${zipFile} → ${dest === themesDir ? 'theme' : 'plugin'}`);
    ensureDir(dest);
    // Forward-slash the dest for Git Bash's unzip — a backslash Windows path
    // ("…\Local Sites\…\plugins") survives quoting but unzip handles `/` more
    // reliably (same trick patchToolsRefs uses for the worktree path).
    await runCmd(`unzip -o -q "${zipFile}" -d "${dest.replace(/\\/g, '/')}"`, releaseDir);
  };
  if (tpmZip) await extractZip(tpmZip);
  for (const z of otherZips) await extractZip(z);
  if (dashboardZip) await extractZip(dashboardZip);

  // 6. Activate.
  sendLog('Activating plugins via wp-cli...');
  try {
    await runWpCli(site, php, ['plugin', 'activate', '--all'], { skipPlugins: false });
    const installedTheme = zips.find((z) => P.THEME_ZIPS.has(z.replace(/-\d.*\.zip$/, '')));
    if (installedTheme) {
      const themeSlug = installedTheme.replace(/-\d.*\.zip$/, '');
      sendLog(`Activating theme ${themeSlug}...`);
      await runWpCli(site, php, ['theme', 'activate', themeSlug], { skipThemes: false });
    }
  } catch (e) {
    sendLog(`[warn] wp-cli activation issue: ${e.message}`);
  }

  sendLog('Build and install completed successfully!');

  // 7. Verify PR-changed files landed.
  try {
    sendLog('---');
    sendLog('Verifying installed files match PR diff...');
    const filesOut = await shRetry(
      `gh api repos/${P.REPO}/pulls/${build.prNumber}/files --paginate --jq '.[] | "\\(.status)\\t\\(.filename)"'`
    );
    const prFiles = filesOut.split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
      const [status, filename] = line.split('\t');
      return { status, filename };
    });
    const builtSlugs = new Set(build.products);
    const stats = { match: 0, stamped: 0, mismatch: 0, missing: 0, skipped: 0, skippedBundled: 0, removed: 0, removedOk: 0 };
    const issues = [];
    for (const { status, filename: file } of prFiles) {
      const mapping = P.SOURCE_TO_PRODUCT.find(([prefix]) => file.startsWith(prefix));
      if (!mapping) { stats.skipped++; continue; }
      const [prefix, productSlug] = mapping;
      if (!builtSlugs.has(productSlug)) { stats.skipped++; continue; }
      if (P.isSourceOnly(file)) { stats.skippedBundled++; continue; }
      const installFolder = P.PRODUCT_INSTALL_FOLDER[productSlug];
      const installRoot = productSlug === 'theme' ? themesDir : pluginsDir;
      const installedPath = path.join(installRoot, installFolder, file.slice(prefix.length));
      const srcPath = path.join(worktreePath, file);
      if (status === 'removed') {
        if (!fs.existsSync(installedPath)) stats.removedOk++;
        else { stats.removed++; issues.push(`✗ removed in PR but still on disk: ${file}`); }
        continue;
      }
      if (!fs.existsSync(installedPath)) { stats.missing++; issues.push(`✗ missing on disk: ${file}`); continue; }
      const srcHash = md5File(srcPath), dstHash = md5File(installedPath);
      if (!srcHash || !dstHash) { stats.missing++; issues.push(`✗ unreadable: ${file}`); continue; }
      if (srcHash === dstHash) { stats.match++; continue; }
      const installedText = fs.readFileSync(installedPath, 'utf8');
      if (installedText.includes(`Version: ${build.version}`) || installedText.includes(`return '${build.version}'`)) {
        stats.stamped++;
      } else { stats.mismatch++; issues.push(`⚠ hash differs (no version stamp): ${file}`); }
    }
    sendLog(`  ✓ exact match:        ${stats.match}`);
    sendLog(`  ✓ version-stamped:    ${stats.stamped}`);
    sendLog(`  ✓ removed (gone):     ${stats.removedOk}`);
    sendLog(`  ⚠ hash mismatch:      ${stats.mismatch}`);
    sendLog(`  ✗ missing on disk:    ${stats.missing}`);
    sendLog(`  ✗ removed but found:  ${stats.removed}`);
    sendLog(`  – skipped (bundled):  ${stats.skippedBundled}`);
    sendLog(`  – skipped (other):    ${stats.skipped}`);
    if (issues.length) {
      sendLog('Issues:');
      issues.slice(0, 30).forEach((i) => sendLog(`    ${i}`));
      if (issues.length > 30) sendLog(`    ... +${issues.length - 30} more`);
    }
    const ok = stats.mismatch + stats.missing + stats.removed === 0;
    sendLog(ok ? '✅ PR content fully present in this site.' : '⚠️  Some PR-changed files do not match — review issues above.');
    sendLog('---');
    build.verification = { ...stats, ok };
  } catch (e) {
    sendLog(`[warn] could not verify install: ${e.message}`);
  }

  sendLog(`Done. Open ${build.adminUrl}`);
  build.status = 'passed';
  finalize();
}

function finalize() {
  if (!current) return;
  const build = current.build;
  build.finishedAt = new Date().toISOString();
  build.durationMs = new Date(build.finishedAt) - new Date(build.startedAt);
  try { current.logStream.end(); } catch (_) {}
  saveBuild(build);
  emit(build.id, { kind: 'build-end', build: summarize(build) });
  current = null;
}

function cancelBuild(id) {
  if (!current || current.build.id !== id) return false;
  current.cancelled = true;
  current.build.status = 'cancelled';
  sendLog('Cancelling build...');
  killTree(current.child);
  emit(id, { kind: 'cancelling', id });
  return true;
}

/* ------------------------------- snapshots -------------------------------- */

function getActive() {
  return current ? summarize(current.build) : null;
}

function shutdown() {
  if (!current) return;
  killTree(current.child);
  current.cancelled = true;
  current.build.status = 'interrupted';
  current.build.finishedAt = current.build.finishedAt || new Date().toISOString();
  if (current.build.startedAt) {
    current.build.durationMs = new Date(current.build.finishedAt) - new Date(current.build.startedAt);
  }
  try { current.logStream.end(); } catch (_) {}
  try { saveBuild(current.build); } catch (_) {}
  current = null;
}

function recoverInterrupted() {
  for (const summary of listBuilds({ limit: 1000 })) {
    if (summary.status !== 'running') continue;
    const b = loadBuild(summary.id);
    if (b && b.status === 'running') {
      b.status = 'interrupted';
      b.finishedAt = b.finishedAt || new Date().toISOString();
      saveBuild(b);
    }
  }
}

module.exports = {
  events,
  listMilestones,
  listPRs,
  recommend,
  buildTestTarget,
  startBuild,
  cancelBuild,
  getActive,
  listBuilds,
  loadBuild,
  readLogLines,
  shutdown,
  recoverInterrupted,
};
