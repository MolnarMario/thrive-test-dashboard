'use strict';

/**
 * Framework registry.
 *
 * The dashboard is framework-agnostic: everything that differs between
 * Playwright, Cypress and Selenium lives behind this interface, and the rest of
 * the server only ever talks about "a suite" and "a target site".
 *
 * To add a framework, drop a module here that implements:
 *
 *   id, label, language, runner, specLabel, specRe   — identity, shown in the UI
 *   supportsGrep, emitsPlan, reportKind              — capabilities
 *   detect(suiteDir)          → { ok, configFile, testsRoot, reason? }
 *   checkTooling(suiteDir)    → { ok, message, detail? }
 *   discover(suiteDir,layout) → Promise<{ files: [{ file, tests[] }], exact }>
 *   buildRun(ctx)             → { command, args, cwd, env, ...extras }
 *   buildAuth(ctx)            → same shape, or null when no auth step is needed
 *   startProgress?(ctx,write) → { stop() }, for frameworks whose results must be
 *                               scraped rather than reported (see selenium.js)
 *   onOutput?(text,ctx,write) → turn child stdout into events
 *
 * `write(event)` appends one NDJSON event, in the same shape the Playwright
 * reporter emits, so the orchestrator consumes a single stream format.
 */

const playwright = require('./playwright');
const cypress = require('./cypress');
const selenium = require('./selenium');

const FRAMEWORKS = { playwright, cypress, selenium };

/** Ordered list, for UI menus and config validation messages. */
const IDS = Object.keys(FRAMEWORKS);

function get(id) {
  const fw = FRAMEWORKS[String(id || '').toLowerCase()];
  if (!fw) {
    throw new Error(`Unknown test framework "${id}". Known: ${IDS.join(', ')}.`);
  }
  return fw;
}

function has(id) {
  return Object.prototype.hasOwnProperty.call(FRAMEWORKS, String(id || '').toLowerCase());
}

/**
 * Guess which framework a directory holds, for config that omits `framework`.
 * Order matters only in that each detect() is specific enough not to overlap.
 */
function detectFramework(suiteDir) {
  for (const id of IDS) {
    if (FRAMEWORKS[id].detect(suiteDir).ok) return id;
  }
  return null;
}

/**
 * Every framework whose layout is found in `suiteDir`, not just the first —
 * a suite directory can legitimately hold Playwright, Cypress and Selenium
 * side by side (each adapter's detect() keys off its own config file, so
 * there's no ambiguity in finding more than one). Config.js uses this to
 * decide whether a suite is single-framework or a composite of several.
 */
function detectAll(suiteDir) {
  const found = [];
  for (const id of IDS) {
    const layout = FRAMEWORKS[id].detect(suiteDir);
    if (layout.ok) found.push({ id, layout });
  }
  return found;
}

/** Public description of a framework, for /api/tree and /api/env. */
function describe(id) {
  const fw = get(id);
  return {
    id: fw.id,
    label: fw.label,
    language: fw.language,
    runner: fw.runner,
    specLabel: fw.specLabel,
    supportsGrep: fw.supportsGrep,
    grepNote: fw.grepNote || null,
    reportKind: fw.reportKind,
    progressGranularity: fw.progressGranularity || 'test',
  };
}

/**
 * The tests a selection covers, for the up-front `plan` event.
 *
 * Only needed for frameworks whose reporters can't produce a plan themselves
 * (Cypress builds a reporter per spec; Surefire reports a class at a time) —
 * without it the Live view could only reveal tests as they finish.
 *
 * @param {object} suite  resolved suite from config.SUITES
 * @param {string[]} paths  tree filters, relative to the suite's tests root
 * @param {string} [grep]
 */
async function collectPlan(suite, paths, grep) {
  const adapter = get(suite.framework);
  const { files } = await adapter.discover(suite.dir, suite.layout);

  const wanted = (paths || [])
    .map((p) => String(p || '').replace(/\\/g, '/'))
    .filter(Boolean);
  const chosen = !wanted.length
    ? files
    : files.filter((f) =>
        wanted.some((w) => (w.endsWith('/') ? f.file.startsWith(w) : f.file === w))
      );

  let tests = chosen.flatMap((f) =>
    f.tests.map((t) => ({
      id: t.id,
      title: t.title,
      file: f.file,
      line: t.line || 0,
      method: t.method,
    }))
  );

  // Mirror how the adapter narrows its own selection, so plan rows and results
  // stay one-to-one.
  if (grep && adapter.supportsGrep) {
    const needle = grep.toLowerCase();
    tests = tests.filter(
      (t) =>
        t.title.toLowerCase().includes(needle) ||
        String(t.method || '').toLowerCase().includes(needle)
    );
  }
  return tests.map(({ method, ...rest }) => rest);
}

module.exports = { FRAMEWORKS, IDS, get, has, detectFramework, detectAll, describe, collectPlan };
