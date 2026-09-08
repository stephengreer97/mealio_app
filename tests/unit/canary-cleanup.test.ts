/**
 * MEAL-7 cleanup. A canary that leaves state behind poisons its own next run,
 * so emptying the cart is part of the run rather than a nicety.
 *
 * The thing these tests protect is the RESTRAINT: clearCart is optional on the
 * rail interface, and a rail whose removal semantics have not been measured must
 * not define it. Emptying a cart writes to a real basket, and the correct call
 * differs by rail in ways that are measured rather than guessable.
 */
import { getNetworkRail } from '../../src/lib/webview-scripts/network-rail';
import { INSTACART_TENANTS } from '../../src/lib/webview-scripts/instacart';

describe('which rails can empty a cart', () => {
  it('every Instacart tenant can, because the write SETS the line', () => {
    // Measured 2026-09-03 against the real store: a line holding 1 was written
    // to 2 and read back as 2, not 3. So quantity 0 removes it.
    for (const id of Object.keys(INSTACART_TENANTS)) {
      const rail = getNetworkRail(id);
      expect(`${id}: ${typeof rail?.clearCart}`).toBe(`${id}: function`);
      expect(`${id}: ${typeof rail!.clearCart!(id)}`).toBe(`${id}: string`);
    }
  });

  it('H-E-B can, by setting a line to zero', () => {
    // Its quantity is CART-ABSOLUTE: the mutation SETS a line rather than
    // incrementing it, so zero removes it. Not an assumption carried over from
    // another rail -- on Albertsons the same call answers 400 and keeps the line.
    expect(typeof getNetworkRail('heb')?.clearCart).toBe('function');
  });

  it('the Albertsons family can, by DELETE with an add-shaped body', () => {
    // Measured 2026-09-04 in the undo path, which tried five shapes:
    //   qty 0 -> 400 (line stays), DELETE /items/{id} -> 404,
    //   POST /items/delete -> 404, DELETE + {itemIds} -> 400,
    //   DELETE + ADD-SHAPED body -> 200, line gone.
    for (const id of ['albertsons', 'safeway', 'tom_thumb']) {
      expect(`${id}: ${typeof getNetworkRail(id)?.clearCart}`).toBe(`${id}: function`);
    }
  });

  it('Wegmans and Walmart do NOT, because nobody has measured their removal', () => {
    // Wegmans' ADD endpoint adds a line and does nothing to one that exists, so
    // a zero there would return 200, change nothing, and report success.
    // Walmart's absoluteQty was never recorded at all. Both are gaps to close by
    // MEASURING, exactly as the other three were -- not by guessing.
    expect(getNetworkRail('wegmans')?.clearCart).toBeUndefined();
    expect(getNetworkRail('walmart')?.clearCart).toBeUndefined();
  });
});

describe('the clear script itself (Instacart)', () => {
  const script = getNetworkRail('aldi')!.clearCart!('aldi')!;

  it('writes quantity 0 rather than deleting by line id', () => {
    expect(script).toContain('quantity: 0');
    expect(script).toContain('UpdateCartItemsMutation');
  });

  it('keys the update on the ITEM id, not the cart line id', () => {
    // Different id spaces. Getting this backwards is what once made the add
    // path key its held-quantity map on ids no search result could match.
    expect(script).toContain('basketProduct');
    expect(script).toContain('itemId');
  });

  it('reads the cart first rather than trusting a caller list', () => {
    // The canary clears what is THERE, including anything a previous failed run
    // left behind, which is the entire point of cleaning up.
    expect(script).toContain('CartItems');
  });

  it('re-reads afterwards and reports what is LEFT', () => {
    // The cart decides, never the write's own report -- the same rule the add
    // path follows.
    expect(script).toMatch(/left/);
    expect(script).toContain('CART_CLEARED');
  });

  it('is tenant-scoped, so one banner cannot clear another\'s cart', () => {
    const publix = getNetworkRail('publix')!.clearCart!('publix')!;
    expect(publix).toContain("'publix'");
    expect(publix).not.toContain("pickCartFor(list, 'aldi')");
  });
});


describe('each rail clears the way ITS store actually removes things', () => {
  // The point of these three: the correct call is different everywhere, and
  // using one store's method on another is how you get a 200 that changed
  // nothing, or a 400 that leaves the line sitting there.
  it('H-E-B writes quantity 0 and declines weight lines', () => {
    const s = getNetworkRail('heb')!.clearCart!()!;
    expect(s).toContain('quantity: 0');
    // A count line can be set back to zero; a weight line cannot be undone at
    // all (MEAL-200), so they are reported rather than silently left behind.
    expect(s).toContain('declined');
    expect(s).toContain('estimatedWeight');
  });

  it('Albertsons DELETEs with the add-shaped body, never a zero', () => {
    const s = getNetworkRail('albertsons')!.clearCart!()!;
    expect(s).toContain("method: 'DELETE'");
    expect(s).toContain('cartItemsList');
    // A quantity of zero is the shape that answered 400 and kept the line.
    expect(s).not.toContain('qty: 0');
  });

  it('Instacart writes quantity 0 and does NOT delete', () => {
    const s = getNetworkRail('aldi')!.clearCart!('aldi')!;
    expect(s).toContain('quantity: 0');
    expect(s).not.toContain("method: 'DELETE'");
  });
});
