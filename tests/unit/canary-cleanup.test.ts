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
import { buildWegmansClearCartScript } from '../../src/lib/webview-scripts/wegmans-network';

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

  it('Walmart can, measured 2026-09-08 rather than assumed', () => {
    // One line of a real 20-line cart: 200, after 19, target gone. A zero
    // removes here as it does on H-E-B and Instacart -- and unlike Albertsons,
    // where the same shape answers 400 and keeps the line. Three agreeing and
    // one not is exactly why each was measured instead of generalised.
    expect(typeof getNetworkRail('walmart')?.clearCart).toBe('function');
  });

  it('Wegmans can, by a DIFFERENT route and a different verb', () => {
    // Captured from the site's own bin icon on 2026-09-08, then measured:
    // before 16 lines, after 15, the target gone.
    //
    //   PUT /commerce/cart/carts/itemdeletion?api-version=2024-02-19-preview
    //   {"cartData":[{"cartID":..,"cartVersion":..,"lineItems":[{"sku":"59556"}]}]}
    //
    // Nothing about it could have been reached by varying the add: the add is a
    // POST to /lineitems carrying full catalogue-built line objects, a StoreKey
    // and a customer; the deletion is a PUT to its own route naming lines by SKU
    // alone. A quantity of 0 on the add route answers 500 where the identical
    // body with a 1 answers 200.
    const rail = getNetworkRail('wegmans');
    expect(typeof rail?.clearCart).toBe('function');
    const script = rail!.clearCart!('wegmans', { limit: 1 })!;
    expect(script).toContain('itemdeletion');
    expect(script).toContain("method: 'PUT'");
    // By SKU, not by line id -- the line id is the ADD's addressing.
    expect(script).toContain('sku: targets[t].sku');
    expect(script).toContain('stillThere');
  });

  it('the deletion route carries its own api-version', () => {
    // A wrong api-version on this gateway is indistinguishable from a wrong
    // route: both answer nothing at all. The default version is what made the
    // first attempt at the captured route report no_response.
    const script = getNetworkRail('wegmans')!.clearCart!('wegmans', { limit: 1 })!;
    expect(script).toContain("'/commerce/cart/carts/itemdeletion': '2024-02-19-preview'");
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

  it('Walmart writes quantity 0 and re-reads to prove the line went', () => {
    const s2 = getNetworkRail('walmart')!.clearCart!()!;
    expect(s2).toContain('quantity: 0');
    // A store that ignores a zero answers 200 and leaves the line, so the write
    // reporting success proves nothing. Only the re-read does.
    expect(s2).toContain('stillThere');
  });

  it('supports a limit, which is what made the measurement safe', () => {
    const one = getNetworkRail('walmart')!.clearCart!('walmart', { limit: 1 })!;
    expect(one).toContain('var LIMIT = 1');
  });

  it('Instacart writes quantity 0 and does NOT delete', () => {
    const s = getNetworkRail('aldi')!.clearCart!('aldi')!;
    expect(s).toContain('quantity: 0');
    expect(s).not.toContain("method: 'DELETE'");
  });
});

describe('an unreadable cart is never reported as a cleared one', () => {
  // Stephen: "wegmans cart is not empty. There is something wrong with the
  // wegmans clear cart cart read. There are over 60 items in the cart".
  //
  // The clear read the response with a hand-rolled unwrap that reached for a
  // `carts` array Wegmans does not send, fell through to the raw envelope,
  // found no lineItems on it, and posted {ok: true, why: 'already_empty'} over
  // a cart holding sixty-odd lines. Every other reader in that file goes
  // through WG.groceryCart, which knows the lines live under `grocery`.
  //
  // The unwrap was one store's bug. The SHAPE of it was not: three of the five
  // clears turned "I could not read this" into an empty array, and an empty
  // array into success. Two of them also computed `left` by reaching through
  // `|| {}` and `|| []` to a `.length`, which yields 0 -- and 0 means cleared --
  // for a response that could not be parsed at all. That is a rail reporting a
  // full cart as emptied, which is the one answer a cleanup must never give.
  //
  // So the invariant is per rail, not per store: unreadable and empty are
  // different answers, and only one of them is ok.
  const RAILS = ['heb', 'walmart', 'wegmans', 'albertsons', 'aldi'];

  it.each(RAILS)('%s names an unreadable cart separately from an empty one', (id) => {
    const script = getNetworkRail(id)!.clearCart!(id, { limit: 1 })!;
    expect(`${id}: ${script.includes('already_empty')}`).toBe(`${id}: true`);
    const namesUnreadable =
      script.includes('cart_unreadable') || script.includes('cart_shape_unknown');
    expect(`${id}: ${namesUnreadable}`).toBe(`${id}: true`);
  });

  it.each(RAILS)('%s does not let a caught read collapse into an empty cart', (id) => {
    const script = getNetworkRail(id)!.clearCart!(id, { limit: 1 })!;
    // The specific line that caused this: a catch whose handler assigns [].
    expect(`${id}: ${/catch\s*\([^)]*\)\s*\{\s*\w+\s*=\s*\[\]/.test(script)}`).toBe(`${id}: false`);
  });

  it('the Wegmans clear unwraps the cart the way every other reader does', () => {
    // The unwrap bug this carried is what made a cart of 18 lines report as
    // empty, with ok:true, so it stays covered.
    const script = buildWegmansClearCartScript({ limit: 1 });
    expect(script).toContain('WG.groceryCart');
    expect(script).not.toContain('.carts ?');
    expect(script).toContain('cart_shape_unknown');
  });
});

describe('cleanup removes what the run added, not the basket', () => {
  // The canary runs against a real account. Its cart holds real shopping -- the
  // Wegmans one was 18 lines and $237 when this was written -- so a cleanup that
  // "empties the cart" would delete someone's groceries to tidy up after a test.
  // Every rail therefore takes a list of the products the run added, named by
  // the same id that rail's own cart read uses for a line.
  const RAILS = ['heb', 'walmart', 'wegmans', 'albertsons', 'aldi'];

  it.each(RAILS)('%s scopes the removal when given a list', (id) => {
    const script = getNetworkRail(id)!.clearCart!(id, { only: ['abc123', 'def456'] })!;
    expect(`${id}: ${script.includes('abc123')}`).toBe(`${id}: true`);
    expect(`${id}: ${script.includes('def456')}`).toBe(`${id}: true`);
    // The filter has to be CONSULTED, not merely embedded.
    expect(`${id}: ${script.includes('keep(')}`).toBe(`${id}: true`);
  });

  it.each(RAILS)('%s still empties when no list is given', (id) => {
    const script = getNetworkRail(id)!.clearCart!(id)!;
    // An empty list must not read as "remove nothing" -- that would make a
    // measurement run silently do nothing and report success.
    expect(`${id}: ${script.includes('var onlySet = null')}`).toBe(`${id}: true`);
  });
});

describe('a scoped clear is judged by what it targeted', () => {
  // A scoped clear removes the canary's own lines from a cart that still holds
  // the user's real shopping, so "the cart is empty" is the wrong success test:
  // it fails every single time the cleanup works. The first end-to-end canary
  // run reported cleanup ok:false having removed exactly the line it meant to,
  // because Instacart's clear still judged itself that way.
  const RAILS = ['heb', 'walmart', 'wegmans', 'albertsons', 'aldi'];

  it.each(RAILS)('%s reports whether the TARGETS survived', (id) => {
    const script = getNetworkRail(id)!.clearCart!(id, { only: ['x1'] })!;
    const judgesByTargets =
      script.includes('stillThere === 0') || script.includes('left === 0 &&');
    expect(`${id}: ${judgesByTargets}`).toBe(`${id}: true`);
  });

  it('no rail calls an unreadable re-read a success', () => {
    for (const id of RAILS) {
      const script = getNetworkRail(id)!.clearCart!(id, { only: ['x1'] })!;
      // Every verdict must require having actually SEEN the cart back.
      // Every verdict names the thing it had to have SEEN: the re-read itself
      // (`seen`, `after != null`, `afterList != null`, `!!after`, `left != null`).
      // A verdict of the bare form `stillThere === 0` passes when the re-read
      // failed and the loop never ran, which is the fail-open shape.
      // EVERY deciding verdict, not the first `ok:` in the file (which is an
      // early `ok: false` bail-out). A deciding one is any that weighs what
      // survived; each must also name the re-read it had to have seen, or it
      // passes when the re-read failed and the counting loop never ran.
      const deciding = (script.match(/ok:\s*[^,\n]*/g) ?? [])
        .filter((v) => v.includes('stillThere') || v.includes('left ==='));
      const guarded = deciding.length > 0 && deciding.every((v) =>
        ['seen', 'after != null', 'afterList != null', '!!after', 'left != null']
          .some((sentinel) => v.includes(sentinel)));
      expect(`${id}: ${guarded}`).toBe(`${id}: true`);
    }
  });
});
