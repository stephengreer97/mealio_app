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
} from '../../../src/lib/automation-config';
import {
  buildCartPageCountScript,
  getCartPageUrl,
  getCartPagePath,
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
  it('reads the bundled URL when config says nothing', () => {
    expect(getCartPageUrl('walmart')).toBe('https://www.walmart.com/cart');
    expect(guardPathIn(buildCartPageCountScript('walmart'))).toBe('/cart');
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

  it('uses the site root when an override names a bare origin', async () => {
    await pushConfig({ heb: { cartUrl: 'https://www.heb.com' } });
    expect(guardPathIn(buildCartPageCountScript('heb'))).toBe('/');
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
