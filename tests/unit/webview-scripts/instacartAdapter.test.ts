// Tests for the Instacart Storefront platform adapter (MEAL-20).
//
// WHAT THESE PROVE, AND WHAT THEY DO NOT
// They prove the adapter's TENANT TOKENS round-trip: swap the tenant and the
// origin and the /store/{slug}/ path segment move with it, so the pieces the
// ticket parameterized are genuinely parameterized, and that every tenant is
// wired to the rail and the registry.
//
// They do NOT prove any second storefront works. The synthetic tenant below is
// a fiction on a .test domain; no traffic from Publix, Sprouts, or any other
// banner has ever been run through this adapter. A tenant whose API answers
// differently would pass every test here and fail on a phone.
//
// The surface they cover is much smaller than it was, because the adapter is:
// every injected script it used to build is gone, the last of them on
// 2026-09-04. ALDI's real behaviour is covered against captured traffic in
// tests/fixture-tests/aldi-network.spec.ts.

import * as fs from 'fs';
import * as path from 'path';

import { getNetworkRail } from '../../../src/lib/webview-scripts/network-rail';
import {
  INSTACART_TENANTS,
  INSTACART_STORE_IDS,
  InstacartTenant,
  getInstacartScripts,
  getInstacartScriptsFor,
  getInstacartSearchUrl,
} from '../../../src/lib/webview-scripts/instacart';
import { getStoreScripts } from '../../../src/lib/webview-scripts';
import {
  buildCartCountScript,
  buildCartPageCountScript,
  buildOpenCartScript,
} from '../../../src/lib/webview-scripts/cart-count';
import { __resetAutomationConfigForTests } from '../../../src/lib/automation-config';
import { BUNDLED_AUTOMATION_CONFIG } from '../../../src/lib/automation-config/schema';

beforeEach(() => __resetAutomationConfigForTests());
afterAll(() => __resetAutomationConfigForTests());

const ALDI = INSTACART_TENANTS.aldi;

/** A tenant that does not exist, on a reserved-for-testing TLD. Deliberately not
 *  named after a real banner: nothing here constitutes support for one. */
const SYNTHETIC: InstacartTenant = {
  storeId: 'exampleco',
  origin: 'https://shop.example-co.test',
  slug: 'example-co',
  domain: 'example-co.test',
};

describe('the tenant seam is complete', () => {
  it('every URL and the domain follow the tenant', () => {
    const s = getInstacartScripts(SYNTHETIC);
    expect(s.storeUrl).toBe('https://shop.example-co.test');
    expect(s.loginUrl).toBe('https://shop.example-co.test');
    expect(s.cartUrl).toBe('https://shop.example-co.test');
    expect(s.railUrl).toBe('https://shop.example-co.test/robots.txt');
    expect(s.domain).toBe('example-co.test');
    expect(getInstacartSearchUrl(SYNTHETIC, 'sour cream')).toBe(
      'https://shop.example-co.test/store/example-co/s?k=sour%20cream',
    );
  });

  it('mentions no other tenant anywhere in what it produces', () => {
    // The claim the round-trip test used to make about five injected scripts,
    // now made about what is left: a hardcoded aldi.us or /store/aldi/ in the
    // adapter would surface here.
    const s = getInstacartScripts(SYNTHETIC);
    const surface = [s.storeUrl, s.loginUrl, s.cartUrl, s.railUrl ?? '', s.domain,
                     getInstacartSearchUrl(SYNTHETIC, 'milk'), s.getSearchUrl!('milk')].join(' ');
    expect(surface).not.toContain('aldi');
  });

  it('injects no script of its own — the rail does all of it', () => {
    // Every one this adapter used to build is gone: the extractor, the add
    // click, the in-page search, the fused search-and-add, the pool worker, and
    // finally (2026-09-04) the login check that opened the hamburger menu and
    // read its text. The tenant's storefront GraphQL answers all of it.
    expect(getInstacartScripts(SYNTHETIC).checkLoginScript).toBeUndefined();
  });

  it("isSearchUrl matches this tenant's store pages and not another's", () => {
    const s = getInstacartScripts(SYNTHETIC);
    expect(s.isSearchUrl('https://shop.example-co.test/store/example-co/s?k=milk')).toBe(true);
    expect(s.isSearchUrl('https://shop.example-co.test/store/example-co/storefront')).toBe(true);
    expect(s.isSearchUrl('https://www.aldi.us/store/aldi/s?k=milk')).toBe(false);
    expect(s.isSearchUrl('https://shop.example-co.test/help')).toBe(false);
  });
});

describe('tenant registry', () => {
  it('routes its store ids through getStoreScripts', () => {
    for (const id of INSTACART_STORE_IDS) {
      const viaRegistry = getStoreScripts(id);
      expect(viaRegistry).not.toBeNull();
      expect(viaRegistry!.domain).toBe(INSTACART_TENANTS[id].domain);
    }
  });

  it('returns null for a store id it does not serve', () => {
    expect(getInstacartScriptsFor('heb')).toBeNull();
  });

  it('every tenant has an automation-config entry (its remote kill switch)', () => {
    // A tenant with no config entry still works, but has no escape hatch: it
    // cannot be disabled or re-selectored without an App Store release.
    for (const id of INSTACART_STORE_IDS) {
      expect(`${id}: ${!!BUNDLED_AUTOMATION_CONFIG.stores[id]}`).toBe(`${id}: true`);
    }
  });

  it('every tenant can probe a cart', () => {
    // WebViewCartSheet picks its cart-probe branch by asking for a script:
    // inline (in-page panel), cart-page (navigate then count), or open-cart
    // (click then count). A tenant that answers null to ALL THREE gets no
    // branch at all — no before baseline, no after count, no cart breakdown on
    // the done screen — and reports nothing, because "no script" is not an
    // error anywhere in that component. Silent degradation is the failure mode
    // this asserts against.
    for (const id of INSTACART_STORE_IDS) {
      // THE RAIL is the cart probe now. The side panel this used to check —
      // open the drawer, count what is rendered, close it — was deleted on
      // 2026-09-04 along with the rest of the DOM automation, and it had been
      // unreachable before that: both call sites sat after the rail's early
      // return. The invariant is unchanged and still worth having, so it asks
      // the thing that does the reading.
      const rail = getNetworkRail(id);
      expect(`${id}: ${!!rail && !!rail.cartRead()}`).toBe(`${id}: true`);
    }
  });

  it('every tenant can read the header cart badge', () => {
    // The other half of the probe: buildCartCountScript reads the header badge
    // for the before/after snapshot. Its EXTRACTORS map is per-store, so a
    // tenant with no entry silently returns null — which callers must treat as
    // "count unknown, skip validation", taking the silent-miss check offline
    // for that banner without saying so.
    for (const id of INSTACART_STORE_IDS) {
      expect(`${id}: ${!!buildCartCountScript(id)}`).toBe(`${id}: true`);
    }
  });

  it('cart probing follows the registry, not a hardcoded banner id', () => {
    // The two tests above pass even against `storeId === 'aldi'` while ALDI is
    // the only tenant, so they cannot catch the regression on their own. Add a
    // second tenant for the length of this test and re-ask: a hardcoded banner
    // check fails here, registry dispatch passes. This is the generalisation
    // MEAL-20 is about — the cart side panel and the header badge belong to
    // Instacart Storefront, not to ALDI.
    const id = SYNTHETIC.storeId;
    expect(INSTACART_TENANTS[id]).toBeUndefined();   // don't clobber a real one
    INSTACART_TENANTS[id] = SYNTHETIC;
    try {
      expect(getNetworkRail(id)).not.toBeNull();
      expect(buildCartCountScript(id)).not.toBeNull();
      // Same platform, same rail and same badge: byte-for-byte what ALDI gets.
      expect(getNetworkRail(id)!.cartRead()).toBe(getNetworkRail('aldi')!.cartRead());
      expect(buildCartCountScript(id)).toBe(buildCartCountScript('aldi'));
    } finally {
      delete INSTACART_TENANTS[id];
    }
    // And the registry is left exactly as it was found.
    expect(INSTACART_TENANTS[id]).toBeUndefined();
    expect(Object.keys(INSTACART_TENANTS)).toEqual(INSTACART_STORE_IDS);
  });

  it('every tenant has captured fixtures behind it', () => {
    // The guard rail on this ticket's whole premise. Instacart serving the same
    // URL contract to several banners does not mean it serves them the same DOM,
    // and every selector in the adapter was read off ALDI. A tenant registered
    // without fixtures is an untested guess pretending to be a supported store —
    // capture it (`npm run capture -- <storeId>`) before adding it here.
    for (const id of INSTACART_STORE_IDS) {
      const dir = path.resolve(__dirname, '..', '..', 'fixtures', id);
      const has = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.html'));
      expect(`${id}: ${has}`).toBe(`${id}: true`);
    }
  });
});
