import type { Step } from '../components/WebViewCartSheet';

/**
 * STEPS THAT BELONG TO THE USER, not to the run.
 *
 * On these the user is looking at products and deciding. The sheet is mounted
 * at app root and outlives any one run, so a rail can report a block long after
 * they have moved on — and replacing what they are reading takes their picks
 * with it.
 */
const THEIRS: ReadonlySet<string> = new Set(['review', 'searchResult', 'done', 'manual']);

/**
 * May a bot challenge take the screen right now?
 *
 * `alreadyShown` is per run: a second block means solving the first did not
 * help, and looping someone through a verification that does not work is worse
 * than handing them the storefront.
 */
export function challengeMayTakeTheScreen(step: Step | string, alreadyShown: boolean): boolean {
  if (alreadyShown) return false;
  return !THEIRS.has(step);
}
