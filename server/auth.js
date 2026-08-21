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
 * The threat model is deliberately not "someone's laptop": this can be hosted
 * on a public domain, and it holds admin credentials for every site it tests.
 * So passwords are slow-hashed with per-record parameters, session ids are
 * stored only as digests, and login is throttled by account *and* by client.
 *
 * No new dependencies: scrypt, timingSafeEqual and randomBytes come from
 * node:crypto, and the cookie header is five lines to parse.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const { DATA_DIR } = require('../config');

const scrypt = promisify(crypto.scrypt);

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const COOKIE = 'atp_sid';

/** Idle timeout: a session unused for this long is dead. Refreshed on use. */
const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_HOURS || 12) * 60 * 60 * 1000;

/**
 * Absolute cap, regardless of activity. Sliding expiry alone means a stolen
 * cookie that is kept warm never expires; this is the backstop that ends it.
 */
const SESSION_MAX_MS = Number(process.env.SESSION_MAX_DAYS || 7) * 24 * 60 * 60 * 1000;

/**
 * Force the Secure flag even when the request looks like plain HTTP. Normally
 * unnecessary — the flag is set automatically for HTTPS requests (see
 * cookieBits) — but useful behind a proxy that terminates TLS without
 * forwarding X-Forwarded-Proto.
 */
const FORCE_SECURE_COOKIES = process.env.SECURE_COOKIES === '1';

const SEED_USER = process.env.SEED_ADMIN_USERNAME || 'admin';

/* ------------------------------- passwords -------------------------------- */

/**
 * scrypt cost. 32 MiB and ~0.2s per hash on ordinary hardware: slow enough to
 * make an offline attack on a stolen users.json expensive, fast enough that a
 * login doesn't feel broken. Stored *per record* so these can be raised later
 * without invalidating anyone's password — verify uses whatever the record was
 * written with, and a successful login silently re-hashes to the current cost.
 */
const SCRYPT = { N: 32768, r: 8, p: 2, keylen: 64, maxmem: 96 * 1024 * 1024 };

/**
 * Minimum password length. 12 by default because this can face the internet;
 * lowerable for a throwaway local install, but not below 8 — at that point the
 * setting is doing more harm than the convenience is worth.
 */
const MIN_PASSWORD = Math.max(8, Number(process.env.MIN_PASSWORD_LENGTH || 12));

/**
 * The handful of passwords that get tried first, always. Not a substitute for
 * a real breach corpus — it's the floor, so that "the admin password is
 * `password123`" can't happen by accident.
 */
const BANNED_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789',
  '1234567890', 'qwertyuiop', 'letmein123', 'welcome123', 'admin123', 'administrator',
  'changeme', 'changeme123', 'dashboard', 'testing123', 'automation', 'iloveyou',
  'football', 'baseball', 'superman', 'trustno1', 'monkey123', 'starwars',
]);

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
 * Sites hold every tested site's credentials, and users control who can sign
 * in at all — both are the keys to the whole install, not a capability like
 * "can run tests" that's fine to delegate a la carte. So unlike the other
 * permissions, these two are never read from a user's `permissions` overrides:
 * an admin can still flip a checkbox in the Users tab, but it's silently
 * dropped (see sanitiseOverrides) rather than taking effect. Only a role
 * change to 'admin' grants them.
 */
const ADMIN_ONLY_PERMISSIONS = ['sites.manage', 'users.manage'];

/**
 * What each role can do out of the box. A user's own `permissions` object
 * overrides individual entries — except ADMIN_ONLY_PERMISSIONS, which always
 * follow the role — so an admin can hand out one extra delegable capability
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
 * user management by unticking a box. ADMIN_ONLY_PERMISSIONS are likewise
 * hard-wired to *off* for everyone else: they cannot be delegated by override,
 * only by promotion.
 */
function effectivePermissions(user) {
  if (!user) return {};
  const out = {};
  for (const p of PERMISSIONS) {
    if (user.role === 'admin') {
      out[p] = true;
      continue;
    }
    if (ADMIN_ONLY_PERMISSIONS.includes(p)) {
      out[p] = false;
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
    lastLoginAt: user.lastLoginAt || null,
  };
}

/* -------------------------------- storage --------------------------------- */
// Same idiom as store.js / scheduler.js: a JSON file under the gitignored
// data/ dir, written via tmp + rename so a crash can't leave a half file.
// Mode 0600 throughout — these two files are the crown jewels.

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
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) { /* Windows: the data/ ACL is what protects it */ }
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

/* ------------------------------- hashing ---------------------------------- */

function scryptParams(user) {
  const p = (user && user.passwordParams) || {};
  return {
    // Records written before parameters were stored used Node's defaults.
    N: p.N || 16384,
    r: p.r || 8,
    p: p.p || 1,
    keylen: p.keylen || 64,
    maxmem: Math.max(p.maxmem || 0, 96 * 1024 * 1024),
  };
}

async function hashPassword(password, salt, params = SCRYPT) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const { keylen, ...cost } = params;
  const hash = await scrypt(String(password), useSalt, keylen, cost);
  return {
    passwordSalt: useSalt,
    passwordHash: hash.toString('hex'),
    passwordParams: { ...params },
  };
}

async function verifyPassword(user, password) {
  if (!user || !user.passwordHash || !user.passwordSalt) return false;
  const params = scryptParams(user);
  const { passwordHash } = await hashPassword(password, user.passwordSalt, params);
  const a = Buffer.from(passwordHash, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Burn the same work a real verification would, so "no such user" and "wrong
 * password" take the same wall-clock time. Without this, the response latency
 * of a failed login tells an attacker which usernames exist.
 */
const DUMMY_USER = {
  passwordSalt: crypto.randomBytes(16).toString('hex'),
  passwordHash: crypto.randomBytes(SCRYPT.keylen).toString('hex'),
  passwordParams: SCRYPT,
};

async function burnVerification(password) {
  try {
    await verifyPassword(DUMMY_USER, password);
  } catch (_) { /* the result is deliberately discarded */ }
}

/** True when a record was written with weaker parameters than we now use. */
function needsRehash(user) {
  const p = scryptParams(user);
  return p.N < SCRYPT.N || p.r < SCRYPT.r || p.p < SCRYPT.p || p.keylen < SCRYPT.keylen;
}

/* -------------------------------- sessions -------------------------------- */
// Kept in memory for request handling; mirrored to disk only so a restart
// (npm run dev restarts on every save) doesn't sign everyone out.
//
// The map is keyed by a SHA-256 of the session id, never the id itself. The
// cookie is a bearer token: anyone who can read the stored value can become
// that user, so what we store must not be usable as one. Digesting is enough
// here — the id is 32 random bytes, so there is nothing to brute-force.

const sessions = new Map(); // sha256(sid) -> { username, expiresAt, absoluteExpiresAt }

function sidDigest(sid) {
  return crypto.createHash('sha256').update(String(sid)).digest('hex');
}

function loadSessions() {
  const raw = readJson(SESSIONS_FILE, {});
  const now = Date.now();
  for (const [key, s] of Object.entries(raw || {})) {
    // Records from before session ids were digested are dropped rather than
    // migrated: they were stored in a form we now consider unsafe, and the
    // cost of honouring them is that everyone signs in once.
    if (!/^[0-9a-f]{64}$/.test(key)) continue;
    if (s && s.username && s.expiresAt > now && (s.absoluteExpiresAt || Infinity) > now) {
      sessions.set(key, s);
    }
  }
}

function persistSessions() {
  writeJson(SESSIONS_FILE, Object.fromEntries(sessions));
}

function createSession(username) {
  const sid = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(sidDigest(sid), {
    username,
    createdAt: now,
    expiresAt: now + SESSION_IDLE_MS,
    absoluteExpiresAt: now + SESSION_MAX_MS,
  });
  persistSessions();
  return sid;
}

function destroySession(sid) {
  if (sid && sessions.delete(sidDigest(sid))) persistSessions();
}

/** Drop every session belonging to a user - used on delete and password change. */
function destroyUserSessions(username, keepSid) {
  const keep = keepSid ? sidDigest(keepSid) : null;
  let changed = false;
  for (const [key, s] of sessions) {
    if (s.username === username && key !== keep) {
      sessions.delete(key);
      changed = true;
    }
  }
  if (changed) persistSessions();
}

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [key, s] of sessions) {
    if (s.expiresAt <= now || (s.absoluteExpiresAt || Infinity) <= now) {
      sessions.delete(key);
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

/**
 * Secure is set whenever the request arrived over TLS — which, behind a proxy,
 * requires `trust proxy` to be configured (see config.TRUST_PROXY). Getting
 * that wrong is the difference between a cookie that never travels in clear
 * and one that always does, so it is derived from the request rather than
 * left to a flag someone has to remember.
 */
function cookieBits(req, extra) {
  const secure = FORCE_SECURE_COOKIES || !!(req && req.secure);
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    ...extra,
  ];
}

function setSessionCookie(req, res, sid) {
  res.setHeader('Set-Cookie', [
    `${COOKIE}=${sid}`,
    ...cookieBits(req, [`Max-Age=${Math.floor(SESSION_IDLE_MS / 1000)}`]),
  ].join('; '));
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', [`${COOKIE}=`, ...cookieBits(req, ['Max-Age=0'])].join('; '));
}

/* ------------------------------- middlewares ------------------------------ */

/**
 * Hydrate req.user from the session cookie. Never rejects - the gate below
 * decides what to do about an anonymous request.
 */
function attachUser(req, _res, next) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  const key = sid ? sidDigest(sid) : null;
  const session = key ? sessions.get(key) : null;
  if (session) {
    const now = Date.now();
    if (session.expiresAt <= now || (session.absoluteExpiresAt || Infinity) <= now) {
      destroySession(sid);
    } else {
      const user = findUser(session.username);
      if (user) {
        req.user = user;
        req.sessionId = sid;
        // Sliding expiry, bounded by the absolute cap: an active tab shouldn't
        // be signed out mid-run, but it can't renew itself forever either.
        session.expiresAt = Math.min(now + SESSION_IDLE_MS, session.absoluteExpiresAt || Infinity);
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
    pathname === '/login.js' ||
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

/**
 * An account flagged `mustChangePassword` — the seeded admin, or anyone whose
 * password an admin has just reset — can do exactly one thing: change it.
 * Until then it is signed in but inert.
 *
 * Without this the flag was advisory: the UI nagged, and an account left on a
 * password somebody else chose stayed fully usable indefinitely.
 */
function requirePasswordChange(req, res, next) {
  if (!req.user || !req.user.mustChangePassword) return next();
  const allowed =
    req.path === '/api/auth/password' ||
    req.path === '/api/auth/me' ||
    req.path === '/api/auth/logout' ||
    !req.path.startsWith('/api/');
  if (allowed) return next();
  res.status(403).json({
    error: 'Change your password before using the dashboard.',
    mustChangePassword: true,
  });
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

/**
 * CSRF defence, second layer.
 *
 * The session cookie is SameSite=Lax, so a browser won't attach it to a
 * cross-site POST — that is the first layer and it covers modern browsers. But
 * Lax is a browser-side promise, and this app can be hosted; a stale browser,
 * or a request shaped to look like a navigation, shouldn't be enough. So every
 * state-changing request must also *say* where it came from, and say us.
 *
 * A request with neither Origin nor Referer is rejected rather than trusted:
 * browsers always send at least one on a cross-origin write, so absence means
 * either a non-browser client (which can set the header) or something odd.
 */
function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const origin = req.headers.origin || req.headers.referer;
  const host = req.headers.host;
  if (origin && host) {
    try {
      if (new URL(origin).host === host) return next();
    } catch (_) { /* malformed — fall through to the rejection */ }
  }
  res.status(403).json({
    error: 'Cross-site request blocked. Reload the dashboard and try again.',
  });
}

/* --------------------------------- login ---------------------------------- */
/**
 * Throttling, on two keys at once.
 *
 * By username, so one account can't be ground down by guesses. By client
 * address, so an attacker can't sidestep that by spreading attempts across
 * accounts — which the username-only version let them do freely. Both maps are
 * pruned and hard-capped: they are keyed by attacker-supplied input, so an
 * unbounded Map is a slow memory leak with a trigger.
 */
const MAX_FAILS_PER_USER = 8;
const MAX_FAILS_PER_IP = 20;
const LOCK_MS = 15 * 60 * 1000;
const MAX_LOCK_MS = 4 * 60 * 60 * 1000;
const MAX_TRACKED = 5000;

const userAttempts = new Map(); // username -> { fails, until, locks }
const ipAttempts = new Map(); // client ip -> { fails, until, locks }

function pruneAttempts(map) {
  const now = Date.now();
  for (const [key, a] of map) {
    if ((!a.until || a.until <= now) && a.seenAt + LOCK_MS <= now) map.delete(key);
  }
  // Still oversized (a flood in one window): drop the oldest entries.
  if (map.size > MAX_TRACKED) {
    const oldest = [...map.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
    for (const [key] of oldest.slice(0, map.size - MAX_TRACKED)) map.delete(key);
  }
}

function lockRemaining(map, key) {
  const a = map.get(key);
  if (!a || !a.until || a.until <= Date.now()) return 0;
  return a.until - Date.now();
}

/**
 * Each lock lasts longer than the last (15m, 30m, 60m … capped at 4h) and the
 * failure count is *not* reset when a lock is applied — resetting it handed an
 * attacker a fresh full budget every time a lock expired.
 */
function noteFailure(map, key, max) {
  const a = map.get(key) || { fails: 0, until: 0, locks: 0, seenAt: 0 };
  a.fails += 1;
  a.seenAt = Date.now();
  if (a.fails >= max) {
    a.locks += 1;
    a.until = Date.now() + Math.min(LOCK_MS * 2 ** (a.locks - 1), MAX_LOCK_MS);
    a.fails = Math.floor(max / 2); // a little headroom, not a clean slate
  }
  map.set(key, a);
  pruneAttempts(map);
}

function minutes(ms) {
  return Math.max(1, Math.ceil(ms / 60000));
}

/**
 * @returns {Promise<{ok: true, user: object, sid: string}|{ok: false, status: number, error: string}>}
 */
async function login(username, password, clientIp = 'unknown') {
  const key = normaliseUsername(username);
  if (!key || !password) {
    return { ok: false, status: 400, error: 'Username and password are required.' };
  }

  const wait = Math.max(lockRemaining(userAttempts, key), lockRemaining(ipAttempts, clientIp));
  if (wait > 0) {
    return {
      ok: false,
      status: 429,
      error: `Too many failed attempts. Try again in ${minutes(wait)} minute(s).`,
    };
  }

  const user = findUser(key);
  let ok = false;
  if (user) ok = await verifyPassword(user, password);
  else await burnVerification(password);

  if (!ok) {
    noteFailure(userAttempts, key, MAX_FAILS_PER_USER);
    noteFailure(ipAttempts, clientIp, MAX_FAILS_PER_IP);
    return { ok: false, status: 401, error: 'Wrong username or password.' };
  }

  userAttempts.delete(key);
  ipAttempts.delete(clientIp);

  // Opportunistic upgrade: the password is in hand and already verified, so a
  // record written under weaker parameters can be brought up to current cost
  // without anyone being asked to do anything.
  const list = loadUsers();
  const rec = list.find((u) => u.username === user.username);
  if (rec) {
    if (needsRehash(rec)) Object.assign(rec, await hashPassword(password));
    rec.lastLoginAt = new Date().toISOString();
    saveUsers(list);
  }

  return { ok: true, user: rec || user, sid: createSession(user.username) };
}

/* ----------------------------- password policy ---------------------------- */

/** What the UI should tell people before they type. Kept next to the rules. */
const passwordPolicy = {
  minLength: MIN_PASSWORD,
  description:
    `At least ${MIN_PASSWORD} characters. Not your username, and not an obvious ` +
    'one — a passphrase of a few unrelated words is the easiest way to clear this.',
};

function assertPasswordOk(password, username) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (password.length > 200) {
    throw new Error('Password must be at most 200 characters.');
  }
  const lower = password.toLowerCase();
  if (BANNED_PASSWORDS.has(lower)) {
    throw new Error('That password is one of the first an attacker tries. Pick another.');
  }
  if (username && lower.includes(normaliseUsername(username)) && normaliseUsername(username).length > 2) {
    throw new Error('Password must not contain your username.');
  }
  if (/^(.)\1+$/.test(password)) {
    throw new Error('Password must not be a single repeated character.');
  }
}

async function changePassword(user, currentPassword, newPassword, keepSid) {
  if (!(await verifyPassword(user, currentPassword))) {
    throw new Error('Your current password is not correct.');
  }
  assertPasswordOk(newPassword, user.username);
  if (await verifyPassword(user, newPassword)) {
    throw new Error('The new password must be different from the current one.');
  }
  const hashed = await hashPassword(newPassword);
  const list = loadUsers();
  const rec = list.find((u) => u.username === user.username);
  if (!rec) throw new Error('Your account no longer exists.');
  Object.assign(rec, hashed, {
    mustChangePassword: false,
    passwordChangedAt: new Date().toISOString(),
  });
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

/**
 * Only known permissions, only real booleans, and never one of
 * ADMIN_ONLY_PERMISSIONS - absent means "follow the role". Applied whether the
 * request came from the Users tab or a hand-crafted API call, so there's no
 * path that writes 'sites.manage' or 'users.manage' onto a non-admin record.
 */
function sanitiseOverrides(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (PERMISSIONS.includes(k) && !ADMIN_ONLY_PERMISSIONS.includes(k) && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

async function createUser({ username, password, role, permissions }, actor) {
  const key = normaliseUsername(username);
  if (!/^[a-z0-9._-]{2,32}$/.test(key)) {
    throw new Error('Username must be 2-32 characters: letters, digits, dot, dash or underscore.');
  }
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
  assertPasswordOk(password, key);

  const list = loadUsers();
  if (list.some((u) => u.username === key)) throw new Error(`User "${key}" already exists.`);

  const user = {
    username: key,
    role,
    permissions: role === 'admin' ? {} : sanitiseOverrides(permissions),
    ...(await hashPassword(password)),
    createdAt: new Date().toISOString(),
    createdBy: actor ? actor.username : null,
    // Whoever created the account knows this password, so it isn't the
    // account holder's yet.
    mustChangePassword: true,
  };
  list.push(user);
  saveUsers(list);
  return publicUser(user);
}

async function updateUser(username, patch, actor) {
  const key = normaliseUsername(username);
  const list = loadUsers();
  const user = list.find((u) => u.username === key);
  if (!user) throw new Error(`No such user: ${key}`);

  if (patch.role !== undefined && patch.role !== user.role) {
    if (!ROLES.includes(patch.role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
    if (user.role === 'admin' && adminCount(list) === 1) {
      throw new Error('This is the only admin - promote someone else first.');
    }
    // No need to end their sessions: attachUser re-reads the user record on
    // every request, so a demotion takes effect on the demoted user's very
    // next click. Signing them out would only add churn.
    user.role = patch.role;
    if (patch.role === 'admin') user.permissions = {}; // admins get everything anyway
  }

  if (patch.permissions !== undefined && user.role !== 'admin') {
    user.permissions = sanitiseOverrides(patch.permissions);
  }

  if (patch.password !== undefined) {
    assertPasswordOk(patch.password, key);
    Object.assign(user, await hashPassword(patch.password), {
      mustChangePassword: true,
      passwordChangedAt: new Date().toISOString(),
    });
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
 * Generate the first admin's password rather than shipping one. A constant in
 * the source is a published password: every install starts with it, and the
 * ones that never get changed are found by anyone who has read this file.
 *
 * Character set excludes the glyphs that get misread off a terminal (0/O, 1/l).
 */
function generatePassword(length = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length; i++) {
    const b = bytes[i % bytes.length];
    // Reject the tail of the byte range so every character stays equally likely.
    if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length];
  }
  return out;
}

/**
 * First boot has no users, and a dashboard nobody can sign into is useless.
 * Seed an admin with a generated password, print it once, and flag the account
 * so it can do nothing else until that password is replaced.
 *
 * @returns {Promise<{seeded: boolean, username: string, password: string|null}|null>}
 */
async function ensureSeedAdmin() {
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

  // SEED_ADMIN_PASSWORD exists for unattended installs (a container that has
  // to come up with known credentials from a secret store). It still has to
  // clear the policy, and the account is still flagged for change.
  const password = process.env.SEED_ADMIN_PASSWORD || generatePassword();
  assertPasswordOk(password, SEED_USER);

  list.push({
    username: SEED_USER,
    role: 'admin',
    permissions: {},
    ...(await hashPassword(password)),
    createdAt: new Date().toISOString(),
    createdBy: null,
    mustChangePassword: true,
  });
  saveUsers(list);
  return {
    seeded: true,
    username: SEED_USER,
    password: process.env.SEED_ADMIN_PASSWORD ? null : password,
  };
}

async function init() {
  loadSessions();
  pruneSessions();
  setInterval(pruneSessions, 60 * 60 * 1000).unref();
  setInterval(() => {
    pruneAttempts(userAttempts);
    pruneAttempts(ipAttempts);
  }, 15 * 60 * 1000).unref();
  return ensureSeedAdmin();
}

module.exports = {
  PERMISSIONS,
  ADMIN_ONLY_PERMISSIONS,
  ROLES,
  ROLE_DEFAULTS,
  passwordPolicy,
  init,
  ensureSeedAdmin,
  attachUser,
  gate,
  requireAuth,
  requirePasswordChange,
  requirePermission,
  sameOriginOnly,
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
