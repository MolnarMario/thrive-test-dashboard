'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const config = require('../config');
const { PORT, RUNS_DIR, SUITES, SITES } = config;
const frameworks = require('./frameworks');
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

// Cancel a single target within a run (kills just that target's process,
// frees it). `:target` is the "<suite>__<site>" key; a bare site key is still
// accepted so older links keep working.
app.post('/api/runs/:id/targets/:target/cancel', (req, res) => {
  const ok = orchestrator.cancelTarget(req.params.id, req.params.target);
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
// Only Playwright produces one; the other frameworks expose /artifacts instead.
app.use('/api/runs/:id/report/:target', (req, res, next) => {
  const dir = path.join(RUNS_DIR, req.params.id, `${req.params.target}-report`);
  if (!fs.existsSync(dir)) {
    return res.status(404).send('No report for this target.');
  }
  express.static(dir)(req, res, next);
});

/**
 * Browse whatever a non-Playwright target left behind: Cypress failure
 * screenshots, Surefire XML/text reports. A plain listing rather than a
 * generated report — the framework didn't produce one, and inventing a fancier
 * view would only hide what's actually there.
 */
app.get('/api/runs/:id/artifacts/:target', (req, res) => {
  const root = path.join(RUNS_DIR, req.params.id, `${req.params.target}-artifacts`);
  if (!fs.existsSync(root)) return res.status(404).send('No artifacts for this target.');

  const files = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, relPath);
      else files.push({ path: relPath, size: fs.statSync(abs).size });
    }
  };
  try { walk(root, ''); } catch (_) { /* listing is best-effort */ }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const base = `/api/runs/${encodeURIComponent(req.params.id)}/artifacts/${encodeURIComponent(req.params.target)}/file`;
  const rows = files.length
    ? files.map((f) => `<li><a href="${base}/${f.path.split('/').map(encodeURIComponent).join('/')}">${esc(f.path)}</a> <span>${(f.size / 1024).toFixed(1)} KB</span></li>`).join('')
    : '<li class="empty">This run produced no artifacts.</li>';

  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>Artifacts — ${esc(req.params.target)}</title>
<style>body{font:14px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif;margin:32px;color:#1a1a2e}
h1{font-size:18px}ul{list-style:none;padding:0}li{padding:6px 0;border-bottom:1px solid #e3e6ec;display:flex;gap:12px}
li span{color:#5b6472;font-size:12px;margin-left:auto}a{color:#1667c2;text-decoration:none}a:hover{text-decoration:underline}
.empty{color:#5b6472}</style></head><body>
<h1>Artifacts · ${esc(req.params.target)}</h1><ul>${rows}</ul></body></html>`);
});

app.use('/api/runs/:id/artifacts/:target/file', (req, res, next) => {
  const root = path.join(RUNS_DIR, req.params.id, `${req.params.target}-artifacts`);
  if (!fs.existsSync(root)) return res.status(404).send('No artifacts for this target.');
  express.static(root)(req, res, next);
});

// Suites, sites and toolchain status — what the UI needs to explain the setup.
app.get('/api/env', (_req, res) => {
  res.json({
    suites: Object.values(SUITES).map((s) => {
      if (s.frameworks) {
        const members = s.frameworks.map((f) => {
          const meta = frameworks.has(f.id) ? frameworks.describe(f.id) : null;
          const tooling = meta && f.layout.ok ? frameworks.get(f.id).checkTooling(s.dir, f.layout) : null;
          const ok = f.layout.ok && (!tooling || tooling.ok);
          return {
            id: f.id,
            label: (meta && meta.label) || f.id,
            language: meta && meta.language,
            ok,
            reason: ok ? null : (f.layout.reason || (tooling && tooling.message)),
          };
        });
        return {
          key: s.key,
          name: s.name,
          dir: s.dir,
          framework: null,
          frameworks: members,
          label: members.map((m) => m.label).join(' + '),
          language: null,
          ok: s.ok,
          reason: s.reason,
        };
      }
      const meta = s.framework && frameworks.has(s.framework) ? frameworks.describe(s.framework) : null;
      const tooling = meta ? frameworks.get(s.framework).checkTooling(s.dir, s.layout) : null;
      return {
        key: s.key,
        name: s.name,
        dir: s.dir,
        framework: s.framework,
        label: meta && meta.label,
        language: meta && meta.language,
        ok: s.ok && (!tooling || tooling.ok),
        reason: s.reason || (tooling && !tooling.ok ? tooling.message : null),
      };
    }),
    sites: Object.values(SITES).map((s) => ({ key: s.key, name: s.name, url: s.url })),
  });
});

// Registered sites — the "testing pool". Credentials never leave the server.
app.get('/api/sites', (_req, res) => {
  res.json({
    sites: Object.values(SITES).map((s) => ({ key: s.key, name: s.name, url: s.url, custom: !!s.custom })),
  });
});

// Add a site from the dashboard UI; selectable in every suite's dropdown
// immediately (config.addSite() reloads SITES/SUITES in place, no restart).
app.post('/api/sites', (req, res) => {
  try {
    const site = config.addSite(req.body || {});
    res.status(201).json({ site: { key: site.key, name: site.name, url: site.url, custom: true } });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Remove a site added through the UI. Sites from sites.config.json can't be
// removed here — that file stays the source of truth for those.
app.delete('/api/sites/:key', (req, res) => {
  try {
    config.removeSite(req.params.key);
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
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

// --- PR Builder (build a configured plugin/theme PR onto its Local site) ---

app.get('/api/prbuilder/projects', (_req, res) => {
  try {
    res.json({ projects: prbuilder.listProjects() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/prbuilder/prs', async (req, res) => {
  try {
    res.json({
      prs: await prbuilder.listPRs({
        project: req.query.project || undefined,
        state: req.query.state || undefined,
        limit: req.query.limit,
      }),
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
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
// Warm the discovery cache (Playwright's `--list` takes a few seconds) so the
// tree shows exact "tests that will run" without the first page load waiting.
tree.getTree().catch(() => {});

app.listen(PORT, () => {
  /* eslint-disable no-console */
  console.log(`\n  Automation Test Platform → http://localhost:${PORT}\n`);
  for (const suite of Object.values(SUITES)) {
    if (suite.frameworks) {
      const labels = suite.frameworks.map((f) => (frameworks.has(f.id) ? frameworks.get(f.id).label : f.id));
      console.log(
        `  ${suite.ok ? '✓' : '✗'} ${suite.key.padEnd(16)} ${labels.join('+').padEnd(11)} ${suite.dir}`
      );
      if (!suite.ok) console.warn(`      ${suite.reason}`);
      continue;
    }
    const fw = suite.framework && frameworks.has(suite.framework)
      ? frameworks.get(suite.framework)
      : null;
    const tooling = fw ? fw.checkTooling(suite.dir, suite.layout) : { ok: false, message: 'unknown framework' };
    const ok = suite.ok && tooling.ok;
    console.log(
      `  ${ok ? '✓' : '✗'} ${suite.key.padEnd(16)} ${(fw ? fw.label : suite.framework || '?').padEnd(11)} ${suite.dir}`
    );
    if (!ok) console.warn(`      ${suite.reason || tooling.message}`);
  }
  console.log('');
  /* eslint-enable no-console */
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
