'use strict';

/**
 * JSON-file-backed store for run history.
 *
 * Each run lives in data/runs/<runId>/run.json. The same directory also holds
 * per-site NDJSON event files, Playwright HTML reports, and test artifacts.
 *
 * This module is the single point of persistence — swapping to SQLite later
 * only touches this file.
 */

const fs = require('fs');
const path = require('path');
const { RUNS_DIR } = require('../config');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function runDir(runId) {
  return path.join(RUNS_DIR, runId);
}

function runJsonPath(runId) {
  return path.join(runDir(runId), 'run.json');
}

function saveRun(run) {
  const dir = runDir(run.id);
  ensureDir(dir);
  const tmp = runJsonPath(run.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2));
  fs.renameSync(tmp, runJsonPath(run.id)); // atomic-ish replace
}

function loadRun(runId) {
  try {
    return JSON.parse(fs.readFileSync(runJsonPath(runId), 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * List runs, newest first. Returns lightweight summaries (no per-test arrays).
 */
function listRuns({ limit = 200 } = {}) {
  ensureDir(RUNS_DIR);
  let ids;
  try {
    ids = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (_) {
    return [];
  }

  const runs = [];
  for (const id of ids) {
    const run = loadRun(id);
    if (!run) continue;
    runs.push(summarize(run));
  }
  // Run IDs are timestamp-prefixed, so lexical sort == chronological.
  runs.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return runs.slice(0, limit);
}

function summarize(run) {
  return {
    id: run.id,
    label: run.label,
    trigger: run.trigger,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    totals: run.totals,
    targets: (run.targets || []).map((t) => ({
      // `key` identifies one (suite, site) pair; older records predate it and
      // fall back to the site key they were written with.
      key: t.key || t.site,
      suite: t.suite || null,
      suiteName: t.suiteName || null,
      framework: t.framework || null,
      frameworkLabel: t.frameworkLabel || null,
      language: t.language || null,
      site: t.site,
      siteName: t.siteName || t.name,
      name: t.name,
      status: t.status,
      authStatus: t.authStatus,
      totals: t.totals,
    })),
  };
}

module.exports = {
  ensureDir,
  runDir,
  saveRun,
  loadRun,
  listRuns,
  summarize,
};
