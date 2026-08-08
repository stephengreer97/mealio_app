// Per-selector resolution health (MEAL-31).
//
// Three things can make this feature a lie rather than a measurement, and each
// one is silent, so each gets tests here rather than a comment:
//
//   1. The samples never leave the page. The parallel-pool wrappers install
//      postMessage overrides that SWALLOW message types they do not name, so a
//      probe on the wrong side of one reports nothing and looks identical to a
//      store whose selectors are all fine. Driven through the real wrapper in a
//      bare vm, not asserted against the prefix's text.
//   2. The row loses its payload on the way out. sanitizeDetail drops nested
//      values and truncates strings at 200 characters WITHOUT SAYING SO, and this
//      project has already shipped a row claiming a tally the sanitizer had
//      thrown away (MEAL-123's failureCodes). So the assertions here go through a
//      real AutomationTelemetry with an injected upload and read what the upload
//      function actually RECEIVED — never what was passed to record().
//   3. A fallback hit is counted as a clean resolve. That is the whole early
//      warning: the primary branch dying while an alternation keeps the run
//      green is exactly the drift this exists to catch, weeks before the store's
//      success rate moves.

import * as vm from 'vm';
import {
  AutomationTelemetry,
  MAX_DETAIL_KEYS,
  MAX_DETAIL_STRING,
  StepRecord,
  sanitizeDetail,
} from '../../src/lib/automation-telemetry';
import {
  MAX_SUMMARY_PARTS,
  SELECTOR_HEALTH_MESSAGE,
  SELECTOR_INVALID,
  SELECTOR_MISS,
  SelectorHealthTally,
  albertsonsSelectorSurface,
  buildSelectorProbe,
  probeTargetsFor,
  resolveSurfaceSelectors,
  selectorSurfaceFor,
  splitSelectorBranches,
  withSelectorProbe,
} from '../../src/lib/selector-health';
import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildExtractWorker, buildPresearchWorker, buildSearchAndAddWorker } from '../../src/lib/webview-scripts/worker-search';
import { __resetAutomationConfigForTests } from '../../src/lib/automation-config';

afterEach(() => __resetAutomationConfigForTests());

// ── A fake page ─────────────────────────────────────────────────────────────

/**
 * Run an injected script in a bare vm with a document that answers
 * querySelector from an explicit list of "selectors this page matches".
 *
 * A stub rather than jsdom on purpose: what is under test is the probe's
 * bookkeeping — which branch it tries first, what it reports when none match,
 * what it does when the browser refuses one — and a stub makes each of those
 * exactly specifiable. Whether a given CSS string matches a given storefront is
 * the fixture drift census's job (MEAL-30), against real HTML in real Chromium.
 */
function runInPage(
  script: string,
  opts: { matches?: string[]; throwsOn?: string[]; posts?: string[] } = {},
): Array<Record<string, any>> {
  const posted: Array<Record<string, any>> = [];
  const ctx: any = {
    ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
    document: {
      querySelector: (sel: string) => {
        if (opts.throwsOn?.includes(sel)) throw new SyntaxError(`bad selector: ${sel}`);
        return opts.matches?.includes(sel) ? { sel } : null;
      },
    },
    JSON,
  };
  vm.createContext(ctx);
  ctx.window = ctx;
  vm.runInContext(script, ctx);
  for (const raw of opts.posts ?? []) {
    vm.runInContext(`window.ReactNativeWebView.postMessage(${JSON.stringify(raw)});`, ctx);
  }
  return posted;
}

const health = (posted: Array<Record<string, any>>) =>
  posted.filter((m) => m.type === SELECTOR_HEALTH_MESSAGE);

const TERMINAL = JSON.stringify({ type: 'SEARCH_RESULT', candidates: [] });

const CARD = {
  key: 'card',
  branches: ['[data-automation-id="product"]', '[data-item-id]'],
};
const TITLE = { key: 'title', branches: ['[data-automation-id="product-title"]'] };

// ── splitSelectorBranches ───────────────────────────────────────────────────

describe('splitSelectorBranches', () => {
  // The drift census's own cases live in driftCensus.test.ts and still pass
  // through this implementation — it moved to src/ so the census and the runtime
  // probe cannot disagree about which branch index a finding names.
  it('is the same splitter the census names its findings with', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { splitSelectorBranches: fromCensus } = require('../drift/census');
    expect(fromCensus).toBe(splitSelectorBranches);
  });
});

// ── Which selectors a script is probed for ──────────────────────────────────

describe('probeTargetsFor', () => {
  const walmart = selectorSurfaceFor('walmart')!;

  it('probes only the selectors the built script actually interpolates', () => {
    const targets = probeTargetsFor(walmart, 'var CARD_SEL = "[data-automation-id=\\"product\\"], [data-item-id]";');
    expect(targets.map((t) => t.key)).toEqual(['card']);
  });

  it('probes nothing for a script that queries none of the table', () => {
    // The point of filtering. A store's table spans the whole run — login
    // hamburger, search affordance, product card, cart bubble — and each script
    // touches one slice. Probing the whole table everywhere would report the
    // login selectors as missing on every search page, which is not drift, and a
    // health metric buried under permanent false misses gets ignored then deleted.
    expect(probeTargetsFor(walmart, 'window.location.href = "https://x";')).toEqual([]);
  });

  it('splits a probed selector into its branches, primary first', () => {
    const targets = probeTargetsFor(walmart, getStoreScripts('walmart')!.extractProductsScript);
    const card = targets.find((t) => t.key === 'card')!;
    expect(card.branches).toEqual(['[data-automation-id="product"]', '[data-item-id]']);
  });

  it('finds a selector spliced in raw, not only as a JSON literal', () => {
    // rawSelectorsFor() exists for the sites that embed a selector INSIDE a
    // quoted literal the script already owns. Those bytes differ from
    // selectorsFor()'s JSON output, and matching only the latter would silently
    // stop probing every one of them.
    const raw = resolveSurfaceSelectors(selectorSurfaceFor('aldi')!).searchTrigger;
    expect(raw).toBeTruthy();
    const targets = probeTargetsFor(selectorSurfaceFor('aldi')!, `document.querySelector('${raw}')`);
    expect(targets.map((t) => t.key)).toEqual(['searchTrigger']);
  });

  it('has a surface for every WebView store the registry can return', () => {
    // A store added without a surface is probed by nothing, and nothing else
    // would say so — the run would simply upload no selector-health row.
    for (const id of ['heb', 'walmart', 'amazon', 'wegmans', 'aldi']) {
      expect(selectorSurfaceFor(id)).not.toBeNull();
    }
    // All 15 Albertsons banners resolve one shared table, so the surface is
    // keyed on the family rather than the banner.
    expect(albertsonsSelectorSurface().configKey).toBe('albertsons');
  });
});

// ── The injected probe ──────────────────────────────────────────────────────

describe('the injected probe', () => {
  it('reports branch 0 when the primary selector resolves', () => {
    const posted = runInPage(buildSelectorProbe([CARD]), {
      matches: [CARD.branches[0]],
      posts: [TERMINAL],
    });
    expect(health(posted)[0].sel).toEqual({ card: 0 });
  });

  it('reports the fallback index when the primary misses and a fallback catches', () => {
    // THE signal this ticket is about. The run succeeds — a card was found — and
    // the store has quietly stopped rendering the attribute we ask for first. A
    // boolean "resolved" would record this as perfectly healthy.
    const posted = runInPage(buildSelectorProbe([CARD]), {
      matches: [CARD.branches[1]],
      posts: [TERMINAL],
    });
    expect(health(posted)[0].sel).toEqual({ card: 1 });
  });

  it('prefers the primary when both branches match', () => {
    const posted = runInPage(buildSelectorProbe([CARD]), {
      matches: CARD.branches,
      posts: [TERMINAL],
    });
    expect(health(posted)[0].sel).toEqual({ card: 0 });
  });

  it('reports a miss when no branch resolves', () => {
    const posted = runInPage(buildSelectorProbe([CARD]), { matches: [], posts: [TERMINAL] });
    expect(health(posted)[0].sel).toEqual({ card: SELECTOR_MISS });
  });

  it('reports a selector the browser refuses as invalid, not as a miss', () => {
    // A pushed selector that no longer parses is a config bug, not store drift,
    // and it would otherwise be indistinguishable from a store that dropped the
    // element — same 0% rate, entirely different fix.
    const posted = runInPage(buildSelectorProbe([CARD]), {
      throwsOn: [CARD.branches[0]],
      posts: [TERMINAL],
    });
    expect(health(posted)[0].sel).toEqual({ card: SELECTOR_INVALID });
  });

  it('samples on every terminal message type the engine and the pools produce', () => {
    // WORKER_RESULT is in the list because the probe's hook sits closest to
    // native and therefore sees what the WRAPPER emitted, not what the store
    // script posted. Dropping it would silence every parallel path.
    for (const type of ['SEARCH_RESULT', 'ADD_RESULT', 'SEARCH_AND_ADD_RESULT', 'WORKER_RESULT', 'LOGIN_STATUS', 'CART_COUNT']) {
      const posted = runInPage(buildSelectorProbe([CARD]), {
        matches: [CARD.branches[0]],
        posts: [JSON.stringify({ type })],
      });
      expect(health(posted)).toHaveLength(1);
    }
  });

  it('does not sample on a debug message', () => {
    const posted = runInPage(buildSelectorProbe([CARD]), {
      matches: [CARD.branches[0]],
      posts: [JSON.stringify({ type: 'EXTRACT_LOG', step: 'start' })],
    });
    expect(health(posted)).toHaveLength(0);
  });

  it('forwards the engine\'s own message untouched, and first', () => {
    // Telemetry must never break a cart run. The result the engine is waiting on
    // goes out BEFORE anything is sampled, so a throw inside the probe cannot
    // swallow it — and it must arrive byte-identical.
    const posted = runInPage(buildSelectorProbe([CARD]), {
      matches: [CARD.branches[0]],
      posts: [TERMINAL],
    });
    expect(posted[0]).toEqual({ type: 'SEARCH_RESULT', candidates: [] });
    expect(posted[1].type).toBe(SELECTOR_HEALTH_MESSAGE);
  });

  it('forwards a message it cannot parse at all', () => {
    // Forward-FIRST, not forward-if-understood. This is the property that makes
    // the probe safe to prepend to every script on every store: the hook sits on
    // the bridge every message crosses, so anything it declines to forward is
    // gone. Moving `post(s)` after the JSON.parse — the obvious tidy-up, since
    // everything below it needs the parsed message — drops non-JSON traffic
    // silently, and no other behavioural test in the suite notices.
    //
    // No store script posts non-JSON today, so this is latent rather than live.
    // It is exactly the kind of latent that a refactor turns live.
    const posted: string[] = [];
    const ctx: any = {
      ReactNativeWebView: { postMessage: (s: string) => posted.push(s) },
      document: { querySelector: () => null },
      JSON,
    };
    vm.createContext(ctx);
    ctx.window = ctx;
    vm.runInContext(buildSelectorProbe([CARD]), ctx);
    vm.runInContext(`window.ReactNativeWebView.postMessage('not json at all');`, ctx);
    expect(posted).toEqual(['not json at all']);
  });

  it('propagates a bridge failure the way an unhooked bridge would', () => {
    // The other side of forward-first: if the native post throws, the store
    // script's own try/catch must see it, exactly as it did before the hook
    // existed. Swallowing it here would turn a broken bridge into a silent one.
    const ctx: any = {
      ReactNativeWebView: { postMessage: () => { throw new Error('bridge gone'); } },
      document: { querySelector: () => null },
      JSON,
    };
    vm.createContext(ctx);
    ctx.window = ctx;
    vm.runInContext(buildSelectorProbe([CARD]), ctx);
    expect(() => vm.runInContext(`window.ReactNativeWebView.postMessage('{"type":"SEARCH_RESULT"}');`, ctx))
      .toThrow('bridge gone');
  });

  it('still delivers the engine\'s message when every selector throws', () => {
    const posted = runInPage(buildSelectorProbe([CARD, TITLE]), {
      throwsOn: [...CARD.branches, ...TITLE.branches],
      posts: [TERMINAL],
    });
    expect(posted[0]).toEqual({ type: 'SEARCH_RESULT', candidates: [] });
  });

  it('emits nothing at all when there is nothing to probe', () => {
    // A script with no configured selectors carries no prefix, so the feature
    // costs a byte of neither injection nor bridge on those paths.
    expect(buildSelectorProbe([])).toBe('');
    expect(withSelectorProbe(selectorSurfaceFor('walmart'), 'var x = 1;')).toBe('var x = 1;');
  });

  it('survives a page with no bridge rather than throwing into the script', () => {
    // A worker WebView on about:blank, or an injection that lands before the
    // bridge is installed. The store script that follows the prefix must still
    // run: refusing to probe is fine, taking the run down is not.
    const ctx: any = { JSON, document: { querySelector: () => null }, ran: [] };
    vm.createContext(ctx);
    ctx.window = ctx;
    expect(() => vm.runInContext(buildSelectorProbe([CARD]) + 'ran.push("yes");', ctx)).not.toThrow();
    expect(ctx.ran).toEqual(['yes']);
  });

  it('installs one hook however many scripts are injected into the page', () => {
    // The pre-search pool injects twice into the same parked page, and an SPA
    // re-render can re-inject. Stacking overrides would post one SELECTOR_HEALTH
    // per layer and inflate every denominator.
    const twice = buildSelectorProbe([CARD]) + buildSelectorProbe([CARD]);
    const posted = runInPage(twice, { matches: [CARD.branches[0]], posts: [TERMINAL] });
    expect(health(posted)).toHaveLength(1);
  });

  it('measures each injected script on its OWN selectors, not the previous one\'s', () => {
    // Replace, not merge. A second script inheriting the first's targets would
    // report them as queried on a page where they were never asked for, which
    // inflates the denominator of exactly the rate this feature publishes.
    const posted = runInPage(buildSelectorProbe([CARD]) + buildSelectorProbe([TITLE]), {
      matches: [TITLE.branches[0]],
      posts: [TERMINAL],
    });
    expect(health(posted)[0].sel).toEqual({ title: 0 });
  });
});

// ── Surviving the worker wrappers, AS THE REGISTRY COMPOSES THEM ────────────

/**
 * Run a whole registry-produced worker script in a page stub and return what it
 * posted, after a terminal message is delivered.
 *
 * The REAL composed text, not a re-assembly of its parts. The first version of
 * these tests built `probe + wrapper(stub)` by hand and asserted on that — an
 * arrangement production never produced. Two of the three pools actually shipped
 * `wrapper(probe + body)`, the probe's hook stacked ON TOP of the wrapper's
 * instead of underneath it, and every sample from the pre-search and parallel-add
 * pools was swallowed in the page. The suite stayed green because it was grading
 * its own composition. So these go through getStoreScripts.
 *
 * The store's own body runs too, and may throw against a stub DOM. That is caught
 * and reported rather than hidden: both prefixes are strictly ahead of the body in
 * the text, so their hooks are installed before anything in the body can fail.
 */
function runWorkerInPage(script: string, terminal: Record<string, unknown>) {
  const posted: Array<Record<string, any>> = [];
  const el = () => ({ click: () => {}, textContent: '', getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [] });
  const ctx: any = {
    ReactNativeWebView: { postMessage: (m: string) => posted.push(JSON.parse(m)) },
    document: {
      querySelector: () => el(), querySelectorAll: () => [], getElementById: () => null,
      addEventListener: () => {}, removeEventListener: () => {}, body: el(),
    },
    location: { href: 'https://store.test/s?k=milk', pathname: '/s', search: '?k=milk', hash: '', host: 'store.test', origin: 'https://store.test' },
    navigator: { userAgent: 'test' },
    JSON, setTimeout, clearTimeout, Promise, Date, Math,
  };
  vm.createContext(ctx);
  ctx.window = ctx;
  let bodyThrew: string | null = null;
  try { vm.runInContext(script, ctx); } catch (e) { bodyThrew = String((e as Error).message); }
  vm.runInContext(`window.ReactNativeWebView.postMessage(${JSON.stringify(JSON.stringify(terminal))});`, ctx);
  return { posted, bodyThrew };
}

/** Every pool's worker script, named by the field the engine actually renders. */
const POOL_WORKERS: Array<[string, (s: any) => string, Record<string, unknown>]> = [
  ['buildWorkerScript (parallel search)', (s) => s.buildWorkerScript!(2), { type: 'SEARCH_RESULT', candidates: [] }],
  ['buildPresearchWorkerScript (pre-search)', (s) => s.buildPresearchWorkerScript!(2), { type: 'SEARCH_RESULT', candidates: [] }],
  ['buildAddWorkerScript (parallel add)', (s) => s.buildAddWorkerScript!(2), { type: 'SEARCH_AND_ADD_RESULT', success: true }],
];

// Walmart uses the generic wrappers in worker-search.ts; ALDI ships a
// purpose-built parallel-search worker with no postMessage override at all, so
// between them the two arrangements the probe has to survive are both covered.
const POOL_STORES = ['heb', 'walmart', 'amazon', 'wegmans', 'aldi', 'safeway'];

describe('a registry-composed pool worker reports its selectors', () => {
  const cases = POOL_STORES.flatMap((storeId) =>
    POOL_WORKERS.map(([label, build, terminal]) => [storeId, label, build, terminal] as const),
  );

  it.each(cases)('%s / %s', (storeId, _label, build, terminal) => {
    const { posted, bodyThrew } = runWorkerInPage(build(getStoreScripts(storeId)!), terminal);
    const samples = posted.filter((m) => m.type === SELECTOR_HEALTH_MESSAGE);
    expect(bodyThrew).toBeNull();
    expect(samples).toHaveLength(1);
    // A map, not an empty object: the probe resolved the selectors this worker's
    // script actually interpolates.
    expect(Object.keys(samples[0].sel).length).toBeGreaterThan(0);
  });

  it('puts the probe\'s hook under any override the composition installs', () => {
    for (const storeId of POOL_STORES) {
      const scripts = getStoreScripts(storeId)!;
      for (const [label, build] of POOL_WORKERS) {
        const script = build(scripts);
        const probe = script.indexOf('__mealioSelHealth');
        const wrapper = Math.max(
          script.indexOf('__mealioWorkerWrapped'),
          script.indexOf('__mealioPresearchWrapped'),
          script.indexOf('__mealioAddWorkerWrapped'),
        );
        expect(`${storeId}/${label}: probe@${probe}`).toBe(`${storeId}/${label}: probe@${probe}`);
        expect(probe).toBeGreaterThanOrEqual(0);
        // -1 means this store ships a purpose-built worker with no override of
        // its own (Wegmans, the Instacart banners) — nothing to be under.
        if (wrapper >= 0) expect(probe).toBeLessThan(wrapper);
      }
    }
  });
});

describe('the failure mode that composition guards against', () => {
  /** A one-line store script that posts the result its wrapper re-tags. */
  const stub = (type: string) =>
    `window.ReactNativeWebView.postMessage(JSON.stringify({ type: '${type}', candidates: [], success: true }));`;

  // The negative control. This is what the two broken pools shipped, and it is
  // the reason `attachWorkerScripts` runs before `withSelectorProbes` instead of
  // the composition happening at the call site: wrapping an already-probed script
  // is silent, total data loss, indistinguishable from a store whose selectors
  // are all healthy.
  const WRAPPERS: Array<[string, (id: number, script: string) => string, string]> = [
    ['buildPresearchWorker', buildPresearchWorker, 'SEARCH_RESULT'],
    ['buildSearchAndAddWorker', buildSearchAndAddWorker, 'SEARCH_AND_ADD_RESULT'],
    ['buildExtractWorker', buildExtractWorker, 'SEARCH_RESULT'],
  ];

  it.each(WRAPPERS)('%s over an already-probed script emits nothing', (_name, wrap, result) => {
    const inverted = wrap(2, buildSelectorProbe([CARD]) + stub(result));
    const posted = runInPage(inverted, { matches: [CARD.branches[1]] });
    expect(posted.map((m) => m.type)).toEqual(['WORKER_RESULT']);
    expect(health(posted)).toHaveLength(0);
  });

  it.each(WRAPPERS)('%s over the probe emits the sample', (_name, wrap, result) => {
    const correct = buildSelectorProbe([CARD]) + wrap(2, stub(result));
    const posted = runInPage(correct, { matches: [CARD.branches[1]] });
    expect(posted.map((m) => m.type)).toEqual(['WORKER_RESULT', SELECTOR_HEALTH_MESSAGE]);
    expect(health(posted)[0].sel).toEqual({ card: 1 });
  });
});

// ── The registry seam ───────────────────────────────────────────────────────

describe('getStoreScripts attaches probes', () => {
  const PROBED: Array<[string, string]> = [
    ['heb', 'heb'], ['walmart', 'walmart'], ['amazon', 'amazon'],
    ['wegmans', 'wegmans'], ['aldi', 'aldi'], ['safeway', 'albertsons'],
  ];

  it.each(PROBED)('probes %s\'s extract and add scripts', (storeId) => {
    const s = getStoreScripts(storeId)!;
    expect(s.extractProductsScript).toContain('__mealioSelHealth');
    expect(s.buildAddToCartScript('Product', null, 1)).toContain('__mealioSelHealth');
  });

  it('leaves the mock store alone', () => {
    // No config selector table, and a deterministic fixture store has no drift.
    expect(selectorSurfaceFor('mockstore')).toBeNull();
  });

  it('does not change what a script DOES', () => {
    // The prefix is additive: everything after it is the script that shipped
    // before this feature, byte for byte.
    const s = getStoreScripts('walmart')!;
    const marker = '})();\n';
    const body = s.extractProductsScript.slice(s.extractProductsScript.indexOf(marker) + marker.length);
    expect(body.startsWith('(async function()')).toBe(true);
  });
});

// ── The tally ───────────────────────────────────────────────────────────────

describe('SelectorHealthTally', () => {
  it('counts a denominator, which is the whole point', () => {
    // `selector_miss` already existed; it only ever fires when a step FAILS. The
    // number that was never recorded is how often a selector was ASKED FOR.
    const t = new SelectorHealthTally();
    t.ingest({ card: 0 });
    t.ingest({ card: 0 });
    t.ingest({ card: SELECTOR_MISS });
    expect(t.counts('card')).toEqual({ queried: 3, primary: 2, fallback: 0, invalid: 0 });
  });

  it('counts a fallback hit apart from a primary hit', () => {
    const t = new SelectorHealthTally();
    t.ingest({ card: 0 });
    t.ingest({ card: 1 });
    t.ingest({ card: 2 });
    expect(t.counts('card')).toEqual({ queried: 3, primary: 1, fallback: 2, invalid: 0 });
  });

  it('counts an unparseable selector apart from a miss', () => {
    const t = new SelectorHealthTally();
    t.ingest({ card: SELECTOR_INVALID });
    expect(t.counts('card')).toEqual({ queried: 1, primary: 0, fallback: 0, invalid: 1 });
  });

  it('ignores anything that is not a selector map', () => {
    const t = new SelectorHealthTally();
    for (const junk of [null, undefined, 'card', 42, [1, 2], { card: 'yes' }, { card: NaN }]) {
      expect(() => t.ingest(junk)).not.toThrow();
    }
    expect(t.size).toBe(0);
    expect(t.samples).toBe(0);
  });

  it('renders terms as key:queried/primary/fallback', () => {
    const t = new SelectorHealthTally();
    t.ingest({ card: 0, title: 1 });
    t.ingest({ card: SELECTOR_MISS, title: 1 });
    expect(t.summaryParts()).toEqual(['card:2/1/0,title:2/0/2']);
  });

  it('chunks at the sanitizer\'s real string cap', () => {
    const t = new SelectorHealthTally();
    const sel: Record<string, number> = {};
    for (let i = 0; i < 40; i++) sel[`selector${i}`] = 0;
    t.ingest(sel);
    const parts = t.summaryParts();
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_DETAIL_STRING);
    // And no term is lost at a chunk boundary.
    expect(parts.join(',').split(',')).toHaveLength(40);
  });

  it('reports nothing when nothing was sampled', () => {
    expect(new SelectorHealthTally().detail()).toBeUndefined();
  });
});

// ── What the server actually receives ───────────────────────────────────────

describe('the uploaded row', () => {
  /** Drive a real recorder with an injected upload and return what it got. */
  async function upload(detail: Record<string, unknown>): Promise<StepRecord> {
    const batches: StepRecord[][] = [];
    const tel = new AutomationTelemetry({
      runId: 'run-1',
      upload: async (b) => { batches.push(b.steps); return true; },
      batchSize: 1000,
      flushIntervalMs: 60_000,
    });
    tel.record('reconcile', 'ok', { detail });
    await tel.flush();
    await tel.dispose();
    return batches.flat()[0];
  }

  function tallyOf(keys: number, samples: number): SelectorHealthTally {
    const t = new SelectorHealthTally();
    const sel: Record<string, number> = {};
    for (let i = 0; i < keys; i++) sel[`selectorKey${i}`] = i % 2;
    for (let i = 0; i < samples; i++) t.ingest(sel);
    return t;
  }

  it('arrives with the tally intact, not silently emptied', async () => {
    // MEAL-123's lesson, tested rather than commented: a nested Record here is
    // DROPPED by sanitizeDetail and the row ships claiming a tally it does not
    // carry. So this reads the upload function's argument, not record()'s.
    const t = new SelectorHealthTally();
    t.ingest({ card: 0, title: 1 });
    t.ingest({ card: SELECTOR_MISS, title: 1 });
    const row = await upload(t.detail()!);
    expect(row.step).toBe('reconcile');
    expect(row.outcome).toBe('ok');
    expect(row.detail).toEqual({
      phase: 'selector_health',
      selectors: 2,
      samples: 2,
      sel1: 'card:2/1/0,title:2/0/2',
    });
  });

  it('carries no failure code, so a drifting store does not recolour the run', async () => {
    // run_summary's code is what the dashboard groups on. A store having
    // half-drifted is not this run failing, and MEAL-123 ranks that code by
    // severity — a selector_miss from here would outrank the real cause.
    const t = new SelectorHealthTally();
    t.ingest({ card: SELECTOR_MISS });
    const row = await upload(t.detail()!);
    expect(row.code).toBeUndefined();
  });

  it('survives the sanitizer whole for the widest table we ship', async () => {
    // Amazon Fresh resolves 15 selectors, which overruns the 200-char string cap
    // in one line. Truncation is SILENT and leaves a row that parses cleanly and
    // is quietly short, so this asserts the chunks come back byte-identical.
    const surface = selectorSurfaceFor('amazon')!;
    const keys = Object.keys(resolveSurfaceSelectors(surface));
    expect(keys.length).toBeGreaterThanOrEqual(15);
    const t = new SelectorHealthTally();
    const sel: Record<string, number> = {};
    keys.forEach((k, i) => { sel[k] = i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : SELECTOR_MISS; });
    for (let i = 0; i < 20; i++) t.ingest(sel);
    const detail = t.detail()!;
    const row = await upload(detail);
    expect(row.detail).toEqual(detail);
    // Every selector is present in the reassembled tally.
    const rejoined = Object.keys(detail)
      .filter((k) => k.startsWith('sel') && /^sel\d+$/.test(k))
      .map((k) => detail[k] as string)
      .join(',');
    expect(rejoined.split(',').map((term) => term.split(':')[0]).sort()).toEqual([...keys].sort());
  });

  it('never exceeds the key cap, so no chunk is dropped in silence', async () => {
    // sanitizeDetail caps at MAX_DETAIL_KEYS and truncates in Object.entries
    // order, so a thirteenth key would take a chunk of the tally with it. The
    // detail is built to fit BY CONSTRUCTION; this holds that.
    const t = tallyOf(400, 3);
    const detail = t.detail()!;
    expect(Object.keys(detail).length).toBeLessThanOrEqual(MAX_DETAIL_KEYS);
    expect(detail.selDropped).toBeGreaterThan(0);
    const row = await upload(detail);
    expect(row.detail).toEqual(detail);
    expect(Object.keys(row.detail!).filter((k) => /^sel\d+$/.test(k))).toHaveLength(MAX_SUMMARY_PARTS);
  });

  it('names the selectors the browser refused, when there is room', async () => {
    const t = new SelectorHealthTally();
    t.ingest({ card: SELECTOR_INVALID, title: 0 });
    const row = await upload(t.detail()!);
    expect(row.detail!.selInvalid).toBe('card');
  });

  it('is distinguishable from the other reconcile rows a run emits', async () => {
    // The cart diff and the MEAL-47 recovery already share this step name. They
    // tell each other apart by `phase`, and so does this one — which is what lets
    // it ride an existing StepName instead of adding a member to a contract the
    // Kroger Brands extension also implements.
    const t = new SelectorHealthTally();
    t.ingest({ card: 0 });
    const row = await upload(t.detail()!);
    expect(row.detail!.phase).toBe('selector_health');
  });

  it('adds one row to a run, not one per observation', async () => {
    // The volume trade. A ten-item run samples ~20 script completions across up
    // to 15 selectors — ~300 observations — and uploads ONE row of a few hundred
    // bytes against the ~25 rows the run already sends.
    const t = tallyOf(15, 20);
    const batches: StepRecord[][] = [];
    const tel = new AutomationTelemetry({
      runId: 'run-1',
      upload: async (b) => { batches.push(b.steps); return true; },
      batchSize: 1000,
      flushIntervalMs: 60_000,
    });
    tel.record('reconcile', 'ok', { detail: t.detail()! });
    await tel.flush();
    await tel.dispose();
    const rows = batches.flat();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]).length).toBeLessThan(1200);
  });
});

// ── The sanitizer's own behaviour, pinned where this depends on it ──────────

describe('why the payload is a flat string', () => {
  it('sanitizeDetail drops the obvious shape entirely', () => {
    // Not a claim in a comment: the Record<string, Counts> this feature wants to
    // send arrives as nothing, exactly as MEAL-123's failureCodes did.
    expect(sanitizeDetail({ phase: 'selector_health', sel: { card: { queried: 3 } } }))
      .toEqual({ phase: 'selector_health' });
  });

  it('sanitizeDetail truncates a long string without saying so', () => {
    const long = 'x'.repeat(MAX_DETAIL_STRING + 50);
    expect((sanitizeDetail({ sel1: long })!.sel1 as string).length).toBe(MAX_DETAIL_STRING);
  });
});
