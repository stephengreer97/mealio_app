import { diffCartItems } from '../../src/lib/webview-scripts/cart-count';

describe('diffCartItems', () => {
  it('marks brand-new items as added (green), others stay grey', () => {
    const before = [{ name: 'Tzatziki', qty: 2 }];
    const after = [
      { name: 'Cilantro', qty: 1 },
      { name: 'Tzatziki', qty: 2 },
    ];
    const rows = diffCartItems(before, after);
    expect(rows).toEqual([
      { name: 'Cilantro', qty: 1, added: true },
      { name: 'Tzatziki', qty: 2, added: false },
    ]);
  });

  it('splits a qty increase into a grey (pre-existing) and a green (added) row', () => {
    const before = [{ name: 'Yogurt', qty: 1 }];
    const after = [{ name: 'Yogurt', qty: 3 }];
    const rows = diffCartItems(before, after);
    // Added rows come first.
    expect(rows).toEqual([
      { name: 'Yogurt', qty: 2, added: true },
      { name: 'Yogurt', qty: 1, added: false },
    ]);
  });

  it('lists all added rows before all grey rows', () => {
    const before = [{ name: 'Milk', qty: 1 }];
    const after = [
      { name: 'Milk', qty: 1 },
      { name: 'Eggs', qty: 2 },
    ];
    const rows = diffCartItems(before, after);
    expect(rows.map((r) => [r.name, r.added])).toEqual([
      ['Eggs', true],
      ['Milk', false],
    ]);
  });

  it('treats an empty before-cart as everything added', () => {
    const after = [
      { name: 'Cilantro', qty: 1 },
      { name: 'Saffron', qty: 1 },
    ];
    const rows = diffCartItems([], after);
    expect(rows.every((r) => r.added)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('omits items that were removed during the run (in before, not after)', () => {
    const before = [{ name: 'Bacon', qty: 1 }];
    const after: { name: string; qty: number }[] = [];
    expect(diffCartItems(before, after)).toEqual([]);
  });

  it('unchanged cart yields only grey rows', () => {
    const cart = [
      { name: 'A', qty: 1 },
      { name: 'B', qty: 2 },
    ];
    const rows = diffCartItems(cart, cart);
    expect(rows.every((r) => !r.added)).toBe(true);
    expect(rows).toEqual([
      { name: 'A', qty: 1, added: false },
      { name: 'B', qty: 2, added: false },
    ]);
  });
});
