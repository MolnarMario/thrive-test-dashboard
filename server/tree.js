'use strict';

/**
 * Builds the selectable test tree from the suite on disk.
 *
 * For each configured site we walk its testDirs under .playwright/tests and
 * produce a nested folder/file tree. Every node carries a `filter` string
 * (e.g. "tests/site-a/Pages/") that can be passed directly to
 * Playwright as a positional argument — Playwright matches it as a substring
 * of the full spec path, which is exactly how run-parallel.sh targets dirs.
 */

const fs = require('fs');
const path = require('path');
const { SUITE_DIR, TESTS_ROOT_REL, SITES, testFilter } = require('../config');
const testcount = require('./testcount');

const TESTS_ROOT = path.join(SUITE_DIR, TESTS_ROOT_REL);
const SPEC_RE = /\.spec\.[tj]s$/;

let cache = null;
let inflight = null;

/**
 * Recursively build a node for a directory. Returns null if it contains no
 * specs. Each node carries both specCount (files) and testCount (actual tests
 * that will run, from Playwright's collection — see testcount.js).
 */
function buildDirNode(absDir, filterPrefix, counts) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (_) {
    return null;
  }

  const children = [];
  let specCount = 0;
  let testCount = 0;

  // Sort: directories first, then files, alphabetically.
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name < b.name ? -1 : 1;
  });

  for (const e of entries) {
    if (e.name === 'helpers' || e.name === 'node_modules') continue;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      const child = buildDirNode(abs, filterPrefix + e.name + '/', counts);
      if (child) {
        children.push(child);
        specCount += child.specCount;
        testCount += child.testCount;
      }
    } else if (SPEC_RE.test(e.name)) {
      const filter = filterPrefix + e.name;
      const t = counts[filter] || 0;
      children.push({ type: 'file', name: e.name, filter, specCount: 1, testCount: t });
      specCount += 1;
      testCount += t;
    }
  }

  if (specCount === 0) return null;

  return {
    type: 'dir',
    name: path.basename(absDir),
    filter: filterPrefix,
    specCount,
    testCount,
    children,
  };
}

async function build({ refresh = false } = {}) {
  const { counts, total, ok } = await testcount.getCounts({ refresh });

  const sites = [];
  let grandSpecs = 0;
  let grandTests = 0;

  for (const [key, cfg] of Object.entries(SITES)) {
    const dirNodes = [];
    let siteSpecCount = 0;
    let siteTestCount = 0;

    for (const dir of cfg.testDirs) {
      const abs = path.join(TESTS_ROOT, dir);
      const node = buildDirNode(abs, testFilter(dir), counts);
      if (node) {
        dirNodes.push(node);
        siteSpecCount += node.specCount;
        siteTestCount += node.testCount;
      }
    }

    sites.push({
      key,
      name: cfg.name,
      url: cfg.url,
      testDirs: cfg.testDirs,
      siteFilters: cfg.testDirs.map((d) => testFilter(d)),
      specCount: siteSpecCount,
      testCount: siteTestCount,
      children: dirNodes,
    });
    grandSpecs += siteSpecCount;
    grandTests += siteTestCount;
  }

  return {
    sites,
    totalSpecs: grandSpecs,
    totalTests: grandTests,
    // false if `--list` failed → UI falls back to showing spec counts only.
    testCountsOk: ok && total > 0,
    testsRoot: TESTS_ROOT,
  };
}

async function getTree({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  if (inflight && !refresh) return inflight; // share one build across concurrent cold calls
  inflight = build({ refresh })
    .then((built) => { cache = built; inflight = null; return built; })
    .catch((err) => { inflight = null; throw err; });
  return inflight;
}

module.exports = { getTree };
