// The drift check's judgement, tested directly (MEAL-30).
//
// These are the tests that matter most about this feature, because the risk is not
// that it misses drift — it is that it fires on noise, gets ignored, and then gets
// deleted. So the bulk of what is asserted here is SILENCE: the specific changes a
// weekly recapture always brings, each pinned as producing no finding.

import {
  Census,
  StoreCensus,
  countBucket,
  diffCensus,
  diffCount,
  diffRatio,
  parseTargetKey,
  ratioBucket,
  splitSelectorBranches,
  standingDeadTargets,
  targetKey,
  targetShapes,
} from '../drift/census';

describe('countBucket', () => {
  it('coarsens a count to none / one / multi', () => {
    expect(countBucket(0)).toBe('none');
    expect(countBucket(1)).toBe('one');
    expect(countBucket(2)).toBe('multi');
    expect(countBucket(622)).toBe('multi');
  });

  it('treats a negative count as an unparseable selector', () => {
    // -1 is the sentinel countMatches() records when querySelectorAll throws.
    expect(countBucket(-1)).toBe('invalid');
  });

  it('puts every plausible result-set size in one bucket', () => {
    // The point of the bucketing: a search that returned 38 products last week and
    // 19 this week must be indistinguishable, or the check fires every week.
    expect(countBucket(19)).toBe(countBucket(38));
    expect(countBucket(640)).toBe(countBucket(622));
  });
});

describe('ratioBucket', () => {
  it('splits field presence into none / rare / common', () => {
    expect(ratioBucket(0, 60)).toBe('none');
    // purchasePreferenceList: 1 item in 60 across the committed HEB payloads.
    expect(ratioBucket(1, 60)).toBe('rare');
    // carouselImageUrls: 54 of 60 — the mapper relies on it.
    expect(ratioBucket(54, 60)).toBe('common');
    expect(ratioBucket(38, 38)).toBe('common');
  });

  it('calls an empty item list none rather than dividing by zero', () => {
    expect(ratioBucket(0, 0)).toBe('none');
  });
});

describe('splitSelectorBranches', () => {
  it('splits a plain alternation', () => {
    expect(splitSelectorBranches('[data-automation-id="product"], [data-item-id]')).toEqual([
      '[data-automation-id="product"]',
      '[data-item-id]',
    ]);
  });

  it('keeps a functional pseudo-class argument list intact', () => {
    // HEB's searchOpen. Splitting inside :not() yields two selectors that both
    // throw, which would be reported as `invalid` — a fabricated finding.
    expect(
      splitSelectorBranches('button[aria-label="Open search"], button[aria-label*="search" i]:not([type="submit"])'),
    ).toEqual(['button[aria-label="Open search"]', 'button[aria-label*="search" i]:not([type="submit"])']);
  });

  it('keeps a comma inside an attribute value intact', () => {
    // Amazon's addBtnA really does have a comma in the aria-label prefix.
    expect(splitSelectorBranches('button[aria-label^="Add to Cart,"], .qs-atc-plus')).toEqual([
      'button[aria-label^="Add to Cart,"]',
      '.qs-atc-plus',
    ]);
  });

  it('returns a single-element list for a selector with no alternation', () => {
    expect(splitSelectorBranches('div.component--product-tile')).toEqual(['div.component--product-tile']);
  });

  it('drops empty branches from a trailing or doubled comma', () => {
    expect(splitSelectorBranches('li, , article,')).toEqual(['li', 'article']);
  });
});

describe('target keys', () => {
  it('round-trips a union key and a branch key', () => {
    expect(parseTargetKey(targetKey('card'))).toEqual({ selectorKey: 'card' });
    expect(parseTargetKey(targetKey('card', 1))).toEqual({ selectorKey: 'card', branchIndex: 1 });
  });

  it('survives a selector key that itself ends in brackets', () => {
    // Not a key we ship, but the parse must not silently mangle one.
    expect(parseTargetKey('card[data-x]')).toEqual({ selectorKey: 'card[data-x]' });
  });
});

describe('targetShapes', () => {
  const store: StoreCensus = {
    selectors: { tile: 'div.tile', grid: '#grid' },
    fixtures: {
      'a.html': { tile: 'one', grid: 'one' },
      'b.html': { tile: 'multi', grid: 'one' },
      'c.html': { tile: 'none', grid: 'none' },
    },
  };

  it('calls a target that ever matches several elements list-shaped', () => {
    // wegmans.tile is exactly this: one tortilla tile in one capture, sixty sour
    // cream tiles in another.
    expect(targetShapes(store).tile).toBe('list');
  });

  it('calls a target that is a singleton everywhere it matches singleton-shaped', () => {
    expect(targetShapes(store).grid).toBe('singleton');
  });
});

describe('diffCount', () => {
  it('reports a selector that stopped matching', () => {
    expect(diffCount('multi', 'none')).toEqual({ kind: 'died', level: 'warn' });
    expect(diffCount('one', 'none')).toEqual({ kind: 'died', level: 'warn' });
  });

  it('reports a selector that started matching, without failing on it', () => {
    expect(diffCount('none', 'multi')).toEqual({ kind: 'appeared', level: 'info' });
  });

  it('reports a cardinality change for a singleton-shaped selector', () => {
    // A second #search_product_grid changes which cards __hebFindCards() sees.
    expect(diffCount('one', 'multi', 'singleton')).toEqual({ kind: 'widened', level: 'warn' });
    expect(diffCount('multi', 'one', 'singleton')).toEqual({ kind: 'narrowed', level: 'warn' });
  });

  it('says nothing about a cardinality change on a list-shaped selector', () => {
    // THE false positive this rule exists to suppress: a recaptured search that
    // returned one product instead of sixty is not a markup change.
    expect(diffCount('one', 'multi', 'list')).toBeNull();
    expect(diffCount('multi', 'one', 'list')).toBeNull();
  });

  it('says nothing when the shape is unchanged', () => {
    expect(diffCount('multi', 'multi')).toBeNull();
    expect(diffCount('none', 'none')).toBeNull();
    expect(diffCount('one', 'one')).toBeNull();
  });

  it('reports a selector that no longer parses, and one that parses again', () => {
    expect(diffCount('multi', 'invalid')).toEqual({ kind: 'invalid', level: 'warn' });
    expect(diffCount('invalid', 'multi')).toEqual({ kind: 'repaired', level: 'info' });
  });
});

describe('diffRatio', () => {
  it('reports a field the mapper relies on losing that status', () => {
    expect(diffRatio('common', 'none')).toEqual({ kind: 'field-degraded', level: 'warn' });
    expect(diffRatio('common', 'rare')).toEqual({ kind: 'field-degraded', level: 'warn' });
  });

  it('reports a field becoming reliable, without failing on it', () => {
    expect(diffRatio('rare', 'common')).toEqual({ kind: 'field-appeared', level: 'info' });
  });

  it('says nothing when a rare field comes and goes', () => {
    // Whether ANY avocado in a recaptured search carries a purchase preference is
    // a fact about H-E-B's produce aisle, not about the payload's shape.
    expect(diffRatio('rare', 'none')).toBeNull();
    expect(diffRatio('none', 'rare')).toBeNull();
  });
});

describe('diffCensus', () => {
  function census(stores: Record<string, StoreCensus>): Census {
    return { version: 1, stores };
  }

  const base = census({
    heb: {
      selectors: { productCard: '[data-qe-id="productCard"]', legacy: '[data-component="product-card"], [data-qe-id="productCard"]' },
      fixtures: {
        'search.html': { productCard: 'multi', legacy: 'multi', 'legacy[0]': 'multi', 'legacy[1]': 'multi' },
      },
    },
  });

  it('is silent when nothing changed shape', () => {
    expect(diffCensus(base, base)).toEqual([]);
  });

  it('names the sibling branch still carrying a selector whose primary hook died', () => {
    // The ticket's headline case: automation is unaffected, and we want the warning
    // anyway, because next time there is no fallback left.
    const now = JSON.parse(JSON.stringify(base)) as Census;
    now.stores.heb.fixtures['search.html']['legacy[1]'] = 'none';
    const findings = diffCensus(base, now);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'warn', kind: 'died', target: 'legacy[1]' });
    expect(findings[0].note).toContain('union still multi');
    expect(findings[0].note).toContain('[data-qe-id="productCard"]');
  });

  it('says the whole selector is down when no branch survives', () => {
    const now = JSON.parse(JSON.stringify(base)) as Census;
    now.stores.heb.fixtures['search.html'].legacy = 'none';
    now.stores.heb.fixtures['search.html']['legacy[0]'] = 'none';
    now.stores.heb.fixtures['search.html']['legacy[1]'] = 'none';
    const notes = diffCensus(base, now)
      .filter((f) => f.target.startsWith('legacy['))
      .map((f) => f.note);
    expect(notes.every((n) => n?.includes('whole selector is none'))).toBe(true);
  });

  it('attributes an edited selector to the edit rather than to the store', () => {
    const now = JSON.parse(JSON.stringify(base)) as Census;
    now.stores.heb.selectors.productCard = '[data-testid="productCard"]';
    now.stores.heb.fixtures['search.html'].productCard = 'none';
    const findings = diffCensus(base, now);
    expect(findings.map((f) => f.kind)).toEqual(['selector-changed', 'died']);
    // The edit is reported first, because it explains the death that follows it.
    expect(findings[0]).toMatchObject({ level: 'info', from: '[data-qe-id="productCard"]' });
  });

  it('does not report a newly declared selector as having appeared', () => {
    // A selector added to a store script has no baseline entry. Calling that
    // `appeared` would blame the store for our own commit.
    const now = JSON.parse(JSON.stringify(base)) as Census;
    now.stores.heb.selectors.brandNew = '[data-new]';
    now.stores.heb.fixtures['search.html'].brandNew = 'multi';
    const findings = diffCensus(base, now);
    expect(findings.map((f) => f.kind)).toEqual(['selector-changed']);
  });

  it('reports a new fixture as informational, not as drift', () => {
    const now = JSON.parse(JSON.stringify(base)) as Census;
    now.stores.heb.fixtures['brand-new.html'] = { productCard: 'multi' };
    const findings = diffCensus(base, now);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'info', kind: 'fixture-added' });
  });

  it('warns when a whole store stops being censused', () => {
    const findings = diffCensus(base, census({}));
    expect(findings).toEqual([expect.objectContaining({ level: 'warn', kind: 'store-removed', store: 'heb' })]);
  });

  it('collapses a wholesale die-off into one finding that blames the capture', () => {
    // A recapture from a blocked IP records the challenge page, and a challenge
    // page kills every selector in every fixture. Reported per selector that is
    // several hundred lines for one fact — the loudest possible way to make this
    // check unreadable.
    const many: StoreCensus = { selectors: { a: '.a' }, fixtures: {} };
    for (let f = 0; f < 5; f++) {
      const fx: Record<string, 'multi'> = {};
      for (let i = 0; i < 10; i++) fx[`t${i}`] = 'multi';
      many.fixtures[`f${f}.html`] = fx;
    }
    const wall = JSON.parse(JSON.stringify(many)) as StoreCensus;
    for (const fx of Object.values(wall.fixtures)) for (const k of Object.keys(fx)) fx[k] = 'none' as never;

    const findings = diffCensus(census({ s: many }), census({ s: wall }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'warn', kind: 'capture-suspect', from: '50 live', to: '50 dead' });
  });

  it('reports a partial die-off selector by selector rather than blaming the capture', () => {
    // A real markup change kills some selectors and leaves the rest. That must stay
    // itemised — it is the actual signal.
    const many: StoreCensus = { selectors: { a: '.a' }, fixtures: {} };
    for (let f = 0; f < 5; f++) {
      const fx: Record<string, 'multi'> = {};
      for (let i = 0; i < 10; i++) fx[`t${i}`] = 'multi';
      many.fixtures[`f${f}.html`] = fx;
    }
    const partial = JSON.parse(JSON.stringify(many)) as StoreCensus;
    for (const fx of Object.values(partial.fixtures)) fx.t0 = 'none' as never;

    const findings = diffCensus(census({ s: many }), census({ s: partial }));
    expect(findings).toHaveLength(5);
    expect(findings.every((f) => f.kind === 'died')).toBe(true);
  });

  it('does not let a store with few censused targets trip the capture heuristic', () => {
    // The floor. Losing three selectors out of four is drift, not a bot wall.
    const small: StoreCensus = { selectors: {}, fixtures: { 'f.html': { a: 'multi', b: 'multi', c: 'multi', d: 'multi' } } };
    const after: StoreCensus = { selectors: {}, fixtures: { 'f.html': { a: 'none', b: 'none', c: 'none', d: 'multi' } } };
    const findings = diffCensus(census({ s: small }), census({ s: after }));
    expect(findings.map((f) => f.kind)).toEqual(['died', 'died', 'died']);
  });

  it('does not compare across census versions', () => {
    // Guards the one way this check could invent findings wholesale: reading a
    // baseline whose buckets meant something else.
    const older = { ...base, version: 0 };
    expect(diffCensus(older, base).filter((f) => f.level === 'warn')).toEqual([]);
  });
});

describe('nextData findings', () => {
  const base: Census = {
    version: 1,
    stores: {
      heb: {
        selectors: {},
        fixtures: { 'search.html': {}, 'cart.html': {} },
        nextData: {
          'search.html': { payload: 'grid', freshness: 'fresh', fields: { decodedDisplayName: 'common', prefs: 'rare' } },
          'cart.html': { payload: 'no-grid' },
        },
      },
    },
  };

  it('warns when a usable search payload stops being usable', () => {
    // Nothing goes red when this happens — the JSON path degrades to the DOM
    // scrape by design — so this is the only place it can be seen.
    const now = JSON.parse(JSON.stringify(base)) as Census;
    now.stores.heb.nextData!['search.html'].payload = 'no-grid';
    expect(diffCensus(base, now)).toEqual([
      expect.objectContaining({ level: 'warn', kind: 'payload-lost', from: 'grid', to: 'no-grid' }),
    ]);
  });

  it('stays quiet about a cart page that never had a search grid', () => {
    expect(diffCensus(base, base)).toEqual([]);
  });

  it('warns when the freshness gate stops proving the payload matches the search', () => {
    const now = JSON.parse(JSON.stringify(base)) as Census;
    now.stores.heb.nextData!['search.html'].freshness = 'unverifiable';
    expect(diffCensus(base, now)).toEqual([
      expect.objectContaining({ level: 'warn', kind: 'freshness-changed', to: 'unverifiable' }),
    ]);
  });

  it('stays quiet when a rare field comes and goes', () => {
    const now = JSON.parse(JSON.stringify(base)) as Census;
    now.stores.heb.nextData!['search.html'].fields!.prefs = 'none';
    expect(diffCensus(base, now)).toEqual([]);
  });
});

describe('standingDeadTargets', () => {
  it('lists selectors that match nothing in any fixture', () => {
    const c: Census = {
      version: 1,
      stores: {
        s: {
          selectors: { dead: '.x', alive: '.y' },
          fixtures: { 'a.html': { dead: 'none', alive: 'multi' }, 'b.html': { dead: 'none', alive: 'none' } },
        },
      },
    };
    expect(standingDeadTargets(c)).toEqual([{ store: 's', target: 'dead', fixtures: 2 }]);
  });

  it('is empty for a store with no fixtures rather than claiming everything is dead', () => {
    const c: Census = { version: 1, stores: { s: { selectors: { a: '.a' }, fixtures: {} } } };
    expect(standingDeadTargets(c)).toEqual([]);
  });
});
