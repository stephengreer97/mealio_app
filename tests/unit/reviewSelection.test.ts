// A review screen must not open on a product it cannot add.
//
// FOUND ON THE PIXEL, 2026-09-04, driving a real Wegmans run rather than a
// fixture. The ingredient was "Chobani Yogurt, Greek, Whole Milk, Plain".
// Wegmans returned "Maia Greek Yogurt, Plain, Grass-Fed — Out of stock" as its
// best match, with four in-stock yogurts under it. The screen preselected the
// out-of-stock one, and:
//
//   • both add buttons were disabled, because an out-of-stock product cannot be
//     added on a review — which is correct;
//   • the only explanation on screen was "Set a quantity above to add this to
//     your cart", which is about something else;
//   • setting a quantity removed even that, leaving two grey buttons and no
//     reason at all.
//
// The way out was "Skip this ingredient", four in-stock alternatives away.
import { firstAddableIdx, reviewUnaddableReason } from '../../src/lib/review-selection';

const inStock = (name: string) => ({ productName: name, outOfStock: false });
const oos = (name: string) => ({ productName: name, outOfStock: true });

describe('where a review screen opens', () => {
  it('opens on the first product it can actually add', () => {
    // The Wegmans list, in the order the store returned it.
    const wegmans = [
      oos('Maia Greek Yogurt, Plain, Grass-Fed'),
      inStock('Chobani Nonfat Plain Greek Yogurt'),
      inStock('Chobani Whole Milk Plain Greek Yogurt'),
    ];
    expect(firstAddableIdx(wegmans)).toBe(1);
  });

  it('still opens on the first row when everything is in stock', () => {
    // The normal case, and it must not move: the store's best match stays the
    // default whenever it is buyable.
    expect(firstAddableIdx([inStock('a'), inStock('b')])).toBe(0);
  });

  it('skips a RUN of out-of-stock products, not just one', () => {
    expect(firstAddableIdx([oos('a'), oos('b'), inStock('c')])).toBe(2);
  });

  it('opens on the first row when nothing can be added', () => {
    // No better answer exists, and the first row is still the store's best
    // match. reviewUnaddableReason is what makes that honest.
    expect(firstAddableIdx([oos('a'), oos('b')])).toBe(0);
  });

  it('treats a missing flag as in stock', () => {
    // Not every store's search reports stock. Absent must not read as "out" —
    // that would move the default on every candidate at those stores.
    expect(firstAddableIdx([{ productName: 'a' } as never, inStock('b')])).toBe(0);
  });

  it('handles an empty list without inventing an index', () => {
    expect(firstAddableIdx([])).toBe(0);
  });
});

describe('why the add button is disabled', () => {
  it('says out of stock, and names the store', () => {
    const why = reviewUnaddableReason(oos('Maia Greek Yogurt'), 1, 'Wegmans');
    expect(why).toContain('Out of stock at Wegmans');
    // And points at the way forward that is on the same screen.
    expect(why).toMatch(/pick another/i);
  });

  it('says it even once a quantity has been set', () => {
    // THE BUG. The old hint was gated on `totalQty === 0`, so solving the
    // quantity made the screen go silent while staying disabled.
    expect(reviewUnaddableReason(oos('x'), 3, 'Wegmans')).toMatch(/out of stock/i);
  });

  it('asks for a quantity when that is genuinely what is missing', () => {
    expect(reviewUnaddableReason(inStock('x'), 0, 'Wegmans'))
      .toBe('Set a quantity above to add this to your cart.');
  });

  it('puts stock before quantity, because only one of them is the user\'s to fix', () => {
    // Both wrong at once: telling someone to press + on a product that can
    // never be added is worse than saying nothing.
    expect(reviewUnaddableReason(oos('x'), 0, 'Wegmans')).toMatch(/out of stock/i);
  });

  it('says nothing when the add is fine', () => {
    expect(reviewUnaddableReason(inStock('x'), 1, 'Wegmans')).toBeNull();
  });

  it('says nothing when there is no candidate to talk about', () => {
    expect(reviewUnaddableReason(null, 0, 'Wegmans')).toBeNull();
  });
});
