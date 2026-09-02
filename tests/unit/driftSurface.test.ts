// Guards on WHAT the drift census watches (MEAL-30).
//
// The census is only worth running if it covers the surface. Three ways it could
// silently stop doing so, each pinned here:
//   • a store's fixtures get committed and nobody registers the store, so its
//     captures are censused by nothing;
//   • a field is added to HEB's JSON mapper and nobody adds it to the field list,
//     so that field can vanish unnoticed;
//   • the freshness gate transcribed into next-data.ts drifts away from the one
//     heb.ts actually ships.

import * as fs from 'fs';
import * as path from 'path';

import { FIXTURE_CAPTURE_STORES } from '../../src/lib/fixture-capture-config';
import { STORE_SURFACES, resolveSelectors, captureUrlFor, surfaceFor } from '../drift/selector-surface';
import { ITEM_FIELDS, SKU_FIELDS, censusNextData, expectedTermFromUrl, nextDataFieldPaths } from '../drift/next-data';
import { splitSelectorBranches } from '../drift/census';

const HEB_SRC = path.resolve(__dirname, '..', '..', 'src', 'lib', 'webview-scripts', 'heb.ts');
const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixtures');

describe('store surface coverage', () => {
  it('registers every store that has committed fixtures', () => {
    const dirs = fs
      .readdirSync(FIXTURE_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const registered = STORE_SURFACES.map((s) => s.fixtureDir).sort();
    // A store added to tests/fixtures/ without an entry in STORE_SURFACES gets no
    // drift coverage at all, and nothing else would say so — the drift spec would
    // simply not have a case for it and would stay green.
    expect(registered).toEqual(dirs);
  });

  it('names a fixture-capture config for every registered store', () => {
    // captureUrlFor() reads from FIXTURE_CAPTURE_STORES keyed on fixtureDir. A
    // store missing there loses the JSON freshness gate silently.
    for (const surface of STORE_SURFACES) {
      expect(FIXTURE_CAPTURE_STORES[surface.fixtureDir]).toBeDefined();
    }
  });

  it('resolves a non-empty, parseable selector table for every store', () => {
    for (const surface of STORE_SURFACES) {
      const selectors = resolveSelectors(surface);
      expect(Object.keys(selectors).length).toBeGreaterThan(0);
      for (const [key, selector] of Object.entries(selectors)) {
        expect(typeof selector).toBe('string');
        expect(selector.length).toBeGreaterThan(0);
        // Every branch must be something a browser will accept. A selector that
        // throws is recorded as `invalid`, which is a real finding — but it should
        // never be true of what we ship.
        for (const branch of splitSelectorBranches(selector)) {
          expect(`${surface.fixtureDir}.${key}: ${branch}`).toBe(`${surface.fixtureDir}.${key}: ${branch}`);
          expect(branch.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('resolves the Albertsons table under the family key, not the capture directory', () => {
    // The captures are ACME's but the selectors resolve under `albertsons`, shared
    // by all 15 banners. Getting this wrong would census an empty table and report
    // nothing forever.
    const albertsons = surfaceFor('albertsons')!;
    expect(albertsons.configKey).toBe('albertsons');
    expect(resolveSelectors(albertsons).atc).toBe('button[aria-label^="Add 1 unit of"]');
  });

  it('resolves the Amazon Fresh table under its config key rather than its directory', () => {
    const amazon = surfaceFor('amazon-fresh')!;
    expect(amazon.configKey).toBe('amazon');
    expect(resolveSelectors(amazon).cardB).toBe('[data-component-type="s-search-result"]');
  });

  it("weaves ALDI's own slug into the Instacart platform table", () => {
    // The Instacart fallbacks are a function of the tenant; a census that treated
    // the platform as having one static table would record the wrong cardLink.
    expect(resolveSelectors(surfaceFor('aldi')!).cardLink).toBe('a[href*="/store/aldi/products/"]');
  });

  it('finds the capture URL for a fixture that has one', () => {
    expect(captureUrlFor(surfaceFor('heb')!, 'search-results-tortillas.html')).toContain('q=mission%20flour%20tortillas');
    // Synthetic and hand-trimmed fixtures have no capture entry; undefined is the
    // right answer, and the JSON census reads it as "no term to gate on".
    expect(captureUrlFor(surfaceFor('heb')!, 'search-results-stale-hoisin.html')).toBeUndefined();
  });
});

// "HEB JSON field surface" lived here: a census that kept the __NEXT_DATA__
// mapper inside buildExtractProductsScript in step with the fields it read, and
// the term normalizer in step with __hebNorm. Both were part of the DOM
// extractor, deleted 2026-09-01. H-E-B reads products from its own API now, and
// heb-network-search.spec.ts covers that mapping against real payloads.

describe('expectedTermFromUrl', () => {
  it('reads and normalizes the q parameter', () => {
    expect(expectedTermFromUrl('https://www.heb.com/search?q=mission%20flour%20tortillas')).toBe(
      'mission flour tortillas',
    );
    expect(expectedTermFromUrl('https://www.heb.com/search?q=sour+cream')).toBe('sour cream');
  });

  it('is empty for a URL with no q, which the gate reads as unverifiable', () => {
    expect(expectedTermFromUrl('https://www.heb.com/cart')).toBe('');
    expect(expectedTermFromUrl(undefined)).toBe('');
  });

  it('survives a malformed escape rather than throwing mid-census', () => {
    expect(expectedTermFromUrl('https://www.heb.com/search?q=%E0%A4%A')).toBe('');
  });
});

describe('censusNextData', () => {
  const payload = (searchTerm: string, items: unknown[]) =>
    JSON.stringify({
      props: { pageProps: { searchTerm, layout: { visualComponents: [{ __typename: 'SearchGridV2', items }] } } },
    });

  it('records an absent payload without treating it as a failure', () => {
    // Several committed fixtures are hand-trimmed and carry no __NEXT_DATA__ at all.
    expect(censusNextData(null, 'https://www.heb.com/search?q=x')).toEqual({ payload: 'absent' });
  });

  it('records an unparseable payload', () => {
    expect(censusNextData('{not json', undefined)).toEqual({ payload: 'unparseable' });
  });

  it('records no-grid for a page whose payload has no search grid', () => {
    const cart = JSON.stringify({ props: { pageProps: { layout: { visualComponents: [{ __typename: 'Banner' }] } } } });
    expect(censusNextData(cart, 'https://www.heb.com/cart')).toEqual({ payload: 'no-grid' });
  });

  it('finds the grid by component id when the typename is renamed', () => {
    // heb.ts keeps the id prefix as a second signal; the census must too, or it
    // would report a payload loss that the extractor would have shrugged off.
    const nd = JSON.stringify({
      props: {
        pageProps: {
          searchTerm: 'sour cream',
          layout: { visualComponents: [{ __typename: 'SearchGridV3', id: 'searchGridV2:abc', items: [{ id: 1 }] }] },
        },
      },
    });
    expect(censusNextData(nd, 'https://www.heb.com/search?q=sour+cream').payload).toBe('grid');
  });

  it('calls a payload fresh when its term equals the captured search term', () => {
    const c = censusNextData(payload('sour cream', [{ id: 1 }]), 'https://www.heb.com/search?q=sour+cream');
    expect(c.freshness).toBe('fresh');
  });

  it('calls a payload stale when its term is a different search', () => {
    // This really happens: the out-of-stock capture shows one search in the DOM and
    // names another in the payload, because HEB runs spaSearch and the payload is
    // the initial render.
    const c = censusNextData(payload('seasonal', [{ id: 1 }]), 'https://www.heb.com/search?q=chicken+thighs');
    expect(c.freshness).toBe('stale');
  });

  it('calls a payload unverifiable when there is no captured term to compare', () => {
    const c = censusNextData(payload('seasonal', [{ id: 1 }]), 'https://www.heb.com/some-page');
    expect(c.freshness).toBe('unverifiable');
  });

  it('buckets field presence across the item list', () => {
    const items = [
      { decodedDisplayName: 'A', SKUs: [{ customerFriendlySize: '16 oz' }] },
      { decodedDisplayName: 'B', SKUs: [{}] },
      { decodedDisplayName: 'C', SKUs: [{}] },
      { decodedDisplayName: 'D', SKUs: [{}] },
    ];
    const c = censusNextData(payload('x', items), 'https://www.heb.com/search?q=x');
    expect(c.fields!.decodedDisplayName).toBe('common');
    expect(c.fields!['SKUs.0.customerFriendlySize']).toBe('rare');
    expect(c.fields!.inventory).toBe('none');
  });

  it('counts a nested field present when any array element carries it', () => {
    const onSale = { SKUs: [{ contextPrices: [{ context: 'ONLINE', salePrice: { formattedAmount: '$3.99' } }] }] };
    const fullPrice = { SKUs: [{ contextPrices: [{ context: 'CURBSIDE', listPrice: { formattedAmount: '$4.29' } }] }] };
    const items = [onSale, fullPrice, fullPrice, fullPrice, fullPrice];
    const c = censusNextData(payload('x', items), 'https://www.heb.com/search?q=x');
    expect(c.fields!['SKUs.0.contextPrices.*.context']).toBe('common');
    expect(c.fields!['SKUs.0.contextPrices.*.salePrice.formattedAmount']).toBe('rare');
  });

  it('treats an empty array as absent, not present', () => {
    // `carouselImageUrls: []` must not read as "the field is there" — the mapper
    // checks length before using it.
    const items = [{ carouselImageUrls: [] }, { carouselImageUrls: ['u'] }, { carouselImageUrls: [] }, { carouselImageUrls: [] }];
    const c = censusNextData(payload('x', items), 'https://www.heb.com/search?q=x');
    expect(c.fields!.carouselImageUrls).toBe('rare');
  });

  it('censuses every declared field path for a grid payload', () => {
    const c = censusNextData(payload('x', [{ id: 1 }]), 'https://www.heb.com/search?q=x');
    expect(Object.keys(c.fields!).sort()).toEqual(nextDataFieldPaths().sort());
  });
});
