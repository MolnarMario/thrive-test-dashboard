# Automation Test Platform — Implementation Plan

A local-only web dashboard to run configured Playwright test suites, watch
live progress, and keep a browsable history of every run.

## Guiding principle

The dashboard is a thin **orchestration + memory** layer around what is already
done manually. It spawns the same `TEST_SITE=<key> npx playwright test <dir>`
processes that `scripts/run-parallel.sh` does — but driven by clicks, with every
run recorded. It lives as a **separate sibling project** and never modifies the
committed test suite (it only passes CLI flags + env vars at spawn time).

- **Suite location** (configurable via `DASHBOARD_SUITE_DIR`, see `config.js`)
- **Sites** (configurable via `sites.config.json`, see `README.md`)

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

## PR Builder tab

Builds a GitHub PR for a configured WordPress plugin/theme and installs it onto
that project's Local site **from the dashboard**, so you can then run the suite
against the built site without leaving the platform.

- **Projects are config-driven** (`pr-builder.config.json`, gitignored — see
  `pr-builder.config.example.json` and `server/pr-projects.js`). Each project
  declares its `repo`, `kind` (plugin/theme), install `slug`, target Local
  `site`, an optional `build` command + `distDir`, `exclude` paths, and the
  `testAreas` to run afterwards. A plain PHP plugin needs no build step at all —
  the repo *is* the plugin.
- **Input** is a PR number *or* a pasted PR URL; a URL that names a configured
  repo selects that project automatically (`pr-projects.parsePrRef`).
- **Build flow** (`server/prbuilder.js` `executeBuild`):
  1. resolve project + Local site, probe the DB, fail fast if it isn't running;
  2. ensure a per-project clone (`gh repo clone`, so private repos work) and a
     detached worktree under `~/.wp-pr-builder/<project>/`;
  3. `git fetch origin pull/<N>/head` + hard reset, then merge the PR's base
     branch — exactly like CI builds the merge commit. A real content conflict
     is fatal with a "rebase and push" message;
  4. run the optional `build` command with `NODE_ENV` stripped (a production
     `NODE_ENV` makes `npm install` drop the devDeps a build needs);
  5. copy the tree (or `distDir`) into `wp-content/{plugins,themes}/<slug>`,
     removing the previous install first when *Clean install* is on — scoped to
     the one folder it owns;
  6. optionally stamp the `Version:` header of the **installed** copy so the
     build is identifiable in wp-admin (the worktree stays pristine);
  7. activate via wp-cli;
  8. verify the PR's changed files landed (md5 against the worktree). Files that
     legitimately don't land 1:1 because a build/`distDir` is in play bucket as
     "compiled" rather than failing.
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
  `data/pr-builds/`), `server/pr-projects.js` (project registry + PR-ref
  parsing), `server/localenv.js`, `/api/prbuilder/*` routes, the **PR Builder**
  tab in the SPA. Same patterns as the test runner: one build at a time,
  child-process cancel, SSE log stream with replay, graceful-shutdown + crash
  recovery.
- **Running tests on the build** reuses the orchestrator's custom-target path
  (single-site `PLAYWRIGHT_BASE_URL` + admin creds). The target site key is
  namespaced `pr:<projectKey>` so two projects never block each other on the
  per-site busy guard.
- **Limitation:** the site must already be running in Local (no standalone start).

## Possible future work
- PR Builder: a standalone site-start (would need Local's CLI/process API), and
  a per-project "recipe" hook for repos whose build can't be expressed as a
  single shell command.
- Calendar click-on-future-day → pre-fill a schedule (currently schedules live
  in their own tab via cron).
- Per-test history search across all runs; flaky detection (needs retries > 0).
- Add Cypress or other suite formats as additional runner types.
- Migrate JSON store → SQLite if history volume grows.

## Out of scope for v1 (architecture leaves room)

- Additional Cypress or other-framework suites — addable later as extra
  runner types / target roots.
