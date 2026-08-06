'use strict';

/* ------------------------------- utilities -------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2), v);
    } else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function fmtDuration(ms) {
  if (ms == null) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleString();
}

function stBadge(status) {
  return el('span', { class: `st st-${status || 'queued'}` }, status || 'queued');
}

/**
 * History status badge keyed off the fail RATE, not just the binary status:
 *   0 failures            → green "passed"
 *   100% of tests failed  → red "failed"
 *   in between            → "partial fail", colour on a yellow→orange→red
 *                           spectrum (yellower the lower the fail rate).
 * Non-pass/fail outcomes (error/cancelled/interrupted/running) keep their badge.
 */
function runStatusBadge(run) {
  const t = run.totals || {};
  const F = t.failed || 0;
  const P = t.passed || 0;
  if (run.status === 'passed') return stBadge('passed');
  if (run.status !== 'failed') return stBadge(run.status);
  // status === 'failed':
  if (F === 0) return el('span', { class: 'st st-failed' }, 'failed'); // failed w/o test failures (auth/error)
  const denom = P + F;
  const rate = denom > 0 ? F / denom : 1;
  if (rate >= 1) return el('span', { class: 'st st-failed' }, 'failed'); // 100% → red FAILED
  const hue = Math.round((1 - rate) * 50); // 0%→50 (yellow) … 100%→0 (red)
  const pct = Math.round(rate * 100);
  return el('span', {
    class: 'st',
    style: `color:hsl(${hue}, 90%, 38%);background:hsla(${hue}, 90%, 45%, 0.16);border-color:hsla(${hue}, 90%, 40%, 0.4)`,
    title: `${F} of ${denom} run tests failed (${pct}%)`,
  }, 'partial fail');
}

/** Failure rate = failed / (passed + failed); null when no tests produced a result. */
function failRate(run) {
  const t = run.totals || {};
  const denom = (t.passed || 0) + (t.failed || 0);
  return denom > 0 ? (t.failed || 0) / denom : null;
}
function failRateColor(rate) {
  if (rate == null) return 'var(--muted)';
  if (rate <= 0) return 'var(--green)';
  if (rate >= 1) return 'var(--red)';
  return `hsl(${Math.round((1 - rate) * 50)}, 90%, 42%)`; // green→yellow→orange→red
}
function failRatePct(run) {
  const r = failRate(run);
  if (r == null) return '—';
  const pct = Math.round(r * 100);
  return r > 0 && pct === 0 ? '<1%' : `${pct}%`;
}

/** Re-runnable = a finished run that didn't fully pass. */
function rerunnable(run) {
  return !!(run && run.status && run.status !== 'passed' && run.status !== 'running');
}

/** Re-run the same targets/specs as a previous run, instantly. */
async function rerunRun(id) {
  try {
    const { run } = await api(`/api/runs/${id}`);
    const targets = (run.targets || []).map((t) => ({ site: t.site, paths: t.paths, grep: t.grep || undefined }));
    if (!targets.length) return alert('Nothing to re-run.');
    const { id: newId } = await api('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets }),
    });
    openLive(newId);
    showTab('live');
  } catch (e) {
    alert('Could not re-run: ' + e.message);
  }
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ------------------------------- tab switching ----------------------------- */

function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tabpane').forEach((p) =>
    p.classList.toggle('active', p.id === `tab-${name}`)
  );
  if (name === 'history') loadHistory();
  if (name === 'live') refreshActiveList();
  if (name === 'calendar') renderCalendar();
  if (name === 'schedules') loadSchedules();
  if (name === 'prbuilder') loadPrBuilder();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

/* ----------------------------------- tree ---------------------------------- */

let TREE = null;
const siteDots = {}; // site key -> status dot element
let HISTORY = []; // cached run summaries for client-side filtering

async function loadTree(refresh = false) {
  $('#tree').textContent = 'Loading test tree…';
  try {
    TREE = await api('/api/tree' + (refresh ? '?refresh=1' : ''));
  } catch (err) {
    $('#tree').innerHTML = `<div class="error-banner">Could not load tree: ${err.message}</div>`;
    return;
  }
  renderTree();
}

function renderTree() {
  const root = $('#tree');
  root.innerHTML = '';
  for (const site of TREE.sites) {
    root.append(renderSiteNode(site));
  }
  updateSelCount();
}

function renderSiteNode(site) {
  const wrap = el('div', { class: 'node', 'data-site': site.key });
  const childrenBox = el('div', { class: 'children hidden' });
  let rendered = false;

  const cb = el('input', { type: 'checkbox', 'data-issite': '1' });
  cb.dataset.sitefilters = JSON.stringify(site.siteFilters);
  cb.addEventListener('change', () => {
    setSubtreeChecked(childrenBox, cb.checked);
    updateSelCount();
  });

  const twisty = el('span', { class: 'twisty' }, '▸');
  const dot = el('span', { class: 'site-status', title: 'reachability unknown' });
  siteDots[site.key] = dot;
  const label = el(
    'span',
    { class: 'node-label dir' },
    el('span', { class: 'site-name' }, site.name),
    dot,
    ' ',
    el('span', { class: 'count', title: countTitle(site) }, countText(site, false))
  );

  function toggle() {
    const open = childrenBox.classList.toggle('hidden') === false;
    twisty.textContent = open ? '▾' : '▸';
    if (open && !rendered) {
      rendered = true;
      for (const child of site.children) childrenBox.append(renderNode(child, site.key));
      // Reflect parent checkbox state onto freshly rendered children.
      if (cb.checked) setSubtreeChecked(childrenBox, true);
    }
  }
  twisty.addEventListener('click', toggle);
  label.addEventListener('click', toggle);

  wrap.append(el('div', { class: 'node-row' }, twisty, cb, label), childrenBox);
  return wrap;
}

function renderNode(node, siteKey) {
  if (node.type === 'file') {
    const cb = el('input', { type: 'checkbox', 'data-filter': node.filter });
    cb.addEventListener('change', updateSelCount);
    const row = el(
      'div',
      { class: 'node-row' },
      el('span', { class: 'twisty' }, ''),
      cb,
      el('span', { class: 'node-label file' }, node.name),
      ' ',
      el('span', { class: 'count', title: countTitle(node) }, countText(node, true))
    );
    return el('div', { class: 'node' }, row);
  }

  // directory
  const wrap = el('div', { class: 'node' });
  const childrenBox = el('div', { class: 'children hidden' });
  let rendered = false;

  const cb = el('input', { type: 'checkbox', 'data-filter': node.filter, 'data-isdir': '1' });
  cb.addEventListener('change', () => {
    setSubtreeChecked(childrenBox, cb.checked);
    updateSelCount();
  });

  const twisty = el('span', { class: 'twisty' }, '▸');
  const label = el(
    'span',
    { class: 'node-label dir' },
    node.name,
    ' ',
    el('span', { class: 'count', title: countTitle(node) }, countText(node, false))
  );

  function toggle() {
    const open = childrenBox.classList.toggle('hidden') === false;
    twisty.textContent = open ? '▾' : '▸';
    if (open && !rendered) {
      rendered = true;
      for (const child of node.children) childrenBox.append(renderNode(child, siteKey));
      if (cb.checked) setSubtreeChecked(childrenBox, true);
    }
  }
  twisty.addEventListener('click', toggle);
  label.addEventListener('click', toggle);

  wrap.append(el('div', { class: 'node-row' }, twisty, cb, label), childrenBox);
  return wrap;
}

function setSubtreeChecked(box, checked) {
  $$('input[type=checkbox]', box).forEach((c) => (c.checked = checked));
}

/** Count selected specs + tests and enable/disable the Run button. */
function updateSelCount() {
  let count = 0;
  let tests = 0;
  for (const siteEl of $$('#tree > .node')) {
    const sel = collectSiteSelection(siteEl);
    count += sel.specCount;
    tests += sel.testCount || 0;
  }
  const showTests = TREE && TREE.testCountsOk;
  $('#selCount').textContent = showTests
    ? `${tests} test${tests === 1 ? '' : 's'} · ${count} spec${count === 1 ? '' : 's'} selected`
    : `${count} spec${count === 1 ? '' : 's'} selected`;
  $('#btnRun').disabled = count === 0;
  $('#btnRun').textContent = count > 0 && showTests
    ? `Run ${tests} test${tests === 1 ? '' : 's'} ▶`
    : 'Run selected ▶';
}

/** Label helpers — test count is the headline number once counts are available. */
function countText(node, isFile) {
  const specs = node.specCount;
  const tests = node.testCount;
  if (!TREE || !TREE.testCountsOk || tests == null) return `(${specs})`;
  if (isFile) return `(${tests} test${tests === 1 ? '' : 's'})`;
  return `(${tests} tests · ${specs} specs)`;
}
function countTitle(node) {
  if (!TREE || !TREE.testCountsOk) return `${node.specCount} spec file(s)`;
  return `${node.testCount} test(s) across ${node.specCount} spec file(s)`;
}

/**
 * For one site DOM node, return { site, paths, specCount }.
 * - If the site checkbox is checked → whole site (siteFilters).
 * - Else gather checked dir/file filters, pruning descendants of checked dirs.
 */
function collectSiteSelection(siteEl) {
  const siteKey = siteEl.dataset.site;
  const siteData = TREE.sites.find((s) => s.key === siteKey);
  const siteCb = siteEl.querySelector('input[data-issite]');

  if (siteCb && siteCb.checked) {
    return { site: siteKey, paths: siteData.siteFilters, specCount: siteData.specCount, testCount: siteData.testCount || 0 };
  }

  // Collect checked nodes that have a filter; prune any whose ancestor is checked.
  const checked = $$('input[data-filter]', siteEl).filter((c) => c.checked);
  if (!checked.length) return { site: siteKey, paths: [], specCount: 0, testCount: 0 };

  const filters = checked.map((c) => c.dataset.filter);
  const pruned = filters.filter(
    (f) => !filters.some((other) => other !== f && f.startsWith(other) && other.endsWith('/'))
  );

  // Spec + test counts: sum counts of pruned nodes (look up in tree).
  let specCount = 0;
  let testCount = 0;
  for (const f of pruned) {
    const c = countsForFilter(siteData, f);
    specCount += c.specCount;
    testCount += c.testCount;
  }
  return { site: siteKey, paths: pruned, specCount, testCount };
}

function countsForFilter(siteData, filter) {
  let found = { specCount: 0, testCount: 0 };
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.filter === filter) { found = { specCount: n.specCount, testCount: n.testCount || 0 }; return true; }
      if (n.children && walk(n.children)) return true;
    }
    return false;
  };
  walk(siteData.children);
  return found;
}

function buildTargets() {
  const grep = $('#grepInput').value.trim() || undefined;
  const targets = [];
  for (const siteEl of $$('#tree > .node')) {
    const sel = collectSiteSelection(siteEl);
    if (sel.specCount > 0) {
      targets.push({ site: sel.site, paths: sel.paths, grep });
    }
  }
  return targets;
}

/* ------------------------------- run actions ------------------------------- */

$('#btnRun').addEventListener('click', async () => {
  const targets = buildTargets();
  $('#runError').classList.add('hidden');
  if (!targets.length) return;

  // Preflight the selected sites; warn (don't block) if any are unreachable.
  const keys = targets.map((t) => t.site);
  const status = await checkSites(keys);
  const down = keys.filter((k) => status[k] && status[k].up === false);
  if (down.length) {
    const ok = confirm(
      `These sites look unreachable (LocalWP not running?):\n  ${down.join(', ')}\n\n` +
        `Auth will fail for them. Start anyway?`
    );
    if (!ok) return;
  }

  try {
    const { id } = await api('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets }),
    });
    openLive(id);
    showTab('live');
  } catch (err) {
    const banner = $('#runError');
    banner.textContent = err.message;
    banner.classList.remove('hidden');
  }
});

$('#btnCheckSites').addEventListener('click', () => checkSites());

/** Ping sites and update the tree status dots. Returns the status map. */
async function checkSites(keys) {
  const targetKeys = keys && keys.length ? keys : Object.keys(siteDots);
  targetKeys.forEach((k) => {
    const d = siteDots[k];
    if (d) { d.className = 'site-status checking'; d.title = 'checking…'; }
  });
  let status = {};
  try {
    const q = keys && keys.length ? `?sites=${keys.join(',')}` : '';
    ({ sites: status } = await api('/api/preflight' + q));
  } catch (_) {
    return {};
  }
  for (const [k, s] of Object.entries(status)) {
    const d = siteDots[k];
    if (!d) continue;
    d.className = 'site-status ' + (s.up ? 'up' : 'down');
    d.title = s.up
      ? `up (HTTP ${s.status}, ${s.ms}ms)`
      : `unreachable (${s.error || 'HTTP ' + s.status})`;
  }
  return status;
}

$('#btnExpandAll').addEventListener('click', () => {
  // Children render lazily on expand, so each pass only reveals the next level.
  // Repeat until no collapsed nodes remain (depth-bounded guard vs. infinite loop).
  for (let pass = 0; pass < 50; pass++) {
    let expanded = false;
    for (const t of $$('#tree .twisty')) {
      const box = t.parentElement.parentElement.querySelector('.children');
      if (box && box.classList.contains('hidden')) { t.click(); expanded = true; }
    }
    if (!expanded) break;
  }
});
$('#btnCollapseAll').addEventListener('click', () => {
  $$('#tree > .node > .node-row > .twisty').forEach((t) => {
    const box = t.parentElement.parentElement.querySelector('.children');
    if (box && !box.classList.contains('hidden')) t.click();
  });
});
$('#btnClear').addEventListener('click', () => {
  $$('#tree input[type=checkbox]').forEach((c) => (c.checked = false));
  updateSelCount();
});
$('#btnRefreshTree').addEventListener('click', () => loadTree(true));

/* ----------------------------------- live ---------------------------------- */

let liveSource = null;
let liveTimer = null;
let liveRunId = null;
const cardRefs = {}; // site -> { node, refs... }

async function refreshActiveList() {
  let data;
  try {
    data = await api('/api/active');
  } catch (_) {
    return;
  }
  const box = $('#activeList');
  box.innerHTML = '';
  const runs = data.runs || [];
  $('#liveBadge').textContent = runs.length;
  $('#liveBadge').classList.toggle('hidden', runs.length === 0);
  for (const r of runs) {
    box.append(
      el('div', { class: 'active-chip', onclick: () => openLive(r.id) },
        `${r.label} · ${r.totals.completed}/${r.totals.total || '?'}`)
    );
  }
}

function openLive(id) {
  liveRunId = id;
  $('#liveEmpty').classList.add('hidden');
  const view = $('#liveView');
  view.classList.remove('hidden');
  view.innerHTML = '';
  for (const k of Object.keys(cardRefs)) delete cardRefs[k];

  if (liveSource) liveSource.close();
  if (liveTimer) clearInterval(liveTimer);

  liveSource = new EventSource(`/api/runs/${id}/stream`);
  liveSource.onmessage = (e) => handleLiveEvent(JSON.parse(e.data));
  liveSource.onerror = () => { /* browser auto-reconnects */ };
  showTab('live');
}

function handleLiveEvent(ev) {
  switch (ev.kind) {
    case 'snapshot':
    case 'run-start':
      renderLive(ev.run);
      break;
    case 'target-begin':
      setTargetTotals(ev.site, ev.totals);
      break;
    case 'target-update':
    case 'target-end':
      updateTargetCard(ev.target);
      break;
    case 'plan':
      renderTargetTests(ev.site, { plannedTests: ev.tests });
      break;
    case 'current':
      setCurrent(ev.site, ev.title);
      if (ev.id) setRowRunning(ev.site, ev.id);
      break;
    case 'test':
      setTargetTotals(ev.site, ev.targetTotals);
      setRunTotals(ev.runTotals);
      if (ev.test) setRowDone(ev.site, ev.test);
      break;
    case 'run-end':
      renderLive(ev.run);
      stopLive();
      break;
    case 'cancelling':
      if (cardRefs.__head) cardRefs.__head.status.replaceWith(stBadge('cancelled'));
      break;
  }
}

function stopLive() {
  if (liveSource) { liveSource.close(); liveSource = null; }
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  refreshActiveList();
  loadHistorySilently();
}

// Run statuses at which a combined report is meaningful (run has finished).
const TERMINAL_RUN = ['passed', 'failed', 'error', 'cancelled', 'interrupted'];

// Link to the single merged HTML report for a whole run (opens in a new tab so
// Ctrl+P prints just the report).
function combinedReportLink(runId) {
  return el('a', {
    class: 'report-link',
    href: `/api/runs/${runId}/combined-report`,
    target: '_blank',
    rel: 'noopener',
  }, '↗ Combined report');
}

function renderLive(run) {
  const view = $('#liveView');
  view.innerHTML = '';
  for (const k of Object.keys(cardRefs)) delete cardRefs[k];
  if (!run) { view.innerHTML = '<div class="empty">Run not found.</div>'; return; }

  const statusBadge = stBadge(run.status);
  const elapsed = el('span', { class: 'stat' }, '');
  const head = el('div', { class: 'run-head' },
    el('h2', {}, run.label),
    statusBadge,
    el('span', { class: 'spacer' }),
    el('span', { class: 'stat', id: 'runTotals' }, totalsText(run.totals)),
    elapsed
  );
  if (run.status === 'running') {
    head.append(el('button', { class: 'danger', onclick: () => cancelRun(run.id) }, 'Cancel run'));
  } else if (TERMINAL_RUN.includes(run.status)) {
    head.append(combinedReportLink(run.id));
  }
  cardRefs.__head = { status: statusBadge, totals: $('#runTotals', head) || head.querySelector('#runTotals'), elapsed, run };

  const cards = el('div', { class: 'cards' });
  for (const t of run.targets) cards.append(buildCard(run.id, t));
  view.append(head, cards);

  // Elapsed timer
  const started = new Date(run.startedAt).getTime();
  const tick = () => {
    const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
    elapsed.textContent = '⏱ ' + fmtDuration(end - started);
  };
  tick();
  if (run.status === 'running') liveTimer = setInterval(tick, 1000);
}

function totalsText(t) {
  if (!t) return '';
  return `✓ ${t.passed}  ✗ ${t.failed}  • ${t.skipped} skipped  —  ${t.completed}/${t.total || '?'}`;
}

function buildCard(runId, t) {
  const totals = t.totals || { total: 0, passed: 0, failed: 0, skipped: 0, completed: 0 };
  const status = stBadge(t.status);
  const segPass = el('div', { class: 'seg-pass' });
  const segFail = el('div', { class: 'seg-fail' });
  const segSkip = el('div', { class: 'seg-skip' });
  const cPass = el('span', { class: 'c-pass' }, `✓ ${totals.passed}`);
  const cFail = el('span', { class: 'c-fail' }, `✗ ${totals.failed}`);
  const cSkip = el('span', { class: 'c-skip' }, `• ${totals.skipped}`);
  const cTotal = el('span', { class: 'c-total' }, `${totals.completed}/${totals.total || '?'}`);
  const current = el('div', { class: 'current' }, t.currentTest || '');

  // Expandable, ordered list of every test that has run on this target.
  const testList = el('div', { class: 'test-list-live hidden' });
  const toggle = el('button', { class: 'ghost expand-toggle' }, 'Show tests');
  toggle.addEventListener('click', () => {
    testList.classList.toggle('hidden');
    updateToggleCount(t.site);
  });

  const auth = t.authStatus === 'failed'
    ? el('span', { class: 'st st-error' }, 'auth failed')
    : null;

  // Per-site controls: Cancel while active, Re-run once terminal.
  const actions = el('div', { class: 'card-actions' });

  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('span', { class: 'name' }, t.name),
      el('span', { class: 'spacer' }),
      auth,
      status
    ),
    el('div', { class: 'progress' }, segPass, segFail, segSkip),
    el('div', { class: 'counts' }, cPass, cFail, cSkip, cTotal),
    current,
    actions,
    toggle,
    testList
  );

  cardRefs[t.site] = {
    card, status, segPass, segFail, segSkip, cPass, cFail, cSkip, cTotal,
    current, actions, testList, toggle, totals, rows: new Map(), planned: false,
  };
  renderSiteActions(actions, runId, t);

  // Build the full list from the snapshot (planned + finished + running).
  renderTargetTests(t.site, t);
  updateBars(t.site);

  // Report link only once the target is done (Playwright writes it at the end).
  if (['passed', 'failed', 'error', 'cancelled'].includes(t.status)) {
    card.append(el('a', {
      class: 'report-link',
      href: `/api/runs/${runId}/report/${t.site}/index.html`,
      target: '_blank',
    }, '↗ Open Playwright report'));
  }
  return card;
}

function setTargetTotals(site, totals) {
  const r = cardRefs[site];
  if (!r || !totals) return;
  r.totals = totals;
  r.cPass.textContent = `✓ ${totals.passed}`;
  r.cFail.textContent = `✗ ${totals.failed}`;
  r.cSkip.textContent = `• ${totals.skipped}`;
  r.cTotal.textContent = `${totals.completed}/${totals.total || '?'}`;
  updateBars(site);
}

function updateBars(site) {
  const r = cardRefs[site];
  if (!r) return;
  const t = r.totals;
  const total = t.total || t.completed || 1;
  r.segPass.style.width = `${(t.passed / total) * 100}%`;
  r.segFail.style.width = `${(t.failed / total) * 100}%`;
  r.segSkip.style.width = `${(t.skipped / total) * 100}%`;
}

function setRunTotals(totals) {
  const h = cardRefs.__head;
  if (h && h.totals) h.totals.textContent = totalsText(totals);
}

function setCurrent(site, title) {
  const r = cardRefs[site];
  if (r) r.current.textContent = title || '';
}

/** Trim the "chromium › <file>.spec.ts › …" prefix down to the readable name. */
function shortTitle(title) {
  const parts = String(title || '').split(' › ');
  return parts.length > 2 ? parts.slice(2).join(' › ') : title;
}

function statusGlyph(status) {
  if (status === 'passed') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'skipped') return '•';
  if (status === 'pending') return '○';
  return ''; // running → empty (a CSS spinner shows via the .spin class)
}

function makeRowClickable(row, site, test) {
  row.classList.add('clickable-row');
  row.onclick = () => openErrorModal({
    title: shortTitle(test.title), status: 'failed', durationMs: test.durationMs,
    site, error: test.error,
    reportUrl: liveRunId ? `/api/runs/${liveRunId}/report/${site}/index.html` : null,
  });
  if (!row.querySelector('.info-ic')) row.append(infoIcon());
}

// Standard circular spinner (faint track + arc), spun via CSS; coloured blue
// to match the "running" status. currentColor is set in CSS.
const SPINNER_SVG =
  '<svg class="spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3"/>' +
  '<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
  '</svg>';

function setIcon(span, status) {
  span.className = 'ic';
  if (status === 'running') span.innerHTML = SPINNER_SVG;
  else span.textContent = statusGlyph(status);
}

// Crisp filled "info" badge shown on failed rows (replaces the thin ⓘ glyph).
const INFO_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="7" fill="currentColor"/>' +
  '<circle cx="8" cy="4.6" r="1.05" fill="#fff"/>' +
  '<rect x="7.05" y="6.7" width="1.9" height="5" rx="0.95" fill="#fff"/>' +
  '</svg>';

function infoIcon() {
  const span = el('span', { class: 'info-ic', title: 'View error details' });
  span.innerHTML = INFO_SVG;
  return span;
}

/** Build one test row for {id,title,status,durationMs}. */
function makeRow(test, site) {
  const status = test.status || 'pending';
  const ic = el('span', { class: 'ic' });
  setIcon(ic, status);
  const row = el('div', { class: `test-row ${status}` },
    ic,
    el('span', { class: 'tname', title: test.title }, shortTitle(test.title)),
    el('span', { class: 'dur' }, test.durationMs != null ? fmtDuration(test.durationMs) : '')
  );
  if (status === 'failed') makeRowClickable(row, site, test);
  return row;
}

/** Update a row in place when a test starts running or finishes. */
function applyRowStatus(row, site, test) {
  row.className = `test-row ${test.status}`;
  if (test.status === 'failed') makeRowClickable(row, site, test);
  else {
    row.classList.remove('clickable-row');
    row.onclick = null;
    const info = row.querySelector('.info-ic');
    if (info) info.remove();
  }
  setIcon(row.querySelector('.ic'), test.status);
  if (test.durationMs != null) row.querySelector('.dur').textContent = fmtDuration(test.durationMs);
}

/**
 * (Re)render a target's full test list: every planned test up front (pending),
 * with already-finished results and currently-running spinners applied. Falls
 * back to an append-as-they-finish list if no plan is available.
 */
function renderTargetTests(site, target) {
  const r = cardRefs[site];
  if (!r) return;
  r.testList.innerHTML = '';
  r.rows = new Map();
  const doneById = new Map((target.tests || []).map((t) => [t.id, t]));
  const running = new Set(target.runningIds || []);
  const planned = target.plannedTests && target.plannedTests.length ? target.plannedTests : null;
  r.planned = !!planned;

  for (const p of planned || target.tests || []) {
    const done = doneById.get(p.id);
    const state = done ? { ...p, ...done } : { ...p, status: running.has(p.id) ? 'running' : 'pending' };
    const row = makeRow(state, site);
    r.rows.set(p.id, row);
    r.testList.append(row);
  }
  updateToggleCount(site);
}

function setRowRunning(site, id) {
  const r = cardRefs[site];
  if (!r || !r.rows) return;
  const row = r.rows.get(id);
  if (!row) return;
  applyRowStatus(row, site, { status: 'running' });
  if (!r.testList.classList.contains('hidden')) row.scrollIntoView({ block: 'nearest' });
  updateToggleCount(site);
}

function setRowDone(site, test) {
  const r = cardRefs[site];
  if (!r) return;
  if (!r.rows) r.rows = new Map();
  const row = r.rows.get(test.id);
  if (row) applyRowStatus(row, site, test);
  else { const nr = makeRow(test, site); r.rows.set(test.id, nr); r.testList.append(nr); } // fallback (no plan)
  updateToggleCount(site);
}

function updateToggleCount(site) {
  const r = cardRefs[site];
  if (!r || !r.toggle) return;
  const total = r.planned ? r.rows.size : (r.totals && r.totals.total) || r.rows.size;
  let done = 0;
  for (const row of r.rows.values()) {
    if (!row.classList.contains('pending') && !row.classList.contains('running')) done += 1;
  }
  const open = !r.testList.classList.contains('hidden');
  r.toggle.textContent = `${open ? 'Hide' : 'Show'} tests (${done}/${total || '?'})`;
}

/* ----------------------------- error modal -------------------------------- */

let _modal = null;
function ensureModal() {
  if (_modal) return _modal;
  const titleEl = el('div', { class: 'modal-title' });
  const closeBtn = el('button', { class: 'modal-close', title: 'Close (Esc)' }, '✕');
  const metaEl = el('div', { class: 'modal-meta' });
  const errEl = el('pre', { class: 'modal-error' });
  const footer = el('div', { class: 'modal-footer' });
  const panel = el('div', { class: 'modal' },
    el('div', { class: 'modal-head' }, titleEl, closeBtn),
    metaEl, errEl, footer);
  const overlay = el('div', { class: 'modal-overlay hidden' }, panel);
  document.body.append(overlay);
  const close = () => overlay.classList.add('hidden');
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
  });
  _modal = { overlay, titleEl, metaEl, errEl, footer, close };
  return _modal;
}

function openErrorModal({ title, status, durationMs, site, error, reportUrl }) {
  const m = ensureModal();
  m.titleEl.textContent = title || 'Test failure';
  m.metaEl.innerHTML = '';
  m.metaEl.append(stBadge(status || 'failed'));
  if (site) m.metaEl.append(el('span', {}, site));
  m.metaEl.append(el('span', {}, '⏱ ' + fmtDuration(durationMs)));
  m.errEl.textContent = error && error.trim() ? error : '(no error message was captured for this test)';
  m.footer.innerHTML = '';
  if (reportUrl) {
    m.footer.append(el('a', { class: 'report-link', href: reportUrl, target: '_blank' },
      '↗ Open Playwright report (trace & screenshots)'));
  }
  m.overlay.classList.remove('hidden');
}

function updateTargetCard(t) {
  const r = cardRefs[t.site];
  if (!r) return;
  const nb = stBadge(t.status);
  r.status.replaceWith(nb);
  r.status = nb; // keep a direct handle (avoids grabbing the auth badge)
  if (t.totals) setTargetTotals(t.site, t.totals);
  if (t.currentTest !== undefined) setCurrent(t.site, t.currentTest);
  // Flip the per-site action button (Cancel ↔ Re-run) on status change.
  if (r.actions) renderSiteActions(r.actions, liveRunId, t);
  // Add the report link as soon as this target finishes, if not already there.
  if (['passed', 'failed', 'error', 'cancelled'].includes(t.status) && !r.card.querySelector('.report-link') && liveRunId) {
    r.card.append(el('a', {
      class: 'report-link',
      href: `/api/runs/${liveRunId}/report/${t.site}/index.html`,
      target: '_blank',
    }, '↗ Open Playwright report'));
  }
}

async function cancelRun(id) {
  try { await api(`/api/runs/${id}/cancel`, { method: 'POST' }); } catch (_) {}
}

// Render the per-site action button into `box` based on the target's status:
// a Cancel button while it's active, a Re-run button once it's terminal.
function renderSiteActions(box, runId, t) {
  if (!box) return;
  box.innerHTML = '';
  if (!runId) return;
  const active = ['queued', 'authenticating', 'running'].includes(t.status);
  if (active) {
    box.append(el('button', {
      class: 'danger sm',
      title: 'Stop just this site (the rest of the run keeps going)',
      onclick: () => cancelSite(runId, t.site),
    }, '■ Cancel site'));
  } else if (!t.custom) {
    box.append(el('button', {
      class: 'ghost sm',
      title: 'Start a fresh run for just this site',
      onclick: () => rerunSite(t.site, t.paths, t.grep),
    }, '↻ Re-run site'));
  }
}

// Cancel one site within a run (kills just its process; frees it immediately).
async function cancelSite(runId, site) {
  try { await api(`/api/runs/${runId}/targets/${site}/cancel`, { method: 'POST' }); }
  catch (_) { /* the target-end event will reflect the result */ }
}

// Start a brand-new run for a single site (the site is already free, so the
// busy guard passes even while the original run is still going).
async function rerunSite(site, paths, grep) {
  try {
    const { id } = await api('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: [{ site, paths, grep: grep || undefined }] }),
    });
    openLive(id);
    showTab('live');
  } catch (e) {
    alert('Could not re-run ' + site + ': ' + (e.message || e));
  }
}

/* --------------------------------- history --------------------------------- */

async function loadHistory() {
  $('#historyDetail').classList.add('hidden');
  $('#historyList').classList.remove('hidden');
  $('#historyList').textContent = 'Loading…';
  populateSiteFilter();
  try {
    const { runs } = await api('/api/runs');
    HISTORY = runs;
    applyHistoryFilter();
  } catch (err) {
    $('#historyList').innerHTML = `<div class="error-banner">${err.message}</div>`;
  }
}

function populateSiteFilter() {
  const sel = $('#hSite');
  if (!TREE || sel.options.length > 1) return;
  for (const s of TREE.sites) {
    sel.append(el('option', { value: s.key }, s.name));
  }
}

function applyHistoryFilter() {
  const q = $('#hSearch').value.trim().toLowerCase();
  const status = $('#hStatus').value;
  const site = $('#hSite').value;
  const filtered = HISTORY.filter((r) => {
    if (status && r.status !== status) return false;
    if (site && !(r.targets || []).some((t) => t.site === site)) return false;
    if (q) {
      const hay = (r.label + ' ' + (r.targets || []).map((t) => t.site).join(' ')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  $('#hCount').textContent = `${filtered.length} of ${HISTORY.length} runs`;
  renderHistory(filtered);
}

$('#hSearch').addEventListener('input', applyHistoryFilter);
$('#hStatus').addEventListener('change', applyHistoryFilter);
$('#hSite').addEventListener('change', applyHistoryFilter);

async function loadHistorySilently() {
  if (!$('#tab-history').classList.contains('active')) return;
  loadHistory();
}

function renderHistory(runs) {
  const box = $('#historyList');
  if (!runs.length) { box.innerHTML = '<div class="empty">No runs yet.</div>'; return; }
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'When'), el('th', {}, 'Run'), el('th', {}, 'Status'),
      el('th', {}, 'Results'), el('th', {}, 'Fail rate'), el('th', {}, 'Duration'), el('th', {}, '')
    ))
  );
  const tbody = el('tbody');
  for (const r of runs) {
    const tr = el('tr', { class: 'clickable', onclick: () => openDetail(r.id) },
      el('td', {}, fmtTime(r.startedAt || r.createdAt)),
      el('td', {}, r.label),
      el('td', {}, runStatusBadge(r)),
      el('td', { class: 'mini-counts', html:
        `<span class="c-pass" style="color:var(--green)">✓ ${r.totals.passed}</span>` +
        `<span class="c-fail" style="color:var(--red)">✗ ${r.totals.failed}</span>` +
        `<span class="c-skip" style="color:var(--muted)">• ${r.totals.skipped}</span>` }),
      el('td', { class: 'fail-rate', style: `color:${failRateColor(failRate(r))}` }, failRatePct(r)),
      el('td', {}, fmtDuration(r.durationMs)),
      el('td', { class: 'row-actions' }, rerunnable(r)
        ? el('button', {
            class: 'rerun-btn', title: 'Re-run this run',
            onclick: (e) => { e.stopPropagation(); rerunRun(r.id); },
          }, '↻ Re-run')
        : null)
    );
    tbody.append(tr);
  }
  table.append(tbody);
  box.innerHTML = '';
  box.append(table);
}

async function openDetail(id) {
  // If the run is still active, just open the live view instead.
  try {
    const { run, live } = await api(`/api/runs/${id}`);
    if (live && run.status === 'running') { openLive(id); return; }
    renderDetail(run);
  } catch (err) {
    alert('Could not load run: ' + err.message);
  }
}

function renderDetail(run) {
  $('#historyList').classList.add('hidden');
  const box = $('#historyDetail');
  box.classList.remove('hidden');
  box.innerHTML = '';

  box.append(
    el('span', { class: 'back-link', onclick: () => loadHistory() }, '← Back to history'),
    el('div', { class: 'run-head' },
      el('h2', {}, run.label),
      runStatusBadge(run),
      el('span', { class: 'spacer' }),
      el('span', { class: 'stat' }, fmtTime(run.startedAt)),
      el('span', { class: 'stat' }, totalsText(run.totals)),
      el('span', { class: 'stat', style: `color:${failRateColor(failRate(run))}` }, `${failRatePct(run)} fail`),
      el('span', { class: 'stat' }, '⏱ ' + fmtDuration(run.durationMs)),
      combinedReportLink(run.id),
      rerunnable(run) ? el('button', { class: 'primary', onclick: () => rerunRun(run.id) }, '↻ Re-run') : null
    )
  );

  // Per-target summary cards.
  const grid = el('div', { class: 'detail-targets' });
  for (const t of run.targets) {
    const totals = t.totals || {};
    grid.append(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('span', { class: 'name' }, t.name),
        el('span', { class: 'spacer' }),
        t.authStatus === 'failed' ? el('span', { class: 'st st-error' }, 'auth failed') : null,
        runStatusBadge(t)
      ),
      el('div', { class: 'counts' },
        el('span', { class: 'c-pass' }, `✓ ${totals.passed || 0}`),
        el('span', { class: 'c-fail' }, `✗ ${totals.failed || 0}`),
        el('span', { class: 'c-skip' }, `• ${totals.skipped || 0}`),
        el('span', { class: 'c-total' }, `${totals.completed || 0}/${totals.total || 0}`)
      ),
      el('a', {
        class: 'report-link',
        href: `/api/runs/${run.id}/report/${t.site}/index.html`,
        target: '_blank',
      }, '↗ Open Playwright report')
    ));
  }
  box.append(grid);

  // Combined, filterable test list.
  const allTests = run.targets.flatMap((t) =>
    (t.tests || []).map((x) => ({ ...x, site: t.site, siteName: t.name }))
  );
  if (!allTests.length) return;

  const state = { which: allTests.some((t) => t.status === 'failed') ? 'failed' : 'all', q: '' };
  const listBox = el('div', { class: 'test-list' });
  const search = el('input', { type: 'text', placeholder: 'Search test…' });
  search.addEventListener('input', () => { state.q = search.value.trim().toLowerCase(); draw(); });

  const tabs = {};
  const tabBar = el('div', { class: 'test-filter' });
  const counts = {
    all: allTests.length,
    failed: allTests.filter((t) => t.status === 'failed').length,
    passed: allTests.filter((t) => t.status === 'passed').length,
    skipped: allTests.filter((t) => t.status === 'skipped').length,
  };
  for (const key of ['failed', 'passed', 'skipped', 'all']) {
    const b = el('button', { onclick: () => { state.which = key; updateTabs(); draw(); } },
      `${key[0].toUpperCase()}${key.slice(1)} (${counts[key]})`);
    tabs[key] = b;
    tabBar.append(b);
  }
  tabBar.append(search);

  function updateTabs() {
    for (const [k, b] of Object.entries(tabs)) b.classList.toggle('active', k === state.which);
  }
  function draw() {
    listBox.innerHTML = '';
    const rows = allTests.filter((t) => {
      if (state.which !== 'all' && t.status !== state.which) return false;
      if (state.q && !t.title.toLowerCase().includes(state.q)) return false;
      return true;
    });
    if (!rows.length) { listBox.append(el('div', { class: 'empty' }, 'No matching tests.')); return; }
    for (const t of rows) {
      const ic = t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '•';
      const row = el('div', { class: `test-row ${t.status}` },
        el('span', { class: 'ic' }, ic),
        el('span', { class: 'tname', title: t.title }, `[${t.site}] ${shortTitle(t.title)}`),
        el('span', { class: 'dur' }, fmtDuration(t.durationMs))
      );
      if (t.status === 'failed') {
        row.classList.add('clickable-row');
        row.addEventListener('click', () => openErrorModal({
          title: shortTitle(t.title),
          status: t.status,
          durationMs: t.durationMs,
          site: t.site,
          error: t.error,
          reportUrl: `/api/runs/${run.id}/report/${t.site}/index.html`,
        }));
        row.append(infoIcon());
      }
      listBox.append(row);
    }
  }

  box.append(el('h3', { style: 'margin:18px 0 0' }, 'Tests'), tabBar, listBox);
  updateTabs();
  draw();
}

/* --------------------------------- calendar -------------------------------- */

let calYear, calMonth; // calMonth is 0-based

// Per-run dot colour/label, mirroring the History fail-rate spectrum.
function runStatusText(run) {
  const t = run.totals || {};
  const F = t.failed || 0, P = t.passed || 0;
  if (run.status === 'passed') return 'passed';
  if (run.status !== 'failed') return run.status;
  if (F === 0) return 'failed';
  const denom = P + F, rate = denom > 0 ? F / denom : 1;
  return rate >= 1 ? 'failed' : 'partial fail';
}
function runDotColor(run) {
  const t = run.totals || {};
  const F = t.failed || 0, P = t.passed || 0;
  if (run.status === 'passed') return 'var(--green)';
  if (run.status === 'error') return 'var(--red)';
  if (run.status !== 'failed') return 'var(--grey-dot)'; // cancelled / interrupted / running
  if (F === 0) return 'var(--red)';
  const denom = P + F, rate = denom > 0 ? F / denom : 1;
  if (rate >= 1) return 'var(--red)';
  return `hsl(${Math.round((1 - rate) * 50)}, 90%, 45%)`; // yellow → orange → red
}
function runDotTitle(run) {
  const t = run.totals || {};
  const when = new Date(run.startedAt || run.createdAt).toLocaleTimeString();
  return `${run.label}\n${runStatusText(run)} · ✓${t.passed || 0} ✗${t.failed || 0} •${t.skipped || 0} · ${failRatePct(run)} fail\n${when} · ${fmtDuration(run.durationMs)}`;
}

function renderCalendar() {
  if (calYear === undefined) {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
  }
  drawCalendar();
}

async function drawCalendar() {
  const p = (n) => String(n).padStart(2, '0');
  const monthStr = `${calYear}-${p(calMonth + 1)}`;
  $('#calMonth').textContent = new Date(calYear, calMonth, 1)
    .toLocaleString(undefined, { month: 'long', year: 'numeric' });
  $('#calDay').innerHTML = '';

  let days = {};
  try { ({ days } = await api(`/api/calendar?month=${monthStr}`)); } catch (_) {}

  const grid = $('#calGrid');
  grid.innerHTML = '';
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d) =>
    grid.append(el('div', { class: 'cal-dow' }, d)));

  // Week starts Monday: shift Sun(0)→6, Mon(1)→0, … Sat(6)→5.
  const first = (new Date(calYear, calMonth, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  for (let i = 0; i < first; i++) grid.append(el('div', { class: 'cal-cell empty' }));

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = `${monthStr}-${p(d)}`;
    const info = days[dayStr];
    const cell = el('div', {
      class: 'cal-cell' + (dayStr === todayStr ? ' today' : '') + (info ? ' has-runs' : ''),
    }, el('div', { class: 'daynum' }, String(d)));
    if (info) {
      cell.append(el('div', { class: 'runcount' }, `${info.count} run${info.count > 1 ? 's' : ''}`));
      const dots = el('div', { class: 'day-dots' });
      const cap = 12;
      info.runs.slice(0, cap).forEach((r) => dots.append(
        el('span', { class: 'dot', title: runDotTitle(r), style: `background:${runDotColor(r)}` })
      ));
      if (info.runs.length > cap) dots.append(el('span', { class: 'dot-more' }, `+${info.runs.length - cap}`));
      cell.append(dots);
      cell.addEventListener('click', () => showCalDay(dayStr, info.runs));
    }
    grid.append(cell);
  }
}

function showCalDay(dayStr, runs) {
  const box = $('#calDay');
  box.innerHTML = '';
  box.append(el('h3', {}, `Runs on ${dayStr}`));
  const tbody = el('tbody');
  runs.slice().sort((a, b) => ((a.startedAt || '') < (b.startedAt || '') ? 1 : -1));
  for (const r of runs) {
    tbody.append(el('tr', { class: 'clickable', onclick: () => { showTab('history'); openDetail(r.id); } },
      el('td', {}, new Date(r.startedAt || r.createdAt).toLocaleTimeString()),
      el('td', {}, r.label),
      el('td', {}, runStatusBadge(r)),
      el('td', {}, `✓ ${r.totals.passed}  ✗ ${r.totals.failed}`),
      el('td', { style: `color:${failRateColor(failRate(r))};font-weight:600` }, `${failRatePct(r)} fail`)
    ));
  }
  box.append(el('div', { class: 'history-list' }, el('table', {}, tbody)));
}

$('#calPrev').addEventListener('click', () => { if (--calMonth < 0) { calMonth = 11; calYear--; } drawCalendar(); });
$('#calNext').addEventListener('click', () => { if (++calMonth > 11) { calMonth = 0; calYear++; } drawCalendar(); });
$('#calToday').addEventListener('click', () => { const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); drawCalendar(); });

/* --------------------------------- schedules ------------------------------- */

async function loadSchedules() {
  $('#scheduleForm').classList.add('hidden');
  const box = $('#scheduleList');
  box.textContent = 'Loading…';
  try {
    const { schedules } = await api('/api/schedules');
    renderSchedules(schedules);
  } catch (err) {
    box.innerHTML = `<div class="error-banner">${err.message}</div>`;
  }
}

function renderSchedules(schedules) {
  const box = $('#scheduleList');
  box.innerHTML = '';
  if (!schedules.length) { box.append(el('div', { class: 'empty' }, 'No schedules yet.')); return; }
  for (const s of schedules) {
    const sites = s.targets.map((t) => t.site).join(', ');
    const grep = s.targets[0] && s.targets[0].grep ? ` · grep: ${s.targets[0].grep}` : '';
    box.append(el('div', { class: 'sched-card' },
      el('div', {},
        el('div', { class: 'sname' }, s.name),
        el('div', { class: 'meta' }, `cron: ${s.cron} · sites: ${sites}${grep}`)
      ),
      el('span', { class: 'spacer' }),
      el('div', { class: 'meta' },
        s.enabled && s.nextRun ? `next: ${fmtTime(s.nextRun)}` : (s.enabled ? 'next: —' : 'disabled'),
        s.lastResult ? el('div', {}, `last: ${s.lastResult}${s.lastFiredAt ? ' @ ' + fmtTime(s.lastFiredAt) : ''}`) : null
      ),
      el('span', { class: `switch ${s.enabled ? 'on' : 'off'}`, onclick: () => toggleSchedule(s) }, s.enabled ? 'Enabled' : 'Disabled'),
      el('button', { class: 'ghost', onclick: () => runScheduleNow(s) }, '▶ Run now'),
      s.lastRunId ? el('button', { class: 'ghost', onclick: () => { showTab('history'); openDetail(s.lastRunId); } }, 'Last run') : null,
      el('button', { class: 'ghost', onclick: () => deleteSchedule(s) }, '🗑')
    ));
  }
}

async function toggleSchedule(s) {
  try {
    await api(`/api/schedules/${s.id}/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    loadSchedules();
  } catch (e) { alert(e.message); }
}
async function runScheduleNow(s) {
  try { const r = await api(`/api/schedules/${s.id}/run`, { method: 'POST' }); openLive(r.runId); }
  catch (e) { alert(e.message); }
}
async function deleteSchedule(s) {
  if (!confirm(`Delete schedule "${s.name}"?`)) return;
  try { await api(`/api/schedules/${s.id}`, { method: 'DELETE' }); loadSchedules(); }
  catch (e) { alert(e.message); }
}

$('#btnNewSchedule').addEventListener('click', showScheduleForm);

function showScheduleForm() {
  const box = $('#scheduleForm');
  box.classList.remove('hidden');
  box.innerHTML = '';

  const name = el('input', { type: 'text', placeholder: 'e.g. Nightly architect + apprentice' });
  const freq = el('select', {},
    el('option', { value: 'daily' }, 'Daily'),
    el('option', { value: 'weekly' }, 'Weekly'),
    el('option', { value: 'hourly' }, 'Hourly'),
    el('option', { value: 'custom' }, 'Custom cron'));
  const time = el('input', { type: 'time', value: '02:00' });
  const dow = el('select', {},
    ...['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      .map((d, i) => el('option', { value: String(i) }, d)));
  const customCron = el('input', { type: 'text', placeholder: 'minute hour day month weekday' });
  const grep = el('input', { type: 'text', placeholder: 'optional --grep keyword' });
  const preview = el('div', { class: 'cron-preview' });

  const siteChecks = el('div', { class: 'site-checks' });
  for (const s of TREE.sites) {
    siteChecks.append(el('label', {}, el('input', { type: 'checkbox', value: s.key }), s.name));
  }

  const dowWrap = el('div', {}, el('label', {}, 'Day of week'), dow);
  const timeWrap = el('div', {}, el('label', {}, 'Time'), time);
  const customWrap = el('div', {}, el('label', {}, 'Cron expression'), customCron);

  function buildCron() {
    const [hh, mm] = (time.value || '02:00').split(':');
    if (freq.value === 'daily') return `${+mm} ${+hh} * * *`;
    if (freq.value === 'weekly') return `${+mm} ${+hh} * * ${dow.value}`;
    if (freq.value === 'hourly') return `${+mm} * * * *`;
    return customCron.value.trim();
  }
  function updateForm() {
    dowWrap.style.display = freq.value === 'weekly' ? '' : 'none';
    timeWrap.style.display = freq.value === 'custom' ? 'none' : '';
    customWrap.style.display = freq.value === 'custom' ? '' : 'none';
    preview.textContent = 'cron: ' + (buildCron() || '—');
  }
  [freq, time, dow, customCron].forEach((e) => e.addEventListener('input', updateForm));

  box.append(
    el('div', {}, el('label', {}, 'Name'), name),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Frequency'), freq),
      timeWrap, dowWrap),
    customWrap,
    preview,
    el('div', {}, el('label', {}, 'Sites'), siteChecks),
    el('div', {}, el('label', {}, 'Keyword filter (applies to all sites)'), grep),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: save }, 'Create schedule'),
      el('button', { class: 'ghost', onclick: () => box.classList.add('hidden') }, 'Cancel'))
  );
  updateForm();

  async function save() {
    const sites = $$('input:checked', siteChecks).map((c) => c.value);
    if (!name.value.trim()) return alert('Name is required.');
    if (!sites.length) return alert('Pick at least one site.');
    const g = grep.value.trim() || undefined;
    const targets = sites.map((site) => ({ site, grep: g }));
    try {
      await api('/api/schedules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.value.trim(), cron: buildCron(), targets }),
      });
      box.classList.add('hidden');
      loadSchedules();
    } catch (e) { alert(e.message); }
  }
}

/* -------------------------------- PR Builder ------------------------------- */

const PRB = { projects: [], prs: [] };
let prbBound = false;
let prbSource = null;
let prbActiveId = null;

async function loadPrBuilder() {
  bindPrb();
  if (!TREE) await loadTree(); // need the site list for the test-area checkboxes
  renderPrbAreas();
  updatePrbTestScope();
  await prbLoadProjects(); // also loads that project's PRs
  prbRefreshActive();
  prbLoadHistory();
}

function bindPrb() {
  if (prbBound) return;
  prbBound = true;
  $('#prbProject').addEventListener('change', onProjectPick);
  $('#prbPr').addEventListener('change', onPrPick);
  $('#prbPrNumber').addEventListener('input', updateVersionPlaceholder);
  $('#prbBuild').addEventListener('click', prbStartBuild);
  $('#prbCancel').addEventListener('click', prbCancel);
  $('#prbClearLog').addEventListener('click', () => { $('#prbLog').textContent = ''; });
  $$('input[name="prbTestScope"]').forEach((r) => r.addEventListener('change', updatePrbTestScope));
  $('#prbRunTests').addEventListener('click', prbRunTests);
}

/* ---- Run tests on the PR-built site ---- */
function renderPrbAreas() {
  const box = $('#prbAreas');
  if (!box || !TREE || !TREE.sites) return;
  box.innerHTML = '';
  for (const s of TREE.sites) {
    const count = TREE.testCountsOk ? ` (${s.testCount})` : '';
    box.append(el('label', { class: 'prb-area' },
      el('input', { type: 'checkbox', value: s.key }), `${s.name}${count}`));
  }
}
function prbTestScope() {
  const r = $$('input[name="prbTestScope"]').find((x) => x.checked);
  return r ? r.value : 'built';
}
function updatePrbTestScope() {
  $('#prbAreas').classList.toggle('hidden', prbTestScope() !== 'areas');
}
function prbTestError(msg) {
  const b = $('#prbTestError');
  b.textContent = msg;
  b.classList.remove('hidden');
}
async function prbRunTests() {
  $('#prbTestError').classList.add('hidden');
  const scope = prbTestScope();
  const project = currentProject();
  const grep = $('#prbTestGrep').value.trim() || undefined;
  const body = { grep, project: project ? project.key : undefined };
  if (scope === 'all') {
    body.all = true;
  } else if (scope === 'areas') {
    body.areas = $$('#prbAreas input:checked').map((c) => c.value);
    if (!body.areas.length) return prbTestError('Pick at least one area, or choose another scope.');
  }
  // scope === 'project' → server falls back to the project's configured testAreas.
  try {
    const { id } = await api('/api/prbuilder/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    openLive(id);
  } catch (e) {
    prbTestError(e.message);
  }
}

/** The project currently selected in the dropdown. */
function currentProject() {
  const key = $('#prbProject').value;
  return PRB.projects.find((p) => p.key === key) || PRB.projects[0] || null;
}

async function prbLoadProjects() {
  const sel = $('#prbProject');
  try {
    const { projects } = await api('/api/prbuilder/projects');
    PRB.projects = projects;
    sel.innerHTML = '';
    if (!projects.length) {
      sel.append(el('option', { value: '' }, '(none configured)'));
      return prbError('No projects configured. Copy pr-builder.config.example.json to pr-builder.config.json and edit it.');
    }
    for (const p of projects) sel.append(el('option', { value: p.key }, `${p.name} — ${p.repo}`));
    if (projects[0] && projects[0].usingExample) {
      prbError('Using pr-builder.config.example.json — copy it to pr-builder.config.json and point it at your own repos.');
    }
    await onProjectPick();
  } catch (e) {
    sel.innerHTML = '';
    sel.append(el('option', { value: '' }, '(could not load projects)'));
    prbError(e.message);
  }
}

async function onProjectPick() {
  const p = currentProject();
  if (!p) return;
  $('#prbSite').textContent = p.site;
  $('#prbTestSite').textContent = p.site;

  const info = $('#prbProjectInfo');
  info.innerHTML = '';
  const folder = p.kind === 'theme' ? 'themes' : 'plugins';
  info.append(el('span', {}, `installs to wp-content/${folder}/${p.slug}`));
  if (p.build) info.append(el('span', { class: 'muted' }, ` · build: ${p.build}`));
  if (p.distDir) info.append(el('span', { class: 'muted' }, ` · dist: ${p.distDir}`));

  const built = $('#prbBuiltInfo');
  if (built) {
    built.textContent = p.testAreas && p.testAreas.length
      ? `· ${p.testAreas.join(', ')}`
      : '· (no testAreas configured)';
  }
  await prbLoadPRs();
}

async function prbLoadPRs() {
  const sel = $('#prbPr');
  const p = currentProject();
  if (!p) { sel.innerHTML = '<option value="">—</option>'; return; }
  sel.innerHTML = '<option value="">Loading PRs…</option>';
  try {
    const { prs } = await api(`/api/prbuilder/prs?limit=100&project=${encodeURIComponent(p.key)}`);
    PRB.prs = prs;
    sel.innerHTML = '<option value="">— pick a PR —</option>';
    for (const x of prs) {
      const tag = x.state === 'MERGED' ? '✓ merged' : x.state === 'CLOSED' ? '✗ closed' : 'open';
      sel.append(el('option', { value: String(x.number) }, `#${x.number} [${tag}] ${x.title}`));
    }
    if (!prs.length) sel.innerHTML = '<option value="">(no open PRs)</option>';
  } catch (e) {
    sel.innerHTML = `<option value="">(could not load PRs: ${e.message})</option>`;
  }
}

function onPrPick() {
  const n = $('#prbPr').value;
  if (!n) return;
  $('#prbPrNumber').value = n;
  updateVersionPlaceholder();
}

/** Pull a PR number out of whatever the user typed (number, #n, or a URL). */
function prNumberFromInput() {
  const raw = $('#prbPrNumber').value.trim();
  const url = raw.match(/\/pull\/(\d+)/);
  if (url) return url[1];
  const qualified = raw.match(/#(\d+)$/);
  if (qualified) return qualified[1];
  const bare = raw.match(/^#?(\d+)$/);
  return bare ? bare[1] : null;
}

function updateVersionPlaceholder() {
  const n = prNumberFromInput();
  $('#prbVersion').placeholder = n ? `100.PR${n}` : '100.PR<N>';
}

async function prbStartBuild() {
  $('#prbError').classList.add('hidden');
  const pr = $('#prbPrNumber').value.trim();
  if (!pr) return prbError('Enter a PR number or link.');
  const project = currentProject();

  const payload = {
    pr,
    project: project ? project.key : undefined,
    version: $('#prbVersion').value.trim() || undefined,
    cleanInstall: $('#prbClean').checked,
  };

  try {
    const { id } = await api('/api/prbuilder/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    $('#prbLog').textContent = '';
    $('#prbVerify').classList.add('hidden');
    openPrBuildLog(id);
  } catch (e) {
    prbError(e.message);
  }
}

function prbError(msg) {
  const b = $('#prbError');
  b.textContent = msg;
  b.classList.remove('hidden');
}

function openPrBuildLog(id) {
  prbActiveId = id;
  if (prbSource) prbSource.close();
  prbBuildBusy(true);
  prbSource = new EventSource(`/api/prbuilder/builds/${id}/stream`);
  prbSource.onmessage = (e) => handlePrbEvent(JSON.parse(e.data));
  prbSource.onerror = () => { /* browser auto-reconnects */ };
}

function handlePrbEvent(ev) {
  switch (ev.kind) {
    case 'snapshot':
      if (ev.logs && ev.logs.length) { $('#prbLog').textContent = ev.logs.join('\n') + '\n'; prbScrollLog(); }
      if (ev.build) prbSetStatus(ev.build);
      prbBuildBusy(!!(ev.live && ev.build && ev.build.status === 'running'));
      if (!ev.live && ev.build) prbRenderVerify(ev.build);
      break;
    case 'log':
      appendPrbLog(ev.line);
      break;
    case 'cancelling':
      $('#prbStatus').textContent = 'cancelling…';
      break;
    case 'build-end':
      prbSetStatus(ev.build);
      prbRenderVerify(ev.build);
      prbBuildBusy(false);
      if (prbSource) { prbSource.close(); prbSource = null; }
      prbLoadHistory();
      break;
  }
}

function appendPrbLog(line) {
  const pre = $('#prbLog');
  pre.textContent += line + '\n';
  const lines = pre.textContent.split('\n');
  if (lines.length > 2500) pre.textContent = lines.slice(-2000).join('\n');
  prbScrollLog();
}
function prbScrollLog() { const pre = $('#prbLog'); pre.scrollTop = pre.scrollHeight; }

function prbSetStatus(build) {
  const s = $('#prbStatus');
  s.innerHTML = '';
  s.append(stBadge(build.status));
  if (build.project && build.project.name) s.append(el('span', { class: 'stat' }, ` ${build.project.name}`));
  if (build.prNumber) s.append(el('span', { class: 'stat' }, ` PR #${build.prNumber}`));
  if (build.durationMs != null) s.append(el('span', { class: 'stat' }, ' ⏱ ' + fmtDuration(build.durationMs)));
  const admin = $('#prbAdmin');
  if (build.adminUrl) { admin.href = build.adminUrl; admin.classList.remove('hidden'); }
  else admin.classList.add('hidden');
}

function prbBuildBusy(busy) {
  $('#prbBuild').disabled = busy;
  $('#prbCancel').classList.toggle('hidden', !busy);
}

function prbRenderVerify(build) {
  const box = $('#prbVerify');
  const v = build.verification;
  if (!v) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '';
  box.append(el('div', { class: 'prb-verify-head ' + (v.ok ? 'good' : 'warn') },
    v.ok ? '✅ PR content fully present in this site' : '⚠️ Some PR-changed files do not match'));
  const row = (label, n, bad) => el('span', { class: 'prb-vstat' + (bad && n ? ' bad' : '') }, `${label}: ${n}`);
  const rows = [row('✓ match', v.match), row('✓ stamped', v.stamped)];
  if (v.built) rows.push(row('– compiled', v.built));
  rows.push(
    row('⚠ mismatch', v.mismatch, true), row('✗ missing', v.missing, true),
    row('✗ removed-but-found', v.removed, true), row('removed ok', v.removedOk));
  box.append(el('div', { class: 'prb-vstats' }, ...rows));
}

async function prbRefreshActive() {
  try {
    const { build } = await api('/api/prbuilder/active');
    if (build && build.status === 'running') openPrBuildLog(build.id);
  } catch (_) {}
}

async function prbCancel() {
  if (!prbActiveId) return;
  try { await api(`/api/prbuilder/builds/${prbActiveId}/cancel`, { method: 'POST' }); } catch (_) {}
}

async function prbLoadHistory() {
  const box = $('#prbHistory');
  try {
    const { builds } = await api('/api/prbuilder/builds');
    if (!builds.length) { box.innerHTML = '<div class="empty">No builds yet.</div>'; return; }
    const tbody = el('tbody');
    for (const b of builds) {
      tbody.append(el('tr', { class: 'clickable', onclick: () => openPrBuildLog(b.id) },
        el('td', {}, fmtTime(b.startedAt || b.createdAt)),
        el('td', {}, (b.project && b.project.name) || '—'),
        el('td', {}, `#${b.prNumber}`),
        el('td', {}, stBadge(b.status)),
        el('td', {}, fmtDuration(b.durationMs))));
    }
    box.innerHTML = '';
    box.append(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Project'), el('th', {}, 'PR'),
        el('th', {}, 'Status'), el('th', {}, 'Duration'))),
      tbody));
  } catch (e) {
    box.innerHTML = `<div class="error-banner">${e.message}</div>`;
  }
}

/* --------------------------------- startup --------------------------------- */

async function init() {
  try {
    const env = await api('/api/env');
    $('#envInfo').textContent = env.playwrightCliExists
      ? `suite: …${env.suiteDir.slice(-40)}`
      : '⚠ Playwright not found — check suite path';
  } catch (_) {}
  await loadTree();
  checkSites(); // initial reachability sweep
  refreshActiveList();
  setInterval(refreshActiveList, 5000);
}

init();
