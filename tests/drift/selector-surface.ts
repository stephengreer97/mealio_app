// What the drift census is allowed to look at (MEAL-30).
//
// The census is only as trustworthy as its answer to "which parts of the markup
// does our code actually read?". This module is that answer, and it is deliberately
// derived rather than written down: each entry points at the SAME selector table
// the store's injected scripts build from, resolved through the SAME config
// accessor. A selector added to a store script is censused on the next run without
// anyone editing this file; a selector deleted from one stops being censused.
//
// WHY NOT JUST READ BUNDLED_AUTOMATION_CONFIG
// Because it is not the whole surface. HEB's config entry publishes exactly one
// selector (`title`); the other twelve — `productCard`, `cardContainer`,
// `searchGrid`, the whole search-UI chain — live only as call-site fallbacks in
// heb.ts. Censusing the config alone would miss the selectors most likely to break.
//
// WHY GO THROUGH selectorsFor() RATHER THAN READING THE FALLBACKS DIRECTLY
// Because a selector's effective value is a merge, and only that accessor knows the
// precedence. Today it is `call-site fallbacks < stores.<id>.selectors`. MEAL-21
// inserts a platform layer in the middle — `platforms.<platform>.selectors`,
// inherited by every banner that declares the platform — and going through the
// accessor means this census follows that change on its own. It notably means a
// drift finding against an Albertsons or Instacart selector is a finding against
// every banner on the platform, whether or not that banner has its own fixtures.
//
// The `platform` argument selectorsFor() grew in MEAL-21 is intentionally NOT
// passed here, and that is now verified rather than assumed: MEAL-21 has landed,
// and `platformFor(storeId, declared)` returns `current.stores[storeId]?.platform
// ?? declared` while BUNDLED_AUTOMATION_CONFIG declares `platform` on every store
// entry. So the two-argument call resolves the platform layer from config, and the
// third argument only matters for a banner with no config entry at all — which by
// definition has no fixtures either, so the census would not reach it.

import { selectorsFor } from '../../src/lib/automation-config';
import { FIXTURE_CAPTURE_STORES } from '../../src/lib/fixture-capture-config';
import { SEL_FALLBACKS as HEB_FALLBACKS } from '../../src/lib/webview-scripts/heb';
import { SEL_FALLBACKS as WALMART_FALLBACKS } from '../../src/lib/webview-scripts/walmart';
import { SEL_FALLBACKS as WEGMANS_FALLBACKS } from '../../src/lib/webview-scripts/wegmans';
import { SEL_FALLBACKS as AMAZON_FALLBACKS } from '../../src/lib/webview-scripts/amazon-fresh';
import { SEL_FALLBACKS as ALBERTSONS_FALLBACKS } from '../../src/lib/webview-scripts/albertsons';
import { INSTACART_TENANTS, selFallbacks } from '../../src/lib/webview-scripts/instacart';

export interface StoreSurface {
  /** Fixture directory under tests/fixtures/, and the key in FIXTURE_CAPTURE_STORES. */
  fixtureDir: string;
  /**
   * The automation-config store id the scripts resolve selectors under. NOT always
   * the fixture directory name: Amazon Fresh captures live in `amazon-fresh/` but
   * the config key is `amazon`, and the whole Albertsons family resolves under the
   * single key `albertsons` while its captures live under the reference banner.
   */
  configKey: string;
  /** The call-site fallback table, exactly as the store's scripts pass it. */
  fallbacks: Record<string, string>;
  /** Whether this store has a JSON extraction surface to census (see next-data.ts). */
  nextData?: boolean;
  /** Why this store's captures and its config key differ, when they do. */
  note?: string;
}

export const STORE_SURFACES: StoreSurface[] = [
  {
    fixtureDir: 'heb',
    configKey: 'heb',
    fallbacks: HEB_FALLBACKS,
    // MEAL-13 added the `__NEXT_DATA__` reader. HEB is the only store with two
    // extraction surfaces, so it is the only one with a JSON census.
    nextData: true,
  },
  { fixtureDir: 'walmart', configKey: 'walmart', fallbacks: WALMART_FALLBACKS },
  { fixtureDir: 'wegmans', configKey: 'wegmans', fallbacks: WEGMANS_FALLBACKS },
  {
    fixtureDir: 'amazon-fresh',
    configKey: 'amazon',
    fallbacks: AMAZON_FALLBACKS,
    note: 'captures under amazon-fresh/, selectors under the config key `amazon`',
  },
  {
    fixtureDir: 'albertsons',
    configKey: 'albertsons',
    fallbacks: ALBERTSONS_FALLBACKS,
    note:
      'one selector table serves all 15 Albertsons banners; the captures are ACME, ' +
      'so a finding here is a finding for every banner on the platform',
  },
  {
    fixtureDir: 'aldi',
    configKey: 'aldi',
    // ALDI is an Instacart Storefront tenant, and its fallbacks are a function of
    // the tenant rather than a constant — `cardLink` weaves in the /store/ slug.
    // Resolved per banner for that reason; a second Instacart banner registered
    // with fixtures gets its own entry here, not a share of this one.
    fallbacks: selFallbacks(INSTACART_TENANTS.aldi),
    note: 'Instacart Storefront tenant; selectors are the platform table with ALDI\'s slug woven in',
  },
];

/**
 * The selectors a store's scripts will actually use, as raw CSS strings.
 *
 * selectorsFor() returns JS string LITERALS (it exists to be interpolated into an
 * injected script), so each value is JSON-parsed back to the string the browser
 * will be handed. Reading it through that accessor rather than merging by hand is
 * what keeps the census honest about override precedence — see the module header.
 */
export function resolveSelectors(surface: StoreSurface): Record<string, string> {
  const literals = selectorsFor(surface.configKey, surface.fallbacks);
  const out: Record<string, string> = {};
  for (const [key, literal] of Object.entries(literals)) {
    out[key] = JSON.parse(literal) as string;
  }
  return out;
}

/**
 * The URL a fixture was captured from, or undefined for a file with no entry in
 * FIXTURE_CAPTURE_STORES. Used by the JSON census to know which search term the
 * freshness gate should be proving.
 */
export function captureUrlFor(surface: StoreSurface, fixtureFile: string): string | undefined {
  const store = FIXTURE_CAPTURE_STORES[surface.fixtureDir];
  return store?.fixtures.find((f) => f.file === fixtureFile)?.url;
}

export function surfaceFor(fixtureDir: string): StoreSurface | undefined {
  return STORE_SURFACES.find((s) => s.fixtureDir === fixtureDir);
}
