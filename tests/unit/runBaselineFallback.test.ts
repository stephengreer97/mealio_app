import { diffCartItems, CartItem } from '../../src/lib/webview-scripts/cart-count';

// Stephen's 17:34 H-E-B run. Eleven items written, all eleven landed, the cart
// went to 186 — and the done screen said ONE item added: spinach.
//
// Nothing was wrong with the cart. The before-probe failed:
//
//   CART_COUNT phase= before count= null reason= not_cart_page
//   url= https://www.heb.com/
//
// It navigates to /cart to take the run's baseline and landed on the homepage
// instead, so cartItemsBeforeRef stayed EMPTY for the whole run. The done
// screen's breakdown then fell back to whichever write posted last — the
// top-up, which had written exactly one thing.
//
// This is the arithmetic underneath that, at the seam where it goes wrong. The
// component wiring is covered by the run itself; what is worth pinning here is
// that the CHOICE of baseline is the whole difference between "1 added" and
// "11 added" on identical cart reads.

const before: CartItem[] = [
  { name: 'Fresh Lime, Each', qty: 16 },
  { name: 'Fresh Roma Tomato, Avg. 0.29 lb', qty: 16 },
];
/** After the first pass: both existing lines grew, and spinach is still absent. */
const afterFirstPass: CartItem[] = [
  { name: 'Fresh Lime, Each', qty: 18 },
  { name: 'Fresh Roma Tomato, Avg. 0.29 lb', qty: 18 },
];
/** After the top-up: spinach lands too. */
const afterTopUp: CartItem[] = [
  ...afterFirstPass,
  { name: 'Fresh Spinach, 1 Bundle', qty: 1 },
];

const addedUnits = (rows: ReturnType<typeof diffCartItems>) =>
  rows.filter((r) => r.added).reduce((n, r) => n + r.qty, 0);

describe('which baseline the done screen diffs against', () => {
  it('THE RUN’S baseline credits everything the run added', () => {
    const rows = diffCartItems(before, afterTopUp);
    // 2 limes + 2 tomatoes + 1 spinach.
    expect(addedUnits(rows)).toBe(5);
    expect(rows.filter((r) => r.added).map((r) => r.name).sort())
      .toEqual(['Fresh Lime, Each', 'Fresh Roma Tomato, Avg. 0.29 lb', 'Fresh Spinach, 1 Bundle']);
  });

  it('THE TOP-UP’S baseline credits only the top-up — the reported bug', () => {
    // What the screen actually did: the last write's own before/after, which
    // differ by one item however much the run added before it.
    const rows = diffCartItems(afterFirstPass, afterTopUp);
    expect(addedUnits(rows)).toBe(1);
    expect(rows.filter((r) => r.added).map((r) => r.name)).toEqual(['Fresh Spinach, 1 Bundle']);
  });

  it('the first write’s cartBefore IS the run’s baseline, which is why it can stand in', () => {
    // The fix: when the page probe gives nothing, keep the FIRST write's
    // cartBefore and diff every later write against it. The rail reads the cart
    // on every write anyway, so this costs nothing and is the same snapshot the
    // probe was trying to take.
    const rows = diffCartItems(before, afterTopUp);
    expect(addedUnits(rows)).toBe(addedUnits(diffCartItems(before, afterTopUp)));
    expect(addedUnits(rows)).toBeGreaterThan(addedUnits(diffCartItems(afterFirstPass, afterTopUp)));
  });
});
