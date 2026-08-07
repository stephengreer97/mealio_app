import {
  getWegmansSearchUrl,
  getWegmansWarmupUrl,
} from '../../../src/lib/webview-scripts/wegmans';
import {
  getAlbertsonsCartPageUrl,
  ALBERTSONS_FAMILY_IDS,
  ALBERTSONS_CART_PATH,
} from '../../../src/lib/webview-scripts/albertsons';
import { getStoreScripts } from '../../../src/lib/webview-scripts';
import { WEBVIEW_STORE_IDS } from '../../../src/constants/stores';

describe('getWegmansSearchUrl', () => {
  it('builds the canonical /shop/search?query=... URL', () => {
    expect(getWegmansSearchUrl('salsa')).toBe(
      'https://www.wegmans.com/shop/search?query=salsa'
    );
  });

  it('URL-encodes spaces and special characters', () => {
    expect(getWegmansSearchUrl('Wegmans Pico de Gallo Salsa')).toBe(
      'https://www.wegmans.com/shop/search?query=Wegmans%20Pico%20de%20Gallo%20Salsa'
    );
  });

  it('URL-encodes non-ASCII characters (the diacritic case)', () => {
    // Pickled Jalapeños — the ñ should be percent-encoded.
    expect(getWegmansSearchUrl('Pickled Jalapeños')).toBe(
      'https://www.wegmans.com/shop/search?query=Pickled%20Jalape%C3%B1os'
    );
  });

  it('encodes apostrophes and other commonly-stripped chars', () => {
    // Walmart-style apostrophe was a regression earlier in the session.
    // encodeURIComponent does NOT encode apostrophes by default — verify
    // that's the case so callers know the limitation.
    const url = getWegmansSearchUrl("Ben's Original");
    expect(url).toBe("https://www.wegmans.com/shop/search?query=Ben's%20Original");
  });
});

describe('getWegmansWarmupUrl', () => {
  it('returns the homepage URL', () => {
    expect(getWegmansWarmupUrl()).toBe('https://www.wegmans.com');
  });
});

// MEAL-136. A wrong host here cannot fail visibly: `united` pointed at
// unitedsupermarkets.com, the banner's Squarespace MARKETING site, which 301s to
// the storefront apex DISCARDING the path. So /erums/cart resolved 200 — on a
// marketing home page with no cart on it. Nothing threw, nothing 404'd, and the
// cart-count script posted a confident `count: 0`.
//
// The only defence against that class is naming the expected host in a test, so
// these expectations are transcribed from what each host actually serves rather
// than from the brand's public-facing address. Verified 2026-08-07: every host
// below returns 200 for /erums/cart with ZERO redirects; unitedsupermarkets.com
// is the only one in the family that redirects at all.
describe('getAlbertsonsCartPageUrl', () => {
  // The whole point of the ticket: United's storefront is on shop*, not on the
  // bare brand domain. Spelled out separately from the table so a careless
  // "tidy the host to match the brand name" edit fails on a test that says why.
  it('sends United Supermarkets to the storefront, not the marketing site', () => {
    expect(getAlbertsonsCartPageUrl('united')).toBe(
      'https://www.shopunitedsupermarkets.com/erums/cart'
    );
  });

  it('never routes United through the path-discarding marketing host', () => {
    expect(getAlbertsonsCartPageUrl('united')).not.toContain('www.unitedsupermarkets.com');
  });

  const EXPECTED_CART_URLS: Record<string, string> = {
    albertsons: 'https://www.albertsons.com/erums/cart',
    safeway: 'https://www.safeway.com/erums/cart',
    vons: 'https://www.vons.com/erums/cart',
    jewel_osco: 'https://www.jewelosco.com/erums/cart',
    shaws: 'https://www.shaws.com/erums/cart',
    acme: 'https://www.acmemarkets.com/erums/cart',
    tom_thumb: 'https://www.tomthumb.com/erums/cart',
    randalls: 'https://www.randalls.com/erums/cart',
    pavilions: 'https://www.pavilions.com/erums/cart',
    star_market: 'https://www.starmarket.com/erums/cart',
    haggen: 'https://www.haggen.com/erums/cart',
    carrs: 'https://www.carrsqc.com/erums/cart',
    kings: 'https://www.kingsfoodmarkets.com/erums/cart',
    balduccis: 'https://www.balduccis.com/erums/cart',
    united: 'https://www.shopunitedsupermarkets.com/erums/cart',
  };

  it.each(Object.entries(EXPECTED_CART_URLS))(
    'builds the verified cart URL for %s',
    (storeId, expected) => {
      expect(getAlbertsonsCartPageUrl(storeId)).toBe(expected);
    }
  );

  // A banner added to DOMAIN_MAP without its host being checked against the live
  // platform is the MEAL-136 defect all over again. Fail here so the author has
  // to curl the host and add the row.
  it('has a verified cart URL for every banner in the family', () => {
    expect([...ALBERTSONS_FAMILY_IDS].sort()).toEqual(Object.keys(EXPECTED_CART_URLS).sort());
  });

  it('uses the platform-uniform cart path for every banner', () => {
    for (const storeId of ALBERTSONS_FAMILY_IDS) {
      expect(new URL(getAlbertsonsCartPageUrl(storeId)).pathname).toBe(ALBERTSONS_CART_PATH);
    }
  });

  // The other half of the invariant, and the half nothing actually held until now.
  // The test above starts FROM DOMAIN_MAP, so it is blind to the opposite mistake:
  // a banner added to the app's own store list with no DOMAIN_MAP row. That is the
  // direction that would silently take the unreachable `albertsons.com` fallback.
  //
  // A comment in albertsons.ts used to credit tests/unit/generatedScripts.test.ts
  // with covering this. It does not — its `STORES` is a hand-written seven-entry
  // array local to that file, not src/constants/stores.ts, so the app's real list
  // was unguarded. WEBVIEW_STORE_IDS is the hand-maintained source of truth for
  // which stores run the WebView engine, so it is what a new banner gets added to,
  // and anything in it must resolve to a script bundle.
  // `mockstore` is the local development storefront and deliberately has no
  // scripts — the sheet opens and closes again for it. It is the one member of the
  // set that is not a real banner, so it is named here rather than silently
  // tolerated by a looser assertion.
  it('has scripts for every real store the app says runs the WebView engine', () => {
    const withoutScripts = [...WEBVIEW_STORE_IDS]
      .filter((id) => id !== 'mockstore')
      .filter((id) => !getStoreScripts(id));
    expect(withoutScripts).toEqual([]);
  });
});
