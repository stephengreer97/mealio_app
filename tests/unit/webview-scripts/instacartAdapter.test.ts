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
  PROVEN_INSTACART_STORE_IDS,
  InstacartTenant,
  getInstacartScripts,
  getInstacartScriptsFor,
  getInstacartSearchUrl,
} from '../../../src/lib/webview-scripts/instacart';
import { getStoreScripts } from '../../../src/lib/webview-scripts';
import { BUNDLED_STORES } from '../../../src/constants/stores';
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
    //
    // Asserted on the KEYS, because StoreScripts no longer has a
    // checkLoginScript field at all to be undefined — no store in the build
    // provides one.
    expect(Object.keys(getInstacartScripts(SYNTHETIC))).not.toContain('checkLoginScript');
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
      expect(`${id}: ${!!rail && !!rail.cartRead(id)}`).toBe(`${id}: true`);
    }
  });

  it('and needs no page of any kind to do it', () => {
    // The header-badge reader that used to be the other half of this lived in
    // cart-count.ts, keyed by store, and was one of six entries a tenant had to
    // remember to appear in. It is gone with the rest of the page reading, and
    // so is the per-store cartPage field that replaced it — every store reads
    // its cart with a request now, so there is no page-reading shape left for a
    // tenant to acquire.
    for (const id of INSTACART_STORE_IDS) {
      expect(Object.keys(getStoreScripts(id)!)).not.toContain('cartPage');
    }
  });

  it('cart probing follows the registry, not a hardcoded banner id', () => {
    // The two tests above pass even against `storeId === 'aldi'` while ALDI is
    // the only tenant, so they cannot catch the regression on their own. Add a
    // second tenant for the length of this test and re-ask: a hardcoded banner
    // check fails here, registry dispatch passes. This is the generalisation
    // MEAL-20 is about — reading a cart belongs to Instacart Storefront, not
    // to ALDI.
    const id = SYNTHETIC.storeId;
    expect(INSTACART_TENANTS[id]).toBeUndefined();   // don't clobber a real one
    INSTACART_TENANTS[id] = SYNTHETIC;
    try {
      expect(getNetworkRail(id)).not.toBeNull();
      // Same platform, same rail OBJECT -- and deliberately NOT the same
      // script. This used to assert the two were byte-for-byte identical, which
      // read as proof of generalisation and was actually the bug written down:
      // Instacart's cart query is account-level and returns carts for every
      // retailer, so a script identical to ALDI's filters a second tenant's
      // carts by ALDI's slug, matches nothing, and reports an empty cart.
      expect(getNetworkRail(id)).toBe(getNetworkRail('aldi'));
      expect(getNetworkRail(id)!.cartRead(id)).not.toBe(getNetworkRail('aldi')!.cartRead('aldi'));
      expect(getNetworkRail(id)!.cartRead(id)).toContain(`'${SYNTHETIC.slug}'`);
    } finally {
      delete INSTACART_TENANTS[id];
    }
    // And the registry is left exactly as it was found.
    expect(INSTACART_TENANTS[id]).toBeUndefined();
    expect(Object.keys(INSTACART_TENANTS)).toEqual(INSTACART_STORE_IDS);
  });

  it('every PROVEN tenant says what proved it, and when', () => {
    // THE GUARD RAIL ON THIS TICKET'S PREMISE, and its terms have changed once
    // for a real reason rather than for convenience.
    //
    // It used to demand captured fixtures, because every selector the adapter
    // used had been read off ALDI and a second banner's DOM was an open
    // question. That automation was deleted on 2026-09-04. There are no
    // selectors left; a banner is answered entirely by its network rail, and
    // the fixture capture tool still only knows the five original stores -- so
    // "capture it before marking it proven" had become impossible to satisfy
    // for exactly the banners this is meant to police.
    //
    // Loosening it to nothing would have been the easy move. Instead the claim
    // has to carry its evidence: what was measured, and on what date. A bare
    // `proven: true` with nothing beside it is what this keeps out, and that
    // was always the actual point.
    for (const id of PROVEN_INSTACART_STORE_IDS) {
      const t = INSTACART_TENANTS[id];
      const why = (t.provenOn || '').trim();
      expect(`${id}: ${why.length > 40}`).toBe(`${id}: true`);
      // A date, so the claim can be aged rather than merely believed.
      expect(`${id}: ${/\d{4}-\d{2}-\d{2}/.test(why)}`).toBe(`${id}: true`);
    }
  });

  it('would reject a bare proven:true, rather than passing vacuously', () => {
    const id = SYNTHETIC.storeId;
    expect(INSTACART_TENANTS[id]).toBeUndefined();
    INSTACART_TENANTS[id] = { ...SYNTHETIC, proven: true };
    try {
      const t = INSTACART_TENANTS[id];
      expect((t.provenOn || '').length > 40).toBe(false);
    } finally {
      delete INSTACART_TENANTS[id];
    }
  });

  it('a PENDING tenant is offered to nobody', () => {
    // The other half, and the reason narrowing the check above is safe rather
    // than a loophole. A pending banner exists so a WebView can be opened at it
    // and somebody can sign in; it must not reach a picker on the way. The
    // bundled catalog is the offline fallback, so a name here would offer the
    // store to every user with no network before anyone had proven anything.
    const pending = Object.values(INSTACART_TENANTS).filter((t) => !t.proven).map((t) => t.storeId);
    expect(pending.length).toBeGreaterThan(0);
    const bundled = new Set(BUNDLED_STORES.map((s) => s.id));
    for (const id of pending) expect(`${id} bundled: ${bundled.has(id)}`).toBe(`${id} bundled: false`);
  });

  it('but a pending tenant DOES get scripts, or it could never be signed into', () => {
    // The whole point of the pending state. Withholding the scripts would mean
    // the WebView never opens, which means nobody can log in, which means the
    // measurements can never be taken — the deadlock this state exists to break.
    for (const id of Object.keys(INSTACART_TENANTS)) {
      expect(`${id}: ${getStoreScripts(id) !== null}`).toBe(`${id}: true`);
    }
  });
});
