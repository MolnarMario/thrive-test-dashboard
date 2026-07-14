'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const { PORT, RUNS_DIR, SUITE_DIR, PLAYWRIGHT_CLI, PR_BUILDER } = require('../config');
const store = require('./store');
const tree = require('./tree');
const orchestrator = require('./orchestrator');
const { buildCombinedReportHtml } = require('./combined-report');
const preflight = require('./preflight');
const scheduler = require('./scheduler');
const prbuilder = require('./prbuilder');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* --------------------------------- API ----------------------------------- */

// Test tree (sites -> dirs -> spec files).
app.get('/api/tree', async (req, res) => {
  try {
    res.json(await tree.getTree({ refresh: req.query.refresh === '1' }));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Start a run.
app.post('/api/runs', (req, res) => {
  const { targets, label } = req.body || {};
  try {
    const { id } = orchestrator.startRun(targets, label);
    res.status(201).json({ id });
  } catch (err) {
    res.status(409).json({ error: String(err.message || err) });
  }
});

// List run history (newest first).
app.get('/api/runs', (req, res) => {
  res.json({ runs: store.listRuns({ limit: Number(req.query.limit) || 200 }) });
});

// Currently active runs.
app.get('/api/active', (_req, res) => {
  res.json({ runs: orchestrator.listActive().filter(Boolean) });
});

// Single run detail. While running, return the live snapshot; once finished,
// prefer the persisted record (it carries the full per-test arrays that the
// slim live snapshot omits — even during the brief post-run lingering window).
app.get('/api/runs/:id', (req, res) => {
  const live = orchestrator.getActiveSnapshot(req.params.id);
  if (live && live.status === 'running') {
    return res.json({ run: live, live: true });
  }
  const run = store.loadRun(req.params.id);
  if (run) return res.json({ run, live: false });
  if (live) return res.json({ run: live, live: true }); // disk not ready yet
  res.status(404).json({ error: 'Run not found' });
});

// Cancel a run.
app.post('/api/runs/:id/cancel', (req, res) => {
  const ok = orchestrator.cancelRun(req.params.id);
  res.status(ok ? 202 : 404).json({ cancelling: ok });
});

// Cancel a single site within a run (kills just that site's process, frees it).
app.post('/api/runs/:id/targets/:site/cancel', (req, res) => {
  const ok = orchestrator.cancelSite(req.params.id, req.params.site);
  res.status(ok ? 202 : 404).json({ cancelling: ok });
});

// Live progress via Server-Sent Events.
app.get('/api/runs/:id/stream', (req, res) => {
  const id = req.params.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Initial snapshot: live state if running, else the final persisted record.
  const live = orchestrator.getActiveSnapshot(id);
  if (live) {
    send({ kind: 'snapshot', run: live });
  } else {
    const run = store.loadRun(id);
    send({ kind: 'snapshot', run, final: true });
    if (run) send({ kind: 'run-end', run });
    res.end();
    return;
  }

  const onUpdate = (runId, payload) => {
    if (runId !== id) return;
    send(payload);
    if (payload.kind === 'run-end') {
      cleanup();
      res.end();
    }
  };

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  orchestrator.events.on('update', onUpdate);

  function cleanup() {
    clearInterval(keepAlive);
    orchestrator.events.removeListener('update', onUpdate);
  }
  req.on('close', cleanup);
});

// One combined HTML report merging every product of a run into a single page
// (printable to PDF via Ctrl+P). Built on demand from the persisted run.json.
app.get('/api/runs/:id/combined-report', (req, res) => {
  const run = store.loadRun(req.params.id);
  if (!run) return res.status(404).send('Run not found.');
  res.type('html').send(buildCombinedReportHtml(run));
});

// Serve a target's Playwright HTML report (drill-down to traces/screenshots).
app.use('/api/runs/:id/report/:site', (req, res, next) => {
  const dir = path.join(RUNS_DIR, req.params.id, `${req.params.site}-report`);
  if (!fs.existsSync(dir)) {
    return res.status(404).send('No report for this target.');
  }
  express.static(dir)(req, res, next);
});

// Lightweight environment / preflight info.
app.get('/api/env', (_req, res) => {
  res.json({
    suiteDir: SUITE_DIR,
    playwrightCliExists: fs.existsSync(PLAYWRIGHT_CLI),
    prBuilderSite: PR_BUILDER.siteDomain,
  });
});

// Site reachability check (LocalWP up?). ?sites=a,b,c (default: all).
app.get('/api/preflight', async (req, res) => {
  const sites = req.query.sites ? String(req.query.sites).split(',').filter(Boolean) : [];
  try {
    res.json({ sites: await preflight.checkSites(sites) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Calendar: runs grouped by local day for a given month (YYYY-MM).
app.get('/api/calendar', (req, res) => {
  const month = String(req.query.month || '').slice(0, 7); // YYYY-MM
  const days = {};
  for (const r of store.listRuns({ limit: 5000 })) {
    const when = r.startedAt || r.createdAt;
    if (!when) continue;
    const day = localDay(when);
    if (month && !day.startsWith(month)) continue;
    if (!days[day]) days[day] = { count: 0, passed: 0, failed: 0, other: 0, runs: [] };
    const d = days[day];
    d.count += 1;
    if (r.status === 'passed') d.passed += 1;
    else if (r.status === 'failed' || r.status === 'error') d.failed += 1;
    else d.other += 1;
    d.runs.push(r);
  }
  res.json({ month, days });
});

// --- Schedules (Phase 5) ---
app.get('/api/schedules', (_req, res) => res.json({ schedules: scheduler.list() }));

app.post('/api/schedules', (req, res) => {
  try {
    res.status(201).json({ schedule: scheduler.create(req.body) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.put('/api/schedules/:id', (req, res) => {
  try {
    res.json({ schedule: scheduler.update(req.params.id, req.body) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post('/api/schedules/:id/toggle', (req, res) => {
  try {
    res.json({ schedule: scheduler.setEnabled(req.params.id, req.body && req.body.enabled) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post('/api/schedules/:id/run', (req, res) => {
  const result = scheduler.fire(req.params.id);
  res.status(result.ok ? 202 : 409).json(result);
});

app.delete('/api/schedules/:id', (req, res) => {
  scheduler.remove(req.params.id);
  res.json({ deleted: true });
});

// --- PR Builder (build a thrive-themes PR onto the designated Local site) ---

app.get('/api/prbuilder/milestones', async (_req, res) => {
  try {
    res.json({ milestones: await prbuilder.listMilestones() });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get('/api/prbuilder/prs', async (req, res) => {
  try {
    res.json({
      prs: await prbuilder.listPRs({
        milestoneTitle: req.query.milestone || undefined,
        limit: req.query.limit,
      }),
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get('/api/prbuilder/recommend', async (req, res) => {
  try {
    res.json(await prbuilder.recommend(req.query.pr));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.get('/api/prbuilder/active', (_req, res) => {
  res.json({ build: prbuilder.getActive() });
});

app.get('/api/prbuilder/builds', (req, res) => {
  res.json({ builds: prbuilder.listBuilds({ limit: Number(req.query.limit) || 100 }) });
});

app.get('/api/prbuilder/builds/:id', (req, res) => {
  const active = prbuilder.getActive();
  if (active && active.id === req.params.id) return res.json({ build: active, live: true });
  const build = prbuilder.loadBuild(req.params.id);
  if (build) return res.json({ build, live: false });
  res.status(404).json({ error: 'Build not found' });
});

app.post('/api/prbuilder/build', (req, res) => {
  try {
    res.status(201).json(prbuilder.startBuild(req.body || {}));
  } catch (err) {
    res.status(409).json({ error: String(err.message || err) });
  }
});

// Run the test suite against the PR-built site. The orchestrator handles the
// run (single-site target), so it shows up in Live + History like any run.
app.post('/api/prbuilder/test', (req, res) => {
  try {
    const { target, label } = prbuilder.buildTestTarget(req.body || {});
    const { id } = orchestrator.startRun([target], label);
    res.status(201).json({ id });
  } catch (err) {
    const msg = String(err.message || err);
    res.status(/in progress/.test(msg) ? 409 : 400).json({ error: msg });
  }
});

app.post('/api/prbuilder/builds/:id/cancel', (req, res) => {
  const ok = prbuilder.cancelBuild(req.params.id);
  res.status(ok ? 202 : 404).json({ cancelling: ok });
});

// Live build log via SSE (replays the persisted log, then streams live).
app.get('/api/prbuilder/builds/:id/stream', (req, res) => {
  const id = req.params.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const active = prbuilder.getActive();
  const isLive = active && active.id === id;
  const build = isLive ? active : prbuilder.loadBuild(id);
  send({ kind: 'snapshot', build, logs: prbuilder.readLogLines(id), live: !!isLive });

  if (!isLive) {
    if (build) send({ kind: 'build-end', build });
    res.end();
    return;
  }

  const onUpdate = (buildId, payload) => {
    if (buildId !== id) return;
    send(payload);
    if (payload.kind === 'build-end') { cleanup(); res.end(); }
  };
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  prbuilder.events.on('update', onUpdate);
  function cleanup() {
    clearInterval(keepAlive);
    prbuilder.events.removeListener('update', onUpdate);
  }
  req.on('close', cleanup);
});

function localDay(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------- bootstrap -------------------------------- */

store.ensureDir(RUNS_DIR);
orchestrator.recoverInterrupted();
prbuilder.recoverInterrupted();
scheduler.init();
// Warm the test-count cache (~6s `playwright --list`) so the tree shows exact
// "tests that will run" without the first page load waiting on it.
tree.getTree().catch(() => {});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`\n  Thrive Test Dashboard → http://localhost:${PORT}\n`);
  if (!fs.existsSync(PLAYWRIGHT_CLI)) {
    console.warn(
      `  WARNING: Playwright CLI not found at:\n    ${PLAYWRIGHT_CLI}\n` +
        `  Check DASHBOARD_SUITE_DIR / that the suite has node_modules installed.\n`
    );
  }
});

/* ------------------------------- shutdown --------------------------------- */
// Stopping the dashboard must not orphan in-flight Playwright runs (they can run
// for hours headless). Kill tracked children and mark runs interrupted on exit.
let shuttingDown = false;
function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} received — stopping active runs and exiting…`);
  try { orchestrator.shutdown(); } catch (_) {}
  try { prbuilder.shutdown(); } catch (_) {}
  process.exit(0);
}
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => process.on(sig, () => gracefulExit(sig)));
