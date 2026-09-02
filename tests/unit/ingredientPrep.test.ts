// MEAL-102 — preparation ("finely diced") on an ingredient, on the app side.
//
// Recipes say "1 onion, finely diced". Mealio threw the preparation away, so a
// creator lost real cooking instruction and their draft read "1 onion". It comes
// back as its OWN field, never part of the product name, for one reason: the
// name doubles as the grocery search term, and a store searched for "diced
// onion" does not return a worse onion — it returns nothing.
//
// This file pins three things:
//   1. prep cannot reach the term the cart searches (the ticket's whole point)
//   2. a row with no prep serialises byte-for-byte the way it did before the
//      field existed
//   3. a save round trip does not erase it
//
// The rendering half, and the cart driven end to end, are in
// tests/components/ingredient-prep-render.test.tsx and
// tests/components/cart-prep-search.test.tsx.

import {
  normalizeIngredients,
  normalizePresetIngredients,
} from '../../src/lib/normalizeIngredients';
import { consolidateIngredients } from '../../src/lib/consolidateIngredients';
import { mergeChosenProduct } from '../../src/lib/saveChosenIngredient';
import { withPrep, ingredientAmount } from '../../src/lib/formatMeasurement';
import { getNetworkRail } from '../../src/lib/webview-scripts/network-rail';
import { getStoreScripts } from '../../src/lib/webview-scripts/index';

/** The onion the recipe wants diced. Prep present, and irrelevant to the store. */
const DICED_ONION = {
  ingredientName: 'Onion',
  searchTerm: null,
  qty: 1,
  productQty: 1,
  unit: 'qty',
  measure: '1',
  prep: 'finely diced',
};

/** Every word that must never appear in anything sent to a store. */
const PREP_WORDS = ['finely', 'diced', 'prep'];

/** Percent-decode where the payload is a URI, and leave it alone where it is a
 *  script that merely happens to contain a `%`. */
function safeDecode(payload: string): string {
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

// ─── 1. The risk, at its exact address ──────────────────────────────────────

/**
 * `WebViewCartSheet` computes what it searches for as
 * `item.searchTerm ?? item.ingredientName`, and the add gate is exact-after-
 * normalisation equality against that same string. Prep leaking into either
 * field does not add a WRONG product — it fails to match at all, silently
 * routing the item to review and looking like a matching problem rather than
 * the data problem it is.
 *
 * So the assertion is made against the URLs and injected scripts that actually
 * go to a store, for every store the registry can build, rather than against a
 * helper in isolation. The chain here is the real one: consolidation, then the
 * term expression, then the store's own URL builder.
 */
describe('preparation never reaches the store', () => {
  const STORE_IDS = ['heb', 'walmart', 'aldi', 'amazon', 'wegmans', 'albertsons', 'safeway'];

  /** The cart's own term expression, from WebViewCartSheet. */
  const termOf = (item: { searchTerm: string | null; ingredientName: string }) =>
    item.searchTerm ?? item.ingredientName;

  it('leaves the term bare when the row is unchosen (term = ingredientName)', () => {
    const [item] = consolidateIngredients([
      { id: 'm1', name: 'Chili', ingredients: [DICED_ONION] },
    ]);
    expect(termOf(item)).toBe('Onion');
  });

  it('leaves the term bare when a product has been chosen (term = searchTerm)', () => {
    const [item] = consolidateIngredients([
      { id: 'm1', name: 'Chili', ingredients: [{ ...DICED_ONION, searchTerm: 'H-E-B Yellow Onion' }] },
    ]);
    expect(termOf(item)).toBe('H-E-B Yellow Onion');
  });

  it.each(STORE_IDS)('sends %s a search URL and add script with no preparation in it', (storeId) => {
    const scripts = getStoreScripts(storeId);
    if (!scripts) throw new Error(`no scripts for ${storeId} — the store list is stale`);

    // Both cases a real cart hits: unchosen (term is the name) and chosen.
    const meals = [
      { id: 'm1', name: 'Chili', ingredients: [DICED_ONION] },
      {
        id: 'm2',
        name: 'Soup',
        ingredients: [{ ...DICED_ONION, searchTerm: 'H-E-B Yellow Onion', prep: 'roughly chopped' }],
      },
    ];

    // Everything this store would be asked, through its own builders. URLs and
    // scripts are kept apart because the bar differs: a URL is entirely ours, so
    // even the field name must not appear in it, while a script is thousands of
    // lines of store automation that legitimately contains words like
    // "prepended". Both are checked for every phrase the fixtures put in `prep`.
    const urls: string[] = [];
    const injected: string[] = [];
    for (const item of consolidateIngredients(meals)) {
      const term = termOf(item);
      // The DOM builders used to be checked here too. They are gone; a store is
      // reached by its search URL (assisted) or by the rail's search batch, and
      // both are covered below.
      if (scripts.getSearchUrl) urls.push(scripts.getSearchUrl(term));
      const rail = getNetworkRail(storeId);
      const sess = { storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY' };
      const batch = rail?.searchBatch([term], sess);
      if (batch) injected.push(batch);
    }

    // An assisted store has no rail, so there is nothing injected to check — the
    // user is handed a search URL and adds it themselves. The URL check below is
    // the whole test for those stores, and it is the one that matters: the URL is
    // entirely ours to build.
    expect(urls.length).toBeGreaterThan(0);
    if (getNetworkRail(storeId)) expect(injected.length).toBeGreaterThan(0);
    // Raw AND percent-decoded: a term reaches a store URL-encoded, so
    // "finely%20diced" has to fail this too. Injected scripts are not URIs and
    // can carry a bare `%`, so the decode is best-effort there.
    for (const url of urls) {
      for (const word of PREP_WORDS) {
        expect(url.toLowerCase()).not.toContain(word);
        expect(safeDecode(url).toLowerCase()).not.toContain(word);
      }
    }
    for (const script of injected) {
      for (const phrase of ['finely', 'diced', 'roughly', 'chopped']) {
        expect(script.toLowerCase()).not.toContain(phrase);
        expect(safeDecode(script).toLowerCase()).not.toContain(phrase);
      }
    }
  });

  it('keeps prep off the consolidated entry entirely, not merely out of the term', () => {
    // Belt and braces: nothing on the object the cart engine passes around
    // carries the phrase, so no future call site can splice it into a query by
    // reading a field it assumed was safe. It lives per-meal, where the amounts
    // live, because two meals sharing an onion can dice one and slice the other.
    const [item] = consolidateIngredients([
      { id: 'm1', name: 'Chili', ingredients: [DICED_ONION] },
    ]);
    const { mealIngredients, ...entry } = item;
    expect(JSON.stringify(entry).toLowerCase()).not.toContain('diced');
    expect(mealIngredients[0].prep).toBe('finely diced');
  });

  it('keeps two meals\' different preparations apart on one shared product', () => {
    const [item] = consolidateIngredients([
      { id: 'm1', name: 'Chili', ingredients: [{ ...DICED_ONION, searchTerm: 'Yellow Onion' }] },
      { id: 'm2', name: 'Soup', ingredients: [{ ...DICED_ONION, searchTerm: 'Yellow Onion', prep: 'sliced thin' }] },
    ]);
    expect(item.mealIngredients.map((m) => m.prep)).toEqual(['finely diced', 'sliced thin']);
  });
});

// ─── 2. Additive: no prep must serialise exactly as it did before ───────────

describe('an ingredient with no preparation is untouched', () => {
  /**
   * The byte-identity check, and the inputs matter more than the assertion.
   *
   * A row that never reaches the prep branch would pass this while proving
   * nothing, so each case below is a row that DOES exercise the branch — one
   * whose `prep` is absent, and rows carrying every falsy or wrong-typed value a
   * writer could put there. The pair asserted is normalize-without-the-field
   * against normalize-with-it, so the comparison is against the real prior
   * behaviour rather than a hand-written expectation.
   */
  const BARE = {
    ingredientName: 'Onion',
    searchTerm: null,
    qty: 2,
    productQty: 2,
    unit: 'qty',
    measure: '2',
    dropdown: null,
  };

  it.each([
    ['the key is absent', {}],
    ['prep is null', { prep: null }],
    ['prep is undefined', { prep: undefined }],
    ['prep is an empty string', { prep: '' }],
    ['prep is whitespace only', { prep: '   ' }],
    ['prep is not a string', { prep: 42 }],
    ['prep is an object', { prep: { note: 'diced' } }],
  ])('serialises byte-for-byte with no prep key when %s', (_label, extra) => {
    const [withField] = normalizeIngredients([{ ...BARE, ...extra }]);
    const [without] = normalizeIngredients([BARE]);

    // Byte-for-byte, key order included — these objects are written straight
    // back to storage by the meal editor, so an extra key is a real write.
    expect(JSON.stringify(withField)).toBe(JSON.stringify(without));
    expect('prep' in withField).toBe(false);
  });

  it('really is exercising the branch — the same rows WITH a prep differ', () => {
    // Guards the test above against passing for the wrong reason: if the prep
    // branch were unreachable, this would be byte-identical too.
    const [withPrepRow] = normalizeIngredients([{ ...BARE, prep: 'finely diced' }]);
    const [without] = normalizeIngredients([BARE]);
    expect(JSON.stringify(withPrepRow)).not.toBe(JSON.stringify(without));
    expect(withPrepRow.prep).toBe('finely diced');
  });

  it('never writes prep: null', () => {
    const rows = normalizeIngredients([BARE, { ...BARE, prep: null }, 'Salt']);
    for (const row of rows) expect(JSON.stringify(row)).not.toContain('"prep":null');
  });

  it('leaves a plain string ingredient with no prep key', () => {
    const [row] = normalizeIngredients(['Sour Cream']);
    expect('prep' in row).toBe(false);
  });
});

// ─── 3. Carried, and not erased by a save ──────────────────────────────────

describe('preparation survives the reads and the writes', () => {
  it('is carried through normalizeIngredients', () => {
    const [row] = normalizeIngredients([DICED_ONION]);
    expect(row.prep).toBe('finely diced');
  });

  it('is spelled one way, and one way only', () => {
    // `prep` is a single word, so camelCase and snake_case are the same six
    // characters — unlike the name, which needs four spellings folded. A row
    // written `prepNote` or `prep_note` is not a spelling we accept; it is a
    // writer that broke the contract, and quietly reading it would invite more.
    const [row] = normalizeIngredients([
      { ...DICED_ONION, prep: undefined, prepNote: 'finely diced', prep_note: 'finely diced' } as any,
    ]);
    expect('prep' in row).toBe(false);
  });

  it('is carried through normalizePresetIngredients, which re-derives the count', () => {
    // The preset path rebuilds productQty, so it is the one most likely to drop
    // a field on the floor. "1 onion" derives up to a package count of 1.
    const [row] = normalizePresetIngredients([{ ...DICED_ONION, qty: 3, measure: '3' }]);
    expect(row.prep).toBe('finely diced');
    expect(row.productQty).toBe(3);
  });

  it('survives choosing a product for the row', () => {
    // mergeChosenProduct is what the cart calls after the shopper picks a
    // product — it PATCHes the meal's whole ingredient array back.
    const [row] = normalizeIngredients([DICED_ONION]);
    const [merged] = mergeChosenProduct([row], 'Onion', 'H-E-B Yellow Onion', { qty: 2 });
    expect(merged.prep).toBe('finely diced');
    expect(merged.searchTerm).toBe('H-E-B Yellow Onion');
  });

  it('is stable across a read → write → read round trip', () => {
    const once = normalizeIngredients([DICED_ONION]);
    const twice = normalizeIngredients(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('drops a whitespace-only prep rather than storing a row that renders a bare comma', () => {
    const [row] = normalizeIngredients([{ ...DICED_ONION, prep: '  ' }]);
    expect('prep' in row).toBe(false);
  });

  it('trims, so a stray-whitespace row does not round-trip its whitespace', () => {
    const [row] = normalizeIngredients([{ ...DICED_ONION, prep: '  finely diced  ' }]);
    expect(row.prep).toBe('finely diced');
  });
});

// ─── 4. The rendering rule ─────────────────────────────────────────────────

describe('withPrep', () => {
  it('trails the preparation after the line, comma-separated', () => {
    expect(withPrep('Onion, 1', 'finely diced')).toBe('Onion, 1, finely diced');
  });

  it('returns the line unchanged when there is no preparation', () => {
    for (const none of [undefined, null, '', '   ']) {
      expect(withPrep('Onion, 1', none)).toBe('Onion, 1');
    }
  });

  it('adds the comma rather than expecting it stored', () => {
    // Storing the punctuation would read "1 onion, , finely diced" the moment
    // both the data and the renderer agreed about it.
    expect(withPrep('Onion', 'finely diced')).not.toContain(', ,');
  });

  it('renders a preparation that itself contains commas, verbatim', () => {
    // "drained, rinsed and patted dry" is a phrase a cook writes. It is one
    // string and stays one — nothing splits it, so nothing can lose half of it.
    const prep = 'drained, rinsed and patted dry';
    expect(withPrep('Chickpeas, 1 can', prep)).toBe('Chickpeas, 1 can, drained, rinsed and patted dry');
  });

  it('renders markup as literal text, without interpreting or stripping it', () => {
    // The ticket wrote `1 onion, *finely diced*` to mark WHICH part is the prep,
    // not to ask for italics — and a source recipe can contain angle brackets or
    // asterisks of its own. React Native <Text> never parses either, so the
    // contract here is simply that the string comes out the way it went in.
    const prep = '<b>finely</b> diced *and* salted';
    expect(withPrep('Onion, 1', prep)).toBe(`Onion, 1, ${prep}`);
  });

  it('does not disturb the amount rule it sits on top of', () => {
    // "salt to taste" arrives as a countable 1 and prints no amount. Adding a
    // preparation must not make an amount appear.
    const salt = { unit: 'qty', qty: 1, measure: null };
    expect(ingredientAmount(salt)).toBe('');
    expect(withPrep('Salt', 'to taste')).toBe('Salt, to taste');
  });
});
