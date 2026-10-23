// Limits on pasted recipe text for "Import a recipe" on New Meal.
//
// A copy of `lib/import/limits.ts` in mealio_central, which the server
// enforces. The two repos share no package; keep the numbers identical, or the
// counter here will promise a paste the server then refuses.

/** Pasted characters accepted. */
export const PASTED_TEXT_MAX = 20_000;
/** Below this the server answers "too short to be a recipe". */
export const PASTED_TEXT_MIN = 40;
