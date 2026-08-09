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
    mergeStoreCatalog([{ id: 'heb', name: 'Renamed', color: '#123456' }, { id: 'publix', name: 'Publix', color: '#008542' }]);
    expect(JSON.stringify(BUNDLED_STORES)).toBe(before);
  });
});

describe('adding a store', () => {
  it('appends an entry the bundle does not have', () => {
    const { stores, warnings } = mergeStoreCatalog([{ id: 'publix', name: 'Publix', color: '#008542' }]);
    expect(warnings).toEqual([]);
    expect(byId(stores, 'publix')).toEqual({ id: 'publix', name: 'Publix', color: '#008542' });
    expect(stores).toHaveLength(BUNDLED_STORES.length + 1);
    // Appended, so nothing that indexes the bundled order shifts under it.
    expect(ids(stores).slice(0, BUNDLED_STORES.length)).toEqual(bundledIds());
  });

  it('accepts both the bare array and the { stores: [...] } envelope', () => {
    // The server half is being built in parallel; tolerating both shapes means
    // the two halves do not have to ship together.
    const entry = { id: 'publix', name: 'Publix', color: '#008542' };
    for (const payload of [[entry], { stores: [entry] }, { version: 4, stores: [entry] }]) {
      expect(byId(mergeStoreCatalog(payload).stores, 'publix')).toEqual(entry);
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
      { id: 'publix', name: 'Publix', color: '#008542' },
    ]);
    expect(stores).toHaveLength(BUNDLED_STORES.length + 1);
    expect(byId(stores, 'publix')).toBeDefined();       // the good neighbour survives
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
      { id: 'publix', name: 'Publix', color: '#008542' },
      { id: 'publix', name: 'Publix (impostor)', color: '#ff0000' },
    ]);
    expect(byId(stores, 'publix')!.name).toBe('Publix');
    expect(stores.filter((s) => s.id === 'publix')).toHaveLength(1);
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
    const { stores, warnings } = mergeStoreCatalog([{ id: 'publix', name, color: '#008542' }]);
    expect(byId(stores, 'publix')).toBeUndefined();
    expect(stores).toEqual(BUNDLED_STORES);
    expect(warnings).toHaveLength(1);
  });

  it('trims a name that is otherwise fine', () => {
    const { stores } = mergeStoreCatalog([{ id: 'publix', name: '  Publix  ', color: '#008542' }]);
    expect(byId(stores, 'publix')!.name).toBe('Publix');
  });
});

describe('a bad colour — decoration degrades, the store survives', () => {
  it.each([
    ['missing', undefined],
    ['not a string', 123],
    ['no hash', '008542'],
    ['a named colour', 'red'],
    ['rgba()', 'rgba(0,0,0,0.5)'],
    ['four digits', '#0085'],
    ['a JS expression', '#000; background: url(x)'],
  ])('keeps the store with the neutral fallback: %s', (_label, color) => {
    const { stores, warnings } = mergeStoreCatalog([{ id: 'publix', name: 'Publix', color }]);
    expect(byId(stores, 'publix')).toEqual({ id: 'publix', name: 'Publix', color: FALLBACK_STORE_COLOR });
    expect(warnings).toHaveLength(1);
  });

  it('accepts #rgb as well as #rrggbb', () => {
    const { stores, warnings } = mergeStoreCatalog([
      { id: 'publix', name: 'Publix', color: '#0f0' },
      { id: 'wawa', name: 'Wawa', color: '#008542' },
    ]);
    expect(warnings).toEqual([]);
    expect(byId(stores, 'publix')!.color).toBe('#0f0');
  });

  it('every colour that reaches the app is a hex literal RN can parse', () => {
    // The reason this is validated and not passed through: `color` lands on
    // `backgroundColor`, where an unparseable string is a render-time throw.
    const { stores } = mergeStoreCatalog([
      { id: 'publix', name: 'Publix', color: 'chartreuse' },
      { id: 'wawa', name: 'Wawa', color: '#008542' },
    ]);
    for (const s of stores) expect(s.color).toMatch(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  });
});

describe('a malformed entry does not cost its neighbours', () => {
  it('keeps the good rows around junk ones', () => {
    const { stores, warnings } = mergeStoreCatalog([
      null,
      'publix',
      [],
      { id: 'publix', name: 'Publix', color: '#008542' },
      { name: 'No Id', color: '#000000' },
      { id: 'wawa', name: 'Wawa', color: '#c8102e' },
    ]);
    expect(ids(stores)).toEqual([...bundledIds(), 'publix', 'wawa']);
    expect(warnings).toHaveLength(4);
  });

  it('takes what it needs from a full server row and drops the rest', () => {
    // The shape GET /api/stores actually serves. Five of its nine fields are
    // descriptive and this build renders none of them, so they must not survive
    // into the app — least of all `platform`, which partitions the catalog
    // exactly like the capability sets today and is therefore the most
    // convincing wrong thing to start gating on. Capability comes from the
    // binary; see isSupportedStore.
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

  it('renders a row whose nullable descriptive fields are all null', () => {
    // servingArea is NULL on every row today, and the other three are nullable.
    // Nothing may depend on them being present.
    const { stores, warnings } = mergeStoreCatalog([{
      id: 'publix', name: 'Publix', color: '#008542',
      slug: 'publix', bannerGroup: null, platform: null, host: null, servingArea: null,
    }]);
    expect(warnings).toEqual([]);
    expect(byId(stores, 'publix')).toEqual({ id: 'publix', name: 'Publix', color: '#008542' });
  });

  it('ignores extra fields a newer server publishes', () => {
    // Forward compatibility: an older app must not choke on a column it has
    // never heard of, and must not carry it into the app either.
    const { stores, warnings } = mergeStoreCatalog([
      { id: 'publix', name: 'Publix', color: '#008542', region: 'FL', enabled: true },
    ]);
    expect(byId(stores, 'publix')).toEqual({ id: 'publix', name: 'Publix', color: '#008542' });
    expect(warnings).toEqual([]);
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
