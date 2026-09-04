// Store differences belong on the rail, not in the engine.
//
// Stephen, 2026-09-02: "I think the changes we are making as we do each store is
// breaking the others. I want more isolation between stores code."
//
// He is right, and the failure this week was not a missing abstraction — it was
// one store's rule written as if it were everyone's:
//
//   • the matcher required a productId AND a skuId. That is how H-E-B addresses
//     a cart line. Albertsons addresses by product id and its search returns no
//     sku at all, so no Albertsons product could ever match — with every search
//     answered and the right product in the list.
//   • the landing page was one storeUrl for everybody. H-E-B's storefront
//     homepage navigates out from under an in-flight request; Albertsons' does
//     too. Both now name their own quiet page.
//
// Neither showed up as `storeId === 'heb'`. Both were universal-looking code
// carrying one store's assumption, which is what these tests are for.

import { getNetworkRail, NETWORK_SESSION_MESSAGE_TYPES } from '../../src/lib/webview-scripts/network-rail';
import { getStoreScripts } from '../../src/lib/webview-scripts';
import { WEBVIEW_STORE_IDS } from '../../src/constants/stores';

/**
 * Every store that HAS a rail — DERIVED, by asking the registry about every
 * store in the catalogue, rather than listed.
 *
 * It used to be a list, and the list was wrong within a day: Walmart's rail
 * shipped on 2026-09-03 and none of the guards in this file were applied to it,
 * because nobody remembered to add the word 'walmart' to an array at the top of
 * a test. A store cannot skip these by being forgotten now.
 */
const RAIL_STORES = [...WEBVIEW_STORE_IDS].filter((id) => !!getNetworkRail(id));

/** One representative per rail, so a per-rail assertion runs once, not fifteen
 *  times for the Albertsons banners. */
const ONE_PER_RAIL = RAIL_STORES.filter((id, i, all) =>
  all.findIndex((o) => getNetworkRail(o) === getNetworkRail(id)) === i);

describe('every rail answers every question the engine asks', () => {
  // A new store that omits a member does not inherit another store's behaviour
  // by accident — it fails here instead.
  const MEMBERS = [
    'sessionMessageType', 'sessionScript', 'searchBatch',
    'cartRead', 'addBatch', 'writable', 'needsPreference', 'sessionUsable', 'budgets',
  ] as const;

  it('there are five of them, and the list found them all', () => {
    // If the derivation above breaks, every it.each below runs zero times and
    // this file passes while checking nothing.
    expect(ONE_PER_RAIL.length).toBe(5);
    expect(RAIL_STORES).toContain('heb');
    expect(RAIL_STORES).toContain('walmart');
    expect(RAIL_STORES).toContain('wegmans');
    expect(RAIL_STORES).toContain('aldi');
    // The whole family, not just the banner that shares its name.
    expect(RAIL_STORES).toContain('safeway');
    expect(RAIL_STORES).toContain('vons');
    // EVERY store in the catalogue has one as of 2026-09-04, when Amazon Fresh
    // — the last without — was removed. So this is the whole catalogue, and a
    // store arriving without a rail has to be a decision someone makes here.
    expect(RAIL_STORES.length).toBe([...WEBVIEW_STORE_IDS].length);
  });

  for (const id of RAIL_STORES) {
    it(`${id} implements the whole rail`, () => {
      const rail = getNetworkRail(id);
      expect(rail).not.toBeNull();
      for (const m of MEMBERS) expect(rail![m]).toBeDefined();
    });
  }

  it('the stores disagree about writability, and say so themselves', () => {
    // The bug that started this: H-E-B needs a sku, Albertsons does not, and the
    // engine must ask rather than assume.
    expect(getNetworkRail('heb')!.writable({ productId: 'p', skuId: null })).toBe(false);
    expect(getNetworkRail('albertsons')!.writable({ productId: 'p', skuId: null })).toBe(true);
  });

  it('each rail store names its own quiet landing page', () => {
    // The rail needs the origin's cookies and nothing else. Sitting on a
    // storefront homepage means every request shares a renderer with the site's
    // own bundles — and can be cancelled when that page navigates, which is
    // exactly how H-E-B broke.
    for (const id of RAIL_STORES) {
      const scripts = getStoreScripts(id)!;
      expect(scripts.railUrl).toBeTruthy();
      // Same ORIGIN as the store, or the session cookies and localStorage do not
      // apply — that is the whole requirement, and it is not the same as sharing
      // a prefix. Walmart's storeUrl is /grocery and its rail sits on
      // /robots.txt, which a startsWith check called a violation.
      expect(`${id}: ${new URL(scripts.railUrl!).origin}`)
        .toBe(`${id}: ${new URL(scripts.storeUrl).origin}`);
      expect(scripts.railUrl).not.toBe(scripts.storeUrl);
    }
  });

  it('every rail posts a session message type of its own', () => {
    const types = RAIL_STORES.map((id) => getNetworkRail(id)!.sessionMessageType);
    // Five rails, five types. Albertsons' fifteen banners share one rail and
    // therefore one type, and every Instacart tenant shares another for the same
    // reason — that rail is registered against the PLATFORM. Two rails sharing a
    // type would cross their answers in the sheet's dispatcher.
    expect(new Set(types).size).toBe(5);
    for (const t of types) expect(NETWORK_SESSION_MESSAGE_TYPES).toContain(t);
  });

  it('and no rail is another rail', () => {
    // Cheap, and it catches the copy-paste that gives a new store the previous
    // store's object outright — which would pass every member check above and
    // send one store's requests to another store's endpoints.
    const objs = ONE_PER_RAIL.map((id) => getNetworkRail(id));
    expect(new Set(objs).size).toBe(objs.length);
  });

  it.each(ONE_PER_RAIL)('%s states every budget itself', (id) => {
    // Was asserted for H-E-B and Albertsons only, which is how three rails
    // shipped without anyone checking. A budget is a store fact; a rail that
    // omitted one would take whatever the type default gave it — undefined,
    // which reads as an immediate timeout.
    const b = getNetworkRail(id)!.budgets;
    for (const k of ['sessionMs', 'searchResumeMs', 'cartProbeMs',
                     'searchRequestMs', 'searchFirstRequestMs'] as const) {
      expect(`${id}.${k}: ${typeof b[k]}`).toBe(`${id}.${k}: number`);
      expect(b[k]).toBeGreaterThan(0);
    }
    expect(b.searchMs(10)).toBeGreaterThan(0);
    expect(b.addMs(10)).toBeGreaterThan(0);
    // A bigger batch waits longer, and every budget is capped so a store that
    // has stopped answering still ends the phase.
    expect(b.searchMs(20)).toBeGreaterThan(b.searchMs(1));
    expect(b.addMs(20)).toBeGreaterThan(b.addMs(1));
    expect(b.searchMs(10_000)).toBeLessThanOrEqual(180_000);
    expect(b.addMs(10_000)).toBeLessThanOrEqual(180_000);
    // A per-request budget always fits inside its batch budget, or the phase
    // deadline fires while one request is still legitimately running.
    expect(b.searchFirstRequestMs).toBeLessThan(b.searchMs(1));
  });

  it.each(ONE_PER_RAIL)('%s builds a script for every phase', (id) => {
    const rail = getNetworkRail(id)!;
    const sess = { storeId: '1', shoppingContext: 'pickup' };
    expect(typeof rail.sessionScript()).toBe('string');
    expect(typeof rail.cartRead()).toBe('string');
    expect(typeof rail.searchBatch(['milk'], sess)).toBe('string');
    expect(typeof rail.addBatch(
      [{ idx: 0, productId: 'p1', skuId: 's1', quantity: 1, name: 'Milk' }])).toBe('string');
  });

  it.each(ONE_PER_RAIL)('%s injects nothing that would break in a template literal', (id) => {
    // Every one of these ships spliced into a template literal in an injected
    // script. A stray backtick ends the literal and a dollar-brace becomes an
    // interpolation — both are BUILD failures, and both have happened here
    // repeatedly, including inside comments.
    const rail = getNetworkRail(id)!;
    const sess = { storeId: '1', shoppingContext: 'pickup' };
    const scripts = [rail.sessionScript(), rail.cartRead(),
                     rail.searchBatch(['milk'], sess) ?? '',
                     rail.addBatch([{ idx: 0, productId: 'p', skuId: 's', quantity: 1, name: 'M' }]) ?? ''];
    for (const src of scripts) {
      // The script itself is one big template literal's OUTPUT, so what matters
      // is that it parses as JavaScript.
      expect(() => new Function(`return function(){ ${src} }`)).not.toThrow();
    }
  });
});

// The cart engine's per-store branches used to be counted here, with the count
// pinned so a new one had to be argued for. There are none left to count, and
// the rule is now enforced structurally and for every shared module rather than
// by a number in one test — see tests/unit/storeBoundaries.test.ts, which reads
// the real import graph and fails on a store id appearing in shared code at all.

describe('how long to wait is a store fact', () => {
  // These were three constants in the engine, each tuned on whichever store was
  // in front of me and applied to both. Albertsons needs a generous search
  // window because its first request into a fresh document can take 40 seconds;
  // H-E-B answers in about one and was made to wait the same 45 plus 8 per term
  // before it could give up.
  const heb = getNetworkRail('heb')!;
  const alb = getNetworkRail('albertsons')!;

  it('every rail states all four budgets', () => {
    for (const rail of [heb, alb]) {
      expect(typeof rail.budgets.sessionMs).toBe('number');
      expect(typeof rail.budgets.searchResumeMs).toBe('number');
      expect(rail.budgets.searchMs(10)).toBeGreaterThan(0);
      expect(rail.budgets.addMs(10)).toBeGreaterThan(0);
      expect(typeof rail.budgets.cartProbeMs).toBe('number');
      expect(typeof rail.budgets.searchRequestMs).toBe('number');
      expect(typeof rail.budgets.searchFirstRequestMs).toBe('number');
    }
  });

  it('H-E-B waits less than Albertsons, because it answers faster', () => {
    // The assertion that matters is that they DIFFER. If a future edit collapses
    // them back to one number, one of these stores is being made to live with
    // the other's measurements.
    expect(heb.budgets.searchMs(20)).toBeLessThan(alb.budgets.searchMs(20));
    expect(heb.budgets.sessionMs).toBeLessThan(alb.budgets.sessionMs);
  });

  it('a bigger batch gets longer, and every budget is capped', () => {
    for (const rail of [heb, alb]) {
      expect(rail.budgets.searchMs(20)).toBeGreaterThan(rail.budgets.searchMs(1));
      expect(rail.budgets.addMs(20)).toBeGreaterThan(rail.budgets.addMs(1));
      // A store that has stopped answering must still end the phase.
      expect(rail.budgets.searchMs(10_000)).toBeLessThanOrEqual(180_000);
      expect(rail.budgets.addMs(10_000)).toBeLessThanOrEqual(180_000);
    }
  });
});

describe('signed in is not the same as ready to run', () => {
  // MEASURED 2026-09-02. Albertsons answers the session probe TWICE: once the
  // instant /userinfo comes back, so no budget of ours can make the sheet think
  // a signed-in user is signed out, and again about 1.3s later with the API keys
  // resolved and the token proved against a real cart read.
  //
  // The engine took the first one and went straight to writing. `wrote 0 of 29`,
  // twenty-seven "nothing found for N chosen products", and a full basket handed
  // back to the user to add by hand.
  //
  // It stayed hidden for as long as it did because the sheet's own prewarm
  // happened to consume the early answer first. Once the selection screen
  // started answering the searches, the prewarm stopped running and the run met
  // the early answer head-on — which is exactly the shape of
  // [[one-stores-rule-is-not-everyones]]: shared code carrying one store's
  // assumption about how many answers a session probe gives.
  const EARLY = { early: true, storeId: '161' };
  const REFINED = { storeId: '161' };

  it('Albertsons refuses the early answer and takes the refined one', () => {
    expect(getNetworkRail('albertsons')!.sessionUsable(EARLY)).toBe(false);
    expect(getNetworkRail('albertsons')!.sessionUsable(REFINED)).toBe(true);
  });

  it('H-E-B posts once, so whatever it posts is ready', () => {
    expect(getNetworkRail('heb')!.sessionUsable(REFINED)).toBe(true);
    // Even shaped like an early answer — H-E-B never sends one, and answering
    // false here would strand its run waiting for a message that never comes.
    expect(getNetworkRail('heb')!.sessionUsable(EARLY)).toBe(true);
  });

  it('an early answer with no store is let through — nothing more is coming', () => {
    // The script returns after posting it. Waiting would burn the whole 25s
    // session budget to reach the same handover the run can make immediately.
    expect(getNetworkRail('albertsons')!.sessionUsable({ early: true, storeId: null })).toBe(true);
  });
});

describe('a variant the user must choose is the store\'s concept', () => {
  it('H-E-B has preferences; Albertsons does not', () => {
    const withPref = { preferences: [{ preferenceId: 'p1' }] };
    expect(getNetworkRail('heb')!.needsPreference(withPref)).toBe(true);
    // Not "no preferences in the data" — the platform has no such concept, and
    // saying so is the point of asking rather than inferring from an empty array.
    expect(getNetworkRail('albertsons')!.needsPreference(withPref)).toBe(false);
  });

  it('no preference list means nothing to choose, at either store', () => {
    for (const id of ['heb', 'albertsons']) {
      expect(getNetworkRail(id)!.needsPreference({ preferences: null })).toBe(false);
      expect(getNetworkRail(id)!.needsPreference({})).toBe(false);
    }
  });
});

describe('a verdict is never built against a cart nobody read', () => {
  // Stephen, 2026-09-02: "it is showing a warning that 170 items are in the cart
  // that mealio did not intend to add. That is wrong. Those were already in the
  // cart before the run."
  //
  //   13:16:18  snapshotBefore: reading the cart over the network
  //   13:16:28  before-probe timed out — starting search without a baseline
  //   13:16:36  CART_COUNT count=170  ms=6646        (discarded: phase null)
  //
  // The read took 6.6s against a shared 10s ceiling, missed it, and arrived
  // eight seconds later with nowhere to go. The after-probe then diffed a
  // 176-line cart against [] — so every pre-existing line showed green and
  // nothing accounted for them, which is the over-add warning.
  const heb = getNetworkRail('heb')!;
  const alb = getNetworkRail('albertsons')!;

  it('the cart probe has a per-store ceiling, and Albertsons gets the longer one', () => {
    // The last engine-wide budget. Ten seconds sat exactly between this store's
    // cold read (6.6s) and its warm one (0.5s) — the worst place for a deadline.
    expect(alb.budgets.cartProbeMs).toBeGreaterThan(10_000);
    expect(alb.budgets.cartProbeMs).toBeGreaterThan(heb.budgets.cartProbeMs);
  });

  it('every rail states one', () => {
    for (const rail of [heb, alb]) {
      expect(typeof rail.budgets.cartProbeMs).toBe('number');
      expect(rail.budgets.cartProbeMs).toBeGreaterThan(0);
    }
  });
});

describe('the first request of a batch is allowed to be slow', () => {
  // MEASURED 2026-09-02, and the measurement is the point: the heartbeat showed
  // a 1.002s gap for a one-second interval, so the document was provably NOT
  // frozen -- and the first search request still ran the whole 15s abort budget
  // and was killed, while every one after it answered in 0.3s.
  //
  // That is a cold start, not a stall, and aborting a slow answer turns it into
  // no answer at all.
  it('Albertsons gives its cold request more room than its warm ones', () => {
    const alb = getNetworkRail('albertsons')!;
    expect(alb.budgets.searchFirstRequestMs).toBeGreaterThan(alb.budgets.searchRequestMs);
  });

  it('H-E-B has no cold-start problem and says so by not asking for one', () => {
    const heb = getNetworkRail('heb')!;
    expect(heb.budgets.searchFirstRequestMs).toBe(heb.budgets.searchRequestMs);
  });

  it('a per-request budget always fits inside its batch budget', () => {
    // Otherwise the phase deadline fires while a single request is still
    // legitimately running, and the run gives up on work that was going to land.
    for (const id of ['heb', 'albertsons']) {
      const b = getNetworkRail(id)!.budgets;
      expect(b.searchFirstRequestMs).toBeLessThan(b.searchMs(1));
    }
  });
});

describe('every rail speaks the same message contract', () => {
  // The engine reads NET_ADD_RESULT.success. The Albertsons script had been
  // posting the same fact under its own name — `ok` — since the rail shipped, so
  // every Albertsons item was recorded as FAILED however well it went.
  //
  // It survived because the batch's own `wrote` count and the cart diff were
  // both right: the done screen looked correct while the reconcile, reading the
  // per-item results, saw nothing confirmed and re-wrote the whole basket on
  // every run. Stephen's 12:07 log has "wrote 18 of 18" one line above
  // "reconcile: confirmed 6, retry 12".
  //
  // This is the same class as the sku rule and the shared landing page: not a
  // store-id branch, just one store quietly meaning something different by the
  // same thing.
  const REQUIRED = ['idx', 'name', 'success', 'reason'];

  it('the add script of every rail reports per item with the engine\'s field names', () => {
    for (const id of ['heb', 'albertsons']) {
      const script = getNetworkRail(id)!.addBatch(
        [{ idx: 0, productId: 'p1', skuId: 's1', quantity: 1, name: 'X' }]);
      expect(script).toBeTruthy();
      // The report helper builds the message; every required key must appear as
      // a literal in it, and the old name must not.
      for (const key of REQUIRED) expect(script!).toContain(`${key}:`);
      expect(script!).toContain("type: 'NET_ADD_RESULT'");
    }
  });

  it('no rail posts the result under `ok`', () => {
    for (const id of ['heb', 'albertsons']) {
      const script = getNetworkRail(id)!.addBatch(
        [{ idx: 0, productId: 'p1', skuId: 's1', quantity: 1, name: 'X' }])!;
      // `ok: !!ok` was the Albertsons shape. Anything reintroducing it means the
      // engine will read undefined and call a successful add a failure.
      expect(script).not.toMatch(/\bok:\s*!!/);
    }
  });
});
