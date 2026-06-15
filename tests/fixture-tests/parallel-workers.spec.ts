// Parallel-search worker scripts — every store that opts into the worker pool
// must, when its buildWorkerScript runs against its captured search-results
// fixture, post a WORKER_RESULT carrying the worker's id and ≥1 candidate.
//
// This is the unit-level proof that enabling parallel search for a store
// actually extracts products (the live WAF behavior is validated separately
// in dev). Wegmans/ALDI use purpose-built workers; HEB/Walmart/Albertsons/
// Amazon use the generic buildExtractWorker wrapper around their existing
// EXTRACT_PRODUCTS_SCRIPT.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { storeFixtures } from './_helpers';

// Every store that opts into the pool must expose both hooks. Cheap, no
// Playwright — assert presence for all six.
const ALL_PARALLEL_STORES = ['heb', 'walmart', 'acme', 'amazon', 'aldi', 'wegmans'];
describe('parallel-search opt-in', () => {
  it.each(ALL_PARALLEL_STORES)('%s exposes getSearchUrl + buildWorkerScript', (storeId) => {
    const scripts = getStoreScripts(storeId)!;
    expect(typeof scripts.getSearchUrl).toBe('function');
    expect(typeof scripts.buildWorkerScript).toBe('function');
    expect(scripts.getSearchUrl!('tortillas')).toContain('tortillas');
  });
});

// Heavy Playwright extraction proof — only the FOUR newly-enabled stores.
// ALDI and Wegmans workers are already exercised in their own spec files;
// re-running them here just adds concurrent-browser load (and flakes the
// shared local run), so they're covered by the presence check above only.
const STORES: Array<{ dir: string; storeId: string; url: string }> = [
  { dir: 'heb', storeId: 'heb', url: 'https://www.heb.com/search?q=tortillas' },
  { dir: 'walmart', storeId: 'walmart', url: 'https://www.walmart.com/search?q=tortillas' },
  { dir: 'albertsons', storeId: 'acme', url: 'https://www.acmemarkets.com/shop/search-results.html?q=tortillas' },
  { dir: 'amazon-fresh', storeId: 'amazon', url: 'https://www.amazon.com/s?k=tortillas&i=amazonfresh' },
];

describe.each(STORES)('parallel worker — $dir', ({ dir, storeId, url }) => {
  const { itWithFixture } = storeFixtures(dir);
  const scripts = getStoreScripts(storeId)!;

  itWithFixture(
    'search-results-tortillas.html',
    'worker posts WORKER_RESULT with its workerId and ≥1 candidate',
    async (runner) => {
      await runner.inject(scripts.buildWorkerScript!(2));
      const result = await runner.waitForMessage('WORKER_RESULT', 15_000);
      expect(result.workerId).toBe(2);
      expect(Array.isArray(result.candidates)).toBe(true);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].productName).toBeTruthy();
    },
    { url },
  );
});
