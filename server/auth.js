'use strict';

/**
 * Access control for the dashboard.
 *
 * Everything auth-related lives here, the way scheduler.js owns scheduling:
 * the user file, the session store, password hashing, and the Express
 * middlewares the routes hang off.
 *
 * Sessions are cookie-based rather than token-based on purpose. Three parts of
 * this app authenticate implicitly and cannot attach an Authorization header:
 * the SSE streams (EventSource), the Playwright HTML reports served as static
 * directories, and the combined-report/artifacts pages opened as plain links.
 * An httpOnly cookie covers all of them without touching that code.
 *
 * No new dependencies: scrypt and randomBytes come from node:crypto, and the
 * cookie header is five lines to parse.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DATA_DIR } = require('../config');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const COOKIE = 'atp_sid';
const SESSION_MS = 12 * 60 * 60 * 1000; // 12h, refreshed on use
const SECURE_COOKIES = process.env.SECURE_COOKIES === '1';

const SEED_USER = 'admin';
const SEED_PASS = 'admin!';
const MIN_PASSWORD = 5;

/* ------------------------------ permissions ------------------------------- */

const PERMISSIONS = [
  'tests.run',
  'schedules.manage',
  'sites.manage',
  'prbuilder.use',
  'users.manage',
];

const ROLES = ['admin', 'tester', 'viewer'];

/**
 * What each role can do out of the box. A user's own `permissions` object
 * overrides individual entries, so an admin can hand out one extra capability
 * without promoting anyone.
 */
const ROLE_DEFAULTS = {
  admin: {
    'tests.run': true,
    'schedules.manage': true,
    'sites.manage': true,
    'prbuilder.use': true,
    'users.manage': true,
  },
  tester: {
    'tests.run': true,
    'schedules.manage': true,
    'sites.manage': false,
    'prbuilder.use': true,
    'users.manage': false,
  },
  viewer: {},
};

/**
 * Effective permissions = role defaults with the user's overrides on top.
 * Admins are hard-wired to everything so nobody can lock the last admin out of
 * user management by unticking a box.
 */
function effectivePermissions(user) {
  if (!user) return {};
  const out = {};
  for (const p of PERMISSIONS) {
    if (user.role === 'admin') {
      out[p] = true;
      continue;
    }
    const override = user.permissions ? user.permissions[p] : undefined;
    out[p] = typeof override === 'boolean'
      ? override
      : !!ROLE_DEFAULTS[user.role || 'viewer'][p];
  }
  return out;
}

function can(user, permission) {
  return !!effectivePermissions(user)[permission];
}

/** The shape the browser is allowed to see - never the hash or the salt. */
function publicUser(user) {
  return {
    username: user.username,
    role: user.role,
    permissions: effectivePermissions(user),
    overrides: user.role === 'admin' ? {} : { ...(user.permissions || {}) },
    mustChangePassword: !!user.mustChangePassword,
    createdAt: user.createdAt,
    createdBy: user.createdBy || null,
  };
}

/* -------------------------------- storage --------------------------------- */
// Same idiom as store.js / scheduler.js: a JSON file under the gitignored
// data/ dir, written via tmp + rename so a crash can't leave a half file.

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function loadUsers() {
  const list = readJson(USERS_FILE, []);
  return Array.isArray(list) ? list : [];
}

function saveUsers(list) {
  writeJson(USERS_FILE, list);
}

function normaliseUsername(name) {
  return String(name || '').trim().toLowerCase();
}

function findUser(username) {
  const key = normaliseUsername(username);
  return loadUsers().find((u) => u.username === key) || null;
}

/* ------------------------------- passwords -------------------------------- */

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { passwordSalt: salt, passwordHash: hash };
}

function verifyPassword(user, password) {
  if (!user || !user.passwordHash || !user.passwordSalt) return false;
  const { passwordHash } = hashPassword(password, user.passwordSalt);
  const a = Buffer.from(passwordHash, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* -------------------------------- sessions -------------------------------- */
// Kept in memory for request handling; mirrored to disk only so a restart
// (npm run dev restarts on every save) doesn't sign everyone out.

const sessions = new Map(); // sid -> { username, expiresAt }

function loadSessions() {
  const raw = readJson(SESSIONS_FILE, {});
  const now = Date.now();
  for (const [sid, s] of Object.entries(raw || {})) {
    if (s && s.username && s.expiresAt > now) sessions.set(sid, s);
  }
}

function persistSessions() {
  writeJson(SESSIONS_FILE, Object.fromEntries(sessions));
}

function createSession(username) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { username, expiresAt: Date.now() + SESSION_MS });
  persistSessions();
  return sid;
}

function destroySession(sid) {
  if (sid && sessions.delete(sid)) persistSessions();
}

/** Drop every session belonging to a user - used on delete and password change. */
function destroyUserSessions(username, keepSid) {
  let changed = false;
  for (const [sid, s] of sessions) {
    if (s.username === username && sid !== keepSid) {
      sessions.delete(sid);
      changed = true;
    }
  }
  if (changed) persistSessions();
}

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [sid, s] of sessions) {
    if (s.expiresAt <= now) {
      sessions.delete(sid);
      changed = true;
    }
  }
  if (changed) persistSessions();
}

/* --------------------------------- cookies -------------------------------- */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, sid) {
  const bits = [
    `${COOKIE}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (SECURE_COOKIES) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* ------------------------------- middlewares ------------------------------ */

/**
 * Hydrate req.user from the session cookie. Never rejects - the gate below
 * decides what to do about an anonymous request.
 */
function attachUser(req, _res, next) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  const session = sid ? sessions.get(sid) : null;
  if (session) {
    if (session.expiresAt <= Date.now()) {
      destroySession(sid);
    } else {
      const user = findUser(session.username);
      if (user) {
        req.user = user;
        req.sessionId = sid;
        // Sliding expiry: an active tab shouldn't be signed out mid-run.
        session.expiresAt = Date.now() + SESSION_MS;
      } else {
        destroySession(sid); // the user was deleted while signed in
      }
    }
  }
  next();
}

/** Paths served before a session exists. Everything else is behind the gate. */
function isPublicPath(pathname) {
  return (
    pathname === '/login.html' ||
    pathname === '/login' ||
    pathname === '/style.css' ||
    pathname.startsWith('/favicon')
  );
}

/**
 * The wall. API calls get a 401 they can act on; page navigations get a
 * redirect, so a bookmarked report link lands on the login form rather than a
 * bare error.
 */
function gate(req, res, next) {
  if (req.user || isPublicPath(req.path)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  const back = encodeURIComponent(req.originalUrl || '/');
  res.redirect(302, `/login.html?next=${back}`);
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

/** Route guard: `app.post('/api/runs', requirePermission('tests.run'), ...)`. */
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    const missing = permissions.find((p) => !can(req.user, p));
    if (missing) {
      return res.status(403).json({ error: `Your account lacks the "${missing}" permission.` });
    }
    next();
  };
}

/* --------------------------------- login ---------------------------------- */
// A crude per-username throttle. Enough to make guessing pointless without
// pulling in a rate-limiter dependency.

const attempts = new Map(); // username -> { fails, until }
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

function lockRemaining(username) {
  const a = attempts.get(username);
  if (!a || !a.until || a.until <= Date.now()) return 0;
  return a.until - Date.now();
}

function noteFailure(username) {
  const a = attempts.get(username) || { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) {
    a.until = Date.now() + LOCK_MS;
    a.fails = 0;
  }
  attempts.set(username, a);
}

/**
 * @returns {{ok: true, user: object, sid: string}|{ok: false, status: number, error: string}}
 */
function login(username, password) {
  const key = normaliseUsername(username);
  if (!key || !password) {
    return { ok: false, status: 400, error: 'Username and password are required.' };
  }

  const wait = lockRemaining(key);
  if (wait > 0) {
    return {
      ok: false,
      status: 429,
      error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60000)} minute(s).`,
    };
  }

  const user = findUser(key);
  if (!user || !verifyPassword(user, password)) {
    noteFailure(key);
    return { ok: false, status: 401, error: 'Wrong username or password.' };
  }

  attempts.delete(key);
  return { ok: true, user, sid: createSession(user.username) };
}

function assertPasswordOk(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
}

function changePassword(user, currentPassword, newPassword, keepSid) {
  if (!verifyPassword(user, currentPassword)) {
    throw new Error('Your current password is not correct.');
  }
  assertPasswordOk(newPassword);
  const list = loadUsers();
  const rec = list.find((u) => u.username === user.username);
  Object.assign(rec, hashPassword(newPassword), { mustChangePassword: false });
  saveUsers(list);
  // Other devices signed in as this account are no longer trusted.
  destroyUserSessions(user.username, keepSid);
  return publicUser(rec);
}

/* --------------------------------- users ---------------------------------- */

function listUsers() {
  return loadUsers()
    .map(publicUser)
    .sort((a, b) => a.username.localeCompare(b.username));
}

function adminCount(list) {
  return list.filter((u) => u.role === 'admin').length;
}

/** Only known permissions, only real booleans - absent means "follow the role". */
function sanitiseOverrides(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (PERMISSIONS.includes(k) && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function createUser({ username, password, role, permissions }, actor) {
  const key = normaliseUsername(username);
  if (!/^[a-z0-9._-]{2,32}$/.test(key)) {
    throw new Error('Username must be 2-32 characters: letters, digits, dot, dash or underscore.');
  }
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
  assertPasswordOk(password);

  const list = loadUsers();
  if (list.some((u) => u.username === key)) throw new Error(`User "${key}" already exists.`);

  const user = {
    username: key,
    role,
    permissions: role === 'admin' ? {} : sanitiseOverrides(permissions),
    ...hashPassword(password),
    createdAt: new Date().toISOString(),
    createdBy: actor ? actor.username : null,
    mustChangePassword: false,
  };
  list.push(user);
  saveUsers(list);
  return publicUser(user);
}

function updateUser(username, patch, actor) {
  const key = normaliseUsername(username);
  const list = loadUsers();
  const user = list.find((u) => u.username === key);
  if (!user) throw new Error(`No such user: ${key}`);

  if (patch.role !== undefined && patch.role !== user.role) {
    if (!ROLES.includes(patch.role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
    if (user.role === 'admin' && adminCount(list) === 1) {
      throw new Error('This is the only admin - promote someone else first.');
    }
    user.role = patch.role;
    if (patch.role === 'admin') user.permissions = {}; // admins get everything anyway
  }

  if (patch.permissions !== undefined && user.role !== 'admin') {
    user.permissions = sanitiseOverrides(patch.permissions);
  }

  if (patch.password !== undefined) {
    assertPasswordOk(patch.password);
    Object.assign(user, hashPassword(patch.password), { mustChangePassword: true });
    destroyUserSessions(key); // an admin reset boots the old sessions
  }

  saveUsers(list);
  return publicUser(user);
}

function deleteUser(username, actor) {
  const key = normaliseUsername(username);
  if (actor && actor.username === key) throw new Error('You cannot delete your own account.');

  const list = loadUsers();
  const user = list.find((u) => u.username === key);
  if (!user) throw new Error(`No such user: ${key}`);
  if (user.role === 'admin' && adminCount(list) === 1) {
    throw new Error('This is the only admin - promote someone else first.');
  }

  saveUsers(list.filter((u) => u.username !== key));
  destroyUserSessions(key);
  return { deleted: true };
}

/* ------------------------------- bootstrap -------------------------------- */

/**
 * First boot has no users, and a dashboard nobody can sign into is useless.
 * Seed a known admin and shout about it in the banner so it gets changed.
 *
 * @returns {{seeded: boolean, username: string, password: string|null}|null}
 */
function ensureSeedAdmin() {
  const list = loadUsers();
  if (list.some((u) => u.role === 'admin')) return null;

  const existing = list.find((u) => u.username === SEED_USER);
  if (existing) {
    // Someone demoted the only admin by editing users.json by hand.
    existing.role = 'admin';
    existing.permissions = {};
    saveUsers(list);
    return { seeded: false, username: SEED_USER, password: null };
  }

  list.push({
    username: SEED_USER,
    role: 'admin',
    permissions: {},
    ...hashPassword(SEED_PASS),
    createdAt: new Date().toISOString(),
    createdBy: null,
    mustChangePassword: true,
  });
  saveUsers(list);
  return { seeded: true, username: SEED_USER, password: SEED_PASS };
}

function init() {
  loadSessions();
  pruneSessions();
  setInterval(pruneSessions, 60 * 60 * 1000).unref();
  return ensureSeedAdmin();
}

module.exports = {
  PERMISSIONS,
  ROLES,
  ROLE_DEFAULTS,
  init,
  ensureSeedAdmin,
  attachUser,
  gate,
  requireAuth,
  requirePermission,
  can,
  effectivePermissions,
  publicUser,
  login,
  logout: destroySession,
  changePassword,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  setSessionCookie,
  clearSessionCookie,
};
