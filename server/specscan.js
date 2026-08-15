'use strict';

/**
 * Static test discovery.
 *
 * Playwright can tell us exactly which tests exist (`--list`), but Cypress and
 * Maven/JUnit have no comparable "collect without running" mode that is cheap
 * enough to call on every tree refresh. So for those we read the spec sources
 * and extract the tests ourselves.
 *
 * Two things depend on this:
 *   1. the Run tree's "N tests · M specs" counts, and
 *   2. the up-front `plan` event, which is what lets the Live view list every
 *      test as pending before the run reaches it.
 *
 * Because (2) has to line up with the events the run actually produces, the
 * test `id`s minted here are exactly the ids the corresponding reporter emits:
 *   - mocha/Cypress → the full title path ("Suite > nested > test title")
 *   - JUnit         → "<fully.qualified.Class>#<methodName>"
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------ mocha / Cypress --------------------------- */

const SUITE_FNS = new Set(['describe', 'context', 'suite']);
const TEST_FNS = new Set(['it', 'specify', 'test']);

// `describe(`, `it.only(`, `context.skip(` … followed by a quote.
const DECL_RE =
  /\b(describe|context|suite|it|specify|test)(\.(?:only|skip))?\s*\(\s*(['"`])/g;

/**
 * Read a single-quoted / double-quoted / backticked literal starting at the
 * opening quote. Returns { value, end } or null when it isn't a plain literal
 * (e.g. a template with `${}` interpolation, which we can't resolve statically).
 */
function readLiteral(src, quoteIdx) {
  const quote = src[quoteIdx];
  let out = '';
  for (let i = quoteIdx + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      out += src[i + 1] || '';
      i += 1;
      continue;
    }
    if (quote === '`' && ch === '$' && src[i + 1] === '{') return null;
    if (ch === quote) return { value: out, end: i };
    if (ch === '\n' && quote !== '`') return null; // unterminated
    out += ch;
  }
  return null;
}

/**
 * Extract every test in a mocha-style spec, with its full describe path.
 *
 * Implemented as a small lexer that tracks brace depth while skipping strings,
 * template literals, regexes and comments — a plain regex can't tell where a
 * `describe` block ends, and indentation is not something to bet test counts on.
 *
 * Returns [{ id, title, titlePath, line }].
 */
function scanMochaSpec(src) {
  // Pre-index the declarations so the lexer can recognise them by offset.
  const decls = new Map();
  DECL_RE.lastIndex = 0;
  let m;
  while ((m = DECL_RE.exec(src))) {
    const quoteIdx = m.index + m[0].length - 1;
    const lit = readLiteral(src, quoteIdx);
    if (!lit) continue;
    decls.set(m.index, {
      fn: m[1],
      skipped: m[2] === '.skip',
      title: lit.value,
      end: lit.end,
    });
  }
  if (!decls.size) return [];

  const tests = [];
  const stack = []; // open describe frames: { title, depth }
  let pending = null; // a describe seen, waiting for its `{`
  let depth = 0;
  let line = 1;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (ch === '\n') { line += 1; continue; }

    // --- skip over things that must not be parsed as code ---
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      i -= 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const chunk = src.slice(i, close < 0 ? src.length : close);
      line += (chunk.match(/\n/g) || []).length;
      i = close < 0 ? src.length : close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const lit = readLiteral(src, i);
      if (lit) {
        line += (src.slice(i, lit.end).match(/\n/g) || []).length;
        i = lit.end;
        continue;
      }
      // Template literal with interpolation: walk to its close, tracking nesting.
      if (ch === '`') {
        let j = i + 1;
        let braces = 0;
        for (; j < src.length; j++) {
          if (src[j] === '\\') { j += 1; continue; }
          if (src[j] === '\n') line += 1;
          if (src[j] === '{') braces += 1;
          else if (src[j] === '}') braces -= 1;
          else if (src[j] === '`' && braces <= 0) break;
        }
        i = j;
        continue;
      }
    }

    // --- declarations ---
    const decl = decls.get(i);
    if (decl) {
      if (TEST_FNS.has(decl.fn)) {
        const titlePath = [...stack.map((s) => s.title), decl.title];
        const title = titlePath.join(' > ');
        tests.push({ id: title, title, titlePath, line, skipped: decl.skipped });
      } else if (SUITE_FNS.has(decl.fn)) {
        pending = decl.title;
      }
      // Jump past the title literal so its contents are never re-lexed.
      line += (src.slice(i, decl.end).match(/\n/g) || []).length;
      i = decl.end;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      if (pending !== null) {
        stack.push({ title: pending, depth });
        pending = null;
      }
      continue;
    }
    if (ch === '}') {
      while (stack.length && stack[stack.length - 1].depth === depth) stack.pop();
      depth -= 1;
      continue;
    }
  }

  return tests;
}

/* ---------------------------------- JUnit --------------------------------- */

// An annotation cluster immediately followed by a method signature. The
// argument matcher skips over quoted strings so a `)` inside a @DisplayName
// (e.g. "…ceil(word count / wpm)…") doesn't end the annotation early.
const JAVA_ANNOTATION = '@\\w+(?:\\s*\\((?:[^)"]|"(?:[^"\\\\]|\\\\.)*")*\\))?\\s*';
const JAVA_METHOD_RE = new RegExp(
  `((?:${JAVA_ANNOTATION})+)(?:public\\s+|protected\\s+|private\\s+)?(?:static\\s+|final\\s+)*void\\s+(\\w+)\\s*\\(`,
  'g'
);
const JAVA_TEST_ANNOTATION = /@(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/;
const DISPLAY_NAME_RE = /@DisplayName\s*\(\s*"((?:[^"\\]|\\.)*)"/;
const DISABLED_RE = /@Disabled\b/;

/**
 * Extract every JUnit test method in a Java source file.
 *
 * The id is "<fqcn>#<methodName>" because that is what Surefire's XML report
 * gives us back (its `classname` + `name` attributes) — @DisplayName only
 * affects the human-readable title, never the reported name.
 *
 * @Nested inner classes are not resolved; their tests are still counted, but
 * attributed to the outer class.
 */
function scanJavaSpec(src, fileName) {
  const pkg = (src.match(/^\s*package\s+([\w.]+)\s*;/m) || [])[1] || '';
  const className = fileName.replace(/\.java$/, '');
  const fqcn = pkg ? `${pkg}.${className}` : className;

  const tests = [];
  JAVA_METHOD_RE.lastIndex = 0;
  let m;
  while ((m = JAVA_METHOD_RE.exec(src))) {
    const [, annotations, method] = m;
    if (!JAVA_TEST_ANNOTATION.test(annotations)) continue;
    const display = (annotations.match(DISPLAY_NAME_RE) || [])[1];
    const title = display ? display.replace(/\\"/g, '"') : method;
    tests.push({
      id: `${fqcn}#${method}`,
      title: `${className} > ${title}`,
      titlePath: [className, title],
      method,
      fqcn,
      className,
      line: src.slice(0, m.index).split('\n').length,
      skipped: DISABLED_RE.test(annotations),
    });
  }
  return tests;
}

/* --------------------------------- walking -------------------------------- */

const IGNORED_DIRS = new Set([
  'node_modules', 'target', 'dist', 'build', '.git',
  'screenshots', 'videos', 'downloads', 'fixtures', 'helpers', 'support',
]);

/**
 * Recursively collect spec files under `root` matching `specRe`.
 * Returns paths relative to `root`, using forward slashes.
 */
function findSpecFiles(root, specRe) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        walk(abs, relPath);
      } else if (specRe.test(e.name)) {
        out.push(relPath);
      }
    }
  };
  walk(root, '');
  out.sort();
  return out;
}

/** Scan one spec file with the scanner appropriate to its extension. */
function scanFile(absFile) {
  let src;
  try {
    src = fs.readFileSync(absFile, 'utf8');
  } catch (_) {
    return [];
  }
  try {
    return absFile.endsWith('.java')
      ? scanJavaSpec(src, path.basename(absFile))
      : scanMochaSpec(src);
  } catch (_) {
    return []; // a scan failure degrades counts, it never breaks a run
  }
}

module.exports = {
  scanMochaSpec,
  scanJavaSpec,
  findSpecFiles,
  scanFile,
};
