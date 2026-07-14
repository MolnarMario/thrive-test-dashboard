# Thrive Test Dashboard

A local web UI to run the Thrive Themes Playwright suites, watch live progress,
and browse a history of past runs. It wraps the same per-site
`THRIVE_SITE=<key> playwright test <dir>` runs that `scripts/run-parallel.sh`
does — it never modifies the test suite.

See [PLAN.md](./PLAN.md) for the full design and roadmap.

## Quick start

```bash
cd "C:\Users\Mario\Local Sites\test-dashboard"
npm install        # installs express (only dependency)
npm start          # → http://localhost:4400
```

Then open **http://localhost:4400**.

Prerequisites (same as running the suite by hand):

- The relevant **LocalWP sites must be running** before you start a run.
- The suite at `../thrive-themes-automated-tests/thrive-themes-automated-tests`
  must have its `node_modules` installed (it does).

## How it works

- **Run tab** — pick whole sites, folders, or individual specs from the tree,
  optionally add a `--grep` keyword, and hit **Run selected**. Each selected
  site becomes one parallel Playwright process (one run per site at a time is
  enforced).
- **Live tab** — per-site cards with a progress bar, pass/fail/skip counts, the
  currently-running test, and failures as they happen. Survives page reloads
  (SSE reconnects). Cancel stops the processes.
- **History tab** — every run is recorded under `data/runs/<id>/`. Click a run
  to see per-site results, failures, and a link to that site's full Playwright
  HTML report (with traces/screenshots).

## Configuration

Edit `config.js`, or set env vars:

- `DASHBOARD_SUITE_DIR` — path to the Playwright suite root.
- `PORT` — HTTP port (default `4400`).

The `SITES` map mirrors the suite's `.playwright/sites.config.ts`. If a site is
added there, add it here too.

## Data layout

```
data/runs/<runId>/
  run.json              # canonical run record (status, totals, per-test results)
  <site>.ndjson         # live event stream from the custom reporter
  <site>.log            # full Playwright stdout/stderr
  <site>-auth.log       # auth step output
  <site>-report/        # Playwright HTML report (served in the UI)
  <site>-test-results/  # traces / screenshots
```

## Roadmap

Phases 2–5 (richer history, calendar view, scheduling) are described in
[PLAN.md](./PLAN.md). This is Phase 1: runner + live progress + history.
