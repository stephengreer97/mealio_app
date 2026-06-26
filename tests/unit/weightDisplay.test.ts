import { ingredientWeight, weightLabelLb } from '../../src/lib/weightDisplay';

describe('ingredientWeight', () => {
  it('returns null for a normal count item', () => {
    expect(ingredientWeight({ productQty: 2 })).toBeNull();
  });

  it('dropdown item: shows the absolute purchaseWeight and steps by weightStep', () => {
    const w = ingredientWeight({ purchaseWeight: 2, weightStep: 1, productQty: 1 });
    expect(w).toEqual({ lb: 2, step: 1, mode: 'dropdown' });
  });

  it('dropdown item defaults the step to 0.25 when weightStep is absent', () => {
    expect(ingredientWeight({ purchaseWeight: 0.75 })).toEqual({ lb: 0.75, step: 0.25, mode: 'dropdown' });
  });

  it('stepper item (Deli): weight = productQty × step (1 step = 0.25 lb → 3 qty = 0.75 lb)', () => {
    const w = ingredientWeight({ weightStep: 0.25, productQty: 3 });
    expect(w).toEqual({ lb: 0.75, step: 0.25, mode: 'stepper' });
  });

  it('stepper item falls back to qty when productQty is absent', () => {
    expect(ingredientWeight({ weightStep: 0.25, qty: 2 })?.lb).toBe(0.5);
  });

  it('weightLabelLb trims trailing zeros', () => {
    expect(weightLabelLb(0.75)).toBe('0.75 lb');
    expect(weightLabelLb(2)).toBe('2 lb');
  });
});
