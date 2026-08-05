// Tests for the Instacart Storefront platform adapter (MEAL-20).
//
// WHAT THESE PROVE, AND WHAT THEY DO NOT
// They prove the adapter's SEAM is complete: swap the tenant and every piece of
// tenant-specific text in the injected JavaScript moves with it, with nothing
// left hardcoded to ALDI. That is a real property and it is the thing the
// refactor was for.
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

/** Rewrite the synthetic tenant's tokens back to ALDI's. If the adapter is fully
 *  parameterized, the result is ALDI's script exactly. Longest tokens first so a
 *  shorter one can't chew a prefix of a longer one. */
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
      // The whole point: after substituting the tenant's own origin/slug/flag
      // back to ALDI's, the two scripts are the same text. Any residue — a
      // hardcoded aldi.us, a stray /store/aldi/ — shows up here as a diff.
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
