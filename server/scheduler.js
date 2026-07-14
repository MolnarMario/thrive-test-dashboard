'use strict';

/**
 * Cron-based run scheduler (Phase 5).
 *
 * Schedules are persisted to data/schedules.json and registered with node-cron.
 * A schedule fires orchestrator.startRun() with its saved targets.
 *
 * NOTE: node-cron only fires while this server process is running. For truly
 * unattended runs, keep the dashboard running (e.g. a Windows Task Scheduler
 * entry that launches `npm start` at logon). See README.
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const { DATA_DIR } = require('../config');
const orchestrator = require('./orchestrator');

const FILE = path.join(DATA_DIR, 'schedules.json');
const tasks = new Map(); // schedule id -> node-cron task

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

function persist(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function makeId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `sch_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${Math.random().toString(36).slice(2, 7)}`
  );
}

function nextRunOf(id) {
  const task = tasks.get(id);
  if (!task) return null;
  try {
    const n = task.getNextRun();
    return n ? new Date(n).toISOString() : null;
  } catch (_) {
    return null;
  }
}

function withRuntime(s) {
  return { ...s, nextRun: s.enabled ? nextRunOf(s.id) : null };
}

function list() {
  return load().map(withRuntime);
}

function get(id) {
  const s = load().find((x) => x.id === id);
  return s ? withRuntime(s) : null;
}

function register(schedule) {
  unregister(schedule.id);
  if (!schedule.enabled) return;
  if (!cron.validate(schedule.cron)) return;
  const task = cron.schedule(schedule.cron, () => fire(schedule.id), {
    name: schedule.id,
  });
  tasks.set(schedule.id, task);
}

function unregister(id) {
  const t = tasks.get(id);
  if (t) {
    try { t.stop(); t.destroy(); } catch (_) {}
    tasks.delete(id);
  }
}

function validateInput(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid schedule.');
  if (!data.name || !String(data.name).trim()) throw new Error('Name is required.');
  if (!data.cron || !cron.validate(data.cron)) {
    throw new Error(`Invalid cron expression: "${data.cron}"`);
  }
  if (!Array.isArray(data.targets) || data.targets.length === 0) {
    throw new Error('At least one target site is required.');
  }
}

function create(data) {
  validateInput(data);
  const list = load();
  const schedule = {
    id: makeId(),
    name: String(data.name).trim(),
    cron: data.cron,
    targets: data.targets,
    enabled: data.enabled !== false,
    createdAt: new Date().toISOString(),
    lastFiredAt: null,
    lastRunId: null,
    lastResult: null,
  };
  list.push(schedule);
  persist(list);
  register(schedule);
  return withRuntime(schedule);
}

function update(id, data) {
  const list = load();
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error('Schedule not found.');
  const merged = { ...list[idx], ...data, id };
  validateInput(merged);
  list[idx] = merged;
  persist(list);
  register(merged);
  return withRuntime(merged);
}

function setEnabled(id, enabled) {
  return update(id, { enabled: !!enabled });
}

function remove(id) {
  const list = load().filter((x) => x.id !== id);
  persist(list);
  unregister(id);
  return true;
}

function recordResult(id, patch) {
  const list = load();
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return;
  list[idx] = { ...list[idx], ...patch };
  persist(list);
}

function fire(id) {
  const schedule = load().find((x) => x.id === id);
  if (!schedule) return { ok: false, error: 'not found' };
  const label = `⏰ ${schedule.name}`;
  try {
    const { id: runId } = orchestrator.startRun(schedule.targets, label);
    recordResult(id, {
      lastFiredAt: new Date().toISOString(),
      lastRunId: runId,
      lastResult: 'started',
    });
    return { ok: true, runId };
  } catch (err) {
    // Most commonly: a target site already has a run in progress.
    recordResult(id, {
      lastFiredAt: new Date().toISOString(),
      lastResult: 'skipped: ' + String(err.message || err),
    });
    return { ok: false, error: String(err.message || err) };
  }
}

function init() {
  for (const s of load()) {
    try { register(s); } catch (_) {}
  }
}

module.exports = {
  init,
  list,
  get,
  create,
  update,
  setEnabled,
  remove,
  fire,
};
