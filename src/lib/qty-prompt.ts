// Asking for a quantity without telling the user off first.
//
// Stephen, 2026-09-05: "improve qty selection forcing in choose and review
// products. Instead of red text, how about a red glow around the qty #?"
//
// The colour was not the problem. THE TIMING WAS. Everything went red the
// moment the screen opened -- the label, the number, and a hint line -- before
// the user had done anything wrong. Red that is already on when you arrive
// cannot then mean "you have made a mistake", because it said the same thing
// when you had made none. So it gets ignored, and the dead button beside it
// reads as broken rather than blocked.
//
// There was a second problem underneath it, and it is the one worth fixing
// first: `0` LOOKS LIKE A VALUE SOMEONE CHOSE. A stepper showing 0 says "zero of
// these", not "you have not told me yet". Rendering the unset state as a dash
// removes most of the confusion before any colour is involved.
//
// What replaces it: neutral on arrival, and the alert becomes a REPLY. Press the
// button with no quantity set and the stepper flashes. An alert that answers
// something you did is the only kind that carries meaning.

// A DASH, and it survived the em-dash sweep on purpose (MEAL-224). Stephen's
// rule is about PUNCTUATION in text a user reads; this character is not
// punctuating a sentence, it is the value in a numeric field. "No value yet" is
// what a dash means in a table and has meant for longer than this app, and the
// alternatives tested worse: `?` reads as a question being asked, and an empty
// cell reads as a rendering fault.
/** The stepper shows a dash until a quantity has actually been chosen. */
export const UNSET_QTY_LABEL = '—';

/**
 * What the stepper renders for a quantity.
 *
 * `formatted` is for the stores that sell by weight, where 1 step is not 1 unit
 * and the label is a poundage rather than a count.
 */
export function qtyDisplay(qty: number, formatted?: string | null): string {
  if (!Number.isFinite(qty) || qty <= 0) return UNSET_QTY_LABEL;
  return formatted ?? String(qty);
}

export type QtyGateInput = {
  /** Everything except the quantity is satisfied. */
  otherwiseReady: boolean;
  /** The quantity the user has set. 0 means they have not. */
  qty: number;
};

/**
 * Is the QUANTITY the only thing standing between the user and the button?
 *
 * This is what lets the button stay pressable while refusing to advance. A
 * disabled button cannot answer a press, and an answer is the entire mechanism
 * here -- fireEvent.press does not even reach onPress on a disabled Touchable,
 * which is also why the old "press it and see" was untestable.
 *
 * Only when the quantity is the ONLY blocker. If the user has picked nothing at
 * all, the button has nothing to say beyond "pick something", and flashing the
 * stepper would point at the wrong control.
 */
export function qtyIsTheOnlyBlocker(input: QtyGateInput): boolean {
  return input.otherwiseReady && input.qty <= 0;
}
