// Snake_case → camelCase mappers for API responses.
//
// The server returns DB rows roughly verbatim, so some fields land in snake_case
// (photo_url, store_id, created_at) and some in camelCase (added by app
// writers). Each mapper accepts both shapes via `field_a ?? fieldA ?? null`.
//
// Extracted from api.ts so unit tests can exercise without dragging the
// expo-secure-store import chain through node-jest.

import type { Meal, PresetMeal, Creator } from '../types';
import { normalizeIngredients } from './normalizeIngredients';

export function mapMeal(m: any): Meal {
  return {
    id: m.id,
    name: m.name,
    storeId: m.store_id ?? m.storeId ?? '',
    ingredients: normalizeIngredients(m.ingredients),
    photoUrl: m.photo_url ?? m.photoUrl ?? null,
    deletedAt: m.deleted_at ?? m.deletedAt ?? null,
    createdAt: m.created_at ?? m.createdAt,
    updatedAt: m.updated_at ?? m.updatedAt,
    presetMealId: m.preset_meal_id ?? m.presetMealId ?? null,
    author: m.author ?? null,
    story: m.story ?? null,
    recipe: m.recipe ?? null,
    website: m.website ?? null,
    difficulty: m.difficulty ?? null,
    serves: m.serves ?? null,
    tags: m.tags ?? [],
  };
}

export function mapPresetMeal(m: any): PresetMeal {
  return {
    id: m.id,
    name: m.name,
    description: m.description ?? null,
    story: m.story ?? null,
    recipe: m.recipe ?? null,
    source: m.source ?? null,
    photoUrl: m.photo_url ?? m.photoUrl ?? null,
    ingredients: normalizeIngredients(m.ingredients),
    tags: m.tags ?? [],
    difficulty: m.difficulty ?? null,
    serves: m.serves ?? null,
    author: m.author ?? null,
    creatorId: m.creator_id ?? m.creatorId ?? null,
    creatorName: m.creator_name ?? m.creatorName ?? null,
    creatorSocial: m.creator_social ?? m.creatorSocial ?? null,
    saves: m.saves_all ?? m.saves ?? 0,
    trendingScore: m.trending_score ?? m.trendingScore ?? 0,
    createdAt: m.created_at ?? m.createdAt,
  };
}

export function mapCreator(c: any): Creator {
  return {
    id: c.id,
    userId: c.user_id ?? c.userId ?? '',
    displayName: c.display_name ?? c.displayName ?? '',
    bio: c.bio ?? null,
    photoUrl: c.photo_url ?? c.photoUrl ?? null,
    socialHandle: c.social_handle ?? c.socialHandle ?? null,
    handle: c.handle ?? null,
    followers: c.followers ?? 0,
    isFollowing: c.is_following ?? c.isFollowing ?? false,
    createdAt: c.created_at ?? c.createdAt,
  };
}
