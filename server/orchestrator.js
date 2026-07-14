'use strict';

/**
 * Run orchestrator. Spawns Playwright per target site (auth, then tests),
 * tails each site's NDJSON event file for live progress, emits 'update'
 * events for SSE, and persists results via the store.
 *
 * Mirrors scripts/run-parallel.sh: sequential auth, then parallel test runs,
 * one OS process per target site.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const {
  SUITE_DIR,
  PLAYWRIGHT_CONFIG,
  PLAYWRIGHT_CLI,
  REPORTER_PATH,
  SITES,
  SITE_START_STAGGER_MS,
  MAX_CONCURRENT_SITES,
  SITE_START_PRIORITY,
} = require('../config');
const store = require('./store');

const events = new EventEmitter();

/** runId -> live run state */
const active = new Map();
/** runId -> [ChildProcess] for cancellation */
const procs = new Map();
/** site key -> runId that currently owns it (concurrency guard + ownership) */
const busySites = new Map();
/** `${runId}:${site}` -> planned test list (live-only; not persisted) */
const plans = new Map();
/** `${runId}:${site}` -> child env overrides (THRIVE_SITE, or single-site
 *  PLAYWRIGHT_BASE_URL + creds). Kept off the run record so creds aren't persisted. */
const spawnEnvs = new Map();

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
 * Free a site ONLY if this run still owns it. Prevents an old run's finalize
 * from releasing a site that a newer run has already re-acquired (e.g. after a
 * per-site cancel frees the site early and the user starts a fresh run for it).
 */
function releaseSite(site, runId) {
  if (busySites.get(site) === runId) busySites.delete(site);
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

/**
 * Start a run.
 * @param {Array<{site:string, paths?:string[], grep?:string}>} targets
 * @param {string} [label]
 * @returns {{id:string}}
 */
function startRun(targets, label) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('No targets selected.');
  }

  const clash = targets.find((t) => busySites.has(t.site));
  if (clash) {
    throw new Error(
      `A run is already in progress for site "${clash.site}". ` +
        `Wait for it to finish (one run per site at a time).`
    );
  }
  for (const t of targets) {
    // Custom targets (a single-site run against an explicit baseUrl, e.g. the
    // PR-built site) don't need a SITES entry.
    if (!t.baseUrl && !SITES[t.site]) throw new Error(`Unknown site: ${t.site}`);
  }

  const id = makeRunId();
  const dir = store.runDir(id);
  store.ensureDir(dir);

  const run = {
    id,
    label: label || defaultLabel(targets),
    trigger: 'manual',
    status: 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    totals: emptyTotals(),
    targets: targets.map((t) => {
      // Custom = single-site run against an explicit baseUrl (the PR-built site);
      // otherwise a configured THRIVE_SITE.
      const custom = !!t.baseUrl;
      const cfg = custom ? null : SITES[t.site];
      const paths =
        Array.isArray(t.paths) && t.paths.length
          ? t.paths
          : (cfg ? cfg.testDirs.map((d) => `tests/${d}/`) : ['tests/']);
      spawnEnvs.set(`${id}:${t.site}`, custom
        ? { PLAYWRIGHT_BASE_URL: t.baseUrl, ...(t.env || {}) }
        : { THRIVE_SITE: t.site });
      return {
        site: t.site,
        name: custom ? (t.name || t.site) : cfg.name,
        url: custom ? (t.url || t.baseUrl) : cfg.url,
        paths,
        grep: t.grep || null,
        status: 'queued',
        authStatus: 'pending',
        exitCode: null,
        totals: emptyTotals(),
        currentTest: null,
        ndjson: path.join(dir, `${t.site}.ndjson`),
        reportDir: path.join(dir, `${t.site}-report`),
        outputDir: path.join(dir, `${t.site}-test-results`),
        authLog: path.join(dir, `${t.site}-auth.log`),
        log: path.join(dir, `${t.site}.log`),
        tests: [],
      };
    }),
  };

  active.set(id, run);
  procs.set(id, []);
  targets.forEach((t) => busySites.set(t.site, id));
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
  const names = targets.map((t) => t.site);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

async function executeRun(id) {
  const run = active.get(id);
  emit(id, { kind: 'run-start', run: snapshot(id) });

  // Phase 1: authenticate each target sequentially (fast, ~5s each), in
  // priority order (apprentice, architect, ttb, quiz first).
  for (const target of orderTargets(run.targets)) {
    if (run.cancelled) break;
    if (target.cancelled) continue; // cancelled while queued
    target.status = 'authenticating';
    emit(id, { kind: 'target-update', target: slimTarget(target) });

    const ok = await authenticate(id, target);
    if (run.cancelled || target.cancelled) continue; // don't clobber a cancel
    target.authStatus = ok ? 'ok' : 'failed';
    if (!ok) {
      target.status = 'error';
      releaseSite(target.site, id); // free the site the moment auth fails
      emit(id, { kind: 'target-update', target: slimTarget(target) });
    }
    store.saveRun(run);
  }

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
 * cancellation. A site cancelled while still queued here never spawns.
 */
async function launchWithStagger(id, targets) {
  const run = active.get(id);
  const inflight = []; // { done:boolean, promise:Promise }

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
    if (target.cancelled) continue; // cancelled during the cap-wait

    const rec = { done: false };
    rec.promise = runTests(id, target).then(() => { rec.done = true; });
    inflight.push(rec);

    // Stagger before the NEXT launch (no wait after the last one).
    if (i < targets.length - 1 && SITE_START_STAGGER_MS > 0) {
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

/** Authenticate one site, retrying once (per suite orchestration rules). */
async function authenticate(id, target, attempt = 1) {
  const ok = await new Promise((resolve) => {
    const child = spawnPw({
      args: ['--reporter=line', 'tests/auth.setup.ts'],
      spawnEnv: spawnEnvs.get(`${id}:${target.site}`),
      logFile: target.authLog,
    });
    track(id, child, target.site);
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });

  if (!ok && attempt < 2 && !active.get(id).cancelled && !target.cancelled) {
    return authenticate(id, target, attempt + 1);
  }
  return ok;
}

/** Run the test step for one target, tailing its NDJSON for live progress. */
function runTests(id, target) {
  return new Promise((resolve) => {
    const run = active.get(id);
    target.status = 'running';
    emit(id, { kind: 'target-update', target: slimTarget(target) });

    const reporterArg = `--reporter=line,html,${REPORTER_PATH}`;
    const args = [reporterArg, `--output=${target.outputDir}`, ...target.paths];
    if (target.grep) args.push(`--grep=${target.grep}`);

    const child = spawnPw({
      args,
      spawnEnv: spawnEnvs.get(`${id}:${target.site}`),
      logFile: target.log,
      extraEnv: {
        DASHBOARD_EVENTS_FILE: target.ndjson,
        PLAYWRIGHT_HTML_REPORT: target.reportDir,
      },
    });
    track(id, child, target.site);

    const tailer = makeTailer(target.ndjson, (evt) =>
      handleEvent(id, target, evt)
    );

    child.on('close', (code) => {
      target.exitCode = code;
      // Give the tailer a moment to drain the final 'end' line.
      setTimeout(() => {
        tailer.stop();
        if (target.status !== 'cancelled') {
          const failed = target.totals.failed > 0 || code !== 0;
          target.status = failed ? 'failed' : 'passed';
        }
        releaseSite(target.site, id); // free the site the moment it finishes
        emit(id, { kind: 'target-end', target: slimTarget(target) });
        store.saveRun(run);
        maybeFinalize(id);
        resolve();
      }, 900);
    });
    child.on('error', (err) => {
      if (target.status !== 'cancelled') {
        target.status = 'error';
        target.error = String(err.message || err);
      }
      tailer.stop();
      releaseSite(target.site, id);
      emit(id, { kind: 'target-end', target: slimTarget(target) });
      store.saveRun(run);
      maybeFinalize(id);
      resolve();
    });
  });
}

function handleEvent(id, target, evt) {
  const run = active.get(id);
  if (!run) return;

  if (evt.type === 'begin') {
    target.totals.total = evt.totalTests || 0;
    recomputeRunTotals(run);
    emit(id, { kind: 'target-begin', site: target.site, totals: target.totals });
    return;
  }

  if (evt.type === 'plan') {
    plans.set(`${id}:${target.site}`, Array.isArray(evt.tests) ? evt.tests : []);
    emit(id, { kind: 'plan', site: target.site, tests: evt.tests || [] });
    return;
  }

  if (evt.type === 'test-begin') {
    target.currentTest = evt.title || null;
    if (!target.runningIds) target.runningIds = [];
    if (evt.id && !target.runningIds.includes(evt.id)) target.runningIds.push(evt.id);
    emit(id, { kind: 'current', site: target.site, title: target.currentTest, id: evt.id });
    return;
  }

  if (evt.type === 'test') {
    const status = normStatus(evt.status);
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
      site: target.site,
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
      run.status = run.targets.every((t) => t.status === 'error')
        ? 'error'
        : 'failed';
    } else if (run.targets.some((t) => t.status === 'failed')) {
      run.status = 'failed';
    } else {
      run.status = 'passed';
    }
  }

  store.saveRun(run);
  emit(id, { kind: 'run-end', run: snapshot(id) });

  run.targets.forEach((t) => releaseSite(t.site, id));
  procs.delete(id);
  // Keep the snapshot briefly so late SSE reconnects still see it.
  setTimeout(() => {
    active.delete(id);
    run.targets.forEach((t) => {
      plans.delete(`${id}:${t.site}`);
      spawnEnvs.delete(`${id}:${t.site}`);
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
 * Cancel ONE site within a run: kill just that site's child process(es), mark
 * the target cancelled, free it from busySites immediately (so a new run can
 * re-target it right away), and finalize the run if nothing else is still
 * active. Does not affect the other sites. Returns false if unknown/terminal.
 */
function cancelSite(id, site) {
  const run = active.get(id);
  if (!run) return false;
  const target = run.targets.find((t) => t.site === site);
  if (!target || isTerminal(target.status)) return false;

  target.cancelled = true; // stops a queued spawn / auth retry
  target.status = 'cancelled';
  for (const child of (procs.get(id) || []).filter((c) => c._site === site)) {
    killTree(child); // idempotent; guarded against double-kill
  }
  releaseSite(site, id);
  emit(id, { kind: 'target-end', target: slimTarget(target) });
  store.saveRun(run);
  maybeFinalize(id);
  return true;
}

/**
 * Finalize the run once Phase 2 has finished launching AND every target has
 * reached a terminal state. Guarded so an early-terminal site (e.g. a per-site
 * cancel or an auth failure) never finalizes the run while others are still
 * queued in the stagger.
 */
function maybeFinalize(id) {
  const run = active.get(id);
  if (!run || run.finalized || !run.launchComplete) return;
  if (run.targets.some((t) => !isTerminal(t.status))) return;
  finalize(id);
}

/**
 * Stop everything when the server is shutting down (Ctrl+C / SIGTERM).
 * Synchronously kills every tracked child so multi-hour Playwright runs don't
 * keep running headless after the dashboard is gone, and records any in-flight
 * run as 'interrupted' on disk. Its NDJSON still holds the detail, which
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

function spawnPw({ args, spawnEnv, logFile, extraEnv }) {
  const fullArgs = [PLAYWRIGHT_CLI, 'test', `--config=${PLAYWRIGHT_CONFIG}`, ...args];
  const child = spawn(process.execPath, fullArgs, {
    cwd: SUITE_DIR,
    // PLAYWRIGHT_HTML_OPEN=never: our CLI `--reporter=...,html,...` overrides the
    // suite config's reporter (incl. its `open:'never'`), and a CLI html reporter
    // defaults to `open:'on-failure'` — which serves the report and blocks on
    // "Press Ctrl+C to quit" forever, so a failed run's process never exits and
    // the run never finalizes. Forcing 'never' here keeps the process short-lived.
    // (Not CI=1 — that would also enable retries and break the 1-event-per-test
    // assumption the live counts rely on.)
    env: { ...process.env, PLAYWRIGHT_HTML_OPEN: 'never', ...(spawnEnv || {}), ...(extraEnv || {}) },
    windowsHide: true,
  });
  if (logFile) {
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
  }
  return child;
}

function track(id, child, site) {
  child._site = site || null; // tag so cancelSite can target one site's process
  const list = procs.get(id);
  if (list) list.push(child);
}

/**
 * Forcibly kill a child and its descendants (Playwright spawns browser procs).
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
    site: t.site,
    name: t.name,
    status: t.status,
    authStatus: t.authStatus,
    exitCode: t.exitCode,
    totals: t.totals,
    currentTest: t.currentTest,
    runningIds: t.runningIds || [],
    // For the per-site "Re-run" button. No creds/baseUrl (those live only in
    // spawnEnvs and are never persisted); `custom` PR-built targets can't be
    // reconstructed generically, so the UI hides Re-run for them.
    paths: t.paths,
    grep: t.grep || null,
    custom: !SITES[t.site],
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
      plannedTests: plans.get(`${run.id}:${t.site}`) || [],
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
      const status = normStatus(evt.status);
      totals[status] += 1;
      totals.completed += 1;
      tests.push({
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
      const file = path.join(dir, `${target.site}.ndjson`);
      const { sawEnd, sawAny, endTs } = replayTargetNdjson(target, file);

      if (sawEnd) {
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
  startRun,
  cancelRun,
  cancelSite,
  shutdown,
  getActiveSnapshot,
  isActive,
  listActive,
  recoverInterrupted,
};
