// The one sentence Mealio has to land, and the words it lands in.
//
// ─── This file is a copy, with one deliberate difference. ────────────────────
// The original is `lib/pitch.ts` in `mealio_central` (MEAL-86). The two repos
// share no package, so the strings are duplicated here — diff the two files
// whenever either changes, and expect the diff to be EMPTY for every string.
//
// It was not always. Step 2 used to interpolate a store list, and the list had
// to differ per surface, because the two surfaces can drive different stores.
// No copy names a store now, on either surface, which ended that divergence and
// took both constants with it -- see the note further down.
//
// The point of a shared module is that both surfaces tell one story. The web
// front door (`/discover`) and this app's first run describe the same product;
// a surface picks the pieces it has room for and does not reword them. If a
// string here needs to change, change it in `mealio_central/lib/pitch.ts` first
// and copy it back, or the two surfaces drift apart again.
//
// The register is the one `/about` and the creator emails already use: say the
// concrete thing that happens, name the limits in the same breath. "Every
// ingredient goes into your cart" is a promise a user can check five minutes
// later. "Effortless meal planning" is not.
// ─────────────────────────────────────────────────────────────────────────────

/** The headline, identical to the web `/about` h1. */
export const PITCH_HEADLINE = "Shop meals. We'll fill the cart.";

/**
 * One sentence under the headline, carrying the whole claim on its own — a user
 * who reads this and nothing else has been told what Mealio does.
 */
export const PITCH_SUBHEAD =
  'Mealio is a recipe app that does the shopping part: pick a meal and the store '
  + 'you shop at, and every ingredient goes into your online cart there.';

/**
 * NO STORE LIST LIVES HERE ANY MORE.
 *
 * `PITCH_STORES` named eight retailers, and Help's FAQ answered "which stores?"
 * with it. Stephen, 2026-09-09: "I don't want specific stores named anywhere.
 * Keep it generic."
 *
 * Staleness had already caught it: the string still offered Amazon Fresh, which
 * was removed from the product on 2026-09-04. That is the structural problem
 * with the list rather than an oversight. The roster changes with a database
 * row, and a string in a shipped binary changes with a release, so the two
 * cannot help drifting apart.
 *
 * The store picker is the answer now, and it is built from the catalog, so it
 * is right on the day a store is added or pulled.
 * `tests/unit/no-store-names-in-copy.test.ts` keeps a brand name from
 * reappearing in the copy.
 */

/**
 * The mechanism in three steps. Ordered; a surface with room for one shows the
 * last, because the cart is the part nobody guesses from a grid of photos.
 */
export const PITCH_STEPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Find a meal you want to cook',
    body: 'Browse recipes from cooks and creators. No account needed to look.',
  },
  {
    // Names no store, and is identical to the web original — see the header.
    // Someone meeting the product wants to know a store like theirs is covered;
    // the honest answer to "is MY store here" is the picker, which shows exactly
    // what this build supports and is right the day the roster changes.
    title: 'Pick the store you shop at',
    body: 'Mealio supports most major grocery retailers. You\'ll see the full list when you pick yours.',
  },
  {
    title: 'Mealio fills your cart',
    body: 'Every ingredient is added to your cart at that store.',
  },
];

/**
 * The limit, stated wherever the promise is. People assume "fills your cart"
 * means "spends your money", and someone who suspects that and is not told
 * otherwise leaves instead of asking.
 */
export const PITCH_NOTHING_ORDERED =
  'Nothing is ordered. The items land in your own cart at your own store, and '
  + 'you check out there.';

/** What it costs, in the same words as the web `/about` and `/pricing`. */
export const PITCH_FREE_TIER = 'Free for up to three saved meals.';
