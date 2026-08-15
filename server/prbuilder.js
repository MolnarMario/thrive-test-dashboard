'use strict';

/**
 * PR Builder engine.
 *
 * Builds a GitHub PR for a configured WordPress plugin/theme project (see
 * pr-builder.config.json / server/pr-projects.js) in a dedicated detached git
 * worktree, installs the result into that project's Local site, activates it
 * via wp-cli (Local's bundled PHP + vendored wp-cli.phar, see localenv.js) and
 * verifies the PR's changed files landed on disk.
 *
 * We can't start a Local site from outside Local's Electron host, so we probe
 * the DB via wp-cli and fail fast with "start it in Local first" instead.
 *
 * Like orchestrator.js: one build at a time, child processes tracked for
 * cancel, progress streamed over an EventEmitter for SSE, records persisted.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const { PR_BUILDER, SUITES, DEFAULT_SUITE } = require('../config');
const localenv = require('./localenv');
const PJ = require('./pr-projects');

const events = new EventEmitter();
const BASH = localenv.resolveBashPath();

/** Git Bash handles forward slashes far more reliably than Windows backslashes
 *  once a path has been through shell quoting. */
const toPosix = (p) => String(p).replace(/\\/g, '/');

/** Child env with NODE_ENV stripped — a production NODE_ENV makes a project's
 *  `npm install` drop devDependencies (webpack et al) and the build fails. */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_ENV;
  return env;
}

/* --------------------------------- state ---------------------------------- */

/** The single in-flight build, or null. (One build at a time.) */
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
    project: b.project, cleanInstall: b.cleanInstall,
    createdAt: b.createdAt, startedAt: b.startedAt,
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

/** Run a build/git/npm command via Git Bash, streaming output to the log and
 *  tracking the child for cancellation. Rejects on non-zero / cancel. */
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

/** Open PRs for a project's repo (state: 'open' | 'all'). */
async function listPRs({ project: projectKey, limit, state = 'open' } = {}) {
  const project = PJ.getProject(projectKey);
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const st = state === 'all' ? 'all' : 'open';
  const out = await shRetry(
    `gh pr list --repo ${project.repo} --state ${st} --limit ${n} ` +
      `--json number,title,headRefName,author,updatedAt,state,mergedAt,closedAt`
  );
  return JSON.parse(out).map((p) => ({
    number: p.number, title: p.title, headRefName: p.headRefName,
    author: p.author && p.author.login, updatedAt: p.updatedAt,
    state: p.state, mergedAt: p.mergedAt, closedAt: p.closedAt,
  }));
}

/* ------------------------- run tests on the built site -------------------- */

/**
 * Resolve a "run a suite against the PR-built site" request into an
 * orchestrator custom target — one that carries its own baseUrl instead of
 * naming a registered site, because the PR-built Local site isn't in the config.
 *
 * Scope:
 *   - all: true         → every test in the suite
 *   - areas: [scopeKey] → named scopes of the chosen suite
 *   - (neither)         → the project's configured testAreas
 *   - grep: string      → keyword filter (frameworks that support one)
 *
 * Returns { target, label } for orchestrator.startRun([target], label).
 */
function buildTestTarget({ project: projectKey, suite: suiteKey, all = false, areas = [], grep } = {}) {
  const project = PJ.getProject(projectKey);
  const site = localenv.getLocalSite(project.site);

  const suite = SUITES[suiteKey || project.suite || DEFAULT_SUITE];
  if (!suite) {
    throw new Error(
      `No test suite configured to run against the PR build. Add one to ` +
        `sites.config.json, or set "suite" on the project in pr-builder.config.json.`
    );
  }

  let paths;
  let scopeLabel;
  if (all || !suite.scopes.length) {
    paths = [''];
    scopeLabel = 'all tests';
  } else {
    const byKey = new Map(suite.scopes.map((s) => [s.key, s]));
    const wanted = (areas.length ? areas : project.testAreas || []).filter((a) => byKey.has(a));
    if (!wanted.length) {
      throw new Error(
        `No test areas resolved for "${project.name}". Set "testAreas" in ` +
          `pr-builder.config.json (scope keys from suite "${suite.key}"), pick ` +
          `areas explicitly, or choose "all tests".`
      );
    }
    paths = wanted.flatMap((a) =>
      byKey.get(a).dirs.map((d) => (!d || d === '.' ? '' : d.replace(/\\/g, '/').replace(/\/?$/, '/')))
    );
    scopeLabel = wanted.map((a) => byKey.get(a).name).join(', ');
  }

  const fwLabel = suite.framework || (suite.frameworks || []).map((f) => f.id).join('+');
  const label =
    `🧪 ${project.name} · ${suite.name} (${fwLabel}) · ${scopeLabel}` +
    (grep ? ` · grep:${grep}` : '');
  const target = {
    suite: suite.key,
    // Namespaced so the orchestrator's busy guard is per project and two
    // projects never block each other.
    site: `pr:${project.key}`,
    name: `${project.name} (PR build)`,
    url: site.url,
    baseUrl: site.url,
    env: { ...PR_BUILDER.testEnv },
    paths,
    grep: grep || undefined,
  };
  return { target, label };
}

/* ------------------------------ install helpers --------------------------- */

/**
 * Recursively copy srcRoot → destRoot, skipping `exclude` entries (matched
 * against both the bare entry name and its path relative to srcRoot).
 * Returns the number of files copied.
 */
async function copyTree(srcRoot, destRoot, exclude) {
  const ex = new Set(
    (exclude || []).map((e) => toPosix(e).replace(/^\.\//, '').replace(/\/+$/, ''))
  );
  let files = 0;

  async function walk(rel) {
    const abs = rel ? path.join(srcRoot, rel) : srcRoot;
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (ex.has(e.name) || ex.has(relPath)) continue;
      const from = path.join(srcRoot, relPath);
      const to = path.join(destRoot, relPath);
      if (e.isDirectory()) {
        await fsp.mkdir(to, { recursive: true });
        await walk(relPath);
      } else {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(from, to);
        files++;
      }
    }
  }

  await fsp.mkdir(destRoot, { recursive: true });
  await walk('');
  return files;
}

/** Find the PHP file carrying the "Plugin Name:" header in an installed plugin. */
async function findPluginHeaderFile(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return null; }
  const phps = entries.filter((e) => e.isFile() && e.name.endsWith('.php'));
  for (const e of phps) {
    const p = path.join(dir, e.name);
    try {
      const head = (await fsp.readFile(p, 'utf8')).slice(0, 8192);
      if (/Plugin Name:/i.test(head)) return p;
    } catch (_) {}
  }
  return null;
}

/**
 * Rewrite the `Version:` header of the *installed* copy so the build is
 * identifiable in wp-admin. Deliberately not applied to the worktree, so the
 * git checkout stays pristine between builds.
 */
async function stampVersion(destDir, project, version) {
  const target = project.kind === 'theme'
    ? path.join(destDir, 'style.css')
    : await findPluginHeaderFile(destDir);
  if (!target || !fs.existsSync(target)) {
    sendLog('[warn] no plugin/theme header file found — skipping version stamp.');
    return null;
  }
  const src = await fsp.readFile(target, 'utf8');
  const VERSION_RE = /^([ \t]*\*?[ \t]*Version:[ \t]*).+$/mi;
  if (!VERSION_RE.test(src)) {
    sendLog(`[warn] no "Version:" header in ${path.basename(target)} — skipping version stamp.`);
    return null;
  }
  await fsp.writeFile(target, src.replace(VERSION_RE, `$1${version}`));
  sendLog(`Stamped version ${version} into ${path.basename(target)}.`);
  return target;
}

/* --------------------------------- build ---------------------------------- */

function makeBuildId(prNumber) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${s}_pr${prNumber}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Per-project checkout locations under PR_BUILDER.home. */
function projectPaths(project) {
  const base = path.join(PR_BUILDER.home, project.key);
  return { base, repoDir: path.join(base, 'repo'), worktreePath: path.join(base, 'worktree') };
}

/**
 * Start a PR build. Fire-and-forget; progress via the events emitter.
 * @param {{pr:string|number, project?:string, version?:string,
 *          cleanInstall?:boolean}} payload
 */
function startBuild(payload) {
  if (current) throw new Error('A build is already in progress. Wait for it to finish or cancel it.');

  const { prNumber, repo } = PJ.parsePrRef(payload && payload.pr);

  // Resolve the project: explicit selection wins; otherwise infer from a pasted
  // PR URL; otherwise fall back to the sole configured project.
  let project;
  if (payload && payload.project) {
    project = PJ.getProject(payload.project);
    if (repo && repo.toLowerCase() !== project.repo.toLowerCase()) {
      throw new Error(
        `That PR is for ${repo}, but the selected project "${project.name}" builds ${project.repo}.`
      );
    }
  } else {
    project = (repo && PJ.projectForRepo(repo)) || PJ.getProject(null);
    if (repo && project.repo.toLowerCase() !== repo.toLowerCase()) {
      throw new Error(`No configured project builds ${repo}.`);
    }
  }

  const version = String(payload.version || PJ.defaultVersion({ prNumber })).trim();
  const cleanInstall = payload.cleanInstall !== false; // default on
  const id = makeBuildId(prNumber);

  const build = {
    id, prNumber, version, cleanInstall,
    project: {
      key: project.key, name: project.name, repo: project.repo,
      kind: project.kind, slug: project.slug,
    },
    status: 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null, durationMs: null,
    site: { domain: project.site },
    verification: null, adminUrl: null, error: null,
  };

  ensureDir(buildDir(id));
  const logStream = fs.createWriteStream(logPath(id), { flags: 'w' });
  current = { build, child: null, cancelled: false, logStream };
  saveBuild(build);

  executeBuild(project).catch((err) => {
    if (!current) return;
    const b = current.build;
    b.status = current.cancelled ? 'cancelled' : 'error';
    b.error = String(err && err.message ? err.message : err);
    sendLog(b.status === 'cancelled' ? 'Build cancelled.' : `ERROR: ${b.error}`);
    finalize();
  });

  return { id };
}

async function executeBuild(project) {
  const build = current.build;
  emit(build.id, { kind: 'build-start', build: summarize(build) });
  sendLog(`PR Builder — ${project.name}: building ${project.repo}#${build.prNumber} (version ${build.version})`);

  /* 1. Resolve the target site. ------------------------------------------- */
  const site = localenv.getLocalSite(project.site);
  build.site = { domain: site.domain, name: site.name, url: site.url, webRoot: site.webRoot };
  build.adminUrl = `${site.url.replace(/\/$/, '')}/wp-admin/`;
  const php = localenv.resolvePhp(site.phpVersion);
  sendLog(`Target site: ${site.name} (${site.domain}) — ${site.webRoot}`);
  sendLog(`PHP: ${php.dir}  ·  MySQL port: ${site.mysqlPort}`);
  saveBuild(build);

  // We can't start a Local site from here, so fail fast with a clear message.
  sendLog('Checking the site is running...');
  if (!probeSite(site, php)) {
    throw new Error(
      `Site "${site.domain}" isn't responding (DB on port ${site.mysqlPort}). ` +
        `Start it in Local first, then re-run the build.`
    );
  }
  sendLog('Site is running.');

  /* 2. Ensure the clone + dedicated worktree. ----------------------------- */
  const { base, repoDir, worktreePath } = projectPaths(project);
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    sendLog(`Cloning ${project.repo} into ${repoDir} ...`);
    ensureDir(base);
    // `gh repo clone` reuses the authenticated gh session, so private repos work.
    await runCmdRetry(`gh repo clone ${project.repo} "${toPosix(repoDir)}"`, base);
  }
  if (!fs.existsSync(path.join(worktreePath, '.git'))) {
    sendLog(`Creating dedicated git worktree at ${worktreePath} ...`);
    await runCmd('git worktree prune', repoDir);
    await runCmd(`git worktree add --detach "${toPosix(worktreePath)}" HEAD`, repoDir);
  }

  /* 3. Fetch the PR head and hard-reset the worktree to it. ---------------- */
  sendLog(`Fetching PR #${build.prNumber}...`);
  await runCmdRetry(`git fetch origin "pull/${build.prNumber}/head"`, worktreePath);
  // Note: reset --hard leaves untracked build output (node_modules/, dist/) in
  // place, so repeat builds stay warm.
  await runCmd('git reset --hard FETCH_HEAD', worktreePath);

  /* 3a. Merge the PR's base branch, exactly like CI builds the merge commit.
   *     A genuine conflict is fatal with a clear "rebase" message; other merge
   *     failures are fatal too (a poisoned worktree would ruin the build); only
   *     failing to *resolve* the base ref (gh down) is a soft warning. */
  let baseRef = null;
  try {
    baseRef = (await shRetry(
      `gh pr view ${build.prNumber} --repo ${project.repo} --json baseRefName --jq .baseRefName`
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
      try { conflict = (await sh(`git -C "${toPosix(worktreePath)}" ls-files -u`)).trim().length > 0; } catch (_) {}
      await runCmd('git merge --abort', worktreePath).catch(() => {});
      throw new Error(
        conflict
          ? `PR #${build.prNumber} has merge conflicts with origin/${baseRef}. ` +
            `Rebase the PR locally and push before re-running.`
          : `Failed to merge origin/${baseRef} into PR #${build.prNumber}: ${mergeErr.message}`
      );
    }
  }

  /* 4. Optional build step. ------------------------------------------------ */
  if (project.build) {
    sendLog(`Building: ${project.build}`);
    await runCmd(project.build, worktreePath);
  } else {
    sendLog('No build command configured — installing the repo as-is.');
  }

  /* 5. Install into wp-content. -------------------------------------------- */
  const srcDir = project.distDir ? path.join(worktreePath, project.distDir) : worktreePath;
  if (!fs.existsSync(srcDir)) {
    throw new Error(
      `distDir "${project.distDir}" does not exist in the worktree after the build. ` +
        `Check the project's "build" command and "distDir".`
    );
  }
  const destRoot = project.kind === 'theme' ? site.themesDir : site.pluginsDir;
  const destDir = path.join(destRoot, project.slug);

  if (build.cleanInstall && fs.existsSync(destDir)) {
    sendLog(`Removing previous install at ${destDir} ...`);
    await fsp.rm(destDir, { recursive: true, force: true });
  }
  sendLog(`Installing ${project.kind} → ${destDir}`);
  const copied = await copyTree(srcDir, destDir, project.exclude);
  sendLog(`  copied ${copied} file(s).`);

  /* 6. Version stamp (optional). ------------------------------------------- */
  if (project.versionStamp) await stampVersion(destDir, project, build.version);

  /* 7. Activate. ----------------------------------------------------------- */
  sendLog(`Activating ${project.slug} via wp-cli...`);
  try {
    if (project.kind === 'theme') {
      await runWpCli(site, php, ['theme', 'activate', project.slug], { skipThemes: false });
    } else {
      await runWpCli(site, php, ['plugin', 'activate', project.slug], { skipPlugins: false });
    }
  } catch (e) {
    sendLog(`[warn] wp-cli activation issue: ${e.message}`);
  }

  sendLog('Build and install completed successfully!');

  /* 8. Verify the PR's changed files landed. ------------------------------- */
  try {
    sendLog('---');
    sendLog('Verifying installed files match PR diff...');
    const filesOut = await shRetry(
      `gh api repos/${project.repo}/pulls/${build.prNumber}/files --paginate --jq '.[] | "\\(.status)\\t\\(.filename)"'`
    );
    const prFiles = filesOut.split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
      const [status, filename] = line.split('\t');
      return { status, filename };
    });

    // Repo root == plugin root, so a PR path maps straight onto the install.
    const excluded = new Set(project.exclude.map((e) => toPosix(e).replace(/\/+$/, '')));
    const isExcluded = (file) =>
      excluded.has(file) ||
      [...excluded].some((e) => file === e || file.startsWith(`${e}/`)) ||
      file.split('/').some((seg) => excluded.has(seg));
    // When a build step or distDir is in play, source files legitimately don't
    // land 1:1 on disk — bucket those as "built" rather than failing.
    const compiled = !!(project.build || project.distDir);

    const stats = { match: 0, stamped: 0, built: 0, mismatch: 0, missing: 0, removed: 0, removedOk: 0, skipped: 0 };
    const issues = [];

    for (const { status, filename: file } of prFiles) {
      if (isExcluded(file)) { stats.skipped++; continue; }
      const installedPath = path.join(destDir, file);
      const srcPath = path.join(worktreePath, file);

      if (status === 'removed') {
        if (!fs.existsSync(installedPath)) stats.removedOk++;
        else { stats.removed++; issues.push(`✗ removed in PR but still on disk: ${file}`); }
        continue;
      }
      if (!fs.existsSync(installedPath)) {
        if (compiled) stats.built++;
        else { stats.missing++; issues.push(`✗ missing on disk: ${file}`); }
        continue;
      }
      const srcHash = md5File(srcPath), dstHash = md5File(installedPath);
      if (!srcHash || !dstHash) { stats.missing++; issues.push(`✗ unreadable: ${file}`); continue; }
      if (srcHash === dstHash) { stats.match++; continue; }
      // The version stamp deliberately rewrites one header line.
      let stampedOnly = false;
      try {
        stampedOnly = fs.readFileSync(installedPath, 'utf8').includes(build.version);
      } catch (_) {}
      if (stampedOnly) stats.stamped++;
      else if (compiled) stats.built++;
      else { stats.mismatch++; issues.push(`⚠ hash differs: ${file}`); }
    }

    sendLog(`  ✓ exact match:        ${stats.match}`);
    sendLog(`  ✓ version-stamped:    ${stats.stamped}`);
    sendLog(`  ✓ removed (gone):     ${stats.removedOk}`);
    if (compiled) sendLog(`  – source (compiled):  ${stats.built}`);
    sendLog(`  ⚠ hash mismatch:      ${stats.mismatch}`);
    sendLog(`  ✗ missing on disk:    ${stats.missing}`);
    sendLog(`  ✗ removed but found:  ${stats.removed}`);
    sendLog(`  – skipped (excluded): ${stats.skipped}`);
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

/** Configured projects, with their resolved Local site URL where available. */
function listProjects() {
  return PJ.listProjects().map((p) => {
    let siteUrl = null;
    try { siteUrl = localenv.getLocalSite(p.site).url; } catch (_) {}
    return {
      key: p.key, name: p.name, repo: p.repo, kind: p.kind, slug: p.slug,
      site: p.site, siteUrl, build: p.build, distDir: p.distDir,
      testAreas: p.testAreas, versionStamp: p.versionStamp,
      usingExample: p.usingExample,
    };
  });
}

module.exports = {
  events,
  listProjects,
  listPRs,
  buildTestTarget,
  startBuild,
  cancelBuild,
  getActive,
  listBuilds,
  loadBuild,
  readLogLines,
  shutdown,
  recoverInterrupted,
  // Exposed for tests (same convention as testcount.js `_parse`).
  _copyTree: copyTree,
  _stampVersion: stampVersion,
  _findPluginHeaderFile: findPluginHeaderFile,
};
