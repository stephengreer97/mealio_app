// WHICH SUGGESTION A REVIEW SCREEN SHOULD START ON.
//
// It started on the first one, always. On a review — the "Pick a Substitute"
// screen, where Mealio could not match an ingredient and is asking the user to
// choose — that is wrong whenever the store's own best match is out of stock,
// because an out-of-stock product CANNOT BE ADDED there. The user lands on a
// dead end: both buttons disabled, and the screen's only explanation is about
// the quantity, which disappears the moment they set one.
//
// FOUND ON THE PIXEL, 2026-09-04, on a real Wegmans run. The ingredient was
// "Chobani Yogurt, Greek, Whole Milk, Plain"; Wegmans returned "Maia Greek
// Yogurt, Plain, Grass-Fed — Out of stock" first, and four in-stock yogurts
// under it. The screen preselected the one that could not be bought and then
// told the user to set a quantity.
//
// PRESENTATIONAL ONLY, and that matters: this moves a highlight, and nothing
// else. The list is unchanged and in the store's order, out-of-stock rows
// included and still visible — a user who wants to see what the store thought
// was the best match still can. Nothing is added, removed, reordered or made
// addable that was not addable before; the add gate (`canAdd`) is untouched and
// still refuses an out-of-stock pick on its own.
//
// The CHOOSE flow is deliberately excluded. Choosing a product saves it as the
// ingredient's search term for future runs and adds nothing to a cart, so an
// out-of-stock pick is legitimate there — today's stock says nothing about next
// week's — and preselecting past it would quietly steer that choice.
export interface Stockable {
  outOfStock?: boolean;
}

/**
 * The index a review screen should preselect: the first candidate that can
 * actually be added, else 0.
 *
 * 0 when everything is out of stock, because then there is no better answer and
 * the first row is still the store's best match. The screen is a dead end
 * either way in that case — but an honest one, and reviewUnaddableReason says
 * so out loud.
 */
export function firstAddableIdx(candidates: readonly Stockable[]): number {
  const i = candidates.findIndex((c) => !c.outOfStock);
  return i === -1 ? 0 : i;
}

/**
 * Why the add buttons are disabled, in the user's words, or null when they are
 * not disabled for a reason this can explain.
 *
 * The screen had exactly one hint — "Set a quantity above to add this to your
 * cart" — shown only while the quantity was zero. So an out-of-stock selection
 * read as a quantity problem, and once the user solved the quantity problem the
 * screen went silent and stayed disabled. Two dead buttons, no reason, with
 * four in-stock alternatives on the same screen.
 *
 * Order matters: stock first. A quantity is fixable by the person reading it;
 * being out of stock is not, and telling someone to press + on a product that
 * can never be added is worse than saying nothing.
 */
export function reviewUnaddableReason(
  candidate: Stockable | null,
  totalQty: number,
  storeName: string,
): string | null {
  if (candidate?.outOfStock) {
    return `Out of stock at ${storeName}. Pick another product below, or skip this ingredient.`;
  }
  if (candidate && totalQty === 0) return 'Set a quantity above to add this to your cart.';
  return null;
}
