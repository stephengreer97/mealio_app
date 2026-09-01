import { planSearchResume, MAX_SEARCH_INJECTS } from '../../src/lib/webview-scripts/resume-search';

// The run this exists for: 18 terms, three answered (as failures), the page
// navigated, and the other 15 were never asked because the document died.
const EIGHTEEN = Array.from({ length: 18 }, (_, i) => `term ${i}`);

describe('planSearchResume', () => {
  it('re-asks only the terms that never came back', () => {
    const answered = new Map<string, unknown>([['term 3', []], ['term 4', []]]);
    const failed = new Set(['term 0', 'term 1', 'term 2']);
    const plan = planSearchResume(EIGHTEEN, answered, failed, 1);
    expect(plan.reason).toBe('resume');
    expect(plan.terms).toHaveLength(13);
    // Nothing already answered is asked again — a re-ask would double-count the
    // progress ring and re-add candidates for a term already matched.
    expect(plan.terms).not.toContain('term 3');
    expect(plan.terms).not.toContain('term 0');
    expect(plan.terms[0]).toBe('term 5');
  });

  it('treats a FAILED term as answered, not as outstanding', () => {
    const plan = planSearchResume(['a', 'b'], new Map(), new Set(['a', 'b']), 1);
    expect(plan.reason).toBe('nothing_outstanding');
    expect(plan.terms).toEqual([]);
  });

  it('does nothing when the batch had already finished', () => {
    const answered = new Map<string, unknown>([['a', []], ['b', []]]);
    expect(planSearchResume(['a', 'b'], answered, new Set(), 1).reason).toBe('nothing_outstanding');
  });

  it('stops re-asking once the page has replaced itself too many times', () => {
    const outstanding = planSearchResume(EIGHTEEN, new Map(), new Set(), 1);
    expect(outstanding.reason).toBe('resume');

    // A page that reload-loops must not keep the run alive forever; the search
    // deadline is what should end it.
    const looping = planSearchResume(EIGHTEEN, new Map(), new Set(), MAX_SEARCH_INJECTS);
    expect(looping.reason).toBe('too_many_injects');
    expect(looping.terms).toEqual([]);
  });

  it('allows exactly two resumes after the opening injection', () => {
    expect(planSearchResume(EIGHTEEN, new Map(), new Set(), 1).reason).toBe('resume');
    expect(planSearchResume(EIGHTEEN, new Map(), new Set(), 2).reason).toBe('resume');
    expect(planSearchResume(EIGHTEEN, new Map(), new Set(), 3).reason).toBe('too_many_injects');
  });

  it('reproduces the 3/18 run: three failures, page navigates, fifteen re-asked', () => {
    const failed = new Set(['term 0', 'term 1', 'term 2']);
    const plan = planSearchResume(EIGHTEEN, new Map(), failed, 1);
    expect(plan.reason).toBe('resume');
    expect(plan.terms).toHaveLength(15);
  });
});
