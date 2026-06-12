// Cart-count snapshot script tests (task #69 — silent-miss detection).
//
// Each store's badge extractor runs against the same captured search-results
// fixture it was derived from, asserting the EXACT count visible in that
// capture. If a store redesigns its header badge, the recaptured fixture
// makes the matching test fail loudly here.

import { buildCartCountScript } from '../../src/lib/webview-scripts/cart-count';
import { storeFixtures } from './_helpers';

// fixtureDir → script storeId → count visible in the captured page.
const CASES: Array<{ dir: string; storeId: string; expected: number }> = [
  { dir: 'heb', storeId: 'heb', expected: 2 },
  { dir: 'walmart', storeId: 'walmart', expected: 4 },
  { dir: 'aldi', storeId: 'aldi', expected: 6 },
  { dir: 'wegmans', storeId: 'wegmans', expected: 2 },
  { dir: 'amazon-fresh', storeId: 'amazon', expected: 4 },
];

describe.each(CASES)('CART_COUNT $dir', ({ dir, storeId, expected }) => {
  const { itWithFixture } = storeFixtures(dir);
  itWithFixture(
    'search-results-tortillas.html',
    `reads the header badge → ${expected}`,
    async (runner) => {
      await runner.inject(buildCartCountScript(storeId)!);
      const msg = await runner.waitForMessage('CART_COUNT', 8_000);
      expect(msg.count).toBe(expected);
    },
  );
});

describe('CART_COUNT albertsons (best effort — badge is client-rendered)', () => {
  const { itWithFixture } = storeFixtures('albertsons');
  itWithFixture(
    'search-results-tortillas.html',
    'returns null on the static capture (live verification pending), never throws',
    async (runner) => {
      await runner.inject(buildCartCountScript('albertsons')!);
      const msg = await runner.waitForMessage('CART_COUNT', 8_000);
      // The hdr-crt-txt-plus badge is empty in static HTML. If a recapture
      // ever shows a real count here, tighten this to the exact number.
      expect(msg.count).toBeNull();
    },
  );
});

describe('CART_COUNT unsupported store', () => {
  it('returns null script for stores without a verified extractor', () => {
    expect(buildCartCountScript('kroger')).toBeNull();
  });
});
