'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const config = require('../config');
const { PORT, HOST, TRUST_PROXY, RUNS_DIR, SUITES, SITES } = config;
const frameworks = require('./frameworks');
const store = require('./store');
const tree = require('./tree');
const orchestrator = require('./orchestrator');
const { buildCombinedReportHtml } = require('./combined-report');
const preflight = require('./preflight');
const scheduler = require('./scheduler');
const prbuilder = require('./prbuilder');
const auth = require('./auth');

const app = express();

// Only meaningful behind a reverse proxy, and actively harmful without one:
// with it on, anyone can forge X-Forwarded-For (defeating per-client login
// throttling) and X-Forwarded-Proto (defeating the Secure cookie flag).
if (TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
}
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));

/* ------------------------------ base headers ------------------------------ */

/**
 * Applied to everything, including the reports and artifacts served further
 * down. The CSP here is the app's own: no external origins at all, so a script
 * that does get injected has nowhere to send what it reads. Report pages
 * relax it slightly (see reportCsp) because Playwright's HTML report is a
 * bundled app that needs inline script to run.
 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
      "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  // Only meaningful over TLS, and only safe to send there: on a plain-HTTP
  // install this would pin a scheme that doesn't exist.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/* ----------------------------- path parameters ---------------------------- */

/**
 * Every id below is pasted straight into a filesystem path, and Express
 * percent-decodes route parameters *after* matching — so `:id` happily arrives
 * as `../../something` if the client sent `..%2f..%2fsomething`. That turns a
 * report link into a file browser for the whole disk.
 *
 * The ids this app actually mints are timestamps, slugs and target keys, so
 * one conservative pattern covers all of them, and anything else is a 400
 * before it reaches path.join().
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeParams(...names) {
  return (req, res, next) => {
    for (const name of names) {
      const value = req.params[name];
      if (typeof value !== 'string' || !SAFE_SEGMENT.test(value) || value.includes('..')) {
        return res.status(400).json({ error: `Invalid ${name}.` });
      }
    }
    next();
  };
}

/* --------------------------------- auth ---------------------------------- */
// Order matters: reject cross-site writes, hydrate the session, expose the
// handful of endpoints a signed-out browser needs, then close the gate.
// Everything below it — API routes, static files, reports, SSE — requires a
// session, and an account still on an assigned password can only change it.

app.use(auth.sameOriginOnly);
app.use(auth.attachUser);

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const result = await auth.login(username, password, req.ip);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    auth.setSessionCookie(req, res, result.sid);
    res.json({ user: auth.publicUser(result.user) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/auth/logout', (req, res) => {
  auth.logout(req.sessionId);
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

// The frontend's single source of truth for what to render. Public so the app
// can ask "am I signed in?" without provoking a 401 in the console. The policy
// rides along so every password field can state the rules before you type.
app.get('/api/auth/me', (req, res) => {
  res.json({
    user: req.user ? auth.publicUser(req.user) : null,
    passwordPolicy: auth.passwordPolicy,
  });
});

app.use(auth.gate);
app.use(auth.requirePasswordChange);

// Change your own password. Signs out this account's other sessions.
app.post('/api/auth/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  try {
    res.json({
      user: await auth.changePassword(req.user, currentPassword, newPassword, req.sessionId),
    });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

/* --------------------------------- users --------------------------------- */

app.get('/api/users', auth.requirePermission('users.manage'), (_req, res) => {
  res.json({
    users: auth.listUsers(),
    roles: auth.ROLES,
    permissions: auth.PERMISSIONS,
    roleDefaults: auth.ROLE_DEFAULTS,
    adminOnlyPermissions: auth.ADMIN_ONLY_PERMISSIONS,
  });
});

app.post('/api/users', auth.requirePermission('users.manage'), async (req, res) => {
  try {
    res.status(201).json({ user: await auth.createUser(req.body || {}, req.user) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.patch('/api/users/:username', auth.requirePermission('users.manage'), async (req, res) => {
  try {
    res.json({ user: await auth.updateUser(req.params.username, req.body || {}, req.user) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.delete('/api/users/:username', safeParams('username'), auth.requirePermission('users.manage'), (req, res) => {
  try {
    res.json(auth.deleteUser(req.params.username, req.user));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

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
app.post('/api/runs', auth.requirePermission('tests.run'), (req, res) => {
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
app.get('/api/runs/:id', safeParams('id'), (req, res) => {
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
app.post('/api/runs/:id/cancel', safeParams('id'), auth.requirePermission('tests.run'), (req, res) => {
  const ok = orchestrator.cancelRun(req.params.id);
  res.status(ok ? 202 : 404).json({ cancelling: ok });
});

// Cancel a single target within a run (kills just that target's process,
// frees it). `:target` is the "<suite>__<site>" key; a bare site key is still
// accepted so older links keep working.
app.post('/api/runs/:id/targets/:target/cancel', safeParams('id', 'target'), auth.requirePermission('tests.run'), (req, res) => {
  const ok = orchestrator.cancelTarget(req.params.id, req.params.target);
  res.status(ok ? 202 : 404).json({ cancelling: ok });
});

// Live progress via Server-Sent Events.
app.get('/api/runs/:id/stream', safeParams('id'), (req, res) => {
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
app.get('/api/runs/:id/combined-report', safeParams('id'), (req, res) => {
  const run = store.loadRun(req.params.id);
  if (!run) return res.status(404).send('Run not found.');
  res.type('html').send(buildCombinedReportHtml(run));
});

/**
 * Serve a target's Playwright HTML report (drill-down to traces/screenshots).
 * Only Playwright produces one; the other frameworks expose /artifacts instead.
 *
 * The report is a self-contained app whose script and data are inlined, so the
 * strict app CSP would stop it dead — it gets its own, relaxed exactly as far
 * as it needs and no further. What stays locked is the network: no origin but
 * this one appears anywhere, so nothing a report renders can call home. That
 * matters because a report renders *test output*, which is attacker-influenced
 * whenever a suite touches a site you don't control.
 */
const REPORT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; media-src 'self' data: blob:; " +
  "connect-src 'self' data: blob:; worker-src 'self' blob:; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

app.use('/api/runs/:id/report/:target', safeParams('id', 'target'), (req, res, next) => {
  const dir = path.join(RUNS_DIR, req.params.id, `${req.params.target}-report`);
  if (!fs.existsSync(dir)) {
    return res.status(404).send('No report for this target.');
  }
  res.setHeader('Content-Security-Policy', REPORT_CSP);
  express.static(dir)(req, res, next);
});

/**
 * Browse whatever a non-Playwright target left behind: Cypress failure
 * screenshots, Surefire XML/text reports. A plain listing rather than a
 * generated report — the framework didn't produce one, and inventing a fancier
 * view would only hide what's actually there.
 */
app.get('/api/runs/:id/artifacts/:target', safeParams('id', 'target'), (req, res) => {
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

/**
 * Raw artifact files. Unlike the Playwright report these are not an app we
 * ship — they are whatever a framework dropped on disk after driving a site,
 * which is to say: content this dashboard did not write and cannot vouch for.
 *
 * So anything a browser would *execute* is handed over as a download instead
 * of rendered: an HTML or SVG artifact rendered inline would run its script
 * on this origin, with the viewer's session. Screenshots and logs still open
 * in the tab, which is all anyone wants from them anyway.
 */
const NEVER_RENDER = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.xsl', '.mhtml']);

app.use('/api/runs/:id/artifacts/:target/file', safeParams('id', 'target'), (req, res, next) => {
  const root = path.join(RUNS_DIR, req.params.id, `${req.params.target}-artifacts`);
  if (!fs.existsSync(root)) return res.status(404).send('No artifacts for this target.');
  express.static(root, {
    setHeaders(response, filePath) {
      if (NEVER_RENDER.has(path.extname(filePath).toLowerCase())) {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader(
          'Content-Disposition',
          `attachment; filename="${path.basename(filePath).replace(/["\\]/g, '')}"`
        );
      }
      // Everything else keeps the strict app-wide CSP set at the top of this
      // file — which already bans inline script — so a screenshot still
      // renders in the tab while nothing here can execute.
    },
  })(req, res, next);
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
app.post('/api/sites', auth.requirePermission('sites.manage'), (req, res) => {
  try {
    const site = config.addSite(req.body || {});
    res.status(201).json({ site: { key: site.key, name: site.name, url: site.url, custom: true } });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Edit a site added through the UI. Sites from sites.config.json can't be
// edited here — that file stays the source of truth for those.
app.patch('/api/sites/:key', safeParams('key'), auth.requirePermission('sites.manage'), (req, res) => {
  try {
    const site = config.updateSite(req.params.key, req.body || {});
    res.json({ site: { key: site.key, name: site.name, url: site.url, custom: true } });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Remove a site added through the UI. Sites from sites.config.json can't be
// removed here — that file stays the source of truth for those.
app.delete('/api/sites/:key', safeParams('key'), auth.requirePermission('sites.manage'), (req, res) => {
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

app.post('/api/schedules', auth.requirePermission('schedules.manage'), (req, res) => {
  try {
    res.status(201).json({ schedule: scheduler.create(req.body) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.put('/api/schedules/:id', safeParams('id'), auth.requirePermission('schedules.manage'), (req, res) => {
  try {
    res.json({ schedule: scheduler.update(req.params.id, req.body) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post('/api/schedules/:id/toggle', safeParams('id'), auth.requirePermission('schedules.manage'), (req, res) => {
  try {
    res.json({ schedule: scheduler.setEnabled(req.params.id, req.body && req.body.enabled) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post('/api/schedules/:id/run', safeParams('id'), auth.requirePermission('schedules.manage', 'tests.run'), (req, res) => {
  const result = scheduler.fire(req.params.id);
  res.status(result.ok ? 202 : 409).json(result);
});

app.delete('/api/schedules/:id', safeParams('id'), auth.requirePermission('schedules.manage'), (req, res) => {
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

app.get('/api/prbuilder/builds/:id', safeParams('id'), (req, res) => {
  const active = prbuilder.getActive();
  if (active && active.id === req.params.id) return res.json({ build: active, live: true });
  const build = prbuilder.loadBuild(req.params.id);
  if (build) return res.json({ build, live: false });
  res.status(404).json({ error: 'Build not found' });
});

app.post('/api/prbuilder/build', auth.requirePermission('prbuilder.use'), (req, res) => {
  try {
    res.status(201).json(prbuilder.startBuild(req.body || {}));
  } catch (err) {
    res.status(409).json({ error: String(err.message || err) });
  }
});

// Run the test suite against the PR-built site. The orchestrator handles the
// run (single-site target), so it shows up in Live + History like any run.
app.post('/api/prbuilder/test', auth.requirePermission('prbuilder.use', 'tests.run'), (req, res) => {
  try {
    // Trusted: this target is built server-side from the project config, not
    // from the request body, so it may carry its own URL and credentials.
    const { target, label } = prbuilder.buildTestTarget(req.body || {});
    const { id } = orchestrator.startRun([target], label, { trusted: true });
    res.status(201).json({ id });
  } catch (err) {
    const msg = String(err.message || err);
    res.status(/in progress/.test(msg) ? 409 : 400).json({ error: msg });
  }
});

app.post('/api/prbuilder/builds/:id/cancel', safeParams('id'), auth.requirePermission('prbuilder.use'), (req, res) => {
  const ok = prbuilder.cancelBuild(req.params.id);
  res.status(ok ? 202 : 404).json({ cancelling: ok });
});

// Live build log via SSE (replays the persisted log, then streams live).
app.get('/api/prbuilder/builds/:id/stream', safeParams('id'), (req, res) => {
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

// auth.init() hashes a password when it seeds the first admin, and hashing is
// deliberately slow — so the listener waits on it rather than racing it.
auth.init().then(startListening).catch((err) => {
  console.error(`\n  Could not initialise authentication: ${err.message}\n`);
  process.exit(1);
});

function startListening(seededAdmin) {
app.listen(PORT, HOST, () => {
  /* eslint-disable no-console */
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`\n  Automation Test Platform → http://${shown}:${PORT}\n`);
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
  if (seededAdmin && seededAdmin.password) {
    console.warn('  ┌──────────────────────────────────────────────────────────┐');
    console.warn('  │  No users existed, so a first admin account was created. │');
    console.warn('  │  This password is shown once and is not stored anywhere  │');
    console.warn('  │  in readable form. You must change it at first sign-in.  │');
    console.warn(`  │    username: ${seededAdmin.username.padEnd(44)}│`);
    console.warn(`  │    password: ${seededAdmin.password.padEnd(44)}│`);
    console.warn('  └──────────────────────────────────────────────────────────┘\n');
  }

  // Loopback is the default for a reason; leaving it deserves a word about
  // what now has to be true for that to be safe.
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn(
      `  ⚠ Listening on ${HOST} — this dashboard is reachable beyond this machine.\n` +
        '    It holds admin credentials for every site it can test, so put it behind\n' +
        '    HTTPS and set TRUST_PROXY so session cookies are marked Secure.\n'
    );
  }
  /* eslint-enable no-console */
});
}

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
