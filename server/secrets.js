'use strict';

/**
 * Encryption at rest for the one class of secret this app cannot hash: the
 * credentials it has to replay to a site under test.
 *
 * Dashboard *user* passwords are hashed (see auth.js) and never recoverable.
 * Site admin passwords are different — a suite has to log into WordPress with
 * the real string, so it must be recoverable, which means "don't store it in
 * the clear" is the best available answer rather than "don't store it".
 *
 * AES-256-GCM, key from one of two places:
 *
 *   DASHBOARD_SECRET_KEY  — 32 bytes as hex or base64. Use this when hosting:
 *                           the key then lives in the process environment / a
 *                           secret manager, not next to the ciphertext.
 *   data/secret.key       — generated on first boot, chmod 0600. The sensible
 *                           default for a local install.
 *
 * Ciphertext is self-describing (`enc:v1:iv:tag:data`), so decrypt() can tell
 * an encrypted value from a legacy plaintext one and existing installs migrate
 * on their next write without a migration script.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;

let cachedKey = null;
let warnedAboutKeyFile = false;

function parseEnvKey(raw) {
  const value = String(raw).trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      'DASHBOARD_SECRET_KEY must be 32 bytes, as 64 hex characters or base64. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return buf;
}

/**
 * Create the key file as close to "owner only" as the platform allows.
 * mode 0600 is honoured on POSIX; on Windows the flag is a no-op, so the file
 * inherits the data/ ACL — see hardenPath() below, which the caller uses to
 * lock down the whole directory.
 */
function readOrCreateKeyFile(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const buf = Buffer.from(raw, 'hex');
    if (buf.length === KEY_BYTES) return buf;
    throw new Error(`${file} does not contain a 32-byte hex key.`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) {
    /* Windows: no-op, the directory ACL is what protects it. */
  }
  if (!warnedAboutKeyFile) {
    warnedAboutKeyFile = true;
    // eslint-disable-next-line no-console
    console.warn(
      `  Generated a site-credential encryption key at ${file}.\n` +
        '  Back it up with your data/ directory — losing it means re-entering every site password.\n' +
        '  When hosting, prefer setting DASHBOARD_SECRET_KEY instead so the key is not stored beside the data.\n'
    );
  }
  return key;
}

function getKey(dataDir) {
  if (cachedKey) return cachedKey;
  cachedKey = process.env.DASHBOARD_SECRET_KEY
    ? parseEnvKey(process.env.DASHBOARD_SECRET_KEY)
    : readOrCreateKeyFile(dataDir);
  return cachedKey;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** @returns {string} `enc:v1:<iv>:<tag>:<ciphertext>`, all base64. */
function encrypt(plaintext, dataDir) {
  const text = String(plaintext == null ? '' : plaintext);
  if (!text) return '';
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(dataDir), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join(':');
}

/**
 * Decrypt a value produced by encrypt(). A value that isn't in that format is
 * returned untouched — that is how installs that predate encryption keep
 * working until their next write re-encrypts them.
 *
 * A value that *is* in that format but won't decrypt (wrong key, tampered
 * file) throws: silently handing back a broken password would send the suite
 * off to fail a login for reasons nobody could diagnose.
 */
function decrypt(value, dataDir) {
  if (!isEncrypted(value)) return value == null ? '' : String(value);
  const [iv, tag, data] = value.slice(PREFIX.length).split(':');
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getKey(dataDir),
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (_) {
    throw new Error(
      'Could not decrypt a stored site password. The encryption key has ' +
        'changed or the file was edited by hand — re-enter the password from the Sites tab.'
    );
  }
}

/**
 * Best-effort "only this account can read it" on the data directory, where
 * every secret this app writes ends up: the key, the encrypted site passwords,
 * the user hashes and the session file.
 *
 * POSIX gets chmod 0700. Windows gets an icacls ACL reset, which drops the
 * inherited Administrators/SYSTEM entries — the right posture for a directory
 * full of credentials, but a real change to the machine, so:
 *
 *   - it runs once, marked by data/.hardened, and never fights an ACL someone
 *     has since set deliberately;
 *   - SKIP_DATA_DIR_HARDENING=1 turns it off entirely;
 *   - failure is never fatal, because a locked-down corporate machine may
 *     refuse and the dashboard is still perfectly usable.
 *
 * To undo it: `icacls data /reset /t` (Windows) or `chmod 755 data` (POSIX).
 */
function hardenDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  if (process.env.SKIP_DATA_DIR_HARDENING === '1') return;

  const marker = path.join(dataDir, '.hardened');
  if (fs.existsSync(marker)) return;

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dataDir, 0o700);
      fs.writeFileSync(marker, new Date().toISOString());
    } catch (_) { /* best effort */ }
    return;
  }

  const user = process.env.USERNAME
    ? `${process.env.USERDOMAIN || process.env.COMPUTERNAME}\\${process.env.USERNAME}`
    : null;
  if (!user) return;
  try {
    const { execFileSync } = require('child_process');
    execFileSync('icacls', [dataDir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
      stdio: 'ignore',
      windowsHide: true,
    });
    fs.writeFileSync(marker, new Date().toISOString());
    // eslint-disable-next-line no-console
    console.log(
      `  Restricted ${dataDir} to ${user} (it holds credentials).\n` +
        '  Undo with: icacls data /reset /t — or set SKIP_DATA_DIR_HARDENING=1 to skip it.\n'
    );
  } catch (_) { /* best effort */ }
}

module.exports = { encrypt, decrypt, isEncrypted, hardenDataDir };
