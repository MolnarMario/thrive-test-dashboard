# Changelog — Automation Test Platform

All notable changes to the dashboard (the local web UI that runs Playwright
suites across configured sites).

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
