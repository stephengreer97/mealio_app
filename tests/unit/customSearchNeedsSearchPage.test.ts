import { getStoreScripts } from '../../src/lib/webview-scripts';

// The substitute search on the review screen drives the store's own header
// search box, which only exists on a search page. A network run never loads one
// — it finishes parked on the cart — so the sheet has to notice and navigate
// instead. That decision is `isSearchUrl` on the last loaded URL, so these are
// the two answers it has to get right.
describe('isSearchUrl — what the substitute search branches on', () => {
  const heb = getStoreScripts('heb')!;

  it('says NO for the cart page a network run ends on', () => {
    // The exact URL from the run where "Onion" did nothing.
    expect(heb.isSearchUrl('https://www.heb.com/cart?_t=1788283154120')).toBe(false);
  });

  it('says YES for the search page the in-page script needs', () => {
    const url = heb.getSearchUrl!('Onion');
    expect(heb.isSearchUrl(url)).toBe(true);
  });

  it('every store with an in-page search can also be navigated to one', () => {
    // The fallback is only safe where getSearchUrl exists. If a store has a
    // search script but no URL for it, the substitute search on that store is
    // still stuck on whatever page it happens to be on.
    for (const id of ['heb', 'walmart', 'albertsons', 'amazon', 'aldi', 'wegmans']) {
      const s = getStoreScripts(id);
      if (!s?.buildSearchScript) continue;
      expect({ id, hasUrl: typeof s.getSearchUrl === 'function' }).toEqual({ id, hasUrl: true });
    }
  });
});
