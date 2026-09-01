/**
 * What to re-ask when the page navigates during a network search.
 *
 * The network rail runs its whole search batch inside one document and reports
 * per term. If that document goes away mid-batch — a store-side redirect, an SPA
 * route commit, anything that replaces the page — every in-flight fetch rejects
 * at once and the loop simply stops. Terms already answered are safe; the rest
 * were never asked.
 *
 * This decides which ones to ask again, and when to stop trying.
 */

export type ResumeReason = 'resume' | 'nothing_outstanding' | 'too_many_injects';

export interface ResumePlan {
  /** Terms to ask again. Empty unless reason is 'resume'. */
  terms: string[];
  reason: ResumeReason;
}

/**
 * Three documents is already a page misbehaving; a fourth is a reload loop, and
 * feeding it would keep the run alive past the point where the deadline should
 * end it.
 */
export const MAX_SEARCH_INJECTS = 3;

export function planSearchResume(
  allTerms: readonly string[],
  answered: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  failed: ReadonlySet<string>,
  injectsSoFar: number,
  maxInjects: number = MAX_SEARCH_INJECTS,
): ResumePlan {
  const isAnswered = (t: string) => answered.has(t);
  // A term that came back FAILED is answered too. It was asked, the store said
  // no, and asking again would spend a request to be told the same thing.
  const outstanding = allTerms.filter((t) => !isAnswered(t) && !failed.has(t));
  if (outstanding.length === 0) return { terms: [], reason: 'nothing_outstanding' };
  if (injectsSoFar >= maxInjects) return { terms: [], reason: 'too_many_injects' };
  return { terms: outstanding, reason: 'resume' };
}
