'use strict';

/**
 * Lightweight site reachability check. LocalWP sites must be running (started
 * from the LocalWP GUI) before a run can succeed; this lets the UI warn first.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { SITES } = require('../config');

function pingUrl(siteUrl, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL('/wp-login.php', siteUrl);
    } catch (_) {
      return resolve({ up: false, status: 0, error: 'bad url' });
    }
    const mod = u.protocol === 'http:' ? http : https;
    const start = Date.now();
    const req = mod.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname,
        rejectUnauthorized: false, // LocalWP self-signed certs
        timeout: timeoutMs,
      },
      (res) => {
        // Any HTTP response means the server is up.
        res.resume();
        resolve({ up: res.statusCode < 500, status: res.statusCode, ms: Date.now() - start });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ up: false, status: 0, error: 'timeout', ms: Date.now() - start });
    });
    req.on('error', (err) => {
      resolve({ up: false, status: 0, error: err.code || String(err.message), ms: Date.now() - start });
    });
    req.end();
  });
}

/**
 * Check a list of site keys (default: all). Returns a map keyed by site key.
 */
async function checkSites(siteKeys) {
  const keys = (siteKeys && siteKeys.length ? siteKeys : Object.keys(SITES)).filter(
    (k) => SITES[k]
  );
  const results = await Promise.all(
    keys.map(async (key) => {
      const r = await pingUrl(SITES[key].url);
      return [key, { site: key, url: SITES[key].url, ...r }];
    })
  );
  return Object.fromEntries(results);
}

module.exports = { checkSites, pingUrl };
