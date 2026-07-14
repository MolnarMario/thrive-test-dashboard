'use strict';

/**
 * Builds a single self-contained HTML report merging every product/site of one
 * run into one page. Rendered on demand from the persisted run.json (see
 * store.loadRun) — no dependency on the per-site Playwright artifacts, so it
 * works for historical runs too.
 *
 * Detail level: summary + failures. Overall totals, a per-product pass/fail/skip
 * breakdown, and a detailed list of only the FAILED tests (title, file:line,
 * error). Passed/skipped are shown as counts. Each product links out to its full
 * Playwright report for trace/screenshot drill-down.
 *
 * The page is print-friendly: Ctrl+P → "Save as PDF" yields a clean document.
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (_) { return esc(iso); }
}

const T = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, completed: 0 };
function totals(x) { return Object.assign({}, T, x || {}); }

/** A run/target status → a badge CSS modifier. */
function statusClass(status) {
  if (status === 'passed') return 'ok';
  if (status === 'failed' || status === 'error') return 'bad';
  if (status === 'cancelled' || status === 'interrupted') return 'warn';
  return 'muted';
}

/** Strip the noisy "chromium › <spec path> › " prefix Playwright puts on titles. */
function cleanTitle(title) {
  const parts = String(title || '').split(' › ');
  // Drop the leading project name ("chromium") and the spec-file segment.
  const trimmed = parts.filter((p, i) => {
    if (i === 0 && /^[a-z-]+$/i.test(p) && !p.includes(' ')) return false; // project
    if (/\.spec\.[tj]s$/i.test(p)) return false;                          // file path
    return true;
  });
  return (trimmed.length ? trimmed : parts).join(' › ');
}

function baseName(file) {
  return String(file || '').split(/[\\/]/).pop() || '';
}

/** A product "did not run" if auth failed, or it errored/ended with no tests. */
function didNotRun(t) {
  const n = (t.tests || []).length;
  return t.authStatus === 'failed' || ((t.status === 'error' || t.status === 'failed' || t.status === 'interrupted') && n === 0);
}

function productSection(run, t) {
  const tt = totals(t.totals);
  const fails = (t.tests || []).filter((x) => x.status === 'failed');
  const sc = statusClass(t.status);

  const failRows = fails.map((f) => `
      <div class="fail">
        <div class="fail-title">${esc(cleanTitle(f.title))}</div>
        <div class="fail-loc">${esc(baseName(f.file))}${f.line ? ':' + f.line : ''}</div>
        ${f.error ? `<pre class="fail-err">${esc(f.error)}</pre>` : ''}
      </div>`).join('');

  const note = didNotRun(t)
    ? `<div class="note">${t.authStatus === 'failed' ? 'Authentication failed' : 'Did not run'} — no tests were executed for this product.</div>`
    : '';

  const reportLink = `<a class="pw-link" href="/api/runs/${esc(run.id)}/report/${esc(t.site)}/index.html" target="_blank" rel="noopener">↗ Open Playwright report</a>`;

  return `
    <section class="product">
      <div class="product-head">
        <h3>${esc(t.name || t.site)}</h3>
        <span class="badge ${sc}">${esc(t.status || 'unknown')}</span>
        <span class="spacer"></span>
        <span class="url">${esc(t.url || '')}</span>
      </div>
      <div class="counts">
        <span class="c pass">✓ ${tt.passed}</span>
        <span class="c fail">✗ ${tt.failed}</span>
        <span class="c skip">• ${tt.skipped}</span>
        ${tt.flaky ? `<span class="c flaky">⚑ ${tt.flaky}</span>` : ''}
        <span class="c tot">${tt.completed}/${tt.total || '?'}</span>
        <span class="spacer"></span>
        ${reportLink}
      </div>
      ${note}
      ${fails.length ? `<div class="fails"><div class="fails-h">Failures (${fails.length})</div>${failRows}</div>` : (didNotRun(t) ? '' : '<div class="allpass">No failures 🎉</div>')}
    </section>`;
}

function buildCombinedReportHtml(run) {
  const rt = totals(run.totals);
  const products = Array.isArray(run.targets) ? run.targets : [];
  const rc = statusClass(run.status);

  const tiles = [
    ['Products', products.length, ''],
    ['Tests', rt.completed + (rt.total && rt.total > rt.completed ? `/${rt.total}` : ''), ''],
    ['Passed', rt.passed, 'ok'],
    ['Failed', rt.failed, 'bad'],
    ['Skipped', rt.skipped, 'muted'],
    ['Flaky', rt.flaky, 'warn'],
  ].map(([label, val, cls]) => `
      <div class="tile ${cls}">
        <div class="n">${esc(val)}</div>
        <div class="l">${esc(label)}</div>
      </div>`).join('');

  const sections = products.map((t) => productSection(run, t)).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Combined report — ${esc(run.label || run.id)}</title>
<style>
  :root { --ink:#1a1a2e; --muted:#5b6472; --line:#e3e6ec; --bg:#f7f8fa; --red:#d64545; --amber:#c77700; --green:#1a9d5b; }
  * { box-sizing: border-box; }
  body { font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:var(--ink); margin:0; background:#fff; line-height:1.5; }
  .wrap { max-width:1000px; margin:0 auto; padding:36px 32px 56px; }
  header h1 { font-size:24px; margin:0 0 2px; letter-spacing:-0.01em; }
  header .sub { color:var(--muted); font-size:13px; }
  .meta { display:flex; flex-wrap:wrap; gap:8px 20px; margin:12px 0 22px; font-size:13px; color:var(--muted); }
  .meta b { color:var(--ink); font-weight:600; }
  .badge { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; padding:2px 9px; border-radius:20px; vertical-align:middle; }
  .badge.ok{background:#e7f6ee;color:var(--green)} .badge.bad{background:#fdecec;color:var(--red)}
  .badge.warn{background:#fdf3e6;color:var(--amber)} .badge.muted{background:#eef0f4;color:var(--muted)}
  .tiles { display:grid; grid-template-columns:repeat(6,1fr); gap:10px; margin:0 0 26px; }
  .tile { border:1px solid var(--line); border-radius:10px; padding:12px; text-align:center; background:var(--bg); }
  .tile .n { font-size:22px; font-weight:700; line-height:1; }
  .tile .l { font-size:10.5px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); margin-top:6px; }
  .tile.ok .n{color:var(--green)} .tile.bad .n{color:var(--red)} .tile.warn .n{color:var(--amber)}
  .product { border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin:0 0 14px; break-inside:avoid; page-break-inside:avoid; }
  .product-head { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .product-head h3 { margin:0; font-size:16px; }
  .spacer { flex:1; }
  .url { font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--muted); }
  .counts { display:flex; align-items:center; gap:14px; font-size:13px; font-variant-numeric:tabular-nums; padding:6px 0; border-top:1px solid var(--line); }
  .counts .pass{color:var(--green);font-weight:600} .counts .fail{color:var(--red);font-weight:600}
  .counts .skip{color:var(--muted)} .counts .flaky{color:var(--amber);font-weight:600} .counts .tot{color:var(--ink)}
  .pw-link, a { color:#1667c2; text-decoration:none; font-size:12px; font-weight:600; }
  a:hover { text-decoration:underline; }
  .note { background:#fdf3e6; color:#8a5a00; border-radius:8px; padding:8px 12px; font-size:13px; margin-top:8px; }
  .allpass { color:var(--green); font-size:13px; margin-top:6px; }
  .fails { margin-top:10px; }
  .fails-h { font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--red); font-weight:700; margin-bottom:8px; }
  .fail { border-top:1px solid var(--line); padding:8px 0; break-inside:avoid; page-break-inside:avoid; }
  .fail-title { font-size:13.5px; font-weight:600; }
  .fail-loc { font-family:ui-monospace,Consolas,monospace; font-size:11.5px; color:var(--muted); margin:1px 0 4px; }
  .fail-err { margin:0; white-space:pre-wrap; word-break:break-word; background:var(--bg); border-radius:6px; padding:8px 10px; font-size:11.5px; color:#333; max-height:240px; overflow:auto; }
  footer { margin-top:28px; font-size:11.5px; color:var(--muted); border-top:1px solid var(--line); padding-top:12px; }
  @media print {
    .wrap { max-width:none; padding:0; }
    .fail-err { max-height:none; overflow:visible; }
    .tiles { grid-template-columns:repeat(6,1fr); }
    a[href]::after { content:""; } /* don't append URLs */
  }
  @media (max-width:720px){ .tiles{grid-template-columns:repeat(3,1fr)} }
</style></head>
<body><div class="wrap">
  <header>
    <h1>Combined Test Report <span class="badge ${rc}">${esc(run.status || 'unknown')}</span></h1>
    <div class="sub">${esc(run.label || run.id)}</div>
    <div class="meta">
      <span>Run: <b>${esc(run.id)}</b></span>
      <span>Trigger: <b>${esc(run.trigger || 'manual')}</b></span>
      <span>Started: <b>${esc(fmtTime(run.startedAt))}</b></span>
      <span>Duration: <b>${esc(fmtDuration(run.durationMs))}</b></span>
    </div>
  </header>

  <div class="tiles">${tiles}</div>

  ${sections || '<p class="note">This run has no products.</p>'}

  <footer>Generated from run data on demand · ${esc(products.length)} product(s). For traces &amp; screenshots, open a product's Playwright report. Print to PDF with Ctrl/⌘+P.</footer>
</div></body></html>`;
}

module.exports = { buildCombinedReportHtml };
