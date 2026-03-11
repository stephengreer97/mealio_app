import { getAccessToken, getRefreshToken, save, clear } from './tokenStorage';
import { Meal, PresetMeal, Creator, User, Ingredient } from '../types';

const BASE_URL = 'https://mealio.co';

// ── Mappers: convert snake_case DB rows → camelCase types ─────────────────────

// Normalise ingredients regardless of how they're stored in the DB.
// Handles: null/undefined → [], plain strings → [{ productName }], objects → as-is.
function normalizeIngredients(raw: any): Ingredient[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === 'string') return { productName: item };
    if (item && typeof item === 'object') {
      return {
        productName: item.productName ?? item.product_name ?? item.name ?? '',
        quantity: item.quantity ?? undefined,
        searchTerm: item.searchTerm ?? item.search_term ?? undefined,
      };
    }
    return { productName: String(item) };
  }).filter((i) => i.productName);
}

function mapMeal(m: any): Meal {
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
    tags: m.tags ?? [],
  };
}

function mapPresetMeal(m: any): PresetMeal {
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
    author: m.author ?? null,
    creatorId: m.creator_id ?? m.creatorId ?? null,
    creatorName: m.creator_name ?? m.creatorName ?? null,
    creatorSocial: m.creator_social ?? m.creatorSocial ?? null,
    saves: m.saves_all ?? m.saves ?? 0,
    trendingScore: m.trending_score ?? m.trendingScore ?? 0,
    createdAt: m.created_at ?? m.createdAt,
  };
}

function mapCreator(c: any): Creator {
  return {
    id: c.id,
    userId: c.user_id ?? c.userId ?? '',
    displayName: c.display_name ?? c.displayName ?? '',
    bio: c.bio ?? null,
    photoUrl: c.photo_url ?? c.photoUrl ?? null,
    socialHandle: c.social_handle ?? c.socialHandle ?? null,
    followers: c.followers ?? 0,
    isFollowing: c.is_following ?? c.isFollowing ?? false,
    quarterlySaves: c.quarterlySaves ?? 0,
    allTimeSaves: c.allTimeSaves ?? 0,
    sharePercent: c.sharePercent ?? 0,
    createdAt: c.created_at ?? c.createdAt,
  };
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retry = true
): Promise<T> {
  const accessToken = await getAccessToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers ? (options.headers as Record<string, string>) : {}),
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401 && retry) {
    // The server uses a long-lived access token (90 days). /api/auth/renew takes the
    // current access token via Authorization header and returns a fresh one.
    const currentToken = await getAccessToken();
    if (!currentToken) {
      await clear();
      throw new ApiError(401, 'Unauthorized');
    }

    const refreshRes = await fetch(`${BASE_URL}/api/auth/renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentToken}`,
      },
    });

    if (!refreshRes.ok) {
      await clear();
      throw new ApiError(401, 'Session expired');
    }

    const { accessToken: newAccess, user } = await refreshRes.json();
    if (!newAccess) {
      await clear();
      throw new ApiError(401, 'Session expired');
    }
    await save(newAccess, null, user);

    // Retry original request with new token
    return request<T>(path, options, false);
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      message = body.error || body.message || message;
    } catch {}
    throw new ApiError(response.status, message);
  }

  // Handle empty responses
  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

// Auth
export const auth = {
  login: (email: string, password: string) =>
    request<any>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (firstName: string, lastName: string, email: string, password: string) =>
    request<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ firstName, lastName, email, password }),
    }),

  verify: () =>
    request<{ user: User }>('/api/auth/verify', { method: 'GET' }),

  renew: (accessToken: string) =>
    fetch(`${BASE_URL}/api/auth/renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    }).then((r) => r.json()),

  logout: () =>
    request<void>('/api/auth/logout', { method: 'POST' }),

  resendVerification: (email: string) =>
    request<void>('/api/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  forgotPassword: (email: string) =>
    request<void>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  verify2FA: (twoFactorToken: string, code: string) =>
    request<any>('/api/auth/2fa/verify', {
      method: 'POST',
      body: JSON.stringify({ twoFactorToken, code }),
    }),

  resend2FA: (twoFactorToken: string) =>
    request<void>('/api/auth/2fa/resend', {
      method: 'POST',
      body: JSON.stringify({ twoFactorToken }),
    }),
};

// Account
export const account = {
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/account/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
};

// Meals
export const meals = {
  list: () =>
    request<{ meals: any[] }>('/api/meals', { method: 'GET' })
      .then((r) => (r.meals ?? []).map(mapMeal)),

  create: (meal: Omit<Meal, 'id' | 'createdAt' | 'updatedAt'> & Record<string, any>) =>
    request<{ meal: any }>('/api/meals', {
      method: 'POST',
      body: JSON.stringify(meal),
    }).then((r) => mapMeal(r.meal)),

  update: (id: string, data: Partial<Meal>) =>
    request<{ meal: any }>(`/api/meals/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }).then((r) => mapMeal(r.meal)),

  delete: (id: string) =>
    request<void>(`/api/meals/${id}`, { method: 'DELETE' }),

  listDeleted: () =>
    request<{ meals: any[] }>('/api/meals/deleted', { method: 'GET' })
      .then((r) => (r.meals ?? []).map(mapMeal)),

  restore: (id: string) =>
    request<void>(`/api/meals/${id}/restore`, { method: 'POST' }),

  permanentDelete: (id: string) =>
    request<void>(`/api/meals/${id}?permanent=true`, { method: 'DELETE' }),

  share: (id: string) =>
    request<{ shareUrl: string }>(`/api/meals/${id}/share`, { method: 'POST' }),
};

// Preset Meals
export const presetMeals = {
  list: (params: { limit?: number; offset?: number; tags?: string[]; difficulty?: string; sort?: string }) => {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    if (params.tags?.length) query.set('tags', params.tags.join(','));
    if (params.difficulty) query.set('difficulty', params.difficulty);
    // "following" uses a separate param; "new" uses sort=new; default is trending
    if (params.sort === 'following') {
      query.set('followed', 'true');
    } else if (params.sort === 'newest') {
      query.set('sort', 'new');
    }
    return request<{ presetMeals: any[]; hasMore: boolean }>(
      `/api/preset-meals?${query}`, { method: 'GET' }
    ).then((r) => ({
      meals: (r.presetMeals ?? []).map(mapPresetMeal),
      hasMore: r.hasMore ?? false,
    }));
  },

  getById: (id: string) =>
    request<{ meal: any }>(`/api/preset-meals/${id}`, { method: 'GET' })
      .then((r) => mapPresetMeal(r.meal)),

  save: (id: string, storeId: string) =>
    request<void>(`/api/preset-meals/${id}/save`, {
      method: 'POST',
      body: JSON.stringify({ storeId }),
    }),
};

// Creators
export const creators = {
  featured: () =>
    request<{ creators: any[] }>('/api/creators/featured', { method: 'GET' })
      .then((r) => (r.creators ?? []).map(mapCreator)),

  getMe: () =>
    request<{ creator: any | null; application: any | null; meals?: any[]; stats?: any }>(
      '/api/creator/me', { method: 'GET' }
    ).then((r) => ({
      creator: r.creator ? mapCreator(r.creator) : null,
      application: r.application ?? null,
      meals: (r.meals ?? []).map(mapPresetMeal),
      stats: r.stats ?? null,
    })),

  updateMe: (data: Partial<Creator>) =>
    request<any>('/api/creator/me', {
      method: 'PATCH',
      body: JSON.stringify({ photoUrl: data.photoUrl, bio: data.bio, displayName: data.displayName }),
    }),

  apply: (data: { displayName: string; phone: string; findUs: string; photoUrl?: string }) =>
    request<any>('/api/creator/apply', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getById: (id: string) =>
    request<{ creator: any; meals: any[]; followerCount: number }>(`/api/creators/${id}`, { method: 'GET' })
      .then((r) => ({
        creator: mapCreator({ ...r.creator, followers: r.followerCount }),
        meals: (r.meals ?? []).map(mapPresetMeal),
      })),

  follow: (id: string) =>
    request<void>(`/api/creators/${id}/follow`, { method: 'POST' }),

  unfollow: (id: string) =>
    request<void>(`/api/creators/${id}/follow`, { method: 'DELETE' }),

  following: () =>
    request<{ creators: any[] }>('/api/creators/following', { method: 'GET' })
      .then((r) => (r.creators ?? []).map(mapCreator)),

  creatorMeals: {
    list: () =>
      request<{ creator: any | null; meals?: any[] }>(
        '/api/creator/me', { method: 'GET' }
      ).then((r) => (r.meals ?? []).map(mapPresetMeal)),

    create: (data: Partial<PresetMeal> & { photoUrl?: string | null }) =>
      request<{ meal: any }>('/api/creator/meals', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name,
          ingredients: data.ingredients,
          story: data.story,
          recipe: data.recipe,
          source: data.source,
          photoUrl: data.photoUrl,
          tags: data.tags,
          difficulty: data.difficulty,
        }),
      }).then((r) => mapPresetMeal(r.meal)),

    update: (id: string, data: Partial<PresetMeal> & { photoUrl?: string | null }) =>
      request<{ meal: any }>(`/api/creator/meals/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: data.name,
          ingredients: data.ingredients,
          story: data.story,
          recipe: data.recipe,
          source: data.source,
          photoUrl: data.photoUrl,
          tags: data.tags,
          difficulty: data.difficulty,
        }),
      }).then((r) => mapPresetMeal(r.meal)),

    delete: (id: string) =>
      request<void>(`/api/creator/meals/${id}`, { method: 'DELETE' }),
  },
};

// Shared meals (public GET, auth-required POST)
export const shared = {
  getMeal: (token: string) =>
    request<{ meal: any }>(`/api/shared/${token}`, { method: 'GET' }),

  saveMeal: (token: string, storeId: string) =>
    request<{ meal: any }>(`/api/shared/${token}/save`, {
      method: 'POST',
      body: JSON.stringify({ storeId }),
    }),
};

// Images
export const images = {
  upload: (imageData: string) =>
    request<{ url: string }>('/api/images/upload', {
      method: 'POST',
      body: JSON.stringify({ imageData }),
    }),

  generatePhoto: (mealName: string) =>
    request<{ thumbs: string[]; fulls: string[] }>('/api/meals/generate-photo', {
      method: 'POST',
      body: JSON.stringify({ mealName }),
    }),
};

// Payments
export const payments = {
  portal: () =>
    request<{ portalUrl: string }>('/api/payments/portal', { method: 'GET' }),
};

export { ApiError };
