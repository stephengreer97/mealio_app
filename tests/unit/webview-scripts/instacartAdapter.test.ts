// Tests for the Instacart Storefront platform adapter (MEAL-20).
//
// WHAT THESE PROVE, AND WHAT THEY DO NOT
// They prove the adapter's TENANT TOKENS round-trip: swap the tenant and the
// origin, the /store/{slug}/ path segment and the login-guard name all move
// with it, so the pieces the ticket parameterized are genuinely parameterized.
//
// They do NOT prove "no ALDI string is left hardcoded", and should not be read
// that way. retenant() below substitutes exactly those three tokens; any
// ALDI-shaped text containing none of them passes invisibly. Known residue that
// slips straight through, all of it deliberate:
//   • English word lists — /ask or search/i, /^Add 1 (?:item|ct)\s+(.+)/i
//   • #search-bar-input, a platform id rather than a configured selector
//   • a USD-only price regex /\$\d+\.\d{2}/, in three places
//   • the CRITICAL / COMMON word sets in the inlined scorer, tuned with a
//     comment that says "ALDI has limited selection"
// These are defensible as platform-level for a white-labelled storefront whose
// only banner is US and English, and none is a bug today. They are the work a
// genuinely different banner would surface, and they are not covered here.
//
// They do NOT prove any second storefront works. The synthetic tenant below is
// a fiction on a .test domain; no HTML from Publix, Sprouts, or any other banner
// has ever been captured or run through this adapter. A tenant whose DOM differs
// from ALDI's would pass every test in this file and fail on a phone. Only
// captured fixtures (tests/fixtures/<storeId>/) can close that gap.
//
// ALDI's own behaviour is covered elsewhere and more strongly:
//   • tests/fixture-tests/aldi.spec.ts     — behaviour against real ALDI HTML
//   • tests/unit/webview-scripts/aldiGeneratedScripts.test.ts
//                                          — the injected JS, pinned byte for byte

import * as fs from 'fs';
import * as path from 'path';

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
  buildInlineCartScript,
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

/** All injectable scripts a tenant produces, keyed for readable failures. */
function scriptsOf(t: InstacartTenant): Record<string, string> {
  const s = getInstacartScripts(t);
  return {
    checkLogin: s.checkLoginScript,
    extract: s.extractProductsScript,
    addToCart: s.buildAddToCartScript('Sour Cream 16 oz', null, 2),
    search: s.buildSearchScript('sour cream'),
    searchAndAdd: s.buildSearchAndAddScript('sour cream', 2, null),
    worker: s.buildWorkerScript!(1),
  };
}

/** The window guard name the adapter derives for a tenant. Mirrors loginFlag()
 *  in instacart.ts, which is module-private. */
const loginFlagOf = (t: InstacartTenant) => `__${t.storeId}LoginCheckActive`;

/** Rewrite the synthetic tenant's THREE tokens back to ALDI's. If those tokens
 *  are fully parameterized, the result is ALDI's script exactly. Longest tokens
 *  first so a shorter one can't chew a prefix of a longer one.
 *
 *  Note the scope: this catches a hardcoded aldi.us or /store/aldi/, and nothing
 *  else. ALDI-derived text that mentions no token — English copy, a USD price
 *  regex, the tuned scorer word lists — round-trips unchanged and passes. See
 *  the file header. */
function retenant(src: string): string {
  return src
    .split(SYNTHETIC.origin).join(ALDI.origin)
    .split(`/store/${SYNTHETIC.slug}/`).join(`/store/${ALDI.slug}/`)
    .split(loginFlagOf(SYNTHETIC)).join(loginFlagOf(ALDI));
}

describe('the tenant seam is complete', () => {
  const aldiScripts = () => scriptsOf(ALDI);
  const synthScripts = () => scriptsOf(SYNTHETIC);

  it.each(Object.keys(scriptsOf(ALDI)))(
    '%s differs from ALDI only by tenant tokens',
    (name) => {
      // After substituting the tenant's own origin/slug/flag back to ALDI's, the
      // two scripts are the same text — so a hardcoded aldi.us or a stray
      // /store/aldi/ shows up here as a diff. That is the whole claim; it is not
      // a claim that nothing ALDI-derived remains (see the file header).
      expect(retenant(synthScripts()[name])).toBe(aldiScripts()[name]);
    },
  );

  it('no script mentions a tenant it was not built for', () => {
    for (const [name, src] of Object.entries(synthScripts())) {
      expect(`${name}: ${src.includes('aldi')}`).toBe(`${name}: false`);
    }
  });

  it('URLs, domain and selectors all follow the tenant', () => {
    const s = getInstacartScripts(SYNTHETIC);
    expect(s.storeUrl).toBe('https://shop.example-co.test');
    expect(s.loginUrl).toBe('https://shop.example-co.test');
    expect(s.cartUrl).toBe('https://shop.example-co.test');
    expect(s.domain).toBe('example-co.test');
    expect(getInstacartSearchUrl(SYNTHETIC, 'sour cream')).toBe(
      'https://shop.example-co.test/store/example-co/s?k=sour%20cream',
    );
    // The product-card selector is slug-derived, not a shared constant — this is
    // what stops one banner's cards from being scraped on another's page.
    expect(scriptsOf(SYNTHETIC).extract).toContain('a[href*=\\"/store/example-co/products/\\"]');
  });

  it('isSearchUrl matches this tenant\'s store pages and not another\'s', () => {
    const s = getInstacartScripts(SYNTHETIC);
    expect(s.isSearchUrl('https://shop.example-co.test/store/example-co/s?k=milk')).toBe(true);
    expect(s.isSearchUrl('https://shop.example-co.test/store/example-co/storefront')).toBe(true);
    expect(s.isSearchUrl('https://www.aldi.us/store/aldi/s?k=milk')).toBe(false);
    expect(s.isSearchUrl('https://shop.example-co.test/help')).toBe(false);
  });

  it('gives each tenant its own login guard, so two cannot clobber each other', () => {
    expect(scriptsOf(ALDI).checkLogin).toContain('window.__aldiLoginCheckActive');
    expect(scriptsOf(SYNTHETIC).checkLogin).toContain('window.__examplecoLoginCheckActive');
  });

  it('lets a banner override login wording without touching search or add', () => {
    // Login is where the ticket expects banners to diverge (membership gates,
    // SSO). Prove that divergence is expressible, and contained.
    const gated: InstacartTenant = {
      ...SYNTHETIC,
      signedOutWords: 'become a member|sign in',
      signedInWords: 'my membership|sign out',
    };
    const base = scriptsOf(SYNTHETIC);
    const withGate = scriptsOf(gated);
    expect(withGate.checkLogin).toContain('/become a member|sign in/');
    expect(withGate.checkLogin).not.toBe(base.checkLogin);
    // Everything else is byte-identical — the override is scoped to login.
    for (const name of ['extract', 'addToCart', 'search', 'searchAndAdd', 'worker']) {
      expect(withGate[name]).toBe(base[name]);
    }
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
      const probes =
        !!buildInlineCartScript(id) || !!buildCartPageCountScript(id) || !!buildOpenCartScript(id);
      expect(`${id}: ${probes}`).toBe(`${id}: true`);
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
      expect(buildInlineCartScript(id)).not.toBeNull();
      expect(buildCartCountScript(id)).not.toBeNull();
      // Same platform, same panel and same badge: byte-for-byte what ALDI gets.
      expect(buildInlineCartScript(id)).toBe(buildInlineCartScript('aldi'));
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
