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

  it('Wegmans does NOT, and that is the point', () => {
    // Its endpoint adds a line and does nothing to one that already exists
    // (measured, recorded in the automation config). Writing quantity 0 there
    // would return 200, change nothing, and report success -- which is worse
    // than not offering the operation.
    expect(getNetworkRail('wegmans')?.clearCart).toBeUndefined();
  });

  it('no rail with unmeasured removal semantics defines it', () => {
    for (const id of ['heb', 'walmart', 'albertsons', 'safeway', 'tom_thumb']) {
      const rail = getNetworkRail(id);
      if (!rail) continue;
      expect(`${id}: ${rail.clearCart === undefined}`).toBe(`${id}: true`);
    }
  });
});

describe('the clear script itself', () => {
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
