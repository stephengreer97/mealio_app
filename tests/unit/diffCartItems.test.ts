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

  // ── Sold-by-weight lines (MEAL-148) ────────────────────────────────────────
  //
  // A weight line carries no unit count, so the diff classifies it by POUNDAGE.
  // What the reconcile then checks an expectation against is the poundage THIS
  // RUN added — the row's own `weight` is the cart's total and belongs to the
  // user, not to the run.
  describe('weight lines carry the run\'s own poundage, not just the line total', () => {
    const deli = (lb: number) => ({
      name: 'H-E-B Deli Roast Beef, lb',
      qty: 1,
      isWeight: true,
      weight: lb,
      weightOptions: [0.25, 0.5, 0.75, 1],
    });

    it('a brand-new weight line credits the run with all of it', () => {
      const [green] = diffCartItems([], [deli(0.5)]);
      expect(green).toMatchObject({ added: true, weight: 0.5, addedWeight: 0.5 });
    });

    it('a line the user had already started credits the run with the INCREASE only', () => {
      // 0.25 lb was theirs; the run clicked twice more. Reading `weight` here
      // would call a 0.5 lb order covered by a line that only gained 0.5 — true
      // by luck — and would call it covered even if the run had added nothing.
      const [green] = diffCartItems([deli(0.25)], [deli(0.75)]);
      expect(green).toMatchObject({ added: true, weight: 0.75, addedWeight: 0.5 });
    });

    it('carries the row\'s option ladder through to the reconcile', () => {
      const [green] = diffCartItems([], [deli(0.5)]);
      expect(green.weightOptions).toEqual([0.25, 0.5, 0.75, 1]);
    });

    it('a weight line that did not grow is grey and claims no added poundage', () => {
      const [grey] = diffCartItems([deli(0.5)], [deli(0.5)]);
      expect(grey.added).toBe(false);
      expect(grey.addedWeight).toBeUndefined();
    });

    it('float noise in the subtraction does not leak into the delta', () => {
      const [green] = diffCartItems([deli(0.1)], [deli(0.3)]);
      expect(green.addedWeight).toBe(0.2);
    });
  });
});
