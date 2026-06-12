// Unit tests for the snake_case → camelCase mappers in api-mappers.ts.
//
// Each mapper accepts both shapes from the API and pins the resulting Meal /
// PresetMeal / Creator structure. Bugs here surface as missing fields in
// every screen that consumes the API, so the contract is pinned strictly.

import { mapMeal, mapPresetMeal, mapCreator } from '../../src/lib/api-mappers';

describe('mapMeal', () => {
  const minimal = { id: 'm1', name: 'Tacos' };

  it('passes through id and name', () => {
    const r = mapMeal(minimal);
    expect(r.id).toBe('m1');
    expect(r.name).toBe('Tacos');
  });

  it('reads snake_case fields', () => {
    const r = mapMeal({
      ...minimal,
      store_id: 'wegmans',
      photo_url: 'https://x/p.jpg',
      deleted_at: '2026-01-01',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
      preset_meal_id: 'pm1',
    });
    expect(r.storeId).toBe('wegmans');
    expect(r.photoUrl).toBe('https://x/p.jpg');
    expect(r.deletedAt).toBe('2026-01-01');
    expect(r.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(r.updatedAt).toBe('2026-02-01T00:00:00Z');
    expect(r.presetMealId).toBe('pm1');
  });

  it('reads camelCase fields when snake_case absent', () => {
    const r = mapMeal({
      ...minimal,
      storeId: 'heb',
      photoUrl: 'https://y/p.jpg',
      presetMealId: 'pm2',
    });
    expect(r.storeId).toBe('heb');
    expect(r.photoUrl).toBe('https://y/p.jpg');
    expect(r.presetMealId).toBe('pm2');
  });

  it('snake_case wins when both present', () => {
    const r = mapMeal({ ...minimal, store_id: 'snake', storeId: 'camel' });
    expect(r.storeId).toBe('snake');
  });

  it('defaults missing fields to null / "" / []', () => {
    const r = mapMeal(minimal);
    expect(r.storeId).toBe('');
    expect(r.photoUrl).toBe(null);
    expect(r.deletedAt).toBe(null);
    expect(r.presetMealId).toBe(null);
    expect(r.author).toBe(null);
    expect(r.story).toBe(null);
    expect(r.recipe).toBe(null);
    expect(r.website).toBe(null);
    expect(r.difficulty).toBe(null);
    expect(r.serves).toBe(null);
    expect(r.tags).toEqual([]);
    expect(r.ingredients).toEqual([]);
  });

  it('normalizes ingredients via normalizeIngredients (string + object inputs both accepted)', () => {
    const r = mapMeal({
      ...minimal,
      ingredients: ['Sour Cream', { product_name: 'Tortillas', qty: 2 }],
    });
    expect(r.ingredients).toHaveLength(2);
    expect(r.ingredients[0].ingredientName).toBe('Sour Cream');
    expect(r.ingredients[1].ingredientName).toBe('Tortillas');
    expect(r.ingredients[1].qty).toBe(2);
  });

  it('passes tags array through verbatim', () => {
    const r = mapMeal({ ...minimal, tags: ['mexican', 'easy'] });
    expect(r.tags).toEqual(['mexican', 'easy']);
  });
});

describe('mapPresetMeal', () => {
  const minimal = { id: 'p1', name: 'Tacos' };

  it('reads snake_case fields', () => {
    const r = mapPresetMeal({
      ...minimal,
      photo_url: 'https://x/p.jpg',
      creator_id: 'c1',
      creator_name: 'Stephen',
      creator_social: '@stephen',
      saves_all: 42,
      trending_score: 99.5,
      created_at: '2026-01-01',
    });
    expect(r.photoUrl).toBe('https://x/p.jpg');
    expect(r.creatorId).toBe('c1');
    expect(r.creatorName).toBe('Stephen');
    expect(r.creatorSocial).toBe('@stephen');
    expect(r.saves).toBe(42);
    expect(r.trendingScore).toBe(99.5);
    expect(r.createdAt).toBe('2026-01-01');
  });

  it('reads camelCase fields when snake_case absent', () => {
    const r = mapPresetMeal({
      ...minimal,
      photoUrl: 'https://y/p.jpg',
      creatorId: 'c2',
      creatorName: 'Sam',
      creatorSocial: '@sam',
      saves: 10,
      trendingScore: 12.3,
    });
    expect(r.photoUrl).toBe('https://y/p.jpg');
    expect(r.creatorId).toBe('c2');
    expect(r.creatorName).toBe('Sam');
    expect(r.creatorSocial).toBe('@sam');
    expect(r.saves).toBe(10);
    expect(r.trendingScore).toBe(12.3);
  });

  it('saves_all wins over saves when both present (preset rollup vs legacy)', () => {
    const r = mapPresetMeal({ ...minimal, saves_all: 100, saves: 5 });
    expect(r.saves).toBe(100);
  });

  it('defaults saves and trendingScore to 0 when both shapes absent', () => {
    const r = mapPresetMeal(minimal);
    expect(r.saves).toBe(0);
    expect(r.trendingScore).toBe(0);
  });

  it('defaults description / story / recipe / etc. to null', () => {
    const r = mapPresetMeal(minimal);
    expect(r.description).toBe(null);
    expect(r.story).toBe(null);
    expect(r.recipe).toBe(null);
    expect(r.source).toBe(null);
    expect(r.author).toBe(null);
    expect(r.creatorId).toBe(null);
    expect(r.creatorName).toBe(null);
    expect(r.creatorSocial).toBe(null);
    expect(r.photoUrl).toBe(null);
    expect(r.difficulty).toBe(null);
    expect(r.serves).toBe(null);
  });

  it('defaults tags to [] when absent', () => {
    expect(mapPresetMeal(minimal).tags).toEqual([]);
  });

  it('normalizes ingredients through normalizeIngredients', () => {
    const r = mapPresetMeal({
      ...minimal,
      ingredients: [{ productName: 'Sour Cream', quantity: 2 }],
    });
    expect(r.ingredients).toHaveLength(1);
    expect(r.ingredients[0].ingredientName).toBe('Sour Cream');
    expect(r.ingredients[0].qty).toBe(2);
  });
});

describe('mapCreator', () => {
  const minimal = { id: 'c1' };

  it('reads snake_case fields', () => {
    const r = mapCreator({
      ...minimal,
      user_id: 'u1',
      display_name: 'Stephen Greer',
      photo_url: 'https://x/p.jpg',
      social_handle: '@stephen',
      is_following: true,
      followers: 100,
      created_at: '2026-01-01',
    });
    expect(r.userId).toBe('u1');
    expect(r.displayName).toBe('Stephen Greer');
    expect(r.photoUrl).toBe('https://x/p.jpg');
    expect(r.socialHandle).toBe('@stephen');
    expect(r.isFollowing).toBe(true);
    expect(r.followers).toBe(100);
    expect(r.createdAt).toBe('2026-01-01');
  });

  it('reads camelCase fields when snake_case absent', () => {
    const r = mapCreator({
      ...minimal,
      userId: 'u2',
      displayName: 'Sam',
      socialHandle: '@sam',
      isFollowing: false,
    });
    expect(r.userId).toBe('u2');
    expect(r.displayName).toBe('Sam');
    expect(r.socialHandle).toBe('@sam');
    expect(r.isFollowing).toBe(false);
  });

  it('defaults missing string fields to "" and missing optional fields to null', () => {
    const r = mapCreator(minimal);
    expect(r.userId).toBe('');
    expect(r.displayName).toBe('');
    expect(r.bio).toBe(null);
    expect(r.photoUrl).toBe(null);
    expect(r.socialHandle).toBe(null);
  });

  it('defaults numeric counters to 0', () => {
    const r = mapCreator(minimal);
    expect(r.followers).toBe(0);
    expect(r.quarterlySaves).toBe(0);
    expect(r.allTimeSaves).toBe(0);
    expect(r.sharePercent).toBe(0);
  });

  it('defaults isFollowing to false', () => {
    expect(mapCreator(minimal).isFollowing).toBe(false);
  });
});
