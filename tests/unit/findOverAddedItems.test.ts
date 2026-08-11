import { findOverAddedItems } from '../../src/lib/webview-scripts/cart-count';
import type { CartRow } from '../../src/lib/webview-scripts/cart-count';

const row = (name: string, qty: number, isWeight = false): CartRow => ({ name, qty, added: true, isWeight });

// Safety net: any unit that landed in the cart but that no intended item
// accounts for is an over-add / unintended product and must be surfaced,
// regardless of the bug that caused it.
describe('findOverAddedItems', () => {
  it('flags a double-added product (2 in cart, 1 intended)', () => {
    const over = findOverAddedItems(
      [row('McCormick Gourmet Organic Ground Turmeric, 1.37 Oz', 2)],
      [{ name: 'McCormick Gourmet, Organic Ground Turmeric, 1.37 Oz', expectedQty: 1 }],
    );
    expect(over).toEqual([{ name: 'McCormick Gourmet Organic Ground Turmeric, 1.37 Oz', qty: 1 }]);
  });

  it('flags an entirely unintended product', () => {
    const over = findOverAddedItems(
      [row('Milk', 1), row('Impulse Candy Bar', 1)],
      [{ name: 'Milk', expectedQty: 1 }],
    );
    expect(over).toEqual([{ name: 'Impulse Candy Bar', qty: 1 }]);
  });

  it('returns nothing when the cart matches intent exactly', () => {
    const over = findOverAddedItems(
      [row('Milk', 2), row('Eggs', 1)],
      [{ name: 'Milk', expectedQty: 2 }, { name: 'Eggs', expectedQty: 1 }],
    );
    expect(over).toEqual([]);
  });

  it('does not flag a legitimately requested higher quantity', () => {
    const over = findOverAddedItems(
      [row('Sparkling Water', 6)],
      [{ name: 'Sparkling Water', expectedQty: 6 }],
    );
    expect(over).toEqual([]);
  });

  it('siblings with similar names each keep their own row (no false overage)', () => {
    const over = findOverAddedItems(
      [row('McCormick Ground Cumin, 4.5 oz', 1), row('McCormick Gourmet Organic Ground Turmeric, 1.37 Oz', 1)],
      [
        { name: 'McCormick Ground Cumin, 4.5 oz', expectedQty: 1 },
        { name: 'McCormick Gourmet, Organic Ground Turmeric, 1.37 Oz', expectedQty: 1 },
      ],
    );
    expect(over).toEqual([]);
  });

  it('treats a weight line as presence (an intended weight item consumes its row)', () => {
    const over = findOverAddedItems(
      [row('Fresh Roma Tomato', 1, true)],
      [{ name: 'Fresh Roma Tomato', expectedQty: 3, isWeight: true }],
    );
    expect(over).toEqual([]);
  });

  it('flags an unintended extra weight line', () => {
    const over = findOverAddedItems(
      [row('Fresh Roma Tomato', 1, true), row('Fresh Avocado', 1, true)],
      [{ name: 'Fresh Roma Tomato', expectedQty: 3, isWeight: true }],
    );
    expect(over).toEqual([{ name: 'Fresh Avocado', qty: 1 }]);
  });

  // MEAL-148. An increment-style item (counted in units, added by clicking a
  // by-the-pound line N times) lands ON a weight line. Reporting that line as
  // unintended tells the user to delete the deli meat they asked for.
  it('lets an increment-style count item account for the weight line it was clicked onto', () => {
    const over = findOverAddedItems(
      [row('H-E-B Deli Roast Beef, lb', 1, true)],
      [{ name: 'H-E-B Deli Roast Beef, lb', expectedQty: 2, weightStepLb: 0.25 }],
    );
    expect(over).toEqual([]);
  });

  it('lets it account for ONE line only', () => {
    const over = findOverAddedItems(
      [row('H-E-B Deli Roast Beef, lb', 1, true), row('H-E-B Deli Roast Beef, lb', 1, true)],
      [{ name: 'H-E-B Deli Roast Beef, lb', expectedQty: 2, weightStepLb: 0.25 }],
    );
    expect(over).toEqual([{ name: 'H-E-B Deli Roast Beef, lb', qty: 1 }]);
  });

  it('still takes its count units first — the weight line is the fallback, not the first claim', () => {
    // Both a count row and a weight row bear the name. The count row is the
    // ordinary claim; taking the weight line first would leave the count units
    // looking unintended.
    const over = findOverAddedItems(
      [row('H-E-B Deli Roast Beef, lb', 2), row('H-E-B Deli Roast Beef, lb', 1, true)],
      [{ name: 'H-E-B Deli Roast Beef, lb', expectedQty: 2, weightStepLb: 0.25 }],
    );
    expect(over).toEqual([{ name: 'H-E-B Deli Roast Beef, lb', qty: 1 }]);
  });

  it('leaves an ordinary count item unable to claim a weight line, exactly as before', () => {
    const over = findOverAddedItems(
      [row('H-E-B Deli Roast Beef, lb', 1, true)],
      [{ name: 'H-E-B Deli Roast Beef, lb', expectedQty: 2 }],
    );
    expect(over).toEqual([{ name: 'H-E-B Deli Roast Beef, lb', qty: 1 }]);
  });
});
