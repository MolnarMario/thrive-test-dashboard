# Changelog — Automation Test Platform

All notable changes to the dashboard (the local web UI that runs Playwright
suites across configured sites).

## 2026-08-20 — Security hardening

An audit of how the dashboard stores user accounts and site passwords, ahead of
open-sourcing it. Everything below is fixed; the through-line is that the app now
assumes it may be hosted on a public domain rather than sitting on one laptop.

### Privilege escalation: environment injection into spawned processes

`POST /api/runs` passed the request body straight through to `spawn()`, so any
account with `tests.run` could set `NODE_OPTIONS=--require …` (or
`CYPRESS_RUN_BINARY`, `PATH`, `LD_PRELOAD`) and execute arbitrary code as the
dashboard's user. Saved schedules were the same hole with a timer on it.
Requested environment is now allowlisted to the `E2E_ / WP_ / TEST_ /
DASHBOARD_` namespaces, and validated when a schedule is saved rather than at
3am when it fires. A run may also no longer carry its own `baseUrl`: only the
PR Builder, which builds its target server-side, can target an unregistered site.

### Site passwords are encrypted at rest

`data/custom-sites.json` held `"adminPass": "admin"` in the clear. It is now
AES-256-GCM, keyed from `DASHBOARD_SECRET_KEY` or a generated `data/secret.key`
(0600), and existing files are migrated on first boot. `data/` itself is locked
to the running account. Adding a site now *requires* a password — the old
silent default meant a site with none would send admin/admin at whatever host
its URL pointed to.

### Bound to loopback by default

`app.listen(PORT)` bound every interface while the banner said `localhost`, over
plain HTTP with non-Secure cookies. Now `127.0.0.1` unless `HOST` says otherwise,
with `TRUST_PROXY` to make `req.secure` and `req.ip` meaningful behind a proxy
and a boot warning when the bind is not loopback.

### Path traversal in run and target ids

Express percent-decodes route parameters after matching, so `..%2f..%2f` reached
`path.join()` in the report, artifact and run-record routes. Both ids are now
validated before they touch the filesystem.

### Accounts

- The seeded admin gets a **generated** password, printed once, instead of the
  published constant `admin!`.
- `mustChangePassword` is enforced rather than advisory: the account is signed in
  but inert until it sets its own password. New accounts and admin resets set it.
- Password floor raised to 12 characters, with checks against the username and a
  short list of the obvious ones.
- scrypt cost raised to 32 MiB with the parameters stored per record, so it can be
  raised again later; a successful sign-in re-hashes older records transparently.
- Unknown usernames now cost the same work as wrong passwords — the previous
  early return leaked which accounts exist through response timing.
- Throttling is per account **and** per client address, escalating, and no longer
  hands back a clean slate when a lock expires. The maps are bounded.
- Session ids are stored as SHA-256 digests, with an absolute 7-day cap on top of
  the sliding idle timeout.

### Browser-side

- Strict CSP (no external origins), `nosniff`, `X-Frame-Options: DENY`, HSTS over
  TLS. The login page's inline script moved to `login.js` so `script-src` can be
  `'self'`. Playwright reports get a narrowly relaxed policy so they still run.
- Same-origin check on every state-changing request, behind `SameSite=Lax`.
- Artifacts that a browser would execute (`.html`, `.svg`, `.xml`) are served as
  downloads — they are test output from sites you may not control.
- Passwords are typed into a real masked dialog instead of `window.prompt()`,
  which paints them onto the screen.

## 2026-07-08 — Run pacing, per-site control, and a combined report

Three problems surfaced running the full 11-product suite from the dashboard, plus
a reporting gap. This release addresses all four.

### 1. Staggered launch (fixes out-of-memory crashes)

**Why:** the orchestrator launched every authenticated site's Playwright process
**simultaneously** (`Promise.all(runnable.map(runTests))`). Eleven concurrent
WordPress stacks plus a swarm of headless Chromium instances exhausted machine
memory, so the OS refused new allocations and several sites died mid-startup
with PHP `Fatal error: Out of memory` / nginx `502 Bad Gateway` (observed on
several sites). Which sites lost was down to luck under contention, so the
failures looked random.

**What changed** (`config.js`, `server/orchestrator.js`):
- Sites now launch **one at a time with a delay between starts** —
  `SITE_START_STAGGER_MS` (default **45000 ms**). Each site clears its
  memory-heavy startup (browser launch + auth + first page load) before the next
  begins, so peak memory stays bounded.
- Optional hard cap `MAX_CONCURRENT_SITES` (default `0` = off) as a complementary
  safeguard; a freed slot lets the next queued site launch.
- New `launchWithStagger()` + `cancellableDelay()` replace the simultaneous
  `Promise.all`; a whole-run cancel no longer has to wait out the stagger.

### 2. Priority start order (largest suites first)

**Why:** the biggest, longest suites should start earliest — they need the most
runway and the freest memory. Previously sites ran in selection/tree order.

**What changed** (`config.js`, `server/orchestrator.js`):
- `SITE_START_PRIORITY` (default `apprentice, architect, ttb, quiz`) is applied to
  **both** the auth phase and the launch phase via `orderTargets()`, regardless of
  selection order. Remaining sites keep their original relative order. Storage /
  render order is untouched.

### 3. Per-site control + instant free-up (unblocks new runs)

**Why:** a site was marked "busy" for the **entire run** and only released at
whole-run `finalize()`. So a product that already failed kept blocking a new run
for that product until every other product finished — you couldn't re-run the
failed one in the meantime.

**What changed** (`server/orchestrator.js`, `server/index.js`, `public/app.js`,
`public/style.css`):
- A site is released from the busy set **the moment it reaches a terminal state**
  (passed/failed/error/cancelled), not at whole-run finalize.
- `busySites` is now a `Map<site, runId>` with an **ownership-checked**
  `releaseSite()` — so an old run's finalize can never free a site a newer run has
  already re-acquired.
- Per-site **Cancel** — `cancelSite()` + `POST /api/runs/:id/targets/:site/cancel`
  kills just that site's process (children are tagged with `_site`), marks it
  cancelled, frees it, and finalizes the run only once nothing else is active
  (`maybeFinalize()`, gated on `launchComplete`; `finalize()` made idempotent).
- Per-site **Re-run** button on finished/failed cards starts a fresh single-site
  run (the site is already free, so the busy guard passes).
- New per-site card buttons render in the Live view (`renderSiteActions()`).

### 4. Combined run report (one shareable, printable page)

**Why:** results were only viewable **per product** (one Playwright report per
site). There was no single view of a whole multi-product run to read, share, or
export.

**What changed** (`server/combined-report.js` (new), `server/index.js`,
`public/app.js`, `public/style.css`):
- New route **`GET /api/runs/:id/combined-report`** renders a **self-contained
  HTML page** merging every product of a run into one document, built **on demand
  from the persisted `run.json`** (so it works for historical runs too — no
  artifact regeneration).
- Content: run header + summary tiles (products / tests / passed / failed /
  skipped / flaky), then one section per product with its pass/fail/skip counts, a
  detailed list of the **failed tests** (title, `file:line`, error), a "did not
  run" note for auth-failed/empty products, and a link to each product's full
  Playwright report for trace/screenshot drill-down. All interpolated strings are
  HTML-escaped.
- Print-friendly (`@media print`, page-break-avoid): open it (it opens in a new
  tab) and **Ctrl/⌘+P → Save as PDF** — no manual PDF step.
- An "↗ Combined report" button appears on a finished run in both the **Live**
  view and the **History** detail panel.

### Files touched
- `config.js` — `SITE_START_STAGGER_MS`, `MAX_CONCURRENT_SITES`, `SITE_START_PRIORITY`
- `server/orchestrator.js` — staggered/ordered launch, per-site cancel + ownership-aware busy release, idempotent finalize, per-site child tagging, `slimTarget` exposes `paths/grep/custom`
- `server/combined-report.js` — **new**; the combined-report HTML builder
- `server/index.js` — combined-report route + per-site cancel route
- `public/app.js` — per-site Cancel/Re-run buttons, combined-report links (Live + History)
- `public/style.css` — `.card-actions`, small button + run-head link styling

### Local configuration note (not a code change to review)
On the machine this runs on, the local site domains didn't match the
canonical names hardcoded in the committed suite config
(`.playwright/sites.config.ts`). To run against the real local sites, the
suite's `sites.config.ts` URLs were pointed at the actual local domains. This
is a machine-specific override, intentionally kept out of this dashboard
change; the long-term fix is to rename the local sites to the canonical names
and drop the override.
