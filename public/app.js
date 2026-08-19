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

/** Re-runnable = a finished run that didn't fully pass, if you may start runs. */
function rerunnable(run) {
  return can('tests.run')
    && !!(run && run.status && run.status !== 'passed' && run.status !== 'running');
}

/** Re-run the same targets/specs as a previous run, instantly. */
async function rerunRun(id) {
  try {
    const { run } = await api(`/api/runs/${id}`);
    const targets = (run.targets || []).map((t) => ({
      suite: t.suite || undefined,
      scope: t.scope || undefined,
      site: t.site,
      paths: t.paths,
      grep: t.grep || undefined,
    }));
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
  // An expired or revoked session shouldn't surface as a cryptic "HTTP 401"
  // in an alert — send the user to the login form and keep where they were.
  if (res.status === 401) {
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
    await new Promise(() => {}); // never settles; the navigation takes over
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* --------------------------------- access ---------------------------------- */

/** The signed-in user, as /api/auth/me described them. Set once, in init(). */
let ME = null;

/** Does the signed-in user hold this permission? Viewing needs none. */
function can(permission) {
  return !!(ME && ME.permissions && ME.permissions[permission]);
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
  if (name === 'sites') loadSites();
  if (name === 'users') loadUsers();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

/* ----------------------------------- tree ---------------------------------- */

/**
 * The Run tab is a table with one row per selectable thing, so a suite's
 * identity is readable by column rather than crammed into one label: what it's
 * called, which framework and language it's written in, how much it contains,
 * and which registered site it will run against.
 *
 * A run target is a (suite, scope, site, paths) tuple — which suite's tests, and
 * which environment to point them at — so the site dropdown lives on the same
 * row as the thing it applies to.
 *
 * Selection and expansion live in STATE, not in the DOM: the table is rebuilt
 * from the model on every change. Rows are few (a suite plus its specs), and
 * deriving the view from one source of truth avoids the usual tree-widget bugs
 * where a checkbox and the thing it represents drift apart.
 */

let TREE = null;
let STATE = []; // per-suite selection/expansion state, see buildState()
let SITE_STATUS = {}; // site key -> last preflight result
let HISTORY = []; // cached run summaries for client-side filtering
let SORT = { key: null, dir: 1 }; // null key = configuration order

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'fw', label: 'Framework' },
  { key: 'lang', label: 'Language' },
  { key: 'count', label: 'Specs / Tests' },
  { key: 'site', label: 'Site' },
  { key: 'status', label: 'Site status' },
];

/** Reachability, worst-last, so "Site status" sorts into up → down → unknown. */
function statusRank(siteKey) {
  const s = SITE_STATUS[siteKey];
  if (!s || s.checking) return 2;
  return s.up ? 0 : 1;
}

function siteUrl(siteKey) {
  const site = TREE && TREE.sites.find((s) => s.key === siteKey);
  return site ? site.url : siteKey || '';
}

/**
 * The value a row sorts by. Suites and scopes share the comparator, so a
 * multi-scope suite sorts its scopes the same way the table sorts its suites.
 */
function sortValue(key, { suite, scope, site, name }) {
  switch (key) {
    case 'name': return (name || '').toLowerCase();
    case 'fw': return (suite.label || suite.framework ||
      (suite.frameworks || []).map((f) => f.label || f.id).join('+') || '').toLowerCase();
    case 'lang': return (suite.language ||
      (suite.frameworks || []).map((f) => f.language).filter(Boolean).join('+') || '').toLowerCase();
    case 'count': return (scope ? scope.testCount : suite.testCount) || 0;
    case 'site': return siteUrl(site).toLowerCase();
    case 'status': return statusRank(site);
    default: return 0;
  }
}

/**
 * Ties break on framework then name, always ascending, so sorting by a column
 * several rows share (three suites of the same project all named the same, say)
 * still produces a stable, predictable order rather than an arbitrary one.
 */
function compareBy(key, dir) {
  return (a, b) => {
    const av = sortValue(key, a);
    const bv = sortValue(key, b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    for (const tie of ['fw', 'name']) {
      const ta = sortValue(tie, a);
      const tb = sortValue(tie, b);
      if (ta < tb) return -1;
      if (ta > tb) return 1;
    }
    return 0;
  };
}

/** Cycle a column: ascending → descending → back to configuration order. */
function toggleSort(key) {
  if (SORT.key !== key) SORT = { key, dir: 1 };
  else if (SORT.dir === 1) SORT = { key, dir: -1 };
  else SORT = { key: null, dir: 1 };
  renderTree();
}

/**
 * STATE in display order. Sorting reorders suites, and the scopes inside a
 * multi-scope suite — never the spec rows, which stay with their parent in the
 * order the framework reports them.
 */
function sortedState() {
  const rows = STATE.map((st) => ({
    st,
    suite: st.suite,
    scope: st.scopes.length === 1 ? st.scopes[0].scope : null,
    site: st.scopes.length === 1 ? st.scopes[0].site : (st.scopes[0] || {}).site,
    name: st.suite.name,
  }));
  if (!SORT.key) return STATE;
  rows.sort(compareBy(SORT.key, SORT.dir));
  return rows.map((r) => r.st);
}

function sortedScopes(st) {
  if (!SORT.key || st.scopes.length < 2) return st.scopes;
  return st.scopes
    .map((sc) => ({ sc, suite: st.suite, scope: sc.scope, site: sc.site, name: sc.scope.name }))
    .sort(compareBy(SORT.key, SORT.dir))
    .map((r) => r.sc);
}

async function loadTree(refresh = false) {
  $('#tree').textContent = 'Loading test tree…';
  try {
    TREE = await api('/api/tree' + (refresh ? '?refresh=1' : ''));
  } catch (err) {
    $('#tree').innerHTML = `<div class="error-banner">Could not load tree: ${err.message}</div>`;
    return;
  }
  STATE = buildState(STATE);
  renderTree();
}

/* --------------------------------- model ---------------------------------- */

function makeNode(node) {
  return { node, checked: false, open: false, children: (node.children || []).map(makeNode) };
}

/**
 * Build fresh state from the loaded tree. Site choices are carried over from the
 * previous state so a Rescan doesn't reset which site each suite points at.
 */
function buildState(previous) {
  const keptSites = new Map();
  for (const st of previous || []) {
    for (const sc of st.scopes) keptSites.set(`${st.key}:${sc.key}`, sc.site);
  }
  return TREE.suites.map((suite) => ({
    key: suite.key,
    suite,
    scopes: (suite.scopes || []).map((scope) => ({
      key: scope.key,
      scope,
      suite,
      site:
        keptSites.get(`${suite.key}:${scope.key}`) ||
        scope.defaultSite ||
        (suite.sites[0] || {}).key ||
        '',
      open: false,
      children: (scope.children || []).map(makeNode),
    })),
  }));
}

/** Every spec file under a node (a file node is its own only leaf). */
function leavesOf(ns) {
  return ns.children.length ? ns.children.flatMap(leavesOf) : [ns];
}

function setChecked(ns, value) {
  ns.checked = value;
  for (const child of ns.children) setChecked(child, value);
}

function fullyChecked(ns) {
  const leaves = leavesOf(ns);
  return leaves.length > 0 && leaves.every((l) => l.checked);
}

function partlyChecked(ns) {
  const leaves = leavesOf(ns);
  return leaves.some((l) => l.checked) && !leaves.every((l) => l.checked);
}

function scopeLeaves(sc) {
  return sc.children.flatMap(leavesOf);
}

function setScopeChecked(sc, value) {
  for (const child of sc.children) setChecked(child, value);
}

function forEachScope(fn) {
  for (const st of STATE) for (const sc of st.scopes) fn(sc, st);
}

/**
 * What one scope contributes to a run: the whole scope when everything under it
 * is selected, otherwise the highest fully-selected nodes (so picking a folder
 * sends the folder, not each file inside it).
 */
function collectScopeSelection(sc) {
  const base = { suite: sc.suite.key, scope: sc.key, site: sc.site };
  const leaves = scopeLeaves(sc);
  if (leaves.length && leaves.every((l) => l.checked)) {
    return {
      ...base,
      paths: sc.scope.filters,
      specCount: sc.scope.specCount,
      testCount: sc.scope.testCount || 0,
    };
  }

  const paths = [];
  let specCount = 0;
  let testCount = 0;
  const walk = (ns) => {
    if (fullyChecked(ns)) {
      paths.push(ns.node.filter);
      specCount += ns.node.specCount;
      testCount += ns.node.testCount || 0;
      return;
    }
    ns.children.forEach(walk);
  };
  sc.children.forEach(walk);
  return { ...base, paths, specCount, testCount };
}

function suiteOf(key) {
  return TREE && TREE.suites.find((s) => s.key === key);
}

function selectedSuites() {
  const keys = new Set();
  forEachScope((sc, st) => {
    if (collectScopeSelection(sc).specCount > 0) keys.add(st.key);
  });
  return TREE.suites.filter((s) => keys.has(s.key));
}

function buildTargets() {
  const grep = $('#grepInput').value.trim() || undefined;
  const targets = [];
  forEachScope((sc) => {
    const sel = collectScopeSelection(sc);
    if (sel.specCount > 0 && sel.site) {
      targets.push({
        suite: sel.suite, scope: sel.scope, site: sel.site, paths: sel.paths, grep,
      });
    }
  });
  return targets;
}

/* -------------------------------- rendering -------------------------------- */

function renderTree() {
  const root = $('#tree');
  root.innerHTML = '';
  if (!TREE || !TREE.suites.length) {
    root.innerHTML = '<div class="empty">No suites configured. Add one to sites.config.json.</div>';
    return;
  }

  const head = el('tr', {}, ...COLUMNS.map((c) => {
    const active = SORT.key === c.key;
    const th = el('th', {
      class: `col-${c.key} sortable${active ? ' sorted' : ''}`,
      title: `Sort by ${c.label}`,
    },
      el('span', { class: 'th-label' }, c.label),
      el('span', { class: 'sort-caret' }, active ? (SORT.dir === 1 ? '▲' : '▼') : '')
    );
    th.addEventListener('click', () => toggleSort(c.key));
    return th;
  }));

  const table = el('table', { class: 'run-table' }, el('thead', {}, head));
  for (const st of sortedState()) table.append(renderSuiteBody(st));
  root.append(table);
  updateSelCount();
}

/**
 * Framework identity chip — the "which stack is this" cue. A composite suite
 * (one directory holding several frameworks — see config.js) has no single
 * framework, so it wears one small chip per member instead of one badge.
 */
function frameworkBadge(suite) {
  if (suite.frameworks) {
    return el('span', { class: 'fw-cell' }, ...suite.frameworks.map((f) =>
      el('span', { class: `fw-chip fw-${f.id}`, title: f.runner || f.id }, f.label || f.id)));
  }
  return el('span', { class: `fw-badge fw-${suite.framework}`, title: suite.runner || suite.framework },
    suite.label || suite.framework);
}

/** Badge for one tree node once it's known to be a single framework's file
 *  or sub-tree — the per-spec-file "which stack" cue inside a composite
 *  suite's expanded tree. `null` for a plain (single-framework) suite, whose
 *  nodes never carry a `framework` field, and for a composite suite's mixed
 *  directories (nodes whose descendants span more than one framework). */
function nodeFrameworkBadge(node, suite) {
  if (!node.framework || !suite.frameworks) return null;
  const meta = suite.frameworks.find((f) => f.id === node.framework);
  if (!meta) return null;
  return el('span', { class: `fw-badge fw-${meta.id}`, title: meta.runner || meta.id },
    el('span', { class: 'fw-name' }, meta.label || meta.id));
}

function renderSuiteBody(st) {
  const suite = st.suite;
  const body = el('tbody', { class: 'suite-body', 'data-suite': st.key });

  if (!suite.ok) {
    body.append(el('tr', { class: 'suite-row broken' },
      el('td', { class: 'col-name' }, el('span', { class: 'suite-name' }, suite.name)),
      el('td', { class: 'col-fw' }, frameworkBadge(suite)),
      el('td', { class: 'col-lang' }, suite.language || '—'),
      el('td', { class: 'col-count' }, '—'),
      el('td', { class: 'col-site', colspan: '2' },
        el('span', { class: 'row-error' }, suite.error || 'This suite is not runnable.'))));
    return body;
  }

  // One scope means the suite *is* the selectable row; several means the suite
  // gets a grouping header and each scope is selected (and sited) separately.
  const multi = st.scopes.length > 1;
  if (multi) {
    body.append(el('tr', { class: 'suite-row group' },
      el('td', { class: 'col-name' }, el('span', { class: 'suite-name' }, suite.name)),
      el('td', { class: 'col-fw' }, frameworkBadge(suite)),
      el('td', { class: 'col-lang' }, suite.language || ''),
      el('td', { class: 'col-count' }, countText(suite)),
      el('td', { class: 'col-site' }),
      el('td', { class: 'col-status' })));
  }

  if (suite.tooling && !suite.tooling.ok) {
    body.append(el('tr', { class: 'note-row' },
      el('td', { class: 'col-name', colspan: String(COLUMNS.length) },
        el('span', { class: 'row-warn' }, suite.tooling.message))));
  }

  for (const sc of sortedScopes(st)) {
    body.append(scopeRow(st, sc, !multi));
    if (sc.open) appendChildRows(body, sc.children, 1, suite);
  }
  return body;
}

function scopeRow(st, sc, isSuiteRow) {
  const suite = st.suite;
  const hasChildren = sc.children.length > 0;

  const cb = el('input', { type: 'checkbox' });
  cb.checked = fullyChecked({ children: sc.children, node: null });
  cb.indeterminate = partlyChecked({ children: sc.children, node: null });
  cb.addEventListener('change', () => {
    setScopeChecked(sc, cb.checked);
    renderTree();
  });

  const twisty = el('span', { class: 'twisty' + (hasChildren ? '' : ' blank') },
    hasChildren ? (sc.open ? '▾' : '▸') : '');
  const toggle = () => { sc.open = !sc.open; renderTree(); };
  if (hasChildren) twisty.addEventListener('click', toggle);

  const name = el('span', { class: 'node-label dir' }, isSuiteRow ? suite.name : sc.scope.name);
  if (hasChildren) name.addEventListener('click', toggle);

  const row = el('tr', { class: 'scope-row' },
    el('td', { class: 'col-name' }, el('span', { class: 'cell-name' }, twisty, cb, name)),
    el('td', { class: 'col-fw' }, isSuiteRow ? frameworkBadge(suite) : null),
    el('td', { class: 'col-lang' }, isSuiteRow ? (suite.language || '') : ''),
    el('td', { class: 'col-count', title: countTitle(sc.scope) }, countText(sc.scope)),
    el('td', { class: 'col-site' }, siteSelect(suite, sc)),
    siteStatusCell(sc.site)
  );
  return row;
}

/**
 * The "run this against…" dropdown — the whole point of the Site column.
 * Options show the URL rather than the display name: the URL is the thing that
 * actually differs between sites, and it's what you check against your browser.
 */
function siteSelect(suite, sc) {
  const select = el('select', { class: 'site-select', title: 'Which registered site to run against' });
  for (const site of suite.sites) {
    select.append(el('option', { value: site.key, title: `${site.name} — ${site.url}` }, site.url));
  }
  if (!suite.sites.length) {
    select.append(el('option', { value: '' }, '(no sites configured)'));
    select.disabled = true;
  }
  select.value = sc.site;
  select.addEventListener('change', () => {
    sc.site = select.value;
    renderTree(); // the status cell belongs to the newly chosen site
  });
  return select;
}

function siteStatusCell(siteKey) {
  const s = SITE_STATUS[siteKey];
  let cls = '';
  let text = 'unknown';
  if (s && s.checking) {
    cls = 'checking';
    text = 'checking…';
  } else if (s) {
    cls = s.up ? 'up' : 'down';
    text = s.up ? `up · ${s.ms}ms` : (s.error || `HTTP ${s.status}`);
  }
  return el('td', { class: 'col-status' },
    el('span', { class: `site-status ${cls}` }),
    el('span', { class: 'status-text' }, text));
}

function appendChildRows(body, nodes, depth, suite) {
  for (const ns of nodes) {
    body.append(nodeRow(ns, depth, suite));
    if (ns.node.type === 'dir' && ns.open) appendChildRows(body, ns.children, depth + 1, suite);
  }
}

function nodeRow(ns, depth, suite) {
  const isDir = ns.node.type === 'dir';

  const cb = el('input', { type: 'checkbox' });
  cb.checked = fullyChecked(ns);
  cb.indeterminate = partlyChecked(ns);
  cb.addEventListener('change', () => {
    setChecked(ns, cb.checked);
    renderTree();
  });

  const twisty = el('span', { class: 'twisty' + (isDir ? '' : ' blank') },
    isDir ? (ns.open ? '▾' : '▸') : '');
  const toggle = () => { ns.open = !ns.open; renderTree(); };
  if (isDir) twisty.addEventListener('click', toggle);

  const name = el('span', { class: `node-label ${isDir ? 'dir' : 'file'}` }, ns.node.name);
  if (isDir) name.addEventListener('click', toggle);

  // Only ever set for a composite suite (see config.js/tree.js) — the cue for
  // which framework this file, or this whole sub-tree, belongs to.
  const fwBadge = nodeFrameworkBadge(ns.node, suite);
  const meta = fwBadge && suite.frameworks.find((f) => f.id === ns.node.framework);

  return el('tr', { class: 'node-row' },
    el('td', { class: 'col-name' },
      el('span', { class: 'cell-name', style: `padding-left:${depth * 22}px` }, twisty, cb, name)),
    el('td', { class: 'col-fw' }, fwBadge),
    el('td', { class: 'col-lang' }, meta ? (meta.language || '') : ''),
    el('td', { class: 'col-count', title: countTitle(ns.node) }, countText(ns.node, !isDir)),
    el('td', { class: 'col-site' }),
    el('td', { class: 'col-status' }));
}

/* --------------------------------- counts ---------------------------------- */

/** Test count is the headline number once counts are available. */
function countText(node, isFile) {
  const specs = node.specCount;
  const tests = node.testCount;
  if (!TREE || !TREE.testCountsOk || tests == null) {
    return `${specs} spec${specs === 1 ? '' : 's'}`;
  }
  if (isFile) return `${tests} test${tests === 1 ? '' : 's'}`;
  return `${tests} tests · ${specs} spec${specs === 1 ? '' : 's'}`;
}

function countTitle(node) {
  if (!TREE || !TREE.testCountsOk) return `${node.specCount} spec file(s)`;
  return `${node.testCount} test(s) across ${node.specCount} spec file(s)`;
}

/** Count selected specs + tests and enable/disable the Run button. */
function updateSelCount() {
  let count = 0;
  let tests = 0;
  forEachScope((sc) => {
    const sel = collectScopeSelection(sc);
    count += sel.specCount;
    tests += sel.testCount || 0;
  });
  const showTests = TREE && TREE.testCountsOk;
  $('#selCount').textContent = showTests
    ? `${tests} test${tests === 1 ? '' : 's'} · ${count} spec${count === 1 ? '' : 's'} selected`
    : `${count} spec${count === 1 ? '' : 's'} selected`;
  $('#btnRun').disabled = count === 0;
  $('#btnRun').textContent = count > 0 && showTests
    ? `Run ${tests} test${tests === 1 ? '' : 's'} ▶`
    : 'Run selected ▶';
  updateGrepHint();
}

/**
 * Not every framework can filter by keyword: Playwright has --grep and the
 * Selenium adapter resolves a keyword into explicit Class#method selections,
 * but Cypress has no CLI title filter at all. Say so rather than silently
 * running more tests than asked for.
 */
function updateGrepHint() {
  const hint = $('#grepHint');
  if (!hint) return;
  const grep = $('#grepInput').value.trim();
  const ignoring = selectedSuites().filter((s) => !s.supportsGrep);
  if (!grep || !ignoring.length) { hint.classList.add('hidden'); return; }
  hint.textContent =
    `Keyword filter ignored for ${[...new Set(ignoring.map((s) => s.label))].join(', ')} — ` +
    `${ignoring[0].grepNote || 'this framework has no CLI keyword filter'}. Select specs instead.`;
  hint.classList.remove('hidden');
}


/* ------------------------------- run actions ------------------------------- */

$('#btnRun').addEventListener('click', async () => {
  const targets = buildTargets();
  $('#runError').classList.add('hidden');
  if (!targets.length) return;

  // Preflight the selected sites; warn (don't block) if any are unreachable.
  const keys = [...new Set(targets.map((t) => t.site))];
  const status = await checkSites(keys);
  const down = keys.filter((k) => status[k] && status[k].up === false);
  if (down.length) {
    const ok = confirm(
      `These sites look unreachable (LocalWP not running?):\n  ${down.join(', ')}\n\n` +
        `Logging in will fail for them. Start anyway?`
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

/**
 * Ping sites and refresh the Site status column. Sites are shared across suites,
 * so one sweep covers every row pointing at the same site. Returns the status
 * map.
 */
async function checkSites(keys) {
  const wanted = keys && keys.length
    ? keys
    : [...new Set(STATE.flatMap((st) => st.scopes.map((sc) => sc.site)).filter(Boolean))];
  for (const key of wanted) SITE_STATUS[key] = { checking: true };
  if (TREE) renderTree();

  let status = {};
  try {
    const q = keys && keys.length ? `?sites=${keys.join(',')}` : '';
    ({ sites: status } = await api('/api/preflight' + q));
  } catch (_) {
    for (const key of wanted) delete SITE_STATUS[key]; // don't leave rows stuck on "checking…"
    if (TREE) renderTree();
    return {};
  }
  SITE_STATUS = { ...SITE_STATUS, ...status };
  if (TREE) renderTree();
  return status;
}

/* ---------------------------------- sites ---------------------------------- */
// A dedicated tab (admins only, see applyPermissions) rather than a panel
// bolted onto the Run toolbar — the same shape as the Users tab. Every site
// (config-file or dashboard-added) is listed here; only dashboard-added ones
// carry Edit/Delete, since sites.config.json stays the source of truth for
// hand-checked-in sites.

const SITES_STATE = { list: [] };

async function loadSites() {
  try {
    const { sites } = await api('/api/sites');
    SITES_STATE.list = sites || [];
    renderSites();
  } catch (e) {
    $('#siteList').textContent = 'Could not load sites: ' + e.message;
  }
}

function siteError(msg) {
  const box = $('#siteError');
  box.textContent = msg || '';
  box.classList.toggle('hidden', !msg);
}

function renderSites() {
  const box = $('#siteList');
  box.innerHTML = '';
  if (!SITES_STATE.list.length) return void (box.textContent = 'No sites configured.');
  for (const s of SITES_STATE.list) box.append(siteRow(s));
}

function siteRow(s) {
  const row = el('div', { class: 'sched-card' },
    el('div', {},
      el('div', { class: 'sname' }, s.name),
      el('div', { class: 'meta' }, s.url)),
    el('span', { class: 'spacer' }));

  if (s.custom) {
    row.append(
      el('button', { class: 'ghost sm', onclick: () => showEditSiteForm(row, s) }, 'Edit'),
      el('button', { class: 'danger sm', onclick: () => deleteSite(s) }, 'Delete'));
  } else {
    row.append(el('span', {
      class: 'meta',
      title: 'Defined in sites.config.json — edit that file to change it.',
    }, 'config file'));
  }
  return row;
}

async function deleteSite(s) {
  if (!confirm(`Remove site "${s.name}"? Suites currently pointed at it will need a different site.`)) return;
  siteError('');
  try {
    await api(`/api/sites/${s.key}`, { method: 'DELETE' });
    await loadTree(true); // refresh the Run tab's site dropdowns immediately
  } catch (e) {
    siteError(e.message);
  }
  loadSites();
}

/** Swap one site row for an inline edit form, prefilled with its current
 *  name/url/admin user. The password field is left blank — submitting it
 *  blank keeps the existing password (credentials never round-trip to the
 *  browser once saved). */
function showEditSiteForm(row, s) {
  siteError('');
  const name = el('input', { type: 'text', value: s.name });
  const url = el('input', { type: 'text', value: s.url });
  const user = el('input', { type: 'text', placeholder: 'admin' });
  const pass = el('input', { type: 'password', placeholder: '(unchanged)' });

  const save = el('button', { class: 'primary' }, 'Save');
  save.addEventListener('click', async () => {
    siteError('');
    try {
      await api(`/api/sites/${s.key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.value, url: url.value, adminUser: user.value, adminPass: pass.value }),
      });
      await loadTree(true);
      loadSites();
    } catch (e) {
      siteError(e.message);
    }
  });
  const cancel = el('button', { class: 'ghost' }, 'Cancel');
  cancel.addEventListener('click', renderSites);

  const form = el('div', { class: 'sched-form sched-target-edit' },
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Name'), name),
      el('div', {}, el('label', {}, 'URL'), url)),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Admin username'), user),
      el('div', {}, el('label', {}, 'Admin password'), pass)),
    el('div', { class: 'actions' }, save, cancel));

  row.replaceWith(form);
}

function showAddSiteForm() {
  siteError('');
  const box = $('#siteForm');
  box.classList.remove('hidden');
  box.innerHTML = '';

  const name = el('input', { type: 'text', placeholder: 'e.g. Staging' });
  const url = el('input', { type: 'text', placeholder: 'https://staging.example.com' });
  const user = el('input', { type: 'text', placeholder: 'admin', value: 'admin' });
  const pass = el('input', { type: 'password', placeholder: 'admin' });

  const save = el('button', { class: 'primary' }, 'Add site');
  save.addEventListener('click', async () => {
    siteError('');
    try {
      await api('/api/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.value, url: url.value, adminUser: user.value, adminPass: pass.value }),
      });
      box.classList.add('hidden');
      await loadTree(true);
      loadSites();
    } catch (e) {
      siteError(e.message);
    }
  });
  const cancel = el('button', { class: 'ghost' }, 'Cancel');
  cancel.addEventListener('click', () => box.classList.add('hidden'));

  box.append(
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Name'), name),
      el('div', {}, el('label', {}, 'URL'), url)),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Admin username'), user),
      el('div', {}, el('label', {}, 'Admin password'), pass)),
    el('div', { class: 'actions' }, save, cancel));
  name.focus();
}

$('#btnNewSite').addEventListener('click', () => {
  const box = $('#siteForm');
  if (box.classList.contains('hidden')) showAddSiteForm();
  else box.classList.add('hidden');
});

/** Open/close every expandable row. */
function setAllOpen(open) {
  const walk = (nodes) => {
    for (const ns of nodes) {
      if (ns.node.type === 'dir') ns.open = open;
      walk(ns.children);
    }
  };
  forEachScope((sc) => {
    sc.open = open;
    walk(sc.children);
  });
  renderTree();
}

$('#btnExpandAll').addEventListener('click', () => setAllOpen(true));
$('#btnCollapseAll').addEventListener('click', () => setAllOpen(false));
$('#btnClear').addEventListener('click', () => {
  forEachScope((sc) => setScopeChecked(sc, false));
  renderTree();
});
$('#btnRefreshTree').addEventListener('click', () => loadTree(true));

/* ----------------------------------- live ---------------------------------- */

let liveSource = null;
let liveTimer = null;
let liveRunId = null;
// Keyed by target key ("<suite>__<site>"), not by site: the same site can be
// under test by several suites in one run.
const cardRefs = {};

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
      setTargetTotals(ev.target, ev.totals);
      break;
    case 'target-update':
    case 'target-end':
      updateTargetCard(ev.target);
      break;
    case 'plan':
      renderTargetTests(ev.target, { plannedTests: ev.tests });
      break;
    case 'current':
      setCurrent(ev.target, ev.title);
      if (ev.id) setRowRunning(ev.target, ev.id);
      break;
    case 'test':
      setTargetTotals(ev.target, ev.targetTotals);
      setRunTotals(ev.runTotals);
      if (ev.test) setRowDone(ev.target, ev.test);
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
    if (can('tests.run')) {
      head.append(el('button', { class: 'danger', onclick: () => cancelRun(run.id) }, 'Cancel run'));
    }
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

/** Where a finished target's detail lives: a real report, or a file listing. */
function targetReportLink(runId, t) {
  const key = t.key || t.site;
  return t.reportKind === 'artifacts'
    ? el('a', { class: 'report-link', href: `/api/runs/${runId}/artifacts/${key}`, target: '_blank' },
        '↗ Artifacts (screenshots, reports)')
    : el('a', { class: 'report-link', href: `/api/runs/${runId}/report/${key}/index.html`, target: '_blank' },
        '↗ Open Playwright report');
}

/** Compact "Cypress · TypeScript" chip for a run target. */
function targetFrameworkBadge(t) {
  if (!t.frameworkLabel) return null;
  return el('span', { class: `fw-badge fw-${t.framework}` },
    el('span', { class: 'fw-name' }, t.frameworkLabel),
    el('span', { class: 'fw-lang' }, t.language || ''));
}

function buildCard(runId, t) {
  const key = t.key || t.site;
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
    updateToggleCount(key);
  });

  const auth = t.authStatus === 'failed'
    ? el('span', { class: 'st st-error' }, 'auth failed')
    : null;

  // Per-target controls: Cancel while active, Re-run once terminal.
  const actions = el('div', { class: 'card-actions' });

  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      targetFrameworkBadge(t),
      el('span', { class: 'name' }, t.suiteName || t.name),
      el('span', { class: 'spacer' }),
      auth,
      status
    ),
    el('div', { class: 'card-site' },
      el('span', { class: 'card-site-label' }, 'on'),
      el('span', { class: 'card-site-name' }, t.siteName || t.site),
      el('span', { class: 'card-site-url' }, t.url || '')),
    el('div', { class: 'progress' }, segPass, segFail, segSkip),
    el('div', { class: 'counts' }, cPass, cFail, cSkip, cTotal),
    current,
    actions,
    toggle,
    testList
  );

  cardRefs[key] = {
    card, status, segPass, segFail, segSkip, cPass, cFail, cSkip, cTotal,
    current, actions, testList, toggle, totals, rows: new Map(), planned: false,
    target: t,
  };
  renderTargetActions(actions, runId, t);

  // Build the full list from the snapshot (planned + finished + running).
  renderTargetTests(key, t);
  updateBars(key);

  // Report link only once the target is done (it's written at the end).
  if (['passed', 'failed', 'error', 'cancelled'].includes(t.status)) {
    card.append(targetReportLink(runId, t));
  }
  return card;
}

function setTargetTotals(key, totals) {
  const r = cardRefs[key];
  if (!r || !totals) return;
  r.totals = totals;
  r.cPass.textContent = `✓ ${totals.passed}`;
  r.cFail.textContent = `✗ ${totals.failed}`;
  r.cSkip.textContent = `• ${totals.skipped}`;
  r.cTotal.textContent = `${totals.completed}/${totals.total || '?'}`;
  updateBars(key);
}

function updateBars(key) {
  const r = cardRefs[key];
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

function setCurrent(key, title) {
  const r = cardRefs[key];
  if (r) r.current.textContent = title || '';
}

/**
 * Trim a test title down to the readable part. Playwright prefixes its path
 * with the project name and spec file and joins with " › "; the Cypress and
 * Selenium adapters join their describe/class path with " > ".
 */
function shortTitle(title) {
  const s = String(title || '');
  if (s.includes(' › ')) {
    const parts = s.split(' › ');
    return parts.length > 2 ? parts.slice(2).join(' › ') : s;
  }
  return s;
}

function statusGlyph(status) {
  if (status === 'passed') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'skipped') return '•';
  if (status === 'pending') return '○';
  return ''; // running → empty (a CSS spinner shows via the .spin class)
}

function makeRowClickable(row, key, test) {
  const t = (cardRefs[key] && cardRefs[key].target) || {};
  row.classList.add('clickable-row');
  row.onclick = () => openErrorModal({
    title: shortTitle(test.title), status: 'failed', durationMs: test.durationMs,
    site: t.siteName || t.site || key, error: test.error,
    reportUrl: liveRunId
      ? (t.reportKind === 'artifacts'
          ? `/api/runs/${liveRunId}/artifacts/${key}`
          : `/api/runs/${liveRunId}/report/${key}/index.html`)
      : null,
    reportLabel: t.reportKind === 'artifacts'
      ? '↗ Artifacts (screenshots, reports)'
      : '↗ Open Playwright report (trace & screenshots)',
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
function makeRow(test, key) {
  const status = test.status || 'pending';
  const ic = el('span', { class: 'ic' });
  setIcon(ic, status);
  const row = el('div', { class: `test-row ${status}` },
    ic,
    el('span', { class: 'tname', title: test.title }, shortTitle(test.title)),
    el('span', { class: 'dur' }, test.durationMs != null ? fmtDuration(test.durationMs) : '')
  );
  if (status === 'failed') makeRowClickable(row, key, test);
  return row;
}

/** Update a row in place when a test starts running or finishes. */
function applyRowStatus(row, key, test) {
  row.className = `test-row ${test.status}`;
  if (test.status === 'failed') makeRowClickable(row, key, test);
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
function renderTargetTests(key, target) {
  const r = cardRefs[key];
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
    const row = makeRow(state, key);
    r.rows.set(p.id, row);
    r.testList.append(row);
  }
  updateToggleCount(key);
}

function setRowRunning(key, id) {
  const r = cardRefs[key];
  if (!r || !r.rows) return;
  const row = r.rows.get(id);
  if (!row) return;
  applyRowStatus(row, key, { status: 'running' });
  if (!r.testList.classList.contains('hidden')) row.scrollIntoView({ block: 'nearest' });
  updateToggleCount(key);
}

function setRowDone(key, test) {
  const r = cardRefs[key];
  if (!r) return;
  if (!r.rows) r.rows = new Map();
  const row = r.rows.get(test.id);
  if (row) applyRowStatus(row, key, test);
  else { const nr = makeRow(test, key); r.rows.set(test.id, nr); r.testList.append(nr); } // fallback (no plan)
  updateToggleCount(key);
}

function updateToggleCount(key) {
  const r = cardRefs[key];
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

function openErrorModal({ title, status, durationMs, site, error, reportUrl, reportLabel }) {
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
      reportLabel || '↗ Open report'));
  }
  m.overlay.classList.remove('hidden');
}

function updateTargetCard(t) {
  const key = t.key || t.site;
  const r = cardRefs[key];
  if (!r) return;
  r.target = { ...r.target, ...t };
  const nb = stBadge(t.status);
  r.status.replaceWith(nb);
  r.status = nb; // keep a direct handle (avoids grabbing the auth badge)
  if (t.totals) setTargetTotals(key, t.totals);
  if (t.currentTest !== undefined) setCurrent(key, t.currentTest);
  // Flip the per-target action button (Cancel ↔ Re-run) on status change.
  if (r.actions) renderTargetActions(r.actions, liveRunId, t);
  // Add the report link as soon as this target finishes, if not already there.
  if (['passed', 'failed', 'error', 'cancelled'].includes(t.status) && !r.card.querySelector('.report-link') && liveRunId) {
    r.card.append(targetReportLink(liveRunId, t));
  }
}

async function cancelRun(id) {
  try { await api(`/api/runs/${id}/cancel`, { method: 'POST' }); } catch (_) {}
}

// Render the per-target action button into `box` based on the target's status:
// a Cancel button while it's active, a Re-run button once it's terminal.
function renderTargetActions(box, runId, t) {
  if (!box) return;
  box.innerHTML = '';
  if (!runId) return;
  if (!can('tests.run')) return; // a viewer watches; it doesn't steer
  const active = ['queued', 'authenticating', 'running'].includes(t.status);
  if (active) {
    box.append(el('button', {
      class: 'danger sm',
      title: 'Stop just this suite + site (the rest of the run keeps going)',
      onclick: () => cancelTarget(runId, t.key || t.site),
    }, '■ Cancel'));
  } else if (!t.custom) {
    box.append(el('button', {
      class: 'ghost sm',
      title: 'Start a fresh run for just this suite + site',
      onclick: () => rerunTarget(t),
    }, '↻ Re-run'));
  }
}

// Cancel one target within a run (kills just its process; frees it immediately).
async function cancelTarget(runId, key) {
  try { await api(`/api/runs/${runId}/targets/${key}/cancel`, { method: 'POST' }); }
  catch (_) { /* the target-end event will reflect the result */ }
}

// Start a brand-new run for a single target (it's already free, so the busy
// guard passes even while the original run is still going).
async function rerunTarget(t) {
  try {
    const { id } = await api('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets: [{
          suite: t.suite, scope: t.scope || undefined, site: t.site,
          paths: t.paths, grep: t.grep || undefined,
        }],
      }),
    });
    openLive(id);
    showTab('live');
  } catch (e) {
    alert('Could not re-run ' + (t.siteName || t.site) + ': ' + (e.message || e));
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
  if (!TREE) return;
  const siteSel = $('#hSite');
  if (siteSel.options.length <= 1) {
    for (const s of TREE.sites) siteSel.append(el('option', { value: s.key }, s.name));
  }
  const fwSel = $('#hFramework');
  if (fwSel && fwSel.options.length <= 1) {
    const seen = new Set();
    const members = TREE.suites.flatMap((s) => s.frameworks || (s.framework ? [s] : []));
    for (const m of members) {
      const id = m.id || m.framework;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      fwSel.append(el('option', { value: id }, `${m.label} (${m.language})`));
    }
  }
}

function applyHistoryFilter() {
  const q = $('#hSearch').value.trim().toLowerCase();
  const status = $('#hStatus').value;
  const site = $('#hSite').value;
  const framework = $('#hFramework') ? $('#hFramework').value : '';
  const filtered = HISTORY.filter((r) => {
    if (status && r.status !== status) return false;
    if (site && !(r.targets || []).some((t) => t.site === site)) return false;
    if (framework && !(r.targets || []).some((t) => t.framework === framework)) return false;
    if (q) {
      const hay = (r.label + ' ' + (r.targets || [])
        .map((t) => `${t.site} ${t.siteName || ''} ${t.suiteName || ''} ${t.frameworkLabel || ''}`)
        .join(' ')).toLowerCase();
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
if ($('#hFramework')) $('#hFramework').addEventListener('change', applyHistoryFilter);

async function loadHistorySilently() {
  if (!$('#tab-history').classList.contains('active')) return;
  loadHistory();
}

function renderHistory(runs) {
  const box = $('#historyList');
  if (!runs.length) { box.innerHTML = '<div class="empty">No runs yet.</div>'; return; }
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'When'), el('th', {}, 'Run'), el('th', {}, 'Frameworks'), el('th', {}, 'Status'),
      el('th', {}, 'Results'), el('th', {}, 'Fail rate'), el('th', {}, 'Duration'), el('th', {}, '')
    ))
  );
  const tbody = el('tbody');
  for (const r of runs) {
    const seen = new Set();
    const chips = (r.targets || [])
      .filter((t) => t.framework && !seen.has(t.framework) && seen.add(t.framework))
      .map((t) => el('span', { class: `fw-chip fw-${t.framework}` }, t.frameworkLabel || t.framework));
    const tr = el('tr', { class: 'clickable', onclick: () => openDetail(r.id) },
      el('td', {}, fmtTime(r.startedAt || r.createdAt)),
      el('td', {}, r.label),
      el('td', { class: 'fw-cell' }, chips.length ? chips : '—'),
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
        targetFrameworkBadge(t),
        el('span', { class: 'name' }, t.suiteName || t.name),
        el('span', { class: 'spacer' }),
        t.authStatus === 'failed' ? el('span', { class: 'st st-error' }, 'auth failed') : null,
        runStatusBadge(t)
      ),
      el('div', { class: 'card-site' },
        el('span', { class: 'card-site-label' }, 'on'),
        el('span', { class: 'card-site-name' }, t.siteName || t.site),
        el('span', { class: 'card-site-url' }, t.url || '')),
      el('div', { class: 'counts' },
        el('span', { class: 'c-pass' }, `✓ ${totals.passed || 0}`),
        el('span', { class: 'c-fail' }, `✗ ${totals.failed || 0}`),
        el('span', { class: 'c-skip' }, `• ${totals.skipped || 0}`),
        el('span', { class: 'c-total' }, `${totals.completed || 0}/${totals.total || 0}`)
      ),
      targetReportLink(run.id, t)
    ));
  }
  box.append(grid);

  // Combined, filterable test list.
  const allTests = run.targets.flatMap((t) =>
    (t.tests || []).map((x) => ({
      ...x,
      targetKey: t.key || t.site,
      site: t.site,
      siteName: t.siteName || t.name,
      frameworkLabel: t.frameworkLabel,
      reportKind: t.reportKind,
    }))
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
      const tag = t.frameworkLabel ? `${t.frameworkLabel} → ${t.siteName}` : t.site;
      const row = el('div', { class: `test-row ${t.status}` },
        el('span', { class: 'ic' }, ic),
        el('span', { class: 'tname', title: t.title }, `[${tag}] ${shortTitle(t.title)}`),
        el('span', { class: 'dur' }, fmtDuration(t.durationMs))
      );
      if (t.status === 'failed') {
        row.classList.add('clickable-row');
        row.addEventListener('click', () => openErrorModal({
          title: shortTitle(t.title),
          status: t.status,
          durationMs: t.durationMs,
          site: tag,
          error: t.error,
          reportUrl: t.reportKind === 'artifacts'
            ? `/api/runs/${run.id}/artifacts/${t.targetKey}`
            : `/api/runs/${run.id}/report/${t.targetKey}/index.html`,
          reportLabel: t.reportKind === 'artifacts'
            ? '↗ Artifacts (screenshots, reports)'
            : '↗ Open Playwright report (trace & screenshots)',
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
    const what = s.targets
      .map((t) => {
        const suite = TREE && suiteOf(t.suite);
        const site = TREE && TREE.sites.find((x) => x.key === t.site);
        return `${suite ? suite.label : t.suite || '?'} → ${site ? site.name : t.site}`;
      })
      .join(', ');
    const grep = s.targets[0] && s.targets[0].grep ? ` · grep: ${s.targets[0].grep}` : '';
    box.append(el('div', { class: 'sched-card' },
      el('div', {},
        el('div', { class: 'sname' }, s.name),
        el('div', { class: 'meta' }, `cron: ${s.cron} · ${what}${grep}`)
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

  // One row per selectable scope: tick it, then choose which site it runs on —
  // the same (suite, site) pairing the Run tab uses.
  const siteChecks = el('div', { class: 'sched-targets' });
  for (const suite of TREE.suites) {
    if (!suite.ok) continue;
    for (const scope of suite.scopes) {
      const cb = el('input', { type: 'checkbox' });
      const select = el('select', { class: 'site-select' });
      for (const site of suite.sites) {
        select.append(el('option', { value: site.key }, site.name));
      }
      select.value = scope.defaultSite || (suite.sites[0] && suite.sites[0].key) || '';
      const row = el('label', { class: 'sched-target' },
        cb,
        frameworkBadge(suite),
        el('span', { class: 'sched-target-name' },
          suite.scopes.length > 1 ? `${suite.name} · ${scope.name}` : suite.name),
        el('span', { class: 'spacer' }),
        el('span', { class: 'site-pick-label' }, 'on'),
        select);
      row.dataset.suite = suite.key;
      row.dataset.scope = scope.key;
      siteChecks.append(row);
    }
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
    el('div', {}, el('label', {}, 'What to run'), siteChecks),
    el('div', {}, el('label', {}, 'Keyword filter (applies to all targets)'), grep),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: save }, 'Create schedule'),
      el('button', { class: 'ghost', onclick: () => box.classList.add('hidden') }, 'Cancel'))
  );
  updateForm();

  async function save() {
    const rows = $$('.sched-target', siteChecks).filter((r) => r.querySelector('input').checked);
    if (!name.value.trim()) return alert('Name is required.');
    if (!rows.length) return alert('Pick at least one suite to run.');
    const g = grep.value.trim() || undefined;
    const targets = rows.map((r) => ({
      suite: r.dataset.suite,
      scope: r.dataset.scope || undefined,
      site: r.querySelector('select').value,
      grep: g,
    }));
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
  if (!TREE) await loadTree(); // need the suite list for the pickers below
  renderPrbSuites();
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
  if ($('#prbSuite')) {
    $('#prbSuite').addEventListener('change', () => { renderPrbAreas(); updatePrbTestScope(); });
  }
}

/* ---- Run tests on the PR-built site ---- */

/** The suite the PR Builder will run against the built site. */
function prbSuite() {
  const sel = $('#prbSuite');
  return (TREE && suiteOf(sel && sel.value)) || (TREE && TREE.suites[0]) || null;
}

function renderPrbSuites() {
  const sel = $('#prbSuite');
  if (!sel || !TREE) return;
  const previous = sel.value;
  sel.innerHTML = '';
  for (const s of TREE.suites) {
    if (!s.ok) continue;
    sel.append(el('option', { value: s.key }, `${s.name} — ${s.label} (${s.language})`));
  }
  if (previous) sel.value = previous;
}

/**
 * A suite's named scopes, when it has any. A suite that isn't split has nothing
 * to pick, so the "specific areas" option is hidden for it.
 */
function renderPrbAreas() {
  const box = $('#prbAreas');
  if (!box || !TREE) return;
  const suite = prbSuite();
  box.innerHTML = '';
  const scopes = (suite && suite.scopes) || [];
  const splittable = scopes.length > 1;
  const areaRadio = $$('input[name="prbTestScope"]').find((r) => r.value === 'areas');
  if (areaRadio) areaRadio.closest('label').classList.toggle('hidden', !splittable);
  if (!splittable) return;
  for (const s of scopes) {
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
  const suite = prbSuite();
  const body = { grep, project: project ? project.key : undefined, suite: suite ? suite.key : undefined };
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

/* ---------------------------------- users ---------------------------------- */
// Admin-only tab. Reuses the schedules tab's list/form markup so it reads as
// part of the app rather than a bolted-on admin panel.

const PERM_LABELS = {
  'tests.run': 'Run tests',
  'schedules.manage': 'Schedules',
  'sites.manage': 'Manage sites',
  'prbuilder.use': 'PR Builder',
  'users.manage': 'Manage users',
};

const USERS = { list: [], roles: [], permissions: [], roleDefaults: {} };

async function loadUsers() {
  try {
    const data = await api('/api/users');
    Object.assign(USERS, {
      list: data.users || [],
      roles: data.roles || [],
      permissions: data.permissions || [],
      roleDefaults: data.roleDefaults || {},
    });
    renderUsers();
  } catch (e) {
    $('#userList').textContent = 'Could not load users: ' + e.message;
  }
}

function userError(msg) {
  const box = $('#userError');
  box.textContent = msg || '';
  box.classList.toggle('hidden', !msg);
}

/** True while this account is the last thing standing between us and lockout. */
function isLastAdmin(u) {
  return u.role === 'admin' && USERS.list.filter((x) => x.role === 'admin').length === 1;
}

function renderUsers() {
  const box = $('#userList');
  box.innerHTML = '';
  if (!USERS.list.length) return void (box.textContent = 'No users yet.');

  for (const u of USERS.list) {
    const last = isLastAdmin(u);
    const isMe = ME && u.username === ME.username;

    const role = el('select', {
      class: 'user-role',
      onchange: () => saveUser(u.username, { role: role.value }),
    }, ...USERS.roles.map((r) => el('option', { value: r }, r)));
    role.value = u.role;
    if (last) {
      role.disabled = true;
      role.title = 'The only admin — promote someone else before changing this.';
    }

    // A tick writes an explicit override; matching the role default again
    // clears it, so "follows the role" stays the resting state.
    const perms = el('div', { class: 'user-perms' }, ...USERS.permissions.map((p) => {
      const cb = el('input', {
        type: 'checkbox',
        onchange: () => {
          const overrides = { ...(u.overrides || {}) };
          const roleDefault = !!(USERS.roleDefaults[u.role] || {})[p];
          if (cb.checked === roleDefault) delete overrides[p];
          else overrides[p] = cb.checked;
          saveUser(u.username, { permissions: overrides });
        },
      });
      cb.checked = !!u.permissions[p];
      if (u.role === 'admin') {
        cb.disabled = true;
        cb.title = 'Admins hold every permission.';
      }
      const overridden = u.overrides && Object.prototype.hasOwnProperty.call(u.overrides, p);
      return el('label', {
        class: 'user-perm' + (overridden ? ' overridden' : ''),
        title: overridden ? 'Set explicitly for this user' : 'Follows the role default',
      }, cb, PERM_LABELS[p] || p);
    }));

    const actions = el('div', { class: 'user-actions' },
      el('button', { class: 'ghost sm', onclick: () => resetPassword(u) }, 'Reset password'),
      el('button', {
        class: 'danger sm',
        disabled: last || isMe ? '' : null,
        title: last
          ? 'The only admin cannot be deleted.'
          : isMe ? 'You cannot delete your own account.' : 'Delete this user',
        onclick: () => deleteUser(u),
      }, 'Delete'));

    box.append(el('div', { class: 'user-row' },
      el('div', { class: 'user-id' },
        el('span', { class: 'user-name' }, u.username),
        isMe ? el('span', { class: 'user-you' }, 'you') : null,
        u.mustChangePassword ? el('span', { class: 'user-warn' }, 'password not changed yet') : null),
      role,
      perms,
      actions));
  }
}

async function saveUser(username, patch) {
  userError('');
  try {
    await api(`/api/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch (e) {
    userError(e.message);
  }
  loadUsers(); // re-read either way: on failure this undoes the optimistic UI
}

async function resetPassword(u) {
  const pw = prompt(`New password for "${u.username}":`);
  if (!pw) return;
  await saveUser(u.username, { password: pw });
}

async function deleteUser(u) {
  if (!confirm(`Delete "${u.username}"? They are signed out immediately.`)) return;
  userError('');
  try {
    await api(`/api/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' });
  } catch (e) {
    userError(e.message);
  }
  loadUsers();
}

function showUserForm() {
  const box = $('#userForm');
  box.classList.remove('hidden');
  box.innerHTML = '';
  userError('');

  const name = el('input', { type: 'text', placeholder: 'e.g. jane' });
  const pass = el('input', { type: 'text', placeholder: 'at least 5 characters' });
  const role = el('select', {}, ...USERS.roles.map((r) => el('option', { value: r }, r)));
  role.value = 'tester';

  const hint = el('p', { class: 'muted-note' });
  function updateHint() {
    const granted = USERS.permissions.filter((p) => (USERS.roleDefaults[role.value] || {})[p]);
    hint.textContent = role.value === 'admin'
      ? 'Admins can do everything, including managing users.'
      : granted.length
        ? 'Grants: ' + granted.map((p) => PERM_LABELS[p] || p).join(', ') + '. Fine-tune after creating.'
        : 'View-only: sees the tree, live runs, history and reports, but changes nothing.';
  }
  role.addEventListener('change', updateHint);

  box.append(
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Username'), name),
      el('div', {}, el('label', {}, 'Password'), pass),
      el('div', {}, el('label', {}, 'Role'), role)),
    hint,
    el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: save }, 'Create user'),
      el('button', { class: 'ghost', onclick: () => box.classList.add('hidden') }, 'Cancel'))
  );
  updateHint();
  name.focus();

  async function save() {
    userError('');
    try {
      await api('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: name.value.trim(),
          password: pass.value,
          role: role.value,
        }),
      });
      box.classList.add('hidden');
      loadUsers();
    } catch (e) {
      userError(e.message);
    }
  }
}

$('#btnNewUser').addEventListener('click', showUserForm);

/* --------------------------------- account --------------------------------- */

function renderUserChip() {
  const chip = $('#userChip');
  chip.innerHTML = '';
  chip.append(
    el('span', { class: 'user-chip-name', title: `Signed in as ${ME.username}` }, ME.username),
    el('span', { class: 'user-chip-role' }, ME.role),
    el('button', { class: 'ghost sm', onclick: changeMyPassword }, 'Password'),
    el('button', { class: 'ghost sm', onclick: logout }, 'Log out'));
}

async function changeMyPassword() {
  const currentPassword = prompt('Your current password:');
  if (!currentPassword) return;
  const newPassword = prompt('New password (at least 5 characters):');
  if (!newPassword) return;
  try {
    await api('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    ME.mustChangePassword = false;
    alert('Password changed. Your other devices have been signed out.');
  } catch (e) {
    alert(e.message);
  }
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  location.replace('/login.html');
}

/**
 * Hide the controls this account may not use. This is cosmetic — the server
 * checks every mutating route independently — but a viewer shouldn't be shown
 * buttons that only ever return 403.
 */
function applyPermissions() {
  const tab = (name) => $(`.tab[data-tab="${name}"]`);
  const toggle = (node, shown) => node && node.classList.toggle('hidden', !shown);

  toggle($('#btnRun'), can('tests.run'));
  toggle(tab('schedules'), can('schedules.manage'));
  toggle($('#btnNewSchedule'), can('schedules.manage'));
  toggle(tab('prbuilder'), can('prbuilder.use'));
  toggle(tab('sites'), can('sites.manage'));
  toggle($('#btnNewSite'), can('sites.manage'));
  toggle(tab('users'), can('users.manage'));

  // Landing on a tab you can no longer see (a bookmark, a demotion) is
  // disorienting; fall back to Run, which everyone can at least look at.
  const active = $('.tab.active');
  if (!active || active.classList.contains('hidden')) showTab('run');
}

/* --------------------------------- startup --------------------------------- */

async function init() {
  // Who are we? Everything else — which tabs exist, which buttons render —
  // hangs off the answer, so this comes before the first data fetch.
  try {
    const { user } = await api('/api/auth/me');
    if (!user) return void location.replace('/login.html');
    ME = user;
  } catch (_) {
    return void location.replace('/login.html');
  }
  renderUserChip();
  applyPermissions();
  if (ME.mustChangePassword) {
    alert(`You are signed in with the default password for "${ME.username}". Please change it now — use the Password button in the top bar.`);
  }

  try {
    const env = await api('/api/env');
    const bad = env.suites.filter((s) => !s.ok);
    const info = $('#envInfo');
    info.innerHTML = '';
    info.title = env.suites.map((s) => `${s.name} (${s.label || s.framework}) — ${s.dir}`).join('\n');
    if (bad.length) {
      info.append(el('span', { class: 'env-bad', title: bad.map((s) => `${s.key}: ${s.reason}`).join('\n') },
        `⚠ ${bad.length} suite${bad.length === 1 ? '' : 's'} unavailable`));
    }
    info.append(el('span', {},
      `${env.suites.length - bad.length} suite${env.suites.length - bad.length === 1 ? '' : 's'} · ` +
      `${env.sites.length} site${env.sites.length === 1 ? '' : 's'}`));
  } catch (_) {}
  await loadTree();
  checkSites(); // initial reachability sweep
  refreshActiveList();
  setInterval(refreshActiveList, 5000);
}

init();
