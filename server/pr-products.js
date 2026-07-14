'use strict';

/**
 * Thrive product/dependency tables and PR→product mapping.
 *
 * Ported verbatim from the Thrive PR Builder LocalWP add-on (src/main.ts) so
 * the dashboard builds the exact same product sets the add-on does. See
 * docs/ARCHITECTURE.md §4 in tools/local-addon-thrive-pr-builder.
 */

const REPO = 'awesomemotive/thrive-themes';

// Canonical build order. closeDeps() returns subsets in this order (deps first).
const ALL_PRODUCTS = [
  'dashboard',
  'tar-light',
  'tar-full',
  'leads',
  'theme',
  'ultimatum',
  'apprentice',
  'quiz-builder',
  'ovation',
  'comments',
  'optimize',
  'product-manager',
];

// Build-time dependencies (a product can't build unless these build first).
const PRODUCT_DEPS = {
  dashboard: [],
  'tar-light': [],
  'tar-full': ['dashboard'],
  leads: ['dashboard', 'tar-light'],
  theme: ['dashboard', 'tar-light'],
  ultimatum: ['dashboard', 'tar-light'],
  apprentice: ['dashboard', 'tar-light', 'theme'],
  'quiz-builder': ['dashboard', 'tar-light'],
  ovation: ['dashboard', 'tar-light'],
  comments: ['dashboard'],
  optimize: [],
  'product-manager': ['dashboard'],
};

// Slug → installed folder name under wp-content/{plugins,themes}.
const PRODUCT_INSTALL_FOLDER = {
  dashboard: 'thrive-dashboard',
  'tar-full': 'thrive-visual-editor',
  leads: 'thrive-leads',
  theme: 'thrive-theme',
  ultimatum: 'thrive-ultimatum',
  apprentice: 'thrive-apprentice',
  'quiz-builder': 'thrive-quiz-builder',
  ovation: 'thrive-ovation',
  comments: 'thrive-comments',
  optimize: 'thrive-ab-page-testing',
  'product-manager': 'thrive-product-manager',
};

// Slug → ZIP filename prefix. NOTE: prefix ≠ slug (e.g. tar-full → thrive-architect).
const PRODUCT_ZIP_PREFIX = {
  dashboard: 'thrive-dashboard',
  'tar-full': 'thrive-architect',
  leads: 'thrive-leads',
  theme: 'thrive-theme',
  ultimatum: 'thrive-ultimatum',
  apprentice: 'thrive-apprentice',
  'quiz-builder': 'thrive-quiz-builder',
  ovation: 'thrive-ovation',
  comments: 'thrive-comments',
  optimize: 'thrive-optimize',
  'product-manager': 'thrive-product-manager',
};

// [worktree-relative prefix, product slug that ships that source]. Order matters
// for verification (first prefix match wins).
const SOURCE_TO_PRODUCT = [
  ['thrive-dashboard/', 'dashboard'],
  ['thrive-product-manager/', 'product-manager'],
  ['thrive-leads/', 'leads'],
  ['thrive-comments/', 'comments'],
  ['thrive-ovation/', 'ovation'],
  ['thrive-quiz-builder/', 'quiz-builder'],
  ['thrive-ultimatum/', 'ultimatum'],
  ['thrive-apprentice/', 'apprentice'],
  ['ab-page-testing/', 'optimize'],
  ['tcb/', 'tar-full'],
  ['thrive-theme/', 'theme'],
];

// Files that are editor sources compiled into bundles — they never land on disk
// as-is, so verification buckets them as "skipped (bundled)" rather than failing.
const SOURCE_ONLY_PATTERNS = [
  'tcb/editor/js/main/',
  'tcb/editor/js/frontend/',
  'tcb/editor/js/editor/',
  'tcb/editor/js/froala/',
  'tcb/editor/js/admin/src/',
  'tcb/editor/js/inline/src/',
  'thrive-theme/editor/js/main/',
  'thrive-theme/editor/js/frontend/',
  'thrive-theme/editor/js/admin/src/',
  'thrive-apprentice/editor/js/main/',
  'thrive-apprentice/editor/js/frontend/',
  'thrive-apprentice/editor/js/admin/src/',
  '/editor/js/main/',
  '/editor/js/src/',
];

// ZIP slugs that route to wp-content/themes/ instead of wp-content/plugins/.
const THEME_ZIPS = new Set(['thrive-theme']);

// Built-product slug → test-suite area (a key in config.SITES, whose testDirs
// hold that product's specs). Build-only deps (dashboard, tar-light) map to no
// area — they have no dedicated test directory.
const PRODUCT_TO_TEST_AREA = {
  'tar-full': 'architect',
  leads: 'leads',
  theme: 'ttb',
  ultimatum: 'ultimatum',
  apprentice: 'apprentice',
  'quiz-builder': 'quiz',
  ovation: 'ovation',
  comments: 'comments',
  optimize: 'optimize',
  'product-manager': 'tpm',
};

/** Transitive build-dep closure, returned in ALL_PRODUCTS (deps-first) order. */
function closeDeps(input) {
  const want = new Set();
  const visit = (slug) => {
    if (want.has(slug)) return;
    want.add(slug);
    for (const dep of PRODUCT_DEPS[slug] || []) visit(dep);
  };
  for (const slug of input) {
    if (PRODUCT_DEPS[slug] !== undefined) visit(slug);
  }
  return ALL_PRODUCTS.filter((p) => want.has(p));
}

/**
 * Smart-pick: which products a single changed file impacts. Mirrors the add-on's
 * impactedProducts() exactly, including the deliberately-narrow thrive-dashboard
 * rule (Dashboard + TPM, not all 12).
 */
function impactedProducts(file, impacts = new Set()) {
  if (file.startsWith('thrive-dashboard/')) {
    impacts.add('dashboard');
    impacts.add('product-manager');
    return impacts;
  }
  if (file.startsWith('tcb/')) {
    ['tar-light', 'tar-full', 'leads', 'theme', 'ultimatum', 'apprentice', 'quiz-builder', 'ovation']
      .forEach((p) => impacts.add(p));
    return impacts;
  }
  if (file.startsWith('thrive-theme/')) {
    impacts.add('theme');
    impacts.add('apprentice');
    return impacts;
  }
  if (file.startsWith('thrive-leads/')) impacts.add('leads');
  if (file.startsWith('thrive-apprentice/')) impacts.add('apprentice');
  if (file.startsWith('thrive-ultimatum/')) impacts.add('ultimatum');
  if (file.startsWith('thrive-quiz-builder/')) impacts.add('quiz-builder');
  if (file.startsWith('thrive-ovation/')) impacts.add('ovation');
  if (file.startsWith('thrive-comments/')) impacts.add('comments');
  if (file.startsWith('ab-page-testing/')) impacts.add('optimize');
  if (file.startsWith('thrive-product-manager/')) impacts.add('product-manager');
  return impacts;
}

/** Recommend the product set (post-closeDeps) plus the directly-impacted slugs. */
function recommendProducts(files) {
  const direct = new Set();
  for (const f of files) impactedProducts(f, direct);
  const directlyImpacted = ALL_PRODUCTS.filter((p) => direct.has(p));
  const products = closeDeps(directlyImpacted);
  return { directlyImpacted, products };
}

function isSourceOnly(file) {
  return SOURCE_ONLY_PATTERNS.some((p) =>
    p.startsWith('/') ? file.includes(p) : file.startsWith(p)
  );
}

const sanitizeSegment = (s) =>
  String(s).replace(/[^0-9A-Za-z.+-]/g, '-').replace(/-+/g, '-');

/**
 * Default version stamp. The 100. prefix is intentional — well above any real
 * Thrive release, so a test build can never be auto-updated past.
 */
function buildDefaultVersion({ prNumber, milestoneTitle } = {}) {
  if (prNumber) {
    return milestoneTitle
      ? `100.PR${prNumber}.Milestone-${sanitizeSegment(milestoneTitle)}`
      : `100.PR${prNumber}`;
  }
  if (milestoneTitle) return `100.Milestone-${sanitizeSegment(milestoneTitle)}`;
  return '100.0';
}

module.exports = {
  REPO,
  ALL_PRODUCTS,
  PRODUCT_DEPS,
  PRODUCT_INSTALL_FOLDER,
  PRODUCT_ZIP_PREFIX,
  SOURCE_TO_PRODUCT,
  SOURCE_ONLY_PATTERNS,
  THEME_ZIPS,
  PRODUCT_TO_TEST_AREA,
  closeDeps,
  impactedProducts,
  recommendProducts,
  isSourceOnly,
  buildDefaultVersion,
  sanitizeSegment,
};
