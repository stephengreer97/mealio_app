// The rule behind MEAL-218: when may the screen tell the user off?
import { qtyDisplay, qtyIsTheOnlyBlocker, UNSET_QTY_LABEL } from '../../src/lib/qty-prompt';

describe('what the stepper shows', () => {
  it('shows a dash, not a zero, when nothing has been chosen', () => {
    // "0" reads as a quantity someone picked. The dash is the whole reason the
    // colour was doing so much work before: the number looked like an answer.
    expect(qtyDisplay(0)).toBe(UNSET_QTY_LABEL);
    expect(qtyDisplay(0)).not.toBe('0');
  });

  it('shows the number once there is one', () => {
    expect(qtyDisplay(1)).toBe('1');
    expect(qtyDisplay(3)).toBe('3');
  });

  it('prefers the store\'s own label for a weight item', () => {
    expect(qtyDisplay(2, '0.50 lb')).toBe('0.50 lb');
  });

  it('does not show a weight label for an unset weight item', () => {
    // A poundage of zero is still "you have not told me yet", and printing
    // "0.00 lb" makes it look like a deliberate choice.
    expect(qtyDisplay(0, '0.00 lb')).toBe(UNSET_QTY_LABEL);
  });

  it.each([NaN, -1, Infinity])('treats %p as unset rather than rendering it', (q) => {
    expect(qtyDisplay(q as number)).toBe(UNSET_QTY_LABEL);
  });
});

describe('when the quantity is the only thing missing', () => {
  it('is true when everything else is ready', () => {
    expect(qtyIsTheOnlyBlocker({ otherwiseReady: true, qty: 0 })).toBe(true);
  });

  it('is false once a quantity is set', () => {
    expect(qtyIsTheOnlyBlocker({ otherwiseReady: true, qty: 1 })).toBe(false);
  });

  it('is false when something ELSE is also missing', () => {
    // The button would otherwise flash the stepper at someone who has not
    // picked a product yet — pointing at the wrong control, which is worse
    // than saying nothing.
    expect(qtyIsTheOnlyBlocker({ otherwiseReady: false, qty: 0 })).toBe(false);
  });
});
