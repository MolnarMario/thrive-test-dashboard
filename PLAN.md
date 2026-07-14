# Thrive Test Dashboard — Implementation Plan

A local-only web dashboard to run the Thrive Themes Playwright suites, watch
live progress, and keep a browsable history of every run.

## Guiding principle

The dashboard is a thin **orchestration + memory** layer around what is already
done manually. It spawns the same `THRIVE_SITE=<key> npx playwright test <dir>`
processes that `scripts/run-parallel.sh` does — but driven by clicks, with every
run recorded. It lives as a **separate sibling project** and never modifies the
committed test suite (it only passes CLI flags + env vars at spawn time).

- **Suite location** (configurable, see `config.js`):
  `C:\Users\Mario\Local Sites\thrive-themes-automated-tests\thrive-themes-automated-tests`
- **Dashboard location:** `C:\Users\Mario\Local Sites\test-dashboard`

## Stack

- **Backend:** Node + Express. Serves the API, the SPA, and (Phase 2) the
  Playwright HTML reports.
- **Store:** JSON files under `data/runs/` (behind a clean `store.js` interface).
  *Deviation from original plan:* SQLite was deferred to avoid native-module
  compile risk on Node 24 / Windows. Swap-in point is isolated to `store.js`.
- **Live progress:** Server-Sent Events (SSE) — server→browser only, reconnects
  automatically on page reload.
- **Process control:** `child_process.spawn(process.execPath, [cli.js, ...])` —
  no shell, so the space in "Local Sites" is harmless. Cancel via Windows
  `taskkill /T /F`.
- **Frontend:** No build step. Vanilla JS + CSS. The calendar (Phase 3) is a
  hand-rendered month grid.

Only runtime dependency: **express**.

## The linchpin: custom Playwright reporter

`reporters/dashboard-reporter.cjs` (plain CommonJS, passed by absolute path so it
never touches the suite) writes one NDJSON line per event to the file named in
`DASHBOARD_EVENTS_FILE`:

```
onBegin   -> { type:"begin", site, totalTests, ts }
onTestEnd -> { type:"test",  site, title, file, line, status, durationMs, retry, error?, ts }
onEnd     -> { type:"end",   site, status, ts }
```

`.setup.ts` tests are filtered out so counts stay clean. This one file feeds both
the live progress bar (tailed while running) and the persisted history.

## Architecture

```
Browser SPA --HTTP + SSE--> Express --> Orchestrator --spawns--> node cli.js test (1 proc/site, parallel)
  tree-select                  |            |                        --reporter=line,html,dashboard-reporter.cjs
  live cards                   |            |                        PLAYWRIGHT_HTML_REPORT=<run>/<site>-report
  history                      v            v                        DASHBOARD_EVENTS_FILE=<run>/<site>.ndjson
                          JSON store    tail NDJSON --> SSE push   per-site HTML report + traces on disk
                         (data/runs/)                + state update
```

## Run lifecycle (mirrors run-parallel.sh)

1. Validate concurrency: reject if any target site already has an active run.
2. Auth per target, sequentially (`tests/auth.setup.ts`), retry once on failure.
3. Spawn per-target test processes in parallel, each with its own HTML-report
   and `--output` dir so artifacts never clobber.
4. Tail each NDJSON -> update state + push SSE.
5. On all exits -> aggregate totals, persist final `run.json`, set status.

Local runs use `retries: 0` (CI not set), so each test emits exactly one `test`
event — counts need no retry de-duplication.

## Phases

- **Phase 1 (DONE) — Runner + live progress:** reporter, orchestrator
  (auth + parallel spawn + SSE), tree API, Run + Live + History views, JSON
  store, concurrency guard.
- **Phase 2 (DONE) — History + per-test detail:** run detail with a filterable,
  searchable full test list (failed/passed/skipped + text search), per-target
  HTML report links, history search/filter bar (text/status/site).
- **Phase 3 (DONE) — Calendar (history view):** month grid over past runs with
  per-day pass/fail dots; click a day → that day's runs.
- **Phase 4 (DONE) — Preflight + cancel polish:** `/api/preflight` site-up ping
  with status dots in the tree + warn-before-run; tree-kill cancel
  (`taskkill /T /F`); interrupted-run recovery on boot.
- **Phase 5 (DONE) — Scheduling:** node-cron schedules (`server/scheduler.js`),
  Schedules tab with a frequency builder (daily/weekly/hourly/custom cron),
  enable/disable, run-now, next-run display. node-cron only fires while the
  server runs — README documents keeping it alive for unattended runs.

### Validated end-to-end (2026-06-05)
Real passing run against the live `architect` LocalWP site: auth → single spec →
live counts (1/1) → NDJSON events → persisted per-test detail → served HTML
report. Plus: concurrency guard (409), crash recovery (interrupted), schedule
CRUD + nextRun, preflight (architect up / others 502).

### Reliability fixes (2026-06-08)
Triggered by a scheduled `architect` run that was "stopped" by closing the
dashboard — but the orphaned Playwright process ran the full 4.3h, then hung
serving its HTML report, leaving the run stuck at `running`:

- **HTML-report hang (the root cause):** test processes now spawn with
  `PLAYWRIGHT_HTML_OPEN=never`. Our `--reporter=line,html,…` CLI flag overrides
  the suite config's reporter list (and its `open:'never'`); a CLI `html`
  reporter defaults to `open:'on-failure'`, which serves the report and blocks
  on "Press Ctrl+C to quit" — so any *failed* run's process never exited,
  `child.close` never fired, and the run never finalized. (`orchestrator.spawnPw`)
  Not `CI=1`, which would also enable retries and break the 1-event-per-test
  assumption the live counts rely on.
- **Graceful shutdown:** `SIGINT`/`SIGTERM`/`SIGHUP` now call
  `orchestrator.shutdown()`, which *synchronously* tree-kills tracked children
  and marks in-flight runs `interrupted`. Stopping the dashboard no longer
  orphans multi-hour runs. (`server/index.js`, `orchestrator.shutdown`)
- **NDJSON-replay recovery:** `recoverInterrupted()` now replays each target's
  NDJSON to rebuild totals + the full per-test list, distinguishing a target
  that truly finished (`end` line → passed/failed) from one cut off mid-flight
  (→ `interrupted`). Recovered runs carry `recovered:true`. This salvaged the
  stuck 2026-06-06 run into a complete 501-test `failed` record.
- `killTree` hardened: async `taskkill` now falls back to `SIGKILL` on
  error/non-zero exit; added a `{sync:true}` mode for shutdown.

## PR Builder tab (2026-06-08)

A standalone port of the Thrive PR Builder LocalWP add-on
(`tools/local-addon-thrive-pr-builder`), so a `awesomemotive/thrive-themes` PR
can be built and installed onto a designated Local site **from the dashboard**,
without Local's Electron host. Mirrors the add-on's 12-stage flow.

- **Designated site:** `pr-builder-4platform.local` (config `PR_BUILDER.siteDomain`).
- **What's reused verbatim** (plain shell/FS): the dedicated detached git
  worktree (shared with the add-on's warm `~/.local-addon-thrive-pr-builder/`),
  `git fetch origin pull/<N>/head` + base-branch merge, the release-tool source
  patches (`patchToolsRefs`, the `style.css`→`webpack.config.js` version rule,
  the version-validator relaxation so `100.PR<N>` stamps pass) + the Windows
  nvm-skip `builder.js` patch, `node index.js build --products <csv>` with
  `NODE_ENV` stripped, ZIP filter/route (TPM first, dashboard last) + `unzip`
  into `wp-content`, and md5 verification of PR-changed files.
- **The three Local-internal APIs, replaced (`server/localenv.js`):**
  1. *site → disk*: read Local's `sites.json` for web root + MySQL port + PHP
     version (keyed by domain).
  2. *wp-cli*: run Local's bundled PHP + a **vendored `vendor/wp-cli.phar`**,
     injecting the site's MySQL TCP port via `-d mysqli.default_port=<port>`
     (wp-config uses bare `localhost`). Verified: bundled PHP 8.2.29 + mysqli
     reads the live DB and `wp option get siteurl` works.
  3. *site start*: can't be done standalone — we **probe the DB via wp-cli and
     fail fast** with "start it in Local first" instead.
- **Files:** `server/prbuilder.js` (engine + SSE + per-build store under
  `data/pr-builds/`), `server/localenv.js`, `server/pr-products.js` (product
  tables + smart-pick), `/api/prbuilder/*` routes, the **PR Builder** tab in the
  SPA. Same patterns as the test runner: one build at a time, child-process
  cancel, SSE log stream with replay, graceful-shutdown + crash recovery.
- **Limitation:** the site must already be running in Local (no standalone start).

## Possible future work
- PR Builder: allow targeting any Local site (currently the one designated
  site), and a standalone site-start (would need Local's CLI/process API).
- Calendar click-on-future-day → pre-fill a schedule (currently schedules live
  in their own tab via cron).
- Per-test history search across all runs; flaky detection (needs retries > 0).
- Add Cypress / `thrive-themes-wt` suites as additional runner types.
- Migrate JSON store → SQLite if history volume grows.

## Out of scope for v1 (architecture leaves room)

- Cypress suites (`pr-builder-2026`, `newwwww2026`) and the `thrive-themes-wt`
  182-spec suite — addable later as extra runner types / target roots.
