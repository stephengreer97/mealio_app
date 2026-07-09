import { diffCartItems, findShortAddedItems } from '../../src/lib/webview-scripts/cart-count';

// addedRows in production are the added (green) rows from diffCartItems, whose
// qty is the delta this run added. Build them the same way here.
const addedRows = (items: { name: string; qty: number }[]) =>
  diffCartItems([], items).filter((r) => r.added);

describe('findShortAddedItems', () => {
  it('flags a product that landed short of the requested quantity', () => {
    // The real ALDI case: asked for 3 broccoli + 3 tomatoes, the store capped
    // tomatoes at 2.
    const rows = addedRows([
      { name: 'Organic Broccoli', qty: 3 },
      { name: 'Happy Harvest Crushed Tomatoes', qty: 2 },
    ]);
    const shorts = findShortAddedItems(rows, [
      { name: 'Organic Broccoli', expectedQty: 3 },
      { name: 'Happy Harvest Crushed Tomatoes', expectedQty: 3 },
    ]);
    expect(shorts).toEqual([
      { name: 'Happy Harvest Crushed Tomatoes', got: 2, expected: 3 },
    ]);
  });

  it('returns nothing when every item met its requested quantity', () => {
    const rows = addedRows([{ name: 'Organic Broccoli', qty: 3 }]);
    expect(findShortAddedItems(rows, [{ name: 'Organic Broccoli', expectedQty: 3 }])).toEqual([]);
  });

  it('excludes fully-missing items (got 0) — those are findUnaddedItems territory', () => {
    const rows = addedRows([{ name: 'Organic Broccoli', qty: 3 }]);
    const shorts = findShortAddedItems(rows, [
      { name: 'Organic Broccoli', expectedQty: 3 },
      { name: 'Saffron', expectedQty: 1 }, // never made it into the cart
    ]);
    expect(shorts).toEqual([]);
  });

  it('shares added units across same-named items instead of double-claiming', () => {
    // Two distinct audited items both resolve to "Cilantro"; the cart only
    // gained 3 units total. First reserves 2, second can only claim the last 1.
    const rows = addedRows([{ name: 'Cilantro', qty: 3 }]);
    const shorts = findShortAddedItems(rows, [
      { name: 'Cilantro', expectedQty: 2 },
      { name: 'Cilantro', expectedQty: 2 },
    ]);
    expect(shorts).toEqual([{ name: 'Cilantro', got: 1, expected: 2 }]);
  });

  it('treats a missing/zero expectedQty as at least 1', () => {
    const rows = addedRows([{ name: 'Milk', qty: 1 }]);
    // expectedQty 0 normalizes to 1, which is satisfied → not short.
    expect(findShortAddedItems(rows, [{ name: 'Milk', expectedQty: 0 }])).toEqual([]);
  });
});
