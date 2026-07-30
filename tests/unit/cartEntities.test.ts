import { decodeHtmlEntities, cartNameMatches, diffCartItems } from '../../src/lib/webview-scripts/cart-count';

// Regression: store cart titles that arrive with literal HTML entities
// ("Chobani&reg;") were shown raw on the done screen and poisoned name matching
// (the entity tokenized to a spurious "reg" word). And the exact-match pass in
// the reconcile was punctuation-sensitive, so "McCormick Gourmet, Organic …"
// (reported) failed to reserve its own "McCormick Gourmet Organic …" cart row,
// letting a sibling ("McCormick Ground Cumin") steal it → spurious re-add.

describe('decodeHtmlEntities', () => {
  it('decodes named entities', () => {
    expect(decodeHtmlEntities('Chobani&reg; Non-Fat Plain Greek Yogurt')).toBe('Chobani® Non-Fat Plain Greek Yogurt');
    expect(decodeHtmlEntities('AT&amp;T Store')).toBe('AT&T Store');
    expect(decodeHtmlEntities('caf&eacute; blend')).toBe('café blend');
  });
  it('decodes numeric entities (decimal + hex)', () => {
    expect(decodeHtmlEntities('a&#174;b')).toBe('a®b');   // ®
    expect(decodeHtmlEntities('a&#xAE;b')).toBe('a®b');
  });
  it('leaves plain strings and unknown entities untouched', () => {
    expect(decodeHtmlEntities('plain title 1.37 oz')).toBe('plain title 1.37 oz');
    expect(decodeHtmlEntities('weird &notareal; token')).toBe('weird &notareal; token');
    expect(decodeHtmlEntities('')).toBe('');
  });
});

describe('cartNameMatches with entity-bearing cart titles', () => {
  it('matches the same product whether the entity is decoded or literal', () => {
    expect(cartNameMatches('Chobani&reg; Non-Fat Plain Greek Yogurt 32oz', 'Chobani Non-Fat Plain Greek Yogurt')).toBe(true);
    expect(cartNameMatches('Chobani® Non-Fat Plain Greek Yogurt 32oz', 'Chobani Non-Fat Plain Greek Yogurt')).toBe(true);
  });
});

describe('diffCartItems decodes titles for display', () => {
  it('renders decoded names on the added rows', () => {
    const rows = diffCartItems([], [{ name: 'Chobani&reg; Non-Fat Plain Greek Yogurt 32oz', qty: 1 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Chobani® Non-Fat Plain Greek Yogurt 32oz');
    expect(rows[0].added).toBe(true);
  });

  it('matches before/after across entity vs decoded so a pre-existing item is not re-flagged', () => {
    const rows = diffCartItems(
      [{ name: 'Chobani&reg; Non-Fat Plain Greek Yogurt 32oz', qty: 1 }],
      [{ name: 'Chobani® Non-Fat Plain Greek Yogurt 32oz', qty: 1 }],
    );
    // Same product, same qty → nothing added (a grey "already there" row only).
    expect(rows.every((r) => !r.added)).toBe(true);
  });
});
