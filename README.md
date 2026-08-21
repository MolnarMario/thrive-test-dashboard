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

Then open **http://localhost:4400** and sign in. On boot it prints one line per
configured suite saying whether it is runnable, and why not if it isn't.

The first time it starts with no users, it creates an `admin` account with a
randomly generated password and prints it in the boot banner **once**:

```
username: admin
password: LdNAjum5DbiFokNftkpi     ← yours will differ
```

Copy it before the terminal scrolls — it is not stored anywhere in readable
form, and the account can do nothing but change it until it has. See
[First sign-in](#first-sign-in) if you lose it.

The dashboard listens on `127.0.0.1` only. See [Hosting it](#hosting-it) before
putting it anywhere else.

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

## Access control

Everything is behind a login — the API, the dashboard, the Playwright reports
and the live streams alike. Signing in gets you a session cookie that lasts 12
hours and refreshes while you are using it, up to an absolute 7 days
(`SESSION_IDLE_HOURS` / `SESSION_MAX_DAYS`).

### Roles

A role sets what someone can do by default. Everyone signed in can always
*look*: the test tree, live runs, history, the calendar, reports and artifacts.
Roles only govern what changes things.

| | admin | tester | viewer |
| --- | --- | --- | --- |
| Run, re-run and cancel tests | ✓ | ✓ | |
| Create and fire schedules | ✓ | ✓ | |
| Use the PR Builder | ✓ | ✓ | |
| Add and remove sites | ✓ | | |
| Manage users and permissions | ✓ | | |

### Handing out one permission

The role is a starting point, not a cage. In the **Users** tab an admin can tick
or untick any single permission for one person — grant a tester `Manage sites`
without making them an admin, or take `Run tests` off a tester who should only
watch for a while. An explicitly set permission shows in green; the rest simply
follow the role, and re-ticking a box back to its role default clears the
override again.

Admins always hold every permission — the checkboxes are fixed for them, and the
last remaining admin can be neither demoted nor deleted, so the dashboard can't
lock everyone out.

Deleting a user, or resetting their password, signs them out everywhere at once.

### First sign-in

The first time the dashboard starts with no users, it creates an `admin`
account with a **randomly generated password, printed once to the console**.
Copy it before the terminal scrolls. It is not stored anywhere in readable
form, and the account can do nothing except change that password until it has.

Lost it? Stop the dashboard, delete `data/users.json`, start it again, and a
fresh admin is seeded. (Site definitions, run history and schedules are
separate files and survive.)

For an unattended install, set `SEED_ADMIN_PASSWORD` — it still has to satisfy
the password policy, and the account is still required to change it at first
sign-in.

### Passwords

Dashboard passwords are stored as scrypt hashes (32 MiB, ~0.2s each) with a
per-user salt and the cost parameters recorded alongside, so the cost can be
raised later without invalidating anyone — a successful sign-in silently
re-hashes an older record. They are never recoverable, by anyone, including you.

The policy is at least 12 characters (set `MIN_PASSWORD_LENGTH` to change it;
it will not go below 8), not the username, and not one of the handful that get
guessed first. An account whose password was chosen by *someone else* — a new
account, or one an admin has reset — is signed in but inert until it sets its
own.

Failed sign-ins are throttled per account and per client address, with each
lock lasting longer than the last. The counters live in memory, so restarting
the dashboard clears them; that is a deliberate trade (nothing an attacker can
trigger) rather than an oversight.

### Site credentials

The admin password for a site under test is the one secret here that cannot be
hashed: a suite has to log in to WordPress with the real string. So it is
**encrypted at rest** (AES-256-GCM) in `data/custom-sites.json`, decrypted only
in memory, handed to the test process through its environment — never on a
command line, never into `run.json`, never into a Surefire report — and never
sent back to the browser. The Sites tab shows a blank password field; leaving it
blank keeps the stored one.

The encryption key comes from one of two places:

| | |
| --- | --- |
| `DASHBOARD_SECRET_KEY` | 32 bytes as hex or base64. **Use this when hosting** — the key then lives in your secret store, not beside the ciphertext. |
| `data/secret.key` | Generated on first boot, `chmod 0600`. The sensible default for a local install. |

Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Back the key up with `data/`. Losing it means re-entering every site password —
which the dashboard will tell you, rather than silently failing a login.

If you would rather not have site passwords on the dashboard host at all, a
site declared in `sites.config.json` can name an environment variable instead:

```json
{ "sites": { "staging": { "url": "https://staging.example.com", "adminPassEnv": "STAGING_WP_PASS" } } }
```

### Where it's stored

`data/users.json`, `data/sessions.json` and `data/custom-sites.json`, in the
same gitignored `data/` dir as run history — written `0600`, with the directory
itself locked to the running account on first boot (`chmod 0700`, or an `icacls`
grant on Windows). Session ids are stored only as SHA-256 digests: the cookie is
a bearer token, so what's on disk must not be usable as one.

There are no new dependencies — `node:crypto` does all of it.

## Hosting it

The dashboard binds to `127.0.0.1` by default. That is not timidity: it holds
admin credentials for every site it can test, so reaching it from anywhere else
should be a decision someone made on purpose.

To expose it, set `HOST=0.0.0.0` — and then, in order:

1. **Put TLS in front of it.** Sign-ins cross the wire in cleartext otherwise.
2. **Set `TRUST_PROXY`** (`1` for a single reverse proxy) so `req.secure` and
   `req.ip` describe the client rather than the proxy. Without it the session
   cookie won't be marked `Secure` and login throttling counts every request as
   coming from the same address. With it *and no proxy actually in front*, a
   client can forge both — so set it only when it's true.
3. **Set `DASHBOARD_SECRET_KEY`** so the site-credential key isn't stored next
   to the data it protects.
4. Restrict who can reach it anyway — a VPN or an IP allow-list. This is a tool
   that runs arbitrary test suites and holds production-adjacent credentials;
   authentication is the last line, not the only one.

`SECURE_COOKIES=1` forces the `Secure` flag on when TLS is terminated somewhere
that doesn't forward `X-Forwarded-Proto`.

### What's already handled

- Every route requires a session — API, reports, artifacts and SSE alike.
- State-changing requests must be same-origin (`SameSite=Lax` plus an explicit
  `Origin`/`Referer` check), so a cross-site form can't act as you.
- A strict `Content-Security-Policy` with no external origins, `nosniff`,
  `X-Frame-Options: DENY` and HSTS over TLS. Playwright reports get a slightly
  looser policy so they can run — still with no origin but this one, so nothing
  a report renders can call out.
- Artifacts are test *output*, which is attacker-influenced whenever a suite
  touches a site you don't control: anything a browser would execute (`.html`,
  `.svg`, `.xml`) is served as a download rather than rendered.
- A run may only target a registered site, and may only set environment
  variables in the `E2E_ / WP_ / TEST_ / DASHBOARD_` namespaces — otherwise
  `tests.run` would be a way to run arbitrary code on the host.
- Run and target ids are validated before they touch the filesystem.

### Reporting a vulnerability

Please open a security advisory on the repository rather than a public issue.

## Configuration

Copy [`sites.config.example.json`](./sites.config.example.json) to
`sites.config.json` (gitignored) in the dashboard root:

```json
{
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

**Sites** — added, edited and removed from the admin **Sites** tab in the
dashboard (sign in as an admin), not from this file. Each one is a
`{ name, url, adminUser, adminPass }` registered once and offered to every
suite; `defaultSite` above just needs to match the key of a site you've added
there. (A `sites` block in `sites.config.json` is still read if present, for
existing installs — but new sites don't need one.)

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
- `HOST` — interface to bind (default `127.0.0.1`; `0.0.0.0` to expose it)
- `TRUST_PROXY` — number of reverse proxies in front (see [Hosting it](#hosting-it))
- `SECURE_COOKIES` — force the `Secure` cookie flag when TLS is terminated upstream
- `DASHBOARD_SECRET_KEY` — 32-byte hex/base64 key for site-credential encryption
- `SEED_ADMIN_USERNAME`, `SEED_ADMIN_PASSWORD` — first-admin seeding, for unattended installs
- `MIN_PASSWORD_LENGTH` — password floor (default `12`, never below `8`)
- `SESSION_IDLE_HOURS`, `SESSION_MAX_DAYS` — session idle and absolute lifetimes

## Data layout

Files are keyed by `<target>` = `<suiteKey>__<siteKey>`, so a single run can
hold several frameworks against several sites without collision.

```
data/
  users.json               # usernames, roles, scrypt password hashes  (0600)
  sessions.json            # live sessions, keyed by digest of the cookie (0600)
  custom-sites.json        # sites added from the UI; adminPass encrypted  (0600)
  secret.key               # site-credential encryption key, unless DASHBOARD_SECRET_KEY (0600)

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
