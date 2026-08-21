'use strict';

/**
 * Run orchestrator.
 *
 * A run is a set of targets, where a target is one (suite, site) pair: *which*
 * tests, run *where*. The orchestrator is deliberately framework-blind — it
 * asks the suite's adapter for a command to spawn, tails a single NDJSON event
 * format for live progress, and persists results via the store. Everything that
 * differs between Playwright, Cypress and Selenium lives in server/frameworks/.
 *
 * Targets run one OS process each: auth first (only frameworks that need a
 * separate auth step), then tests, staggered to avoid memory contention.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const {
  SITES,
  SUITES,
  DEFAULT_SUITE,
  siteEnv,
  targetKey,
  REPORTER_PATHS,
  SITE_START_STAGGER_MS,
  MAX_CONCURRENT_SITES,
  SITE_START_PRIORITY,
} = require('../config');
const frameworks = require('./frameworks');
const store = require('./store');

const events = new EventEmitter();

/** runId -> live run state */
const active = new Map();
/** runId -> [ChildProcess] for cancellation */
const procs = new Map();
/** target key -> runId that currently owns it (concurrency guard + ownership) */
const busyTargets = new Map();
/** `${runId}:${targetKey}` -> planned test list (live-only; not persisted) */
const plans = new Map();
/** `${runId}:${targetKey}` -> child env overrides. Kept off the run record so
 *  credentials are never persisted. */
const spawnEnvs = new Map();
/** `${runId}:${targetKey}` -> adapter run spec (command/args/extras). */
const runSpecs = new Map();

function makeRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

function emptyTotals() {
  return { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, completed: 0 };
}

function normStatus(s) {
  if (s === 'passed') return 'passed';
  if (s === 'skipped') return 'skipped';
  return 'failed'; // failed | timedOut | interrupted
}

const TERMINAL_STATUSES = ['passed', 'failed', 'error', 'cancelled', 'interrupted'];
function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Free a target ONLY if this run still owns it. Prevents an old run's finalize
 * from releasing a target that a newer run has already re-acquired (e.g. after a
 * per-target cancel frees it early and the user starts a fresh run for it).
 */
function releaseTarget(key, runId) {
  if (busyTargets.get(key) === runId) busyTargets.delete(key);
}

/**
 * Return targets ordered for execution: SITE_START_PRIORITY sites first (in that
 * order), then the rest in their original relative order (stable). Does NOT
 * mutate the input — storage/render order (run.targets) is preserved.
 */
function orderTargets(targets) {
  const rank = (t) => {
    const i = SITE_START_PRIORITY.indexOf(t.site);
    return i === -1 ? SITE_START_PRIORITY.length : i;
  };
  return targets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (rank(a.t) - rank(b.t)) || (a.i - b.i))
    .map((x) => x.t);
}

/* ------------------------------ request hygiene ---------------------------- */

/**
 * Which environment variables a *requested* target may set.
 *
 * A target arrives in an HTTP body — from the Run tab, or out of a saved
 * schedule, both of which any account holding `tests.run` can shape. Whatever
 * it contains is merged into the environment of a child process we then spawn.
 * Merged unfiltered, that is a remote code execution primitive and not a
 * subtle one: `NODE_OPTIONS=--require /tmp/x.js` runs arbitrary code as
 * whoever owns the dashboard, and `CYPRESS_RUN_BINARY` / `PATH` / `LD_PRELOAD`
 * each get you there by a different road.
 *
 * So: an allowlist, not a denylist. These are the namespaces the suites
 * themselves read (see config.siteEnv), and nothing outside them gets through.
 * Environment declared on a *suite* in sites.config.json is exempt — that file
 * is local operator config, not user input.
 */
const ENV_ALLOWED_PREFIXES = ['E2E_', 'WP_', 'TEST_', 'DASHBOARD_'];
const ENV_ALLOWED_EXACT = new Set(['PLAYWRIGHT_BASE_URL']);

function sanitiseRequestedEnv(raw, suiteName) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const name = String(key);
    const allowed =
      ENV_ALLOWED_EXACT.has(name) || ENV_ALLOWED_PREFIXES.some((p) => name.startsWith(p));
    if (!allowed) {
      throw new Error(
        `"${name}" is not an environment variable a run may set. Allowed: ` +
          `${ENV_ALLOWED_PREFIXES.map((p) => p + '*').join(', ')}. ` +
          `Suite-wide variables belong in sites.config.json under "${suiteName}".`
      );
    }
    if (value !== null && typeof value === 'object') {
      throw new Error(`Environment variable "${name}" must be a string.`);
    }
    out[name] = String(value == null ? '' : value);
  }
  return out;
}

/* --------------------------------- starting -------------------------------- */

/**
 * Resolve one requested target into the record(s) the run stores and executes.
 *
 * Almost always one record. The exception is a composite suite (one directory
 * holding more than one framework — see config.js's normaliseCompositeSuite):
 * there, one requested (suite, site) fans out into one record per member
 * framework the selection actually touches, each spawning its own process
 * against the same site. That's what makes "run the whole suite" run every
 * framework in it fully, not just whichever one the config happened to name.
 */
function resolveTarget(t, runDir, opts) {
  const suiteKey = t.suite || DEFAULT_SUITE;
  const suite = SUITES[suiteKey];
  if (!suite) throw new Error(`Unknown suite: ${t.suite}`);
  if (!suite.ok) throw new Error(`Suite "${suite.name}" is not runnable: ${suite.reason}`);

  if (suite.frameworks) return resolveCompositeTargets(suite, t, runDir, opts);
  return [resolveSingleTarget(suite, t, runDir, null, opts)];
}

/**
 * Split a composite suite's requested paths by the framework id each is
 * prefixed with (`"playwright::tests/login.spec.ts"` — see tree.js's
 * buildNodes), and build one target per framework touched. Paths that carry
 * no recognised prefix (no selection was made, or an older/other caller sent
 * a plain path — e.g. the PR Builder's `['']` "everything") fall back to
 * every runnable member framework, run in full — the safe default for
 * "nothing more specific was said."
 */
function resolveCompositeTargets(suite, t, runDir, opts) {
  const runnable = suite.frameworks.filter((f) => f.layout && f.layout.ok);
  if (!runnable.length) throw new Error(`Suite "${suite.name}" has no runnable framework.`);

  const byFramework = new Map();
  for (const raw of Array.isArray(t.paths) ? t.paths : []) {
    const s = String(raw || '');
    const idx = s.indexOf('::');
    if (idx === -1) continue; // unprefixed — doesn't identify a framework
    const id = s.slice(0, idx);
    const rel = s.slice(idx + 2);
    if (!runnable.some((f) => f.id === id)) continue; // unknown/broken member
    if (!byFramework.has(id)) byFramework.set(id, []);
    if (rel) byFramework.get(id).push(rel);
  }
  const wanted = byFramework.size ? byFramework : new Map(runnable.map((f) => [f.id, []]));

  const out = [];
  for (const [id, rel] of wanted) {
    out.push(resolveSingleTarget(
      suite,
      { ...t, paths: rel.length ? rel : undefined },
      runDir,
      { framework: id },
      opts
    ));
  }
  if (!out.length) throw new Error(`No runnable framework matched the selection for "${suite.name}".`);
  return out;
}

/**
 * Two flavours: a normal (suite, registered site) pair, and a "custom" target
 * that carries its own baseUrl — used by the PR Builder to test a site that
 * isn't in the config. `member` overrides `{framework, layout}` for one leg of
 * a composite suite; omitted for a plain single-framework suite, which reads
 * both off the suite itself exactly as before.
 */
function resolveSingleTarget(suite, t, runDir, member, opts = {}) {
  const suiteKey = t.suite || DEFAULT_SUITE;
  const framework = member ? member.framework : suite.framework;

  // A "custom" target carries its own URL and credentials instead of naming a
  // registered site. Only the PR Builder legitimately does that (it tests a
  // site it just built, which is in no config), and it passes trusted:true.
  //
  // Honouring it from an HTTP body would let anyone with `tests.run` aim a
  // suite — and whatever credentials it is handed — at a host of their
  // choosing, which is both an exfiltration channel and a way to make this
  // server attack things it can reach and the caller cannot.
  const wantsCustom = !!t.baseUrl && !SITES[t.site];
  if (wantsCustom && !opts.trusted) {
    throw new Error(
      `Unknown site: ${t.site}. Runs may only target a site registered on the Sites tab.`
    );
  }
  const custom = wantsCustom;
  const site = SITES[t.site];
  if (!custom && !site) throw new Error(`Unknown site: ${t.site}`);
  if (site && site.credentialError) {
    throw new Error(`Site "${site.name}": ${site.credentialError}`);
  }

  const adapter = frameworks.get(framework);
  const key = targetKey(suiteKey, t.site, member ? framework : null);

  const scope = (suite.scopes || []).find((s) => s.key === t.scope) || null;
  const defaultPaths = scope
    ? scope.dirs.map((d) => (!d || d === '.' ? '' : d.replace(/\\/g, '/').replace(/\/?$/, '/')))
    : [''];
  const paths = Array.isArray(t.paths) && t.paths.length ? t.paths : defaultPaths;

  const baseUrl = custom ? t.baseUrl.replace(/\/$/, '') : site.url;
  const grepIgnored = !!t.grep && !adapter.supportsGrep;

  // A custom target isn't in the sites config, so its credentials come from the
  // caller (the PR Builder) rather than from a registered site.
  const requestedEnv = opts.trusted
    ? { ...(t.env || {}) }
    : sanitiseRequestedEnv(t.env, suite.name);
  const adminUser = custom ? requestedEnv.E2E_ADMIN_USER || 'admin' : site.adminUser;
  const adminPass = custom ? requestedEnv.E2E_ADMIN_PASS : site.adminPass;

  // No credentials means the run would try admin/admin against whatever the
  // URL points at. Fail here, where the reason can be stated, instead of
  // leaving someone to read a failed login out of a Selenium stack trace.
  if (!adminPass) {
    throw new Error(
      custom
        ? 'No admin password was supplied for this target.'
        : `Site "${site.name}" has no admin password set. Add one on the Sites tab.`
    );
  }

  spawnEnvs.set(`${runDir.id}:${key}`, {
    ...siteEnv({ url: baseUrl, adminUser, adminPass }),
    ...suite.env,
    ...requestedEnv,
    // Legacy: suites that pick their environment by name rather than by URL.
    TEST_SITE: t.site,
    DASHBOARD_SITE: t.site,
  });

  return {
    key,
    suite: suiteKey,
    suiteName: suite.name,
    framework,
    frameworkLabel: adapter.label,
    language: adapter.language,
    reportKind: adapter.reportKind,
    scope: t.scope || null,
    scopeName: scope ? scope.name : null,
    site: t.site,
    name: custom ? (t.name || t.site) : `${suite.name} · ${adapter.label}`,
    siteName: custom ? (t.name || t.site) : site.name,
    url: custom ? (t.url || baseUrl) : site.url,
    baseUrl,
    custom,
    paths,
    grep: t.grep || null,
    grepIgnored,
    status: 'queued',
    authStatus: 'pending',
    exitCode: null,
    totals: emptyTotals(),
    currentTest: null,
    ndjson: path.join(runDir.dir, `${key}.ndjson`),
    reportDir: path.join(runDir.dir, `${key}-report`),
    outputDir: path.join(runDir.dir, `${key}-test-results`),
    artifactsDir: path.join(runDir.dir, `${key}-artifacts`),
    authLog: path.join(runDir.dir, `${key}-auth.log`),
    log: path.join(runDir.dir, `${key}.log`),
    tests: [],
  };
}

/**
 * Start a run.
 * @param {Array<{suite?:string, site:string, scope?:string, paths?:string[], grep?:string}>} targets
 * @param {string} [label]
 * @returns {{id:string}}
 */
function startRun(targets, label, { trusted = false } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('No targets selected.');
  }

  const id = makeRunId();
  const dir = store.runDir(id);

  // A composite suite's one requested target can resolve into several (one
  // per member framework — see resolveCompositeTargets), so the busy-guard has
  // to run against the resolved keys, not the requested ones.
  //
  // Resolve and check before creating the directory: both are where a request
  // gets rejected, and doing it the other way round left an empty run
  // directory on disk for every rejection.
  const resolved = targets.flatMap((t) => resolveTarget(t, { id, dir }, { trusted }));

  // One run per (suite, site[, framework]) at a time: two runs fighting over
  // the same target would fight over its site's state, but the *same* suite
  // against a different site — or a different suite/framework against the
  // same site — is fine.
  for (const r of resolved) {
    if (busyTargets.has(r.key)) {
      throw new Error(
        `A run is already in progress for "${r.suiteName}" on "${r.siteName}". ` +
          `Wait for it to finish (one run per suite + site at a time).`
      );
    }
  }

  store.ensureDir(dir);

  const run = {
    id,
    label: label || defaultLabel(resolved),
    trigger: 'manual',
    status: 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    totals: emptyTotals(),
    targets: resolved,
  };

  active.set(id, run);
  procs.set(id, []);
  resolved.forEach((t) => busyTargets.set(t.key, id));
  store.saveRun(run);

  // Kick off asynchronously; caller gets the id immediately.
  executeRun(id).catch((err) => {
    const r = active.get(id);
    if (r) {
      r.status = 'error';
      r.error = String(err && err.message ? err.message : err);
      finalize(id);
    }
  });

  return { id };
}

function defaultLabel(targets) {
  const names = targets.map((t) => `${t.frameworkLabel || t.suite} → ${t.siteName || t.site}`);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

async function executeRun(id) {
  const run = active.get(id);
  emit(id, { kind: 'run-start', run: snapshot(id) });

  // Phase 1: run each target's auth step sequentially (fast, ~5s each), in
  // priority order. Most suites have none — Playwright suites that log in from
  // `globalSetup`, and Cypress/Selenium suites, authenticate inside the run —
  // in which case the target goes straight to the test phase.
  for (const target of orderTargets(run.targets)) {
    if (run.cancelled) break;
    if (target.cancelled) continue; // cancelled while queued

    const auth = authSpecFor(target, id);
    if (!auth) {
      target.authStatus = 'ok';
      continue;
    }

    target.status = 'authenticating';
    emit(id, { kind: 'target-update', target: slimTarget(target) });

    const ok = await authenticate(id, target, auth);
    if (run.cancelled || target.cancelled) continue; // don't clobber a cancel
    target.authStatus = ok ? 'ok' : 'failed';
    if (!ok) {
      target.status = 'error';
      releaseTarget(target.key, id); // free it the moment auth fails
      emit(id, { kind: 'target-update', target: slimTarget(target) });
    }
    store.saveRun(run);
  }
  store.saveRun(run);

  // Phase 2: launch tests for every authenticated target, in priority order,
  // staggered (and optionally capped) to avoid memory contention.
  const runnable = orderTargets(
    run.targets.filter((t) => t.authStatus === 'ok' && !run.cancelled && !t.cancelled)
  );
  await launchWithStagger(id, runnable);

  run.launchComplete = true; // gate for maybeFinalize
  finalize(id);
}

/**
 * Launch runTests() for each target with SITE_START_STAGGER_MS between starts,
 * honouring MAX_CONCURRENT_SITES (0 = unlimited), run.cancelled, and per-target
 * cancellation. A target cancelled while still queued here never spawns.
 */
async function launchWithStagger(id, targets) {
  const run = active.get(id);
  const inflight = []; // { done:boolean, promise:Promise, site:string }

  for (let i = 0; i < targets.length; i++) {
    if (run.cancelled) break;
    const target = targets[i];
    if (target.cancelled || isTerminal(target.status)) continue;

    // Optional concurrency cap: wait until a slot frees up.
    if (MAX_CONCURRENT_SITES > 0) {
      while (inflight.filter((p) => !p.done).length >= MAX_CONCURRENT_SITES) {
        await Promise.race(inflight.filter((p) => !p.done).map((p) => p.promise));
        if (run.cancelled) break;
      }
    }
    if (run.cancelled) break;

    // Targets against the same site share live state (e.g. a WordPress
    // install's DB/options) even when they're different frameworks — a
    // composite suite like e2e-combo resolves into one target per framework,
    // all against the same site. Running those concurrently lets one
    // framework's setting change or page read land mid-way through another's,
    // producing nondeterministic failures. Never run two targets against the
    // same site at once, regardless of MAX_CONCURRENT_SITES.
    while (inflight.some((p) => !p.done && p.site === target.site)) {
      await Promise.race(inflight.filter((p) => !p.done).map((p) => p.promise));
      if (run.cancelled) break;
    }
    if (run.cancelled) break;
    if (target.cancelled) continue; // cancelled during the cap/site wait

    const rec = { done: false, site: target.site };
    rec.promise = runTests(id, target).then(() => { rec.done = true; });
    inflight.push(rec);

    // Stagger before the NEXT launch, but only when it's a different site —
    // same-site targets already wait for each other above, so an extra flat
    // delay there would just slow the run down for no reason.
    const next = targets[i + 1];
    if (next && next.site !== target.site && SITE_START_STAGGER_MS > 0) {
      await cancellableDelay(id, SITE_START_STAGGER_MS);
    }
  }

  await Promise.all(inflight.map((p) => p.promise));
}

/**
 * A sleep that resolves early if the run is cancelled, so a whole-run cancel
 * doesn't have to wait out the full stagger interval.
 */
function cancellableDelay(id, ms) {
  return new Promise((resolve) => {
    const step = 250;
    let waited = 0;
    const tick = () => {
      const run = active.get(id);
      if (!run || run.cancelled || waited >= ms) return resolve();
      waited += step;
      setTimeout(tick, Math.min(step, Math.max(0, ms - waited) + step));
    };
    tick();
  });
}

/* --------------------------------- spawning -------------------------------- */

/**
 * A plain suite already carries its one `layout`; a composite suite carries
 * one per member framework instead, keyed by id — this picks the right one
 * for a resolved target, which always names a single concrete framework
 * regardless of which kind of suite it came from.
 */
function layoutFor(suite, target) {
  if (suite.layout) return suite.layout;
  const member = (suite.frameworks || []).find((f) => f.id === target.framework);
  return member ? member.layout : null;
}

/**
 * Build the adapter context shared by the auth and test commands.
 *
 * Credentials are read back out of spawnEnvs rather than off the target record:
 * the record is persisted to run.json, and passwords have no business being
 * written to disk.
 */
function specContext(target, runId) {
  const suite = SUITES[target.suite];
  const env = spawnEnvs.get(`${runId}:${target.key}`) || {};
  return {
    suite,
    // Unique per (run, target): adapters that share a workspace with other runs
    // use it to tag their output. See server/frameworks/selenium.js.
    runToken: `${runId || 'run'}-${target.key}`,
    suiteDir: suite.dir,
    layout: layoutFor(suite, target),
    paths: target.paths,
    grep: target.grepIgnored ? null : target.grep,
    ndjsonFile: target.ndjson,
    reportDir: target.reportDir,
    outputDir: target.outputDir,
    artifactsDir: target.artifactsDir,
    authLog: target.authLog,
    reporterPath: REPORTER_PATHS[target.framework],
    baseUrl: target.baseUrl,
    // No "or admin" default: resolveSingleTarget already refused a target
    // without credentials, and quietly substituting a guess here would undo it.
    adminUser: env.E2E_ADMIN_USER || '',
    adminPass: env.E2E_ADMIN_PASS || '',
    siteKey: target.site,
  };
}

function authSpecFor(target, runId) {
  try {
    return frameworks.get(target.framework).buildAuth(specContext(target, runId));
  } catch (_) {
    return null;
  }
}

/** Authenticate one target, retrying once (per suite orchestration rules). */
async function authenticate(id, target, auth, attempt = 1) {
  const ok = await new Promise((resolve) => {
    const child = spawnSpec(id, target, auth, target.authLog);
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });

  if (!ok && attempt < 2 && !active.get(id).cancelled && !target.cancelled) {
    return authenticate(id, target, auth, attempt + 1);
  }
  return ok;
}

function spawnSpec(id, target, spec, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: {
      ...process.env,
      ...(spawnEnvs.get(`${id}:${target.key}`) || {}),
      ...(spec.env || {}),
    },
    windowsHide: true,
  });
  track(id, child, target.key);
  if (logFile) {
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
  }
  return child;
}

/** Append one NDJSON event, in the shape the reporters emit. */
function makeWriter(target) {
  return (event) => {
    try {
      fs.appendFileSync(target.ndjson, JSON.stringify({ site: target.site, ...event }) + '\n');
    } catch (_) {
      // Progress reporting must never break a run.
    }
  };
}

/**
 * Frameworks whose reporters can't produce an up-front plan get one written for
 * them from static discovery, so the Live view can list every test as pending
 * before the run gets to it.
 */
async function writePlan(target) {
  const adapter = frameworks.get(target.framework);
  if (adapter.emitsPlan) return;
  const write = makeWriter(target);
  let tests = [];
  try {
    const suite = SUITES[target.suite];
    // collectPlan() reads suite.framework/suite.layout directly; a composite
    // suite carries neither (it has `frameworks`), so hand it a single-
    // framework view scoped to this target's own member.
    const suiteView = suite.frameworks
      ? { ...suite, framework: target.framework, layout: layoutFor(suite, target) }
      : suite;
    tests = await frameworks.collectPlan(
      suiteView,
      target.paths,
      target.grepIgnored ? null : target.grep
    );
  } catch (_) {
    tests = [];
  }
  const ts = Date.now();
  write({ type: 'begin', totalTests: tests.length, ts });
  write({ type: 'plan', tests, ts });
}

/** Run the test step for one target, tailing its NDJSON for live progress. */
function runTests(id, target) {
  return new Promise((resolve) => {
    const run = active.get(id);
    const adapter = frameworks.get(target.framework);
    target.status = 'running';
    emit(id, { kind: 'target-update', target: slimTarget(target) });

    let spec;
    try {
      fs.mkdirSync(target.artifactsDir, { recursive: true });
      spec = adapter.buildRun(specContext(target, id));
      runSpecs.set(`${id}:${target.key}`, spec);
    } catch (err) {
      target.status = 'error';
      target.error = String((err && err.message) || err);
      releaseTarget(target.key, id);
      emit(id, { kind: 'target-end', target: slimTarget(target) });
      store.saveRun(run);
      maybeFinalize(id);
      return resolve();
    }

    const write = makeWriter(target);
    const tailer = makeTailer(target.ndjson, (evt) => handleEvent(id, target, evt));

    // Frameworks that report results out-of-band (Selenium reads Surefire's
    // XML) get a watcher that turns them into the same event stream.
    const progress = adapter.startProgress
      ? adapter.startProgress({ ...specContext(target, id), ...spec }, write)
      : null;

    // The plan is written before the child starts so the UI has the full list
    // from the first frame.
    writePlan(target).finally(() => {
      if (target.cancelled || run.cancelled) {
        if (progress) progress.stop();
        tailer.stop();
        return resolve();
      }

      const child = spawnSpec(id, target, spec, target.log);
      if (adapter.onOutput) {
        const onData = (d) => adapter.onOutput(d.toString(), spec, write);
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
      }

      child.on('close', (code) => {
        target.exitCode = code;
        // Give the tailer/watcher a moment to drain the final events.
        setTimeout(() => {
          if (progress) progress.stop();
          setTimeout(() => {
            tailer.stop();
            if (target.status !== 'cancelled') {
              // A target that was supposed to run tests but reported none did
              // not pass — it never ran. Frameworks invoked in a
              // "don't fail the build on test failures" mode (Maven) exit 0
              // either way, so exit code alone can't be trusted here.
              if (target.totals.total > 0 && target.totals.completed === 0) {
                target.status = 'error';
                target.error =
                  target.error ||
                  `${target.frameworkLabel} produced no test results — see the run log.`;
              } else {
                const failed = target.totals.failed > 0 || code !== 0;
                target.status = failed ? 'failed' : 'passed';
              }
            }
            target.currentTest = null;
            releaseTarget(target.key, id);
            emit(id, { kind: 'target-end', target: slimTarget(target) });
            store.saveRun(run);
            maybeFinalize(id);
            resolve();
          }, 400);
        }, 900);
      });
      child.on('error', (err) => {
        if (target.status !== 'cancelled') {
          target.status = 'error';
          target.error = String(err.message || err);
        }
        if (progress) progress.stop();
        tailer.stop();
        releaseTarget(target.key, id);
        emit(id, { kind: 'target-end', target: slimTarget(target) });
        store.saveRun(run);
        maybeFinalize(id);
        resolve();
      });
    });
  });
}

function handleEvent(id, target, evt) {
  const run = active.get(id);
  if (!run) return;

  if (evt.type === 'begin') {
    target.totals.total = evt.totalTests || 0;
    recomputeRunTotals(run);
    emit(id, { kind: 'target-begin', target: target.key, totals: target.totals });
    return;
  }

  if (evt.type === 'plan') {
    plans.set(`${id}:${target.key}`, Array.isArray(evt.tests) ? evt.tests : []);
    emit(id, { kind: 'plan', target: target.key, tests: evt.tests || [] });
    return;
  }

  // A coarse "what's executing now" signal from frameworks that can't report
  // per-test starts (see server/frameworks/selenium.js).
  if (evt.type === 'stage') {
    target.currentTest = evt.title || null;
    emit(id, { kind: 'current', target: target.key, title: target.currentTest });
    return;
  }

  if (evt.type === 'test-begin') {
    target.currentTest = evt.title || null;
    if (!target.runningIds) target.runningIds = [];
    if (evt.id && !target.runningIds.includes(evt.id)) target.runningIds.push(evt.id);
    emit(id, { kind: 'current', target: target.key, title: target.currentTest, id: evt.id });
    return;
  }

  if (evt.type === 'test') {
    const status = normStatus(evt.status);
    // Guard against a duplicate result for the same test (a retried hook, or a
    // watcher re-reading a report) inflating the counts.
    if (evt.id && target.tests.some((t) => t.id === evt.id)) return;
    target.totals[status] += 1;
    target.totals.completed += 1;
    const test = {
      id: evt.id,
      title: evt.title,
      file: evt.file,
      line: evt.line,
      status, // normalized
      rawStatus: evt.status,
      durationMs: evt.durationMs,
      error: evt.error,
    };
    target.tests.push(test);
    if (target.runningIds) target.runningIds = target.runningIds.filter((x) => x !== evt.id);
    target.currentTest = null;
    recomputeRunTotals(run);
    emit(id, {
      kind: 'test',
      target: target.key,
      test: {
        id: test.id,
        title: test.title,
        status,
        durationMs: test.durationMs,
        error: status === 'failed' ? test.error : undefined,
      },
      targetTotals: target.totals,
      runTotals: run.totals,
    });
    return;
  }
  // 'end' is implicit — handled by process close.
}

function recomputeRunTotals(run) {
  const t = emptyTotals();
  for (const tg of run.targets) {
    t.total += tg.totals.total;
    t.passed += tg.totals.passed;
    t.failed += tg.totals.failed;
    t.skipped += tg.totals.skipped;
    t.flaky += tg.totals.flaky;
    t.completed += tg.totals.completed;
  }
  run.totals = t;
}

function finalize(id) {
  const run = active.get(id);
  if (!run) return;
  if (run.finalized) return; // idempotent — maybeFinalize/executeRun may both call
  run.finalized = true;

  recomputeRunTotals(run);
  run.finishedAt = new Date().toISOString();
  run.durationMs = new Date(run.finishedAt) - new Date(run.startedAt);

  if (run.status !== 'error') {
    if (run.cancelled) {
      run.status = 'cancelled';
    } else if (run.targets.some((t) => t.status === 'error')) {
      run.status = run.targets.every((t) => t.status === 'error') ? 'error' : 'failed';
    } else if (run.targets.some((t) => t.status === 'failed')) {
      run.status = 'failed';
    } else {
      run.status = 'passed';
    }
  }

  store.saveRun(run);
  emit(id, { kind: 'run-end', run: snapshot(id) });

  run.targets.forEach((t) => releaseTarget(t.key, id));
  procs.delete(id);
  // Keep the snapshot briefly so late SSE reconnects still see it.
  setTimeout(() => {
    active.delete(id);
    run.targets.forEach((t) => {
      plans.delete(`${id}:${t.key}`);
      spawnEnvs.delete(`${id}:${t.key}`);
      runSpecs.delete(`${id}:${t.key}`);
    });
  }, 30000);
}

function cancelRun(id) {
  const run = active.get(id);
  if (!run) return false;
  run.cancelled = true;
  run.targets.forEach((t) => {
    if (t.status === 'running' || t.status === 'authenticating' || t.status === 'queued') {
      t.status = 'cancelled';
    }
  });
  for (const child of procs.get(id) || []) killTree(child);
  emit(id, { kind: 'cancelling', id });
  return true;
}

/**
 * Cancel ONE target within a run: kill just its child process(es), mark it
 * cancelled, free it immediately (so a new run can re-target it right away), and
 * finalize the run if nothing else is still active. Does not affect the other
 * targets. Returns false if unknown/terminal.
 */
function cancelTarget(id, key) {
  const run = active.get(id);
  if (!run) return false;
  const target = run.targets.find((t) => t.key === key || t.site === key);
  if (!target || isTerminal(target.status)) return false;

  target.cancelled = true; // stops a queued spawn / auth retry
  target.status = 'cancelled';
  for (const child of (procs.get(id) || []).filter((c) => c._target === target.key)) {
    killTree(child); // idempotent; guarded against double-kill
  }
  releaseTarget(target.key, id);
  emit(id, { kind: 'target-end', target: slimTarget(target) });
  store.saveRun(run);
  maybeFinalize(id);
  return true;
}

/**
 * Finalize the run once Phase 2 has finished launching AND every target has
 * reached a terminal state. Guarded so an early-terminal target (e.g. a
 * per-target cancel or an auth failure) never finalizes the run while others are
 * still queued in the stagger.
 */
function maybeFinalize(id) {
  const run = active.get(id);
  if (!run || run.finalized || !run.launchComplete) return;
  if (run.targets.some((t) => !isTerminal(t.status))) return;
  finalize(id);
}

/**
 * Stop everything when the server is shutting down (Ctrl+C / SIGTERM).
 * Synchronously kills every tracked child so long runs don't keep going
 * headless after the dashboard is gone, and records any in-flight run as
 * 'interrupted' on disk. Its NDJSON still holds the detail, which
 * recoverInterrupted() replays on the next boot.
 */
function shutdown() {
  for (const [id, run] of active.entries()) {
    if (!run || run.status !== 'running') continue;
    for (const child of procs.get(id) || []) killTree(child, { sync: true });
    run.cancelled = true;
    run.status = 'interrupted';
    run.finishedAt = run.finishedAt || new Date().toISOString();
    if (run.startedAt) run.durationMs = new Date(run.finishedAt) - new Date(run.startedAt);
    run.targets.forEach((t) => {
      if (['queued', 'authenticating', 'running'].includes(t.status)) t.status = 'interrupted';
    });
    recomputeRunTotals(run);
    try { store.saveRun(run); } catch (_) {}
  }
}

/* ----------------------------- process helpers ---------------------------- */

function track(id, child, targetKeyValue) {
  child._target = targetKeyValue || null; // tag so cancelTarget can kill one target
  const list = procs.get(id);
  if (list) list.push(child);
}

/**
 * Forcibly kill a child and its descendants — every framework here spawns a
 * process tree (browsers for Playwright/Cypress; a forked Surefire JVM plus
 * chromedriver and Chrome for Selenium).
 *
 * Pass { sync:true } during shutdown so the kill is actually issued before the
 * server process exits — an async spawn would be abandoned by process.exit().
 */
function killTree(child, { sync = false } = {}) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/T', '/F'];
    try {
      if (sync) {
        spawnSync('taskkill', args, { windowsHide: true });
      } else {
        const tk = spawn('taskkill', args, { windowsHide: true });
        // taskkill can fail (already gone, access denied) — fall back to SIGKILL.
        tk.on('error', () => { try { child.kill('SIGKILL'); } catch (_) {} });
        tk.on('exit', (code) => {
          if (code !== 0) { try { child.kill('SIGKILL'); } catch (_) {} }
        });
      }
    } catch (_) {
      try { child.kill('SIGKILL'); } catch (_) {}
    }
  } else {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}

/** Poll-based NDJSON tail (robust on Windows where fs.watch misses appends). */
function makeTailer(file, onLine) {
  let offset = 0;
  let buf = '';
  let stopped = false;

  function poll() {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      return; // file not created yet
    }
    if (stat.size <= offset) return;
    const len = stat.size - offset;
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, offset);
    fs.closeSync(fd);
    offset = stat.size;
    buf += b.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        try {
          onLine(JSON.parse(line));
        } catch (_) {}
      }
    }
  }

  const timer = setInterval(poll, 400);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      poll(); // final drain
      clearInterval(timer);
    },
  };
}

/* ------------------------------- snapshots -------------------------------- */

function slimTarget(t) {
  return {
    key: t.key,
    suite: t.suite,
    suiteName: t.suiteName,
    framework: t.framework,
    frameworkLabel: t.frameworkLabel,
    language: t.language,
    reportKind: t.reportKind,
    site: t.site,
    siteName: t.siteName,
    url: t.url,
    name: t.name,
    scope: t.scope,
    scopeName: t.scopeName,
    status: t.status,
    authStatus: t.authStatus,
    exitCode: t.exitCode,
    totals: t.totals,
    currentTest: t.currentTest,
    runningIds: t.runningIds || [],
    error: t.error,
    // For the per-target "Re-run" button. No credentials or baseUrl (those live
    // only in spawnEnvs and are never persisted); `custom` PR-built targets
    // can't be reconstructed generically, so the UI hides Re-run for them.
    paths: t.paths,
    grep: t.grep || null,
    grepIgnored: !!t.grepIgnored,
    custom: !!t.custom,
    // Full ordered list (slim, keyed by id) so a mid-run reconnect rebuilds the
    // whole list. Errors are kept only for failed tests.
    tests: t.tests.map((x) => ({
      id: x.id,
      title: x.title,
      status: x.status,
      durationMs: x.durationMs,
      error: x.status === 'failed' ? x.error : undefined,
    })),
  };
}

/** Full live snapshot for a connecting SSE client (trims passed-test detail). */
function snapshot(id) {
  const run = active.get(id);
  if (!run) return null;
  return {
    id: run.id,
    label: run.label,
    status: run.status,
    trigger: run.trigger,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    totals: run.totals,
    targets: run.targets.map((t) => ({
      ...slimTarget(t),
      plannedTests: plans.get(`${run.id}:${t.key}`) || [],
    })),
  };
}

function getActiveSnapshot(id) {
  return active.has(id) ? snapshot(id) : null;
}

function isActive(id) {
  return active.has(id);
}

function listActive() {
  return [...active.keys()].map((id) => snapshot(id));
}

function emit(id, payload) {
  events.emit('update', id, payload);
}

/**
 * Replay a target's NDJSON event file to rebuild its totals + per-test list
 * after the server died mid-run. The slim live run.json doesn't persist
 * per-test detail until a target ends, but the NDJSON is a complete log — so a
 * run whose process actually finished (or got far) can be fully reconstructed.
 *
 * Returns { sawEnd, sawAny, endTs }: sawEnd distinguishes a target that truly
 * finished (has an 'end' line) from one cut off mid-flight.
 */
function replayTargetNdjson(target, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return { sawEnd: false, sawAny: false, endTs: null };
  }

  const totals = emptyTotals();
  const tests = [];
  const seen = new Set();
  let sawEnd = false;
  let sawAny = false;
  let endTs = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let evt;
    try { evt = JSON.parse(line); } catch (_) { continue; }
    sawAny = true;

    if (evt.type === 'begin') {
      totals.total = evt.totalTests || 0;
    } else if (evt.type === 'test') {
      if (evt.id && seen.has(evt.id)) continue;
      if (evt.id) seen.add(evt.id);
      const status = normStatus(evt.status);
      totals[status] += 1;
      totals.completed += 1;
      tests.push({
        id: evt.id,
        title: evt.title,
        file: evt.file,
        line: evt.line,
        status,
        rawStatus: evt.status,
        durationMs: evt.durationMs,
        error: evt.error,
      });
    } else if (evt.type === 'end') {
      sawEnd = true;
      endTs = evt.ts || endTs;
    }
  }

  target.totals = totals;
  target.tests = tests;
  target.currentTest = null;
  return { sawEnd, sawAny, endTs };
}

/**
 * On boot, reconcile any run left 'running' by a previous (crashed/stopped)
 * process. We replay each target's NDJSON to salvage the results that were
 * never finalized, then set a faithful status: a target with an 'end' line
 * actually finished (passed/failed); one without was genuinely interrupted.
 *
 * Only Playwright writes an 'end' line, so for the other frameworks a target is
 * treated as finished when every planned test produced a result.
 */
function recoverInterrupted() {
  for (const summary of store.listRuns({ limit: 1000 })) {
    if (summary.status !== 'running') continue;
    const run = store.loadRun(summary.id);
    if (!run || run.status !== 'running') continue;

    const dir = store.runDir(run.id);
    let anyCutOff = false;
    let latestEndTs = 0;

    for (const target of run.targets || []) {
      // Recompute the path from the run dir so records written with stale
      // absolute paths (or on another machine) still resolve locally.
      const file = path.join(dir, `${target.key || target.site}.ndjson`);
      const { sawEnd, sawAny, endTs } = replayTargetNdjson(target, file);
      const complete =
        sawEnd ||
        (target.totals.total > 0 && target.totals.completed >= target.totals.total);

      if (complete) {
        target.status = target.totals.failed > 0 ? 'failed' : 'passed';
        if (endTs && endTs > latestEndTs) latestEndTs = endTs;
      } else if (sawAny || ['queued', 'authenticating', 'running'].includes(target.status)) {
        target.status = 'interrupted';
        anyCutOff = true;
      }
    }

    recomputeRunTotals(run);
    run.recovered = true;
    run.finishedAt =
      run.finishedAt ||
      (latestEndTs ? new Date(latestEndTs).toISOString() : new Date().toISOString());
    if (run.startedAt) {
      run.durationMs = new Date(run.finishedAt) - new Date(run.startedAt);
    }

    if (anyCutOff || !run.targets || !run.targets.length) {
      run.status = 'interrupted';
    } else if (run.targets.some((t) => t.status === 'failed')) {
      run.status = 'failed';
    } else {
      run.status = 'passed';
    }

    store.saveRun(run);
  }
}

module.exports = {
  events,
  sanitiseRequestedEnv,
  startRun,
  cancelRun,
  cancelTarget,
  shutdown,
  getActiveSnapshot,
  isActive,
  listActive,
  recoverInterrupted,
};
