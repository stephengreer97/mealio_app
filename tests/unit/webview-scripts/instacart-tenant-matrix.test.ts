/**
 * ONE RAIL, EVERY TENANT.
 *
 * Stephen, after the third login-detection regression in a row: "do we need to
 * decouple all instacart stores from each other to prevent these regression
 * issues?"
 *
 * The measured answer is no, and this file is what replaces the decoupling.
 * The per-tenant surface is two fields, `origin` and `slug`; everything else --
 * the prelude, the operation cache, the GraphQL caller, the cart matching -- is
 * one shared body of code, and the sharing is the ASSET rather than the
 * problem. Publix runs on ALDI's seeded operation hashes (`harvested: 0`,
 * `ok: true`), so five separate scripts would mean five sets of hashes to
 * harvest, four of which have never been harvested successfully.
 *
 * What actually produced the regressions was shared code with SINGLE-TENANT
 * TESTS: every change to the login heuristic was validated against ALDI
 * fixtures, ALDI stayed green, and Publix broke unseen. Roughly thirty test
 * files name aldi; one named the other three banners at all.
 *
 * So the difference goes on the rail and the rail gets tested across every
 * tenant in the registry. This file iterates INSTACART_TENANTS rather than
 * listing banners, which means a tenant added tomorrow is covered the moment it
 * is registered, and cannot be added without these properties holding.
 */
import {
  INSTACART_TENANTS,
  isInstacartStore,
} from '../../../src/lib/webview-scripts/instacart';
import {
  INSTACART_RAIL,
  buildAldiSessionScript,
  buildAldiCartReadScript,
} from '../../../src/lib/webview-scripts/aldi-network';

const TENANTS = Object.entries(INSTACART_TENANTS);

describe('the Instacart rail, across every registered tenant', () => {
  it('registers more than one tenant, or this whole file proves nothing', () => {
    expect(TENANTS.length).toBeGreaterThan(1);
  });

  describe.each(TENANTS)('%s', (storeId, tenant) => {
    it('matches carts on ITS OWN slug, never ALDI’s', () => {
      const script = buildAldiSessionScript(storeId);
      expect(script).toContain(`pickCartFor(list, '${tenant.slug}')`);
      if (storeId !== 'aldi') {
        // The exact regression: a Publix run hunting an ALDI cart among Publix
        // carts, finding none, and reporting a signed-in user as signed out.
        expect(script).not.toContain("pickCartFor(list, 'aldi')");
      }
    });

    it('reads ITS OWN cart, which is the half that was still broken', () => {
      // cartRead took no store id at all until this was written, so all four
      // non-ALDI banners filtered an account-level cart query by ALDI's slug,
      // matched nothing, and reported no rows -- a before-snapshot that was
      // permanently missing, on the path that feeds the add arithmetic.
      const script = buildAldiCartReadScript({ storeId });
      expect(script).toContain(`'${tenant.slug}'`);
      if (storeId !== 'aldi') expect(script).not.toContain("pickCartFor(list, 'aldi')");
    });

    it('is reachable through the rail dispatcher', () => {
      expect(isInstacartStore(storeId)).toBe(true);
      expect(() => INSTACART_RAIL.sessionScript(storeId)).not.toThrow();
      expect(() => INSTACART_RAIL.cartRead(storeId)).not.toThrow();
    });

    it('declares the two fields the shared code actually branches on', () => {
      expect(tenant.slug).toMatch(/^[a-z0-9-]+$/);
      expect(tenant.origin).toMatch(/^https:\/\//);
      expect(tenant.storeId).toBe(storeId);
    });
  });

  it('gives every tenant a DISTINCT slug', () => {
    // Two tenants sharing a slug would match each other's carts, which is the
    // same failure as the ALDI fallback wearing a different hat.
    const slugs = TENANTS.map(([, t]) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  describe('a store id that went missing on the way in', () => {
    // Not a hypothetical. sessionScript() took no argument at all, storeId came
    // through undefined, `?? 'aldi'` turned that into ALDI, and the run
    // operated on the wrong banner without a word. A throw is strictly better
    // than a guess here: a run that fails to start is visible and costs
    // nothing, and a run that reads or writes the wrong basket is neither.
    it('refuses null rather than guessing ALDI', () => {
      expect(() => INSTACART_RAIL.sessionScript(null)).toThrow(/no store id/i);
      expect(() => INSTACART_RAIL.cartRead(null)).toThrow(/no store id/i);
    });

    it('refuses undefined rather than guessing ALDI', () => {
      expect(() => INSTACART_RAIL.sessionScript(undefined)).toThrow(/no store id/i);
      expect(() => INSTACART_RAIL.cartRead(undefined)).toThrow(/no store id/i);
    });

    it('refuses an id it does not know, and says what it does know', () => {
      expect(() => INSTACART_RAIL.sessionScript('zz_not_a_real_store')).toThrow(
        /no Instacart tenant/i,
      );
      // The message has to name the known ids, because the failure it reports
      // is almost always a typo or a dropped id rather than a genuinely new
      // store, and the reader needs to see that immediately.
      try {
        INSTACART_RAIL.sessionScript('zz_not_a_real_store');
      } catch (e) {
        expect(String((e as Error).message)).toContain('aldi');
      }
    });
  });
});
