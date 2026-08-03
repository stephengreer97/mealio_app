/**
 * The `serves` rule on a published meal, mirrored from the server.
 *
 * `serves` is **how many people the dish feeds** — not a yield.
 * `POST /api/creator/meals` and `PUT /api/creator/meals/[id]` both refuse
 * anything else, in these words, because recipe pages overwhelmingly publish a
 * `recipeYield` that is a volume ("2 1/2 cups guacamole") or a count of items
 * ("12 pancakes"), and an import that read one of those as a head count would
 * print a wrong number on a card in Discover.
 *
 * Mirrored here the same way `ALL_TAGS` and `MAX_MEAL_TAGS` are: the portal's
 * `serves` field is a plain text input, so without this the server's sentence
 * arrives in an `Alert` after Save Meal has already been pressed — on a form
 * that never said there was a rule.
 *
 * The wording is the server's own, deliberately. A creator who hits this on the
 * phone and again in the admin editor should not have to work out whether they
 * are two different rules.
 */
export const SERVES_PATTERN = /^\d+(-\d+)?$/;

export const SERVES_ERROR = 'Serves must be a number or a range, like 4 or 2-4.';

/**
 * The refusal for a `serves` this save is *changing*, or null.
 *
 * Grandfathered, exactly as the route is. The form posts `serves` on every save
 * whether or not the creator opened it, and meals published before the rule
 * existed can carry "2 1/2 cups" — so checking what is in the box rather than
 * what changed would refuse to save a typo fix in the name, blaming a field they
 * never touched. The client must not be stricter than the route it posts to, or
 * the 400 it exists to pre-empt becomes a refusal to send the request at all.
 *
 * Clearing a legacy value is always allowed: empty is how you take it off.
 */
export function servesChangeError(incoming: string, stored: unknown): string | null {
  const next = incoming.trim();
  const before = stored == null ? '' : String(stored).trim();
  if (next === before) return null;
  if (next && !SERVES_PATTERN.test(next)) return SERVES_ERROR;
  return null;
}
