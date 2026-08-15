'use strict';

/**
 * Selenium adapter (Java + JUnit 5 + Maven Surefire).
 *
 * There is no reporter plugin point here that doesn't mean adding a JAR and a
 * ServiceLoader file to the user's suite, and this platform's rule is that a
 * suite is never modified to be runnable. So instead of injecting a listener we
 * read what Surefire already writes: it flushes a TEST-<class>.xml report as
 * each test class completes, with one <testcase> per method including its
 * duration and failure message.
 *
 * The result is per-test fidelity with per-class latency: results appear a class
 * at a time rather than a test at a time. To keep the Live view honest in the
 * gap, `Running <class>` lines on Maven's stdout are turned into a `stage` event
 * so the card shows what's currently executing.
 *
 * Test ids are "<fqcn>#<method>", which is exactly the `classname` + `name` pair
 * Surefire reports, so the statically-scanned plan lines up with the results.
 */

const fs = require('fs');
const path = require('path');

const specscan = require('../specscan');
const toolchain = require('./toolchain');

const LAYOUTS = [
  { configFile: 'pom.xml', testsRoot: 'src/test/java' },
];

const SPEC_RE = /(?:Test|Tests|IT)\.java$/;

function detect(suiteDir) {
  for (const layout of LAYOUTS) {
    if (fs.existsSync(path.join(suiteDir, layout.configFile))) return { ok: true, ...layout };
  }
  return { ok: false, ...LAYOUTS[0], reason: `No pom.xml found in ${suiteDir}` };
}

function checkTooling() {
  const java = toolchain.javaExe();
  const maven = toolchain.mavenHome();
  if (!java) {
    return { ok: false, message: 'Java not found — set JAVA_HOME or DASHBOARD_JAVA_HOME' };
  }
  if (!maven) {
    return { ok: false, message: 'Maven not found — set MAVEN_HOME or DASHBOARD_MAVEN_HOME' };
  }
  return { ok: true, message: 'Java + Maven found', detail: `${java} · ${maven}` };
}

function discover(suiteDir, layout) {
  const testsRootAbs = path.join(suiteDir, layout.testsRoot);
  const files = specscan.findSpecFiles(testsRootAbs, SPEC_RE).map((file) => ({
    file,
    tests: specscan.scanFile(path.join(testsRootAbs, file)),
  }));
  return Promise.resolve({ files, exact: false });
}

/**
 * Every test the current selection covers, as scanned from source.
 *
 * An empty path means "the whole scope", so empty entries are dropped rather
 * than matched literally — `['']` selects everything, not nothing.
 */
function selectedTests(suiteDir, layout, paths) {
  const testsRootAbs = path.join(suiteDir, layout.testsRoot);
  const wanted = (paths || []).map((p) => String(p || '').replace(/\\/g, '/')).filter(Boolean);
  const all = specscan.findSpecFiles(testsRootAbs, SPEC_RE);
  const files = !wanted.length
    ? all
    : all.filter((f) => wanted.some((w) => (w.endsWith('/') ? f.startsWith(w) : f === w)));
  return files.flatMap((f) => specscan.scanFile(path.join(testsRootAbs, f)));
}

/**
 * A `-Dtest=` value that matches nothing. Omitting `-Dtest` entirely makes
 * Surefire run the *whole* suite, so "nothing matched" has to be stated
 * explicitly — otherwise an over-narrow filter would quietly run everything.
 */
const MATCH_NOTHING = 'NoTestsMatchedTheSelection';

/**
 * Surefire's `-Dtest=` selector. Classes normally, but when a keyword filter is
 * active we resolve it against the scanned titles and select `Class#method`
 * explicitly — which is exact, unlike a wildcard against method names.
 */
function testSelector(suiteDir, layout, paths, grep) {
  const tests = selectedTests(suiteDir, layout, paths);
  if (!tests.length) return { selector: MATCH_NOTHING, tests: [] };

  if (grep) {
    const needle = grep.toLowerCase();
    const matched = tests.filter(
      (t) => t.title.toLowerCase().includes(needle) || t.method.toLowerCase().includes(needle)
    );
    if (!matched.length) return { selector: MATCH_NOTHING, tests: [] };
    return {
      selector: matched.map((t) => `${t.className}#${t.method}`).join(','),
      tests: matched,
    };
  }

  const classes = [...new Set(tests.map((t) => t.className))];
  return { selector: classes.join(','), tests };
}

/**
 * Surefire always writes to `target/surefire-reports` — `reportsDirectory` is a
 * POM parameter with no `-D` user property, so it can't be relocated per run.
 * `reportNameSuffix` *is* settable, so instead of moving the directory we tag
 * this run's reports and read only those. That also makes the directory safe to
 * share: the same suite can run against two sites at once without either run
 * reading the other's results, or last week's.
 */
function reportSuffixFor(runToken) {
  return `-atp-${String(runToken || 'run').replace(/[^\w.-]+/g, '-')}`;
}

function buildRun(ctx) {
  const {
    suiteDir, layout, paths, grep, baseUrl, adminUser, adminPass, artifactsDir, runToken,
  } = ctx;

  const surefireDir = path.join(suiteDir, 'target', 'surefire-reports');
  const reportSuffix = reportSuffixFor(runToken);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const sel = testSelector(suiteDir, layout, paths, grep);
  const mavenArgs = [
    '-B', // batch mode: no ANSI progress spinners in the log
    '-f', path.join(suiteDir, 'pom.xml'),
    'test',
    `-Dsurefire.reportNameSuffix=${reportSuffix}`,
    // Let the run finish and report every class; the dashboard derives
    // pass/fail from the parsed results, not from Maven's exit code.
    '-Dmaven.test.failure.ignore=true',
    '-DfailIfNoTests=false',
    // Only the URL goes on the command line. Surefire copies every system
    // property into the <properties> block of each XML report, which we archive
    // with the run — so credentials are passed through the environment instead,
    // which it does not record.
    `-DE2E_BASE_URL=${baseUrl || ''}`,
  ];
  if (sel && sel.selector) mavenArgs.push(`-Dtest=${sel.selector}`);

  const cmd = toolchain.mavenCommand(mavenArgs, { projectDir: suiteDir });
  if (!cmd) {
    const why = checkTooling();
    throw new Error(why.message);
  }

  return {
    command: cmd.command,
    args: cmd.args,
    cwd: suiteDir,
    env: {
      JAVA_HOME: toolchain.javaHome() || '',
      // Surefire forks a JVM but inherits the environment, so the suite reads
      // its credentials here (see Config.java: system property, then env).
      E2E_BASE_URL: baseUrl || '',
      E2E_ADMIN_USER: adminUser || '',
      E2E_ADMIN_PASS: adminPass || '',
    },
    surefireDir,
    reportSuffix,
  };
}

/* ---------------------------- Surefire XML reading ------------------------- */

const TESTCASE_RE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
const ATTR_RE = /([\w.:-]+)="([^"]*)"/g;

function unescapeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function attrs(str) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(str))) out[m[1]] = unescapeXml(m[2]);
  return out;
}

/**
 * A report suffix shows up in the XML as `com.example.FooTest(-atp-run123)`.
 * Strip it so ids match the "<fqcn>#<method>" the static scan produced.
 */
function bareClassName(classname) {
  return String(classname || '').replace(/\([^)]*\)\s*$/, '');
}

/** Parse one TEST-*.xml into normalised test results. */
function parseSurefireXml(xml) {
  const results = [];
  TESTCASE_RE.lastIndex = 0;
  let m;
  while ((m = TESTCASE_RE.exec(xml))) {
    const a = attrs(m[1]);
    const body = m[3] || '';
    let status = 'passed';
    let error;

    const problem = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
    if (body.includes('<skipped')) {
      status = 'skipped';
    } else if (problem) {
      status = 'failed';
      const pa = attrs(problem[2] || '');
      const text = unescapeXml(problem[3] || '').trim();
      error = [pa.message, pa.type, text].filter(Boolean).join('\n').slice(0, 2000);
    }

    const fqcn = bareClassName(a.classname);
    results.push({
      id: `${fqcn}#${a.name}`,
      title: `${fqcn.split('.').pop()} > ${a.name}`,
      file: fqcn.replace(/\./g, '/') + '.java',
      status,
      durationMs: Math.round(Number(a.time || 0) * 1000),
      error,
    });
  }
  return results;
}

/**
 * Watch the run's Surefire directory and turn each report, as it lands, into
 * the same test events the other frameworks' reporters emit.
 *
 * Titles come from the static scan (@DisplayName is not in the XML), keyed by
 * the "<fqcn>#<method>" id so plan rows and results are the same rows.
 */
function startProgress(ctx, write) {
  const { suiteDir, layout, paths, grep, surefireDir, reportSuffix, artifactsDir } = ctx;

  const titles = new Map();
  const sel = testSelector(suiteDir, layout, paths, grep);
  for (const t of (sel && sel.tests) || []) titles.set(t.id, t.title);

  // Only this run's reports — the directory is shared with every other run of
  // the same suite, past and concurrent.
  const mine = (name) => name.startsWith('TEST-') && name.endsWith(`${reportSuffix}.xml`);

  const seen = new Set();
  let stopped = false;

  const sweep = () => {
    let entries;
    try {
      entries = fs.readdirSync(surefireDir);
    } catch (_) {
      return; // not created until the first class finishes
    }
    for (const name of entries) {
      if (!mine(name) || seen.has(name)) continue;
      let xml;
      try {
        xml = fs.readFileSync(path.join(surefireDir, name), 'utf8');
      } catch (_) {
        continue; // mid-write; pick it up next sweep
      }
      if (!/<\/testsuite>/.test(xml)) continue; // partially flushed
      seen.add(name);
      for (const r of parseSurefireXml(xml)) {
        write({
          type: 'test',
          id: r.id,
          title: titles.get(r.id) || r.title,
          file: r.file,
          status: r.status,
          durationMs: r.durationMs,
          error: r.error,
          ts: Date.now(),
        });
      }
    }
  };

  /** Keep this run's reports with the run, not in the suite's build output. */
  const archive = () => {
    const dest = path.join(artifactsDir, 'surefire-reports');
    try {
      fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(surefireDir)) {
        if (!name.includes(reportSuffix)) continue;
        fs.copyFileSync(path.join(surefireDir, name), path.join(dest, name));
        try { fs.unlinkSync(path.join(surefireDir, name)); } catch (_) { /* leave it */ }
      }
    } catch (_) {
      // Archiving is a convenience; results are already in the run record.
    }
  };

  const timer = setInterval(sweep, 500);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      sweep(); // final drain — the last class lands right before the process exits
      clearInterval(timer);
      archive();
    },
  };
}

// "[INFO] Running com.example.FooTest" — the only progress signal available
// between class completions.
const RUNNING_RE = /Running\s+([\w.$]+Test\w*)\s*$/;

/** Turn Maven's stdout into a coarse "what's executing now" signal. */
function onOutput(text, ctx, write) {
  for (const line of String(text).split('\n')) {
    const m = line.match(RUNNING_RE);
    if (m) {
      write({ type: 'stage', title: `Running ${m[1].split('.').pop()}…`, ts: Date.now() });
    }
  }
}

module.exports = {
  id: 'selenium',
  label: 'Selenium',
  language: 'Java',
  specLabel: '*Test.java',
  runner: 'JUnit 5 · Maven Surefire',
  specRe: SPEC_RE,
  // Resolved against scanned test names into explicit Class#method selections.
  supportsGrep: true,
  emitsPlan: false,
  reportKind: 'artifacts',
  // Results land a class at a time, so the UI can explain the pauses.
  progressGranularity: 'class',
  detect,
  checkTooling,
  discover,
  buildRun,
  buildAuth: () => null,
  startProgress,
  onOutput,
  _parseSurefireXml: parseSurefireXml,
};
