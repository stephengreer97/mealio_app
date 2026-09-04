// A CHANGE TO ONE STORE MUST NOT BE ABLE TO REACH ANOTHER.
//
// Stephen, 2026-09-04: "I don't [want] changes in one stores code to ever ever
// ever cause a bug in another store. Think about it. I will have to test every
// store every time we make a small change to fix a bug in one store."
//
// The alternative he raised — five separate engines, one per store — trades this
// problem for a worse one: a bug fixed in one is four times unfixed, and the
// four are found by users rather than by us. So the shape is one engine that
// cannot NAME a store and one file per store that cannot REACH another, and this
// file is what makes that structural instead of aspirational.
//
// What it enforces, mechanically, from the real import graph:
//
//   1. Nothing shared imports a store's module. The two registries are the
//      exception, because being the exception is their whole job.
//   2. No store's module imports another store's. A platform family — the
//      fifteen Albertsons banners, the Instacart tenants — is one store here,
//      because it genuinely is one storefront.
//   3. No shared module names a store in its CODE. Comments may: half of what
//      this repo knows is written down as "measured on Albertsons, 2026-09-02",
//      and that history is worth more than the tidiness of banning it.
//
// The rule these came from is [[one-stores-rule-is-not-everyones]]: the breakage
// that keeps happening is never a `storeId === 'heb'`, it is universal-looking
// code carrying one store's assumption. Rule 3 catches the visible half; rules 1
// and 2 remove the reach that lets the invisible half happen at all. Neither is
// a substitute for asking the rail — see storeIsolation.test.ts for the
// behavioural side.
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');

/**
 * One store's files. The key is the FAMILY, not the banner: safeway and vons are
 * albertsons, and every Instacart tenant is instacart, because a platform is one
 * codebase and one storefront however many names it trades under.
 */
const STORE_FILES: Record<string, string[]> = {
  heb: ['heb.ts', 'heb-network-search.ts'],
  walmart: ['walmart.ts', 'walmart-network.ts'],
  albertsons: ['albertsons.ts', 'albertsons-network.ts'],
  instacart: ['instacart.ts', 'aldi-network.ts'],
  wegmans: ['wegmans.ts', 'wegmans-network.ts'],
  mockstore: ['mockstore.ts'],
};

/** The two files whose job is knowing every store. */
const REGISTRIES = [
  'lib/webview-scripts/index.ts',      // storeId → StoreScripts
  'lib/webview-scripts/network-rail.ts', // storeId → NetworkRail
];

/**
 * Store ids as they appear in code — the banners, not the families.
 *
 * From constants/stores.ts rather than typed out, so a store added there is
 * covered here without anyone remembering to add it.
 */
function storeIds(): string[] {
  const src = fs.readFileSync(path.join(SRC, 'constants/stores.ts'), 'utf8');
  // From the DECLARATION, not the first mention: the module header names both
  // capability sets in prose, and starting there swept KROGER_BRAND_IDS in — so
  // this file demanded that no shared module name 'kroger', which is not a
  // WebView store and never passes through any of this.
  const block = src.slice(src.indexOf('export const WEBVIEW_STORE_IDS'),
                          src.indexOf('export function isWebViewStore'));
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Every .ts/.tsx under src/, repo-relative to src/. */
function allSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(path.relative(SRC, full));
    }
  };
  walk(SRC);
  return out.sort();
}

const FILE_TO_STORE = new Map<string, string>();
for (const [store, files] of Object.entries(STORE_FILES)) {
  for (const f of files) FILE_TO_STORE.set(`lib/webview-scripts/${f}`, store);
}

/** Which store a module belongs to, or null for shared code. */
const storeOf = (rel: string): string | null => FILE_TO_STORE.get(rel) ?? null;

/** Every module path this file imports, resolved to a src-relative path. */
function importsOf(rel: string): string[] {
  const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
  const dir = path.dirname(rel);
  const out: string[] = [];
  for (const m of src.matchAll(/from '(\.[^']*)'/g)) {
    const resolved = path.normalize(path.join(dir, m[1]));
    for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (fs.existsSync(path.join(SRC, resolved + ext))) { out.push(resolved + ext); break; }
    }
  }
  return out;
}

/** Source with comments and string literals removed — what actually RUNS. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('nothing shared can reach into a store', () => {
  const registries = new Set(REGISTRIES);

  it.each(allSources().filter((f) => !storeOf(f) && !registries.has(f)))(
    '%s imports no store module', (rel) => {
      const reached = importsOf(rel)
        .map((i) => ({ i, store: storeOf(i) }))
        .filter((x) => x.store !== null)
        // The mock store is a dev-only fixture we serve ourselves, not a
        // storefront, and constants/stores.ts reads its build flag to keep it
        // out of production. It is a store here only because it implements the
        // same interface.
        .filter((x) => x.store !== 'mockstore')
        .map((x) => `${x.i} (${x.store})`);
      expect(reached).toEqual([]);
    });

  it('and the registries, which may, are the only two', () => {
    // Named rather than derived: adding a third place that imports every store
    // should be a decision someone makes on purpose, and this is where they say
    // so. Both of these exist to map a storeId onto that store's own code and to
    // do nothing else with it.
    for (const r of REGISTRIES) {
      expect(importsOf(r).some((i) => storeOf(i) !== null)).toBe(true);
    }
  });
});

describe('no store can reach into another', () => {
  const storeSources = allSources().filter((f) => storeOf(f));

  it.each(storeSources)('%s imports only its own', (rel) => {
    const mine = storeOf(rel);
    const trespass = importsOf(rel)
      .map((i) => ({ i, store: storeOf(i) }))
      .filter((x) => x.store !== null && x.store !== mine)
      .map((x) => `${x.i} (${x.store})`);
    expect(trespass).toEqual([]);
  });

  it('a store may still import shared code, or this proves nothing', () => {
    // The rule above is satisfied trivially by a store that imports nothing at
    // all. These do import — the config, the registry's types, the rail's — so
    // the check is looking at a real graph.
    const withImports = storeSources.filter((f) => importsOf(f).length > 0);
    expect(withImports.length).toBeGreaterThan(5);
  });
});

describe('shared code does not name a store', () => {
  // The engine, the reconcile, the scoring, the verdicts. A store id here is a
  // rule for one store living where all of them run, which is the exact shape of
  // every cross-store break this month: the sku requirement, the shared landing
  // page, the shared cart budget, the "refuse what the cart already holds" guard
  // copied from ALDI onto Wegmans.
  //
  // SCOPED TO THE WEBVIEW AUTOMATION SURFACE, deliberately. Kroger-family stores
  // are not driven through a WebView at all — they are an OAuth API client, and
  // its own screens and API module name Kroger constantly because they ARE the
  // Kroger client. Widening this rule to the whole app would only teach people
  // to skip it. Anything under lib/webview-scripts/ is covered automatically;
  // everything else that a cart run passes through is listed, and the list is
  // short on purpose.
  const ids = storeIds().filter((id) => id !== 'mockstore');
  const registries = new Set(REGISTRIES);
  const ALSO_SHARED = [
    'components/WebViewCartSheet.tsx',   // the cart engine
    'components/SilentLoginProbe.tsx',   // the prewarm probe
    'lib/cart-reconcile.ts',
    'lib/cart-confirmation.ts',
    'lib/cart-challenge.ts',
    'lib/north-star.ts',
    'lib/chooseRanking.ts',
    'lib/storeProducts.ts',
    'lib/automation-config/decisions.ts',
    'lib/automation-telemetry.ts',
  ];
  const shared = allSources().filter((f) =>
    !storeOf(f) && !registries.has(f)
    // The per-store CONFIG tables are registries too: schema.ts is the bundled
    // automation config and fixture-capture-config.ts drives the capture
    // tooling. Both are keyed by store id because that is what they are.
    && f !== 'lib/automation-config/schema.ts'
    && f !== 'lib/fixture-capture-config.ts'
    && (f.startsWith('lib/webview-scripts/') || ALSO_SHARED.includes(f)));

  it('the store list this checks against is the real one', () => {
    // A typo in the extraction above would make every test below vacuous.
    expect(ids).toContain('heb');
    expect(ids).toContain('walmart');
    expect(ids).toContain('safeway');
    // Kroger-family banners are an OAuth client, not a WebView store, and must
    // not be in here — see the note on the slice above.
    expect(ids).not.toContain('kroger');
    expect(ids).not.toContain('ralphs');
    expect(ids.length).toBeGreaterThan(15);
  });

  it('is looking at the files that matter', () => {
    // A scoping mistake above would make every case below vacuous. The engine is
    // the file this whole rule exists for.
    expect(shared).toContain('components/WebViewCartSheet.tsx');
    expect(shared).toContain('lib/cart-reconcile.ts');
    expect(shared).toContain('lib/webview-scripts/cart-count.ts');
    expect(shared.length).toBeGreaterThan(12);
  });

  it.each(shared)('%s names none of them in code', (rel) => {
    const code = codeOnly(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    const named = ids.filter((id) => new RegExp(`\\b${id}\\b`).test(code));
    expect(named).toEqual([]);
  });
});
