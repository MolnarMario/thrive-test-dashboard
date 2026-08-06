# Automation Test Platform

A local web UI to run Playwright test suites, watch live progress, and browse
a history of past runs. It wraps per-site `TEST_SITE=<key> playwright test
<dir>` runs — it never modifies the test suite itself.

See [PLAN.md](./PLAN.md) for the full design and roadmap.

## Quick start

```bash
npm install        # installs express (only dependency)
npm start          # → http://localhost:4400
```

Then open **http://localhost:4400**.

Prerequisites:

- The sites you want to test **must be running** before you start a run.
- The Playwright suite (see `DASHBOARD_SUITE_DIR` below) must have its
  `node_modules` installed.

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
- **PR Builder tab** — paste a GitHub PR number or link for a configured
  plugin/theme project; it builds that PR and installs it onto the project's
  Local site, then lets you run the suite against it (see below).

## PR Builder

Builds a PR for a WordPress plugin/theme repo and installs it onto a
[Local](https://localwp.com/) site, so you can run tests against the PR.

Copy [`pr-builder.config.example.json`](./pr-builder.config.example.json) to
`pr-builder.config.json` (gitignored) and describe your repos:

| field | meaning |
| --- | --- |
| `repo` | GitHub `owner/name` — used for `gh` calls and cloning |
| `kind` | `plugin` or `theme` → installs under `wp-content/plugins` or `.../themes` |
| `slug` | install folder name |
| `site` | Local site domain to install onto (per project) |
| `build` | optional shell command run in the worktree; `null` for plain PHP plugins |
| `distDir` | optional worktree subdir that *is* the plugin, if the build emits one |
| `exclude` | paths never copied to the site |
| `testAreas` | keys from your sites config whose tests run after a build |
| `versionStamp` | rewrite the installed copy's `Version:` header to include the PR number |

Requirements: the [`gh` CLI](https://cli.github.com/) authenticated
(`gh auth status`) — this is also how private repos are cloned — and the target
site **already running in Local** (the dashboard can't start it for you).

Checkouts live under `~/.wp-pr-builder/<project>/` (override with
`PR_BUILDER_HOME`); build records and logs under `data/pr-builds/`.

## Configuration

Copy [`sites.config.example.json`](./sites.config.example.json) to
`sites.config.json` (gitignored) in the dashboard root:

```json
{
  "suiteDir": "../my-plugin/e2e-playwright",
  "sites": {
    "my-site": {
      "name": "My Site",
      "url": "http://my-site.local",
      "testDirs": ["."]
    }
  }
}
```

- `suiteDir` — path to the Playwright suite root, relative to the dashboard.
  Optional; if omitted the dashboard looks for a suite next to it.
- `sites` — one entry per test area: `key: { name, url, testDirs }`. `testDirs`
  are relative to the tests root; use `["."]` when the specs sit directly in
  the tests root rather than in per-site subfolders.

**Suite layout** is auto-detected — both of these work with no configuration:

```
<suite>/playwright.config.ts             <suite>/.playwright/playwright.config.ts
<suite>/tests/…                          <suite>/.playwright/tests/…
```

**Authentication** — if the suite has `<tests root>/auth.setup.ts`, it runs
once per site before the tests. If it doesn't (e.g. the suite logs in from
Playwright's `globalSetup`), that phase is skipped automatically.

Env overrides, if auto-detection guesses wrong:

- `DASHBOARD_SUITE_DIR`, `DASHBOARD_PLAYWRIGHT_CONFIG`, `DASHBOARD_TESTS_ROOT`
- `DASHBOARD_AUTH_SETUP` — a spec path, or empty to skip the auth phase
- `PORT` — HTTP port (default `4400`)

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
