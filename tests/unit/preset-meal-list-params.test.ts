// EVERY DISCOVER FILTER REACHES THE SERVER.
//
// The bug: filters were applied on the phone over the meals already loaded, 20
// at a time. So "vegetarian" meant "vegetarian among the ones we happen to be
// holding", and scrolling revealed more matches. Only `tags` was ever sent.
//
// Asserted on the REQUEST rather than on the screen, because the request is
// what changed and it is the thing a screen test cannot see. The screen test
// beside it (discover-filters-are-server-side) covers the other half: that the
// screen stops filtering locally.
// api.ts reaches expo-secure-store through tokenStorage, and the node project
// does not transform it. Stubbed rather than moved to the components project:
// what is under test is a URL, and it needs no renderer.
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

import { presetMeals } from '../../src/lib/api';

const originalFetch = global.fetch;

/** Captures the URL the client asks for. */
function captureUrl(): { urls: string[] } {
  const urls: string[] = [];
  global.fetch = jest.fn(async (input: unknown) => {
    urls.push(String(input));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ presetMeals: [], hasMore: false, matched: 0 }),
      json: async () => ({ presetMeals: [], hasMore: false, matched: 0 }),
    } as never;
  }) as never;
  return { urls };
}

afterEach(() => { global.fetch = originalFetch; });

/** The query string of the one request that was made. */
const paramsOf = (url: string) => new URLSearchParams(url.split('?')[1] ?? '');

describe('presetMeals.list sends every filter', () => {
  it('sends all five plus the search box', async () => {
    const cap = captureUrl();
    await presetMeals.list({
      limit: 20,
      offset: 0,
      tags: ['vegetarian', 'quick'],
      difficulty: [1, 2],
      authors: ['sarah'],
      ingredients: ['chicken', 'rice'],
      excludeIngredients: ['peanut'],
      q: 'curry',
    });
    const p = paramsOf(cap.urls[0]);
    expect(p.get('tags')).toBe('vegetarian,quick');
    expect(p.get('difficulty')).toBe('1,2');
    expect(p.get('authors')).toBe('sarah');
    expect(p.get('ingredients')).toBe('chicken,rice');
    expect(p.get('excludeIngredients')).toBe('peanut');
    expect(p.get('q')).toBe('curry');
  });

  it('omits an empty filter rather than sending a blank one', async () => {
    // `ingredients=` would parse server-side as one empty string, which matches
    // EVERY meal, so a blank param silently disables the filter it names.
    const cap = captureUrl();
    await presetMeals.list({ limit: 20, offset: 0, tags: [], difficulty: [], q: '   ' });
    const p = paramsOf(cap.urls[0]);
    expect(p.has('tags')).toBe(false);
    expect(p.has('difficulty')).toBe(false);
    expect(p.has('q')).toBe(false);
  });

  it('keeps the feed selectors working alongside the filters', async () => {
    const cap = captureUrl();
    await presetMeals.list({ limit: 20, offset: 0, sort: 'newest', tags: ['quick'] });
    let p = paramsOf(cap.urls[0]);
    expect(p.get('sort')).toBe('new');
    expect(p.get('tags')).toBe('quick');

    await presetMeals.list({ limit: 20, offset: 0, sort: 'following', tags: ['quick'] });
    p = paramsOf(cap.urls[1]);
    expect(p.get('followed')).toBe('true');
    expect(p.get('tags')).toBe('quick');
  });

  it('reads `matched` back, and tolerates a server that does not send it', async () => {
    // How many matched across the whole catalogue, which is what lets a screen
    // say "18 meals" honestly rather than counting what it is holding.
    const cap = captureUrl();
    const r = await presetMeals.list({ limit: 20, offset: 0 });
    expect(cap.urls).toHaveLength(1);
    expect(r.matched).toBe(0);
  });
});
