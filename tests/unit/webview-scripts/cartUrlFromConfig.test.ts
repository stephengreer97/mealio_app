// MEAL-156 — a broken cart-probe URL must be fixable from remote config.
//
// The cart URL is the one piece of this subsystem a store can invalidate
// unilaterally and without notice. It happened twice: MEAL-152 caught
// www.walmart.com/cart starting to 302 to the homepage, MEAL-136 caught United
// Supermarkets' cart host dropping the path. Both shipped as code fixes because
// the probe read a hardcoded table, even though the config schema had carried a
// `cartUrl` field the whole time — that value only ever reached the "open my
// cart" button (Linking.openURL), never the probe.
//
// WHAT MAKES THIS TEST NON-TRIVIAL, and why it asserts on emitted script text:
//
// Repointing the URL alone is a half-fix that looks like a whole one. The
// page-identity guard from MEAL-152 compares location.pathname against an
// expected path, and that path used to live in a second hardcoded table beside
// the URL table. Move the URL by config and the guard keeps demanding the old
// path, so every load answers `not_cart_page` and the store becomes permanently
// uncountable — SAFE, since null is "unknown", but the lever would do nothing on
// the exact incident it exists for, while appearing to work. The guard path is
// therefore DERIVED from whichever URL is in force, and the observable that
// proves it is the path literal compiled into the injected script.
//
// So every assertion below reads the script the WebView would actually receive.
// Asserting on getCartPagePath alone would restate the implementation; the
// script is the artifact the feature ships.

import {
  loadAutomationConfig,
  __resetAutomationConfigForTests,
  BUNDLED_AUTOMATION_CONFIG,
} from '../../../src/lib/automation-config';
import {
  buildCartPageCountScript,
  getCartPageUrl,
  getCartPagePath,
  CART_PAGE_URL,
  CART_PAGE_URL_STORE_IDS,
} from '../../../src/lib/webview-scripts/cart-count';

/** Push a config exactly as the loader would, through real validation. */
async function pushConfig(stores: Record<string, Record<string, unknown>>) {
  await loadAutomationConfig(async () => ({ version: 42, config: { stores } }));
}

/** The path literal the emitted guard actually compares against, or null. */
function guardPathIn(script: string | null): string | null {
  if (!script) return null;
  const m = /__path !== ("(?:[^"\\]|\\.)*")/.exec(script);
  return m ? (JSON.parse(m[1]) as string) : null;
}

beforeEach(() => __resetAutomationConfigForTests());
afterAll(() => __resetAutomationConfigForTests());

describe('cart URL from remote config (MEAL-156)', () => {
  it('reads the bundled URL when no push has happened', () => {
    expect(getCartPageUrl('walmart')).toBe('https://www.walmart.com/cart');
    expect(guardPathIn(buildCartPageCountScript('walmart'))).toBe('/cart');
  });

  it('resolves the two bundled sources to the same URL', () => {
    // There are TWO bundled sources for this fact and the resolver prefers the
    // config one, so CART_PAGE_URL's heb and walmart entries are shadowed and
    // never resolve. Editing the table to fix an incident on those stores does
    // nothing — a silent no-op of exactly the kind this ticket removed on the
    // guard path. schema.ts cannot import from webview-scripts (the dependency
    // runs the other way), so the duplication is pinned rather than deleted:
    // this fails the moment the two disagree and names which to change.
    // Compared against the TABLE, not against getCartPageUrl — the resolver
    // prefers the config value, so asking it would compare the config with
    // itself and pass no matter how far the table had drifted.
    const divergent = CART_PAGE_URL_STORE_IDS
      .map((id) => ({ id, table: CART_PAGE_URL[id], config: BUNDLED_AUTOMATION_CONFIG.stores[id]?.cartUrl }))
      .filter((r) => r.config !== undefined && r.config !== r.table);
    expect(divergent).toEqual([]);
  });

  it('repoints the probe URL from a config push', async () => {
    await pushConfig({ walmart: { cartUrl: 'https://www.walmart.com/cart/basket' } });
    expect(getCartPageUrl('walmart')).toBe('https://www.walmart.com/cart/basket');
  });

  it('moves the page-identity guard with the URL', async () => {
    // The half-fix detector. Repointing the URL while the guard still demands
    // /cart turns every Walmart baseline into null — the store goes silently
    // uncountable and the operator sees a config push that "worked".
    await pushConfig({ walmart: { cartUrl: 'https://www.walmart.com/cart/basket' } });
    const script = buildCartPageCountScript('walmart');
    expect(guardPathIn(script)).toBe('/cart/basket');
    expect(script).not.toContain('__path !== "/cart"');
  });

  it.each(['heb', 'walmart', 'wegmans', 'safeway'])(
    'keeps URL and guard in agreement under an override (%s)',
    async (storeId) => {
      // The invariant, per store, with new URL() as an INDEPENDENT oracle —
      // cart-count.ts parses by regex on purpose (Hermes' URL is a partial
      // polyfill), so this is a second implementation rather than a restatement.
      await pushConfig({ [storeId]: { cartUrl: 'https://example.com/deep/cart/page' } });
      const url = getCartPageUrl(storeId)!;
      expect(url).toBe('https://example.com/deep/cart/page');
      expect(guardPathIn(buildCartPageCountScript(storeId))).toBe(new URL(url).pathname);
    },
  );

  it('repoints one Albertsons banner without touching its siblings', async () => {
    // The MEAL-136 shape: one banner's host/path moves, the other 14 are fine.
    await pushConfig({ safeway: { cartUrl: 'https://www.safeway.com/erums/basket' } });
    expect(guardPathIn(buildCartPageCountScript('safeway'))).toBe('/erums/basket');
    expect(getCartPageUrl('vons')).toBe('https://www.vons.com/erums/cart');
    expect(guardPathIn(buildCartPageCountScript('vons'))).toBe('/erums/cart');
  });

  it('normalises a trailing slash so the guard still matches the real page', async () => {
    // location.pathname is '/cart'; the guard strips trailing slashes from it
    // before comparing, so an expected '/cart/' would never match and the store
    // would go uncountable on a cosmetically different override.
    await pushConfig({ heb: { cartUrl: 'https://www.heb.com/cart/' } });
    expect(guardPathIn(buildCartPageCountScript('heb'))).toBe('/cart');
  });

  it('refuses to count when an override names a bare origin', async () => {
    // THE DANGEROUS ONE. An earlier revision of this file asserted the guard
    // became '/' here and called that correct. It is the MEAL-152 defect wearing
    // the fix's clothes: '/' is satisfied by the store HOMEPAGE, which carries no
    // line items, so the script counts zero and posts it as fact. A trusted zero
    // reached through the config lever built to prevent trusted zeros.
    //
    // Verified against the captured homepage fixture rather than argued: with a
    // guard of '/' this scenario posts `count: 0` on tests/fixtures/walmart/
    // logged-in-home.html. Refusing to build the script is what keeps it null.
    await pushConfig({ heb: { cartUrl: 'https://www.heb.com' } });
    expect(getCartPagePath('heb')).toBeNull();
    expect(buildCartPageCountScript('heb')).toBeNull();
  });

  describe('paths that cannot be matched are refused, not guessed', () => {
    // Every case here is ACCEPTED by merge.ts — `^https://` does not imply a
    // parseable host — so each reaches cartPathnameOf and must fail closed.
    // Building a script for any of them means guarding on '/' or on a literal
    // the page can never report, and the first of those posts a trusted zero.
    it.each([
      ['no authority at all', 'https:///cart'],
      ['scheme only', 'https://'],
      ['authority replaced by a query', 'https://?q=1'],
      ['authority replaced by a fragment', 'https://#frag'],
      ['dot segments the browser resolves away', 'https://www.heb.com/cart/../checkout'],
      ['a malformed percent-escape', 'https://www.heb.com/ca%rt'],
    ])('refuses %s', async (_label, cartUrl) => {
      await pushConfig({ heb: { cartUrl } });
      expect(getCartPagePath('heb')).toBeNull();
      expect(buildCartPageCountScript('heb')).toBeNull();
    });
  });

  describe('percent-encoding matches what location.pathname reports', () => {
    // location.pathname is ALWAYS encoded. A raw override compared literally
    // never matches its own page, so the store goes quietly uncountable — a
    // config push that looks like it worked and did nothing, which is the
    // failure this ticket removes rather than relocates.
    it.each([
      ['a space', 'https://www.heb.com/my cart', '/my%20cart'],
      ['non-ASCII', 'https://www.heb.com/café', '/caf%C3%A9'],
      ['an emoji-class codepoint', 'https://www.heb.com/❤', '/%E2%9D%A4'],
    ])('encodes %s', async (_label, cartUrl, expected) => {
      await pushConfig({ heb: { cartUrl } });
      expect(guardPathIn(buildCartPageCountScript('heb'))).toBe(expected);
    });

    it('leaves an already-encoded override alone rather than double-encoding', async () => {
      // encodeURI(decodeURIComponent(x)) has to be idempotent, or an operator
      // who writes the encoded form — the form they would copy out of a browser
      // address bar — gets '/caf%25C3%25A9' and a permanently uncountable store.
      await pushConfig({ heb: { cartUrl: 'https://www.heb.com/caf%C3%A9' } });
      expect(guardPathIn(buildCartPageCountScript('heb'))).toBe('/caf%C3%A9');
    });
  });

  describe('overrides that must be refused', () => {
    it('ignores a cleartext http override', async () => {
      // merge.ts is https-only: an override must not be able to downgrade a
      // logged-in store to cleartext. Refusal has to leave the store WORKING on
      // its bundled URL, not broken.
      await pushConfig({ walmart: { cartUrl: 'http://www.walmart.com/cart' } });
      expect(getCartPageUrl('walmart')).toBe('https://www.walmart.com/cart');
      expect(guardPathIn(buildCartPageCountScript('walmart'))).toBe('/cart');
    });

    it.each([
      ['javascript: scheme', 'javascript:alert(1)'],
      ['not a URL', 'www.walmart.com/cart'],
      ['wrong type', 42],
    ])('ignores %s', async (_label, value) => {
      await pushConfig({ walmart: { cartUrl: value } });
      expect(getCartPageUrl('walmart')).toBe('https://www.walmart.com/cart');
      expect(guardPathIn(buildCartPageCountScript('walmart'))).toBe('/cart');
    });
  });

  describe('the override repoints, it does not promote', () => {
    // null from getCartPageUrl is not "no URL known" — it is the branch selector
    // for a different counting strategy. Amazon Fresh reaches its cart by
    // CLICKING and traverses several paths (/gp/aw/c → /cart/localmarket), so it
    // has no single pathname to guard. Honouring a cartUrl there would navigate
    // a store whose script was written for the click-through AND leave it
    // unguarded — reintroducing the trusted zero MEAL-152 removed, from a config
    // push, on a store nobody is watching. Adding a store to cart-page counting
    // stays a code change with a guard and a fixture.
    it('leaves Amazon Fresh on its click-through path', async () => {
      await pushConfig({ amazon: { cartUrl: 'https://www.amazon.com/cart' } });
      expect(getCartPageUrl('amazon')).toBeNull();
      expect(getCartPagePath('amazon')).toBeNull();
      expect(buildCartPageCountScript('amazon')).not.toContain('not_cart_page');
    });

    it('leaves an Instacart banner with no cart URL at all', async () => {
      await pushConfig({ aldi: { cartUrl: 'https://www.aldi.us/cart' } });
      expect(getCartPageUrl('aldi')).toBeNull();
      expect(buildCartPageCountScript('aldi')).toBeNull();
    });

    it('repoints the mockstore harness but leaves it unguarded, as documented', async () => {
      // mockstore HAS a bundled URL, so the override applies; it is exempt from
      // the guard because it is served by a local server that does not redirect.
      // Pinned so the exemption stays a decision rather than an accident.
      await pushConfig({ mockstore: { cartUrl: 'https://example.com/mock/cart' } });
      expect(getCartPageUrl('mockstore')).toBe('https://example.com/mock/cart');
      expect(getCartPagePath('mockstore')).toBeNull();
      expect(buildCartPageCountScript('mockstore')).not.toContain('not_cart_page');
    });
  });

  it('restores the bundled URL when the override is withdrawn', async () => {
    // A rollback is the other half of a hot fix: the operator must be able to
    // take the override back out once the store is fixed.
    await pushConfig({ walmart: { cartUrl: 'https://www.walmart.com/cart/basket' } });
    expect(getCartPageUrl('walmart')).toBe('https://www.walmart.com/cart/basket');
    await loadAutomationConfig(async () => ({ version: 43, config: { stores: {} } }));
    expect(getCartPageUrl('walmart')).toBe('https://www.walmart.com/cart');
    expect(guardPathIn(buildCartPageCountScript('walmart'))).toBe('/cart');
  });
});
