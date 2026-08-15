'use strict';

/**
 * Builds the selectable test tree, one branch per configured suite.
 *
 * Each suite is asked (via its framework adapter) to enumerate its specs and the
 * tests inside them; the flat list is then folded into a folder/file tree. Every
 * node carries a `filter` — a path relative to that suite's tests root — which
 * is what a run target sends back as its `paths`, and which each adapter turns
 * into whatever its CLI actually wants (a Playwright positional filter, a
 * Cypress `--spec` glob, a Surefire `-Dtest=` class list).
 *
 * A suite may also declare `scopes`: named slices of itself that are selected
 * and targeted independently, each with its own site. A suite without scopes has
 * exactly one implicit scope covering everything.
 */

const path = require('path');

const { SUITES, SITES } = require('../config');
const frameworks = require('./frameworks');

let cache = null;
let inflight = null;

/**
 * Fold `[{ file: 'a/b.cy.ts', tests: [...] }]` into a nested tree, keeping only
 * the part of the listing under `prefix` (a scope's directory, '' for all).
 *
 * For a composite suite (see buildCompositeSuite), entries also carry a
 * `framework` id. `frameworkFilter`, when given, keeps only that framework's
 * entries — buildCompositeSuite calls this once per member framework against
 * the suite's combined file list. Each node's `filter` — the string a run
 * request sends back to pick it — gets that framework id prefixed
 * (`"playwright::tests/login.spec.ts"`) so the orchestrator can tell which
 * adapter a selected path belongs to; `name` stays the plain file/dir name,
 * so nothing about how the tree *looks* changes. Every node whose spec files
 * all belong to one framework also gets a plain `framework` field, which is
 * what lets the UI show a badge on it once expanded — down to a single spec
 * file if that's as far as you go. Suites with only one framework never set
 * `entry.framework`, so `filter`/`name` are identical to before and no node
 * gets a `framework` field — this is a no-op for every suite that isn't a
 * combination of frameworks.
 */
function buildNodes(files, prefix, frameworkFilter) {
  const root = { children: new Map(), specCount: 0, testCount: 0 };

  for (const entry of files) {
    if (frameworkFilter && entry.framework !== frameworkFilter) continue;
    const rel = entry.file.replace(/\\/g, '/');
    if (prefix && !rel.startsWith(prefix)) continue;

    const wireBase = entry.framework ? `${entry.framework}::` : '';
    const parts = rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      const name = parts[i];
      const realFilter = parts.slice(0, i + 1).join('/') + (isFile ? '' : '/');
      const filter = wireBase + realFilter;
      if (!node.children.has(name)) {
        node.children.set(name, {
          type: isFile ? 'file' : 'dir',
          name,
          filter,
          specCount: 0,
          testCount: 0,
          children: new Map(),
          frameworks: new Set(),
        });
      }
      const child = node.children.get(name);
      child.specCount += isFile ? 1 : 0;
      child.testCount += entry.tests.length;
      if (entry.framework) child.frameworks.add(entry.framework);
      if (isFile) {
        child.specCount = 1;
        child.testCount = entry.tests.length;
        if (entry.framework) child.framework = entry.framework;
      }
      node = child;
    }
    root.specCount += 1;
    root.testCount += entry.tests.length;
  }

  const toArray = (node) =>
    [...node.children.values()]
      .sort((a, b) => {
        if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
        return a.name < b.name ? -1 : 1;
      })
      .map((child) => {
        // A dir whose descendants are all one framework wears that framework
        // too — a file always knows its own.
        const framework = child.type === 'file'
          ? child.framework
          : (child.frameworks.size === 1 ? [...child.frameworks][0] : null);
        return {
          type: child.type,
          name: child.name,
          filter: child.filter,
          specCount: child.specCount,
          testCount: child.testCount,
          ...(framework ? { framework } : {}),
          ...(child.type === 'dir' ? { children: toArray(child) } : {}),
        };
      });

  // Collapse single-child directory chains ("cypress/e2e" style nesting adds a
  // level of clicking for nothing).
  const collapse = (nodes) =>
    nodes.map((n) => {
      if (n.type !== 'dir') return n;
      let node = { ...n, children: collapse(n.children) };
      while (node.children.length === 1 && node.children[0].type === 'dir') {
        const only = node.children[0];
        node = { ...only, name: `${node.name}/${only.name}` };
      }
      return node;
    });

  return {
    children: collapse(toArray(root)),
    specCount: root.specCount,
    testCount: root.testCount,
  };
}

function siteInfo(key) {
  const s = SITES[key];
  return s ? { key, name: s.name, url: s.url } : null;
}

async function buildSuite(suite) {
  const base = {
    key: suite.key,
    name: suite.name,
    framework: suite.framework,
    dir: suite.dir,
    sites: suite.sites.map(siteInfo).filter(Boolean),
    defaultSite: suite.defaultSite,
  };

  if (suite.frameworks) return buildCompositeSuite(suite, base);

  if (!suite.framework || !frameworks.has(suite.framework)) {
    return { ...base, ok: false, error: suite.reason, scopes: [], specCount: 0, testCount: 0 };
  }

  const meta = frameworks.describe(suite.framework);
  const adapter = frameworks.get(suite.framework);
  const tooling = adapter.checkTooling(suite.dir, suite.layout);

  if (!suite.ok) {
    return { ...base, ...meta, ok: false, error: suite.reason, tooling, scopes: [], specCount: 0, testCount: 0 };
  }

  let listing = { files: [], exact: false };
  let error = null;
  try {
    listing = await adapter.discover(suite.dir, suite.layout);
  } catch (err) {
    error = String((err && err.message) || err);
  }

  // No declared scopes → one implicit scope covering the whole suite.
  const scopeDefs = suite.scopes.length
    ? suite.scopes
    : [{ key: '', name: 'All tests', dirs: ['.'], defaultSite: null }];

  const scopes = scopeDefs.map((scope) => {
    const dirs = scope.dirs.length ? scope.dirs : ['.'];
    const merged = { children: [], specCount: 0, testCount: 0 };
    for (const dir of dirs) {
      const prefix = !dir || dir === '.' ? '' : dir.replace(/\\/g, '/').replace(/\/?$/, '/');
      const built = buildNodes(listing.files, prefix);
      merged.children.push(...built.children);
      merged.specCount += built.specCount;
      merged.testCount += built.testCount;
    }
    return {
      key: scope.key,
      name: scope.name,
      // What a run target sends when the whole scope is selected.
      filters: dirs.map((d) => (!d || d === '.' ? '' : d.replace(/\\/g, '/').replace(/\/?$/, '/'))),
      defaultSite:
        (scope.defaultSite && suite.sites.includes(scope.defaultSite) && scope.defaultSite) ||
        suite.defaultSite,
      specCount: merged.specCount,
      testCount: merged.testCount,
      children: merged.children,
    };
  });

  return {
    ...base,
    ...meta,
    ok: true,
    error,
    tooling,
    testsRoot: path.join(suite.dir, suite.layout.testsRoot),
    // Playwright collects its own tests, so its counts are exact; the others are
    // parsed from source and the UI says so.
    exactCounts: listing.exact,
    scopes,
    specCount: scopes.reduce((n, s) => n + s.specCount, 0),
    testCount: scopes.reduce((n, s) => n + s.testCount, 0),
  };
}

/**
 * A suite that holds more than one framework (see config.js's
 * normaliseCompositeSuite). Every member is discovered independently through
 * its own adapter, tagged with its framework id, then folded into one tree —
 * so the suite shows up as a single branch in the UI whose spec files each
 * carry which framework/language they are, all the way down to a leaf.
 */
async function buildCompositeSuite(suite, base) {
  const members = [];
  for (const fw of suite.frameworks) {
    if (!frameworks.has(fw.id) || !fw.layout.ok) {
      members.push({ id: fw.id, meta: null, layoutOk: false, tooling: null, error: fw.layout.reason, files: [], exact: true });
      continue;
    }
    const meta = frameworks.describe(fw.id);
    const adapter = frameworks.get(fw.id);
    const tooling = adapter.checkTooling(suite.dir, fw.layout);
    let files = [];
    let exact = true;
    let error = null;
    try {
      const listing = await adapter.discover(suite.dir, fw.layout);
      files = listing.files.map((f) => ({ ...f, framework: fw.id }));
      exact = listing.exact;
    } catch (err) {
      error = String((err && err.message) || err);
    }
    members.push({ id: fw.id, meta, layoutOk: true, tooling, error, files, exact });
  }

  const allFiles = members.flatMap((m) => m.files);
  // A member is browsable/selectable as soon as its config file is found —
  // exactly like a plain suite, which stays browsable even before `npm
  // install`. Whether it can actually *run* right now (tooling) is a
  // separate, non-gating concern surfaced per-member below.
  const browsableIds = new Set(members.filter((m) => m.layoutOk).map((m) => m.id));

  const scopeDefs = suite.scopes.length
    ? suite.scopes
    : [{ key: '', name: 'All tests', dirs: ['.'], defaultSite: null }];

  const scopes = scopeDefs.map((scope) => {
    const dirs = scope.dirs.length ? scope.dirs : ['.'];
    const merged = { children: [], specCount: 0, testCount: 0 };
    const filters = [];
    for (const dir of dirs) {
      const rel = !dir || dir === '.' ? '' : dir.replace(/\\/g, '/').replace(/\/?$/, '/');
      for (const m of members) {
        if (!browsableIds.has(m.id)) continue;
        filters.push(`${m.id}::${rel}`);
        const built = buildNodes(allFiles, rel, m.id);
        merged.children.push(...built.children);
        merged.specCount += built.specCount;
        merged.testCount += built.testCount;
      }
    }
    return {
      key: scope.key,
      name: scope.name,
      filters,
      defaultSite:
        (scope.defaultSite && suite.sites.includes(scope.defaultSite) && scope.defaultSite) ||
        suite.defaultSite,
      specCount: merged.specCount,
      testCount: merged.testCount,
      children: merged.children,
    };
  });

  return {
    ...base,
    framework: null,
    composite: true,
    frameworks: members.map((m) => {
      const ok = m.layoutOk && !m.error && (!m.tooling || m.tooling.ok);
      return {
        id: m.id,
        label: (m.meta && m.meta.label) || m.id,
        language: m.meta && m.meta.language,
        runner: m.meta && m.meta.runner,
        specLabel: m.meta && m.meta.specLabel,
        supportsGrep: m.meta ? m.meta.supportsGrep : false,
        grepNote: m.meta ? m.meta.grepNote : null,
        reportKind: m.meta && m.meta.reportKind,
        ok,
        error: ok ? null : (m.error || (m.tooling && m.tooling.message) || null),
      };
    }),
    ok: suite.ok,
    error: suite.ok ? null : suite.reason,
    tooling: null,
    testsRoot: null,
    exactCounts: members.every((m) => m.exact !== false),
    scopes,
    specCount: scopes.reduce((n, s) => n + s.specCount, 0),
    testCount: scopes.reduce((n, s) => n + s.testCount, 0),
  };
}

async function build() {
  const suites = await Promise.all(Object.values(SUITES).map(buildSuite));
  return {
    suites,
    sites: Object.values(SITES).map((s) => ({ key: s.key, name: s.name, url: s.url })),
    totalSpecs: suites.reduce((n, s) => n + (s.specCount || 0), 0),
    totalTests: suites.reduce((n, s) => n + (s.testCount || 0), 0),
    testCountsOk: suites.some((s) => s.testCount > 0),
  };
}

async function getTree({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  if (inflight && !refresh) return inflight; // share one build across concurrent cold calls
  inflight = build()
    .then((built) => { cache = built; inflight = null; return built; })
    .catch((err) => { inflight = null; throw err; });
  return inflight;
}

module.exports = { getTree, _buildNodes: buildNodes };
