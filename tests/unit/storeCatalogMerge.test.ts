import { mergeStoreCatalog, FALLBACK_STORE_COLOR } from '../../src/lib/store-catalog/merge';
import { BUNDLED_STORES, Store } from '../../src/constants/stores';

// The trust boundary for MEAL-23. Everything here is about one question: what a
// payload we did not write is allowed to do to the list a user picks from.
//
// The load-bearing property is ADDITIVE AND OVERRIDING, NEVER SUBTRACTIVE. No
// input — truncated, empty, hostile, or merely wrong — may remove a bundled
// store, because a user's saved meals point at these ids.

const bundledIds = () => BUNDLED_STORES.map((s) => s.id);
const ids = (stores: Store[]) => stores.map((s) => s.id);
const byId = (stores: Store[], id: string) => stores.find((s) => s.id === id);

describe('what the bundled list guarantees', () => {
  it('stands unchanged when there is no payload at all', () => {
    for (const nothing of [undefined, null]) {
      const { stores } = mergeStoreCatalog(nothing);
      expect(stores).toEqual(BUNDLED_STORES);
    }
  });

  it('stands when the payload is not a list', () => {
    for (const junk of [42, 'stores', true, { version: 1 }, { stores: 'nope' }]) {
      const { stores, warnings } = mergeStoreCatalog(junk);
      expect(stores).toEqual(BUNDLED_STORES);
      expect(warnings).toHaveLength(1);
    }
  });

  it('stands when the payload is implausibly long', () => {
    const flood = Array.from({ length: 201 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, color: '#000000' }));
    const { stores, warnings } = mergeStoreCatalog(flood);
    expect(stores).toEqual(BUNDLED_STORES);
    expect(warnings[0]).toContain('exceeds 200');
  });

  it('is never SHORTENED by a payload that omits stores', () => {
    // The failure this refuses: a half-written table, a truncated body, or a
    // query that returned one row emptying the picker.
    for (const payload of [[], [{ id: 'heb', name: 'H-E-B', color: '#dd0031' }]]) {
      const { stores } = mergeStoreCatalog(payload);
      expect(ids(stores)).toEqual(bundledIds());
    }
  });

  it('is not mutated by a merge', () => {
    const before = JSON.stringify(BUNDLED_STORES);
    mergeStoreCatalog([{ id: 'heb', name: 'Renamed', color: '#123456' }, { id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#008542' }]);
    expect(JSON.stringify(BUNDLED_STORES)).toBe(before);
  });
});

describe('adding a store', () => {
  it('appends an entry the bundle does not have', () => {
    const { stores, warnings } = mergeStoreCatalog([{ id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#008542' }]);
    expect(warnings).toEqual([]);
    expect(byId(stores, 'zz_not_a_real_store')).toEqual({ id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#008542' });
    expect(stores).toHaveLength(BUNDLED_STORES.length + 1);
    // Appended, so nothing that indexes the bundled order shifts under it.
    expect(ids(stores).slice(0, BUNDLED_STORES.length)).toEqual(bundledIds());
  });

  it('accepts both the bare array and the { stores: [...] } envelope', () => {
    // The server half is being built in parallel; tolerating both shapes means
    // the two halves do not have to ship together.
    const entry = { id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#008542' };
    for (const payload of [[entry], { stores: [entry] }, { version: 4, stores: [entry] }]) {
      expect(byId(mergeStoreCatalog(payload).stores, 'zz_not_a_real_store')).toEqual(entry);
    }
  });
});

describe('an id colliding with a bundled store', () => {
  it('updates the name and colour in place — the rebrand path', () => {
    const { stores } = mergeStoreCatalog([{ id: 'heb', name: 'H-E-B Plus!', color: '#ff0000' }]);
    expect(byId(stores, 'heb')).toEqual({ id: 'heb', name: 'H-E-B Plus!', color: '#ff0000' });
    // In place: the entry keeps its position and the list its length.
    expect(ids(stores)).toEqual(bundledIds());
  });

  it('cannot remove it, only relabel it', () => {
    const { stores } = mergeStoreCatalog([{ id: 'heb', name: '', color: '#ff0000' }]);
    expect(byId(stores, 'heb')).toEqual(BUNDLED_STORES.find((s) => s.id === 'heb'));
  });
});

describe('a bad id', () => {
  it.each([
    ['uppercase', 'HEB'],
    ['a space', 'my store'],
    ['a hyphen', 'amazon-fresh'],
    ['a path separator', 'a/b'],
    ['a leading underscore', '_heb'],
    ['empty', ''],
    ['over 40 characters', 'a'.repeat(41)],
    ['a number', 7],
    ['null', null],
    ['an object', { id: 'heb' }],
  ])('drops the entry: %s', (_label, id) => {
    const { stores, warnings } = mergeStoreCatalog([
      { id, name: 'Sneaky', color: '#000000' },
      { id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#008542' },
    ]);
    expect(stores).toHaveLength(BUNDLED_STORES.length + 1);
    expect(byId(stores, 'zz_not_a_real_store')).toBeDefined();       // the good neighbour survives
    expect(warnings).toHaveLength(1);
  });

  it('cannot smuggle a lookalike past an existing id', () => {
    // ' heb' and 'HEB' are rejected outright rather than normalised onto 'heb',
    // so nothing can quietly take over a shipped store's identity.
    const { stores } = mergeStoreCatalog([
      { id: ' heb', name: 'Not HEB', color: '#000000' },
      { id: 'HEB', name: 'Not HEB', color: '#000000' },
    ]);
    expect(byId(stores, 'heb')).toEqual(BUNDLED_STORES.find((s) => s.id === 'heb'));
    expect(stores).toHaveLength(BUNDLED_STORES.length);
  });
});

describe('a duplicate id inside one payload', () => {
  it('keeps the FIRST occurrence and warns', () => {
    const { stores, warnings } = mergeStoreCatalog([
      { id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#008542' },
      { id: 'zz_not_a_real_store', name: 'Publix (impostor)', color: '#ff0000' },
    ]);
    expect(byId(stores, 'zz_not_a_real_store')!.name).toBe('Not A Real Store');
    expect(stores.filter((s) => s.id === 'zz_not_a_real_store')).toHaveLength(1);
    expect(warnings.join()).toContain('duplicate id');
  });

  it('a duplicate cannot re-edit a bundled store the payload already touched', () => {
    const { stores } = mergeStoreCatalog([
      { id: 'heb', name: 'H-E-B Plus!', color: '#dd0031' },
      { id: 'heb', name: 'Free Money', color: '#000000' },
    ]);
    expect(byId(stores, 'heb')!.name).toBe('H-E-B Plus!');
  });
});

describe('a bad name — identity is required, so the entry goes', () => {
  it.each([
    ['missing', undefined],
    ['a number', 7],
    ['empty', ''],
    ['only whitespace', '   '],
    ['over 60 characters', 'x'.repeat(61)],
    ['a newline', 'Publix\nFree'],
    ['a control character', 'Pub\u0007lix'],
    ['a line separator', 'Publix\u2028Free'],
  ])('drops the entry: %s', (_label, name) => {
    const { stores, warnings } = mergeStoreCatalog([{ id: 'zz_not_a_real_store', name, color: '#008542' }]);
    expect(byId(stores, 'zz_not_a_real_store')).toBeUndefined();
    expect(stores).toEqual(BUNDLED_STORES);
    expect(warnings).toHaveLength(1);
  });

  it('trims a name that is otherwise fine', () => {
    const { stores } = mergeStoreCatalog([{ id: 'zz_not_a_real_store', name: '  Not A Real Store  ', color: '#008542' }]);
    expect(byId(stores, 'zz_not_a_real_store')!.name).toBe('Not A Real Store');
  });
});

describe('a bad colour on a store the bundle already has', () => {
  // The colour already on file is strictly better information than the neutral,
  // so a row that fails to supply one must not overwrite it. The failure this
  // avoids is a publishing failure, not a coding one: if colour is ever absent
  // for a subset of rows, substituting here would make the FIRST FULL CATALOG
  // PUBLISH grey out exactly those stores across the whole picker, with no
  // client release to blame it on.
  const bundledHeb = BUNDLED_STORES.find((s) => s.id === 'heb')!;

  it.each([
    ['missing', undefined],
    ['not a string', 123],
    ['no hash', 'dd0031'],
    ['a named colour', 'red'],
    ['rgba()', 'rgba(0,0,0,0.5)'],
  ])('keeps the bundled colour: %s', (_label, color) => {
    const { stores, warnings } = mergeStoreCatalog([{ id: 'heb', name: 'H-E-B Plus!', color }]);
    // The rename still lands — only the colour is declined.
    expect(byId(stores, 'heb')).toEqual({ id: 'heb', name: 'H-E-B Plus!', color: bundledHeb.color });
    expect(bundledHeb.color).not.toBe(FALLBACK_STORE_COLOR);
    expect(warnings).toHaveLength(1);
  });

  it('never substitutes the neutral for a store that has a real colour', () => {
    // The whole-picker version of the same claim: a catalog that supplies no
    // colours at all must leave every bundled brand colour exactly as shipped.
    const colourless = BUNDLED_STORES.map((s) => ({ id: s.id, name: s.name }));
    const { stores } = mergeStoreCatalog(colourless);
    expect(stores).toEqual(BUNDLED_STORES);
    expect(stores.some((s) => s.color === FALLBACK_STORE_COLOR)).toBe(false);
  });

  it('still takes a GOOD colour from a row that has one', () => {
    const { stores, warnings } = mergeStoreCatalog([{ id: 'heb', name: 'H-E-B', color: '#123456' }]);
    expect(byId(stores, 'heb')!.color).toBe('#123456');
    expect(warnings).toEqual([]);
  });
});

describe('a bad colour on a store with no history — decoration degrades', () => {
  it.each([
    ['missing', undefined],
    ['not a string', 123],
    ['no hash', '008542'],
    ['a named colour', 'red'],
    ['rgba()', 'rgba(0,0,0,0.5)'],
    ['four digits', '#0085'],
    ['a JS expression', '#000; background: url(x)'],
  ])('keeps the store with the neutral fallback: %s', (_label, color) => {
    const { stores, warnings } = mergeStoreCatalog([{ id: 'zz_not_a_real_store', name: 'Not A Real Store', color }]);
    expect(byId(stores, 'zz_not_a_real_store')).toEqual({ id: 'zz_not_a_real_store', name: 'Not A Real Store', color: FALLBACK_STORE_COLOR });
    expect(warnings).toHaveLength(1);
  });

  it('accepts #rgb as well as #rrggbb', () => {
    const { stores, warnings } = mergeStoreCatalog([
      { id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#0f0' },
      { id: 'wawa', name: 'Wawa', color: '#008542' },
    ]);
    expect(warnings).toEqual([]);
    expect(byId(stores, 'zz_not_a_real_store')!.color).toBe('#0f0');
  });

  it('every colour that reaches the app is a hex literal RN can parse', () => {
    // The reason this is validated and not passed through: `color` lands on
    // `backgroundColor`, where an unparseable string is a render-time throw.
    const { stores } = mergeStoreCatalog([
      { id: 'zz_not_a_real_store', name: 'Not A Real Store', color: 'chartreuse' },
      { id: 'wawa', name: 'Wawa', color: '#008542' },
    ]);
    for (const s of stores) expect(s.color).toMatch(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  });
});

describe('a malformed entry does not cost its neighbours', () => {
  it('keeps the good rows around junk ones', () => {
    const { stores, warnings } = mergeStoreCatalog([
      null,
      'zz_not_a_real_store',
      [],
      { id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#008542' },
      { name: 'No Id', color: '#000000' },
      { id: 'wawa', name: 'Wawa', color: '#c8102e' },
    ]);
    expect(ids(stores)).toEqual([...bundledIds(), 'zz_not_a_real_store', 'wawa']);
    expect(warnings).toHaveLength(4);
  });

  it('takes what it needs from a wide server row and drops the rest', () => {
    // Not a transcript of today's response — `platform` and `bannerGroup` were
    // both withdrawn from it during MEAL-23. That is exactly why they are still
    // here: this asserts the rule (keep three, drop everything else) against a
    // row wider than any the server currently sends, so a column coming BACK
    // cannot reach the app without someone editing merge.ts on purpose.
    const { stores, warnings } = mergeStoreCatalog([{
      id: 'king_soopers',
      name: 'King Soopers',
      color: '#005DAA',
      slug: 'king-soopers',
      bannerGroup: 'Kroger',
      platform: 'kroger',
      host: 'kingsoopers.com',
      servingArea: null,
    }]);
    expect(warnings).toEqual([]);
    expect(byId(stores, 'king_soopers')).toEqual({
      id: 'king_soopers', name: 'King Soopers', color: '#005DAA',
    });
    for (const store of stores) expect(Object.keys(store).sort()).toEqual(['color', 'id', 'name']);
  });

  it('renders a row whose descriptive fields are all null', () => {
    // The descriptive columns are nullable, and nothing may depend on any of
    // them being present — or on their being absent, which is the same rule.
    const { stores, warnings } = mergeStoreCatalog([{
      id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#008542',
      slug: 'zz_not_a_real_store', bannerGroup: null, platform: null, host: null, servingArea: null,
    }]);
    expect(warnings).toEqual([]);
    expect(byId(stores, 'zz_not_a_real_store')).toEqual({ id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#008542' });
  });

  it('ignores extra fields a newer server publishes', () => {
    // Forward compatibility: an older app must not choke on a column it has
    // never heard of, and must not carry it into the app either.
    const { stores, warnings } = mergeStoreCatalog([
      { id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#008542', region: 'FL', enabled: true },
    ]);
    expect(byId(stores, 'zz_not_a_real_store')).toEqual({ id: 'zz_not_a_real_store', name: 'Not A Real Store', color: '#008542' });
    expect(warnings).toEqual([]);
  });
});

// Every limit in merge.ts was exercised only from the REJECTING side — 201
// entries but never 200, a 61-character name but never 60, a 41-character id but
// never 40. That leaves each boundary free to drift by one in the conservative
// direction without a single test noticing: `>` slipping to `>=` would start
// refusing a catalog that is exactly at the limit, which is a silently smaller
// product rather than an unsafe one, and therefore the kind of change nobody
// goes looking for. These pin the accepting side.
describe('the limits, at exactly their limit', () => {
  it('accepts a payload of exactly MAX_CATALOG_STORES entries', () => {
    const exactly200 = Array.from({ length: 200 }, (_, i) => ({
      id: `store_${i}`, name: `Store ${i}`, color: '#008542',
    }));
    const { stores, warnings } = mergeStoreCatalog(exactly200);
    expect(warnings).toEqual([]);
    expect(stores).toHaveLength(BUNDLED_STORES.length + 200);
  });

  it('accepts a name of exactly MAX_NAME_LENGTH characters', () => {
    const name = 'N'.repeat(60);
    const { stores, warnings } = mergeStoreCatalog([{ id: 'zz_not_a_real_store', name, color: '#008542' }]);
    expect(warnings).toEqual([]);
    expect(byId(stores, 'zz_not_a_real_store')!.name).toBe(name);
  });

  it('accepts an id of exactly the longest permitted length', () => {
    const id = `a${'b'.repeat(39)}`;   // 1 + 39 = the 40 STORE_ID allows
    expect(id).toHaveLength(40);
    const { stores, warnings } = mergeStoreCatalog([{ id, name: 'Long', color: '#008542' }]);
    expect(warnings).toEqual([]);
    expect(byId(stores, id)).toBeDefined();
  });
});

describe('merging against a base other than the bundled list', () => {
  // How a store that IS in the bundle today would behave if a future build
  // shipped without it: it arrives as a genuinely new entry. This is also the
  // only way to exercise the "new AND supported" path, because in this build
  // every capable store is already bundled — see storeCatalogLoader.test.ts.
  const base = BUNDLED_STORES.filter((s) => s.id !== 'heb');

  it('adds it as a new entry', () => {
    const { stores } = mergeStoreCatalog([{ id: 'heb', name: 'H-E-B', color: '#dd0031' }], base);
    expect(byId(stores, 'heb')).toEqual({ id: 'heb', name: 'H-E-B', color: '#dd0031' });
    expect(stores).toHaveLength(base.length + 1);
  });

  it('leaves the given base alone', () => {
    const before = JSON.stringify(base);
    mergeStoreCatalog([{ id: 'heb', name: 'H-E-B', color: '#dd0031' }], base);
    expect(JSON.stringify(base)).toBe(before);
  });
});
