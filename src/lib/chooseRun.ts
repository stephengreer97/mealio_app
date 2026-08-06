// Is a cart run Choose Products, or is it shopping? (MEAL-84)
//
// One definition, because two surfaces ask it about the same selection one
// screen apart: the My Meals floating button — which labels the run and decides
// whether the first-run explainer is due — and `WebViewCartSheet`, which titles
// the screen that button opens.
//
// They used to disagree. The button asked "does any *meal* still need
// choosing?"; the sheet asked "does *everything* still need choosing?". Select
// one chosen meal and one unchosen one and you got a button reading "Choose
// Products for 1 meal", an explainer about matching ingredients, and then a
// screen titled "Add to Cart".
//
// The sheet's answer is the right one and is the one kept here. A run holding
// even one already-chosen item adds that item to a real cart, so it is shopping.
// Calling shopping "setup" is the same confusion MEAL-84 exists to remove,
// pointed the more expensive way round.
//
// Kroger does not use this: there, choosing and adding are separate flows and a
// meal with anything unchosen cannot reach the cart review at all, so "any meal
// still needs choosing" is the right routing question on that path.

/** Anything with a chosen store product on it, or not. */
export interface ChooseRunItem {
  searchTerm?: string | null;
}

/** True when nothing in the run has a chosen product yet. */
export function isChooseRun(items: ReadonlyArray<ChooseRunItem>): boolean {
  return items.length > 0 && items.every((it) => !it.searchTerm);
}
