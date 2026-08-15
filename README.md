# Automation Test Platform

A local web UI to run end-to-end test suites, watch live progress, and browse a
history of past runs. It is **framework-agnostic**: Playwright, Cypress and
Selenium suites all run through the same dashboard, with the same live per-test
progress and the same history. It never modifies the suites themselves.

| Framework | Language | Specs | Runner |
| --- | --- | --- | --- |
| Playwright | TypeScript | `*.spec.ts` | `playwright test` |
| Cypress | TypeScript | `*.cy.ts` | `cypress run` |
| Selenium | Java | `*Test.java` | JUnit 5 via Maven Surefire |

See [PLAN.md](./PLAN.md) for the full design and roadmap.

## The model: suites × sites

Two independent lists, and the run matrix is their product:

- **A suite** says *how* to run — a directory plus which framework it uses.
- **A site** says *where* to run — a URL plus admin credentials.

Every suite is handed `E2E_BASE_URL`, `E2E_ADMIN_USER` and `E2E_ADMIN_PASS`, so
any suite that reads those can be pointed at any registered site from the
dropdown on its row in the Run tab. One run per (suite, site) pair at a time is
enforced; the same suite against two different sites, or two frameworks against
the same site, run happily in parallel.

## Quick start

```bash
npm install        # installs express (only dependency)
npm start          # → http://localhost:4400
```

Then open **http://localhost:4400**. On boot it prints one line per configured
suite saying whether it is runnable, and why not if it isn't.

Prerequisites:

- The sites you want to test **must be running** before you start a run.
- Node suites (Playwright, Cypress) need their own `node_modules` installed.
- Selenium suites need a JDK and Maven. Neither has to be on `PATH` — the
  dashboard looks in the usual install locations, and `DASHBOARD_JAVA_HOME` /
  `DASHBOARD_MAVEN_HOME` override the search.

## How it works

- **Run tab** — the tree is grouped by suite, each labelled with its framework
  and language. Pick a whole suite, a folder, or individual specs; choose which
  registered site to run it against from the dropdown on the suite's row; hit
  **Run selected**. Each selected (suite, site) pair becomes one OS process.
- **Live tab** — a card per target with a progress bar, pass/fail/skip counts,
  the currently-running test, and failures as they happen. Survives page
  reloads (SSE reconnects). Cancel stops the process tree, per target or for
  the whole run.
- **History tab** — every run is recorded under `data/runs/<id>/`, filterable by
  site and by framework. Click a run for per-target results, failures, and a
  link to that target's Playwright report or artifacts.
- **Calendar / Schedules** — runs by day, and cron schedules that fire while the
  dashboard is running. A schedule picks (suite, site) pairs just like the Run
  tab does.
- **PR Builder tab** — paste a GitHub PR number or link for a configured
  plugin/theme project; it builds that PR and installs it onto the project's
  Local site, then lets you run any configured suite against it (see below).

### What each framework can and can't do

The adapters normalise as much as is honest, and the UI says so where they
differ:

| | Playwright | Cypress | Selenium |
| --- | --- | --- | --- |
| Test counts in the tree | exact (`--list`) | parsed from source | parsed from source |
| Live progress | per test | per test | per test, arriving a class at a time |
| Keyword filter | `--grep` | **not supported** | resolved to explicit `Class#method` |
| Failure detail | HTML report + traces | screenshots | Surefire reports |

Cypress has no CLI title filter at all, so a keyword is ignored for it rather
than silently running more than you asked for — the Run tab warns when that
applies to your selection. Select specs instead.

Selenium results arrive a test class at a time, because Maven Surefire flushes
its report once per class; the card shows which class is executing in between.

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
  "sites": {
    "my-site": {
      "name": "My Site",
      "url": "http://my-site.local",
      "adminUser": "admin",
      "adminPass": "admin"
    }
  },
  "suites": {
    "e2e-playwright": {
      "name": "End-to-end",
      "framework": "playwright",
      "dir": "../my-plugin/e2e-playwright",
      "defaultSite": "my-site"
    }
  }
}
```

**Sites** — `key: { name, url, adminUser, adminPass }`. Registered once and
offered to every suite.

**Suites** — `key: { name, framework, dir, … }`:

| field | meaning |
| --- | --- |
| `framework` | `playwright`, `cypress` or `selenium`. Omit to auto-detect from the files on disk. |
| `dir` | suite root, relative to the dashboard |
| `sites` | optional allow-list of site keys this suite may target (default: all) |
| `defaultSite` | the site preselected in the dropdown |
| `env` | extra environment variables for this suite's runs |
| `scopes` | split one suite into separately selectable slices, each with its own default site — for a suite whose specs are organised per product or tenant |

**Suite layouts** are auto-detected:

```
playwright   <suite>/playwright.config.ts  + tests/   (or .playwright/…)
cypress      <suite>/cypress.config.ts     + cypress/e2e/
selenium     <suite>/pom.xml               + src/test/java/
```

**Making a suite site-agnostic** — read the base URL and credentials from the
environment instead of hardcoding them, and the site dropdown just works:

```ts
// Playwright / Cypress config
baseURL: process.env.E2E_BASE_URL || 'http://my-site.local'
```

```java
// Selenium — system property first, then environment variable
String url = System.getProperty("E2E_BASE_URL", System.getenv("E2E_BASE_URL"));
```

**Authentication** — if a Playwright suite has `<tests root>/auth.setup.ts`, it
runs once per target before the tests. Suites that log in inside the run
(Playwright's `globalSetup`, a Cypress `cy.session` command, a JUnit
`@BeforeAll`) skip that phase automatically.

The older single-suite config shape (`suiteDir`, with `testDirs` on each site)
is still read and upgraded in memory, so existing installs keep working: the
suite becomes one entry, and each site's `testDirs` becomes a scope.

Env overrides:

- `DASHBOARD_JAVA_HOME`, `DASHBOARD_MAVEN_HOME` — JVM toolchain locations
- `SITE_START_STAGGER_MS`, `MAX_CONCURRENT_SITES`, `SITE_START_PRIORITY`
- `PORT` — HTTP port (default `4400`)

## Data layout

Files are keyed by `<target>` = `<suiteKey>__<siteKey>`, so a single run can
hold several frameworks against several sites without collision.

```
data/runs/<runId>/
  run.json                 # canonical run record (status, totals, per-test results)
  <target>.ndjson          # live event stream — one format for every framework
  <target>.log             # full runner stdout/stderr
  <target>-auth.log        # auth step output, when the suite has one
  <target>-report/         # Playwright HTML report (served in the UI)
  <target>-test-results/   # Playwright traces / screenshots
  <target>-artifacts/      # Cypress screenshots, Surefire reports
```

## Adding another framework

Drop a module in `server/frameworks/` implementing `detect`, `checkTooling`,
`discover` and `buildRun` (plus optional `buildAuth`, `startProgress`,
`onOutput`), then register it in `server/frameworks/index.js` — that file
documents the interface. Nothing outside `server/frameworks/` knows or cares
which framework a suite uses.

## Roadmap

Phases 2–5 (richer history, calendar view, scheduling) are described in
[PLAN.md](./PLAN.md). This is Phase 1: runner + live progress + history.
