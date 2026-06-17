import { cartNameMatches, findUnaddedItems } from '../../src/lib/webview-scripts/cart-count';

describe('cartNameMatches', () => {
  it('matches identical titles', () => {
    expect(cartNameMatches('O Organics Rice White Basmati - 32 Oz', 'O Organics Rice White Basmati - 32 Oz')).toBe(true);
  });
  it('matches despite minor size/weight suffix differences', () => {
    expect(cartNameMatches("Hunt's Crushed Tomatoes - 28 Oz", "Hunt's Crushed Tomatoes")).toBe(true);
  });
  it('does not match different products', () => {
    expect(cartNameMatches('Fresh Cilantro, 1 Bunch', 'H-E-B Classic Granola, 14 oz')).toBe(false);
  });
  it('is false on empty input', () => {
    expect(cartNameMatches('', 'Yogurt')).toBe(false);
    expect(cartNameMatches('Yogurt', '')).toBe(false);
  });
});

describe('findUnaddedItems', () => {
  it('flags a reported-added product that is absent from the cart', () => {
    const reported = ['O Organics Rice White Basmati - 32 Oz', "Hunt's Crushed Tomatoes - 28 Oz"];
    const inCart = ['O Organics Rice White Basmati - 32 Oz']; // Hunt's silently failed
    expect(findUnaddedItems(reported, inCart)).toEqual(["Hunt's Crushed Tomatoes - 28 Oz"]);
  });

  it('returns empty when every reported item is in the cart', () => {
    const reported = ['Fresh Cilantro, 1 Bunch', 'Fage Total 0% Greek Yogurt'];
    const inCart = ['Fresh Cilantro, 1 Bunch', 'Fage Total 0% Nonfat Plain Greek Yogurt, 32 oz'];
    expect(findUnaddedItems(reported, inCart)).toEqual([]);
  });

  it('treats an empty cart as everything missing', () => {
    const reported = ['A Product', 'B Product'];
    expect(findUnaddedItems(reported, [])).toEqual(['A Product', 'B Product']);
  });
});
