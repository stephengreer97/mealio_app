import { getAccessToken, getRefreshToken, save, clear } from './tokenStorage';
import { Meal, PresetMeal, Creator, CreatorStats, User, Ingredient } from '../types';
import { normalizeIngredients } from './normalizeIngredients';
import { mapMeal, mapPresetMeal, mapCreator } from './api-mappers';

export { normalizeIngredients };

const BASE_URL = 'https://mealio.co';

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// RN's fetch has no request timeout, so a stalled connection hangs forever —
// which in flows like Kroger add-to-cart means a spinner that never resolves.
const DEFAULT_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new ApiError(408, 'Request timed out. Please try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

type RequestOptions = RequestInit & { timeoutMs?: number };

// Single-flight renew: concurrent 401s share one in-flight renewal instead of
// each firing their own /renew (and a failure clearing the session mid-session).
let inflightRenew: Promise<void> | null = null;

async function renewAccessToken(): Promise<void> {
  const currentToken = await getAccessToken();
  if (!currentToken) {
    throw new ApiError(401, 'Unauthorized');
  }

  const refreshRes = await fetchWithTimeout(`${BASE_URL}/api/auth/renew`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${currentToken}`,
    },
  }, DEFAULT_TIMEOUT_MS);

  if (!refreshRes.ok) {
    throw new ApiError(401, 'Session expired');
  }

  const { accessToken: newAccess, user } = await refreshRes.json();
  if (!newAccess) {
    throw new ApiError(401, 'Session expired');
  }
  // /renew may omit the user — save() tolerates a missing one and keeps the
  // already-stored user instead of clobbering it.
  await save(newAccess, null, user);
}

function renewOnce(): Promise<void> {
  if (!inflightRenew) {
    inflightRenew = renewAccessToken().finally(() => { inflightRenew = null; });
  }
  return inflightRenew;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
  retry = true
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
  const accessToken = await getAccessToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOptions.headers ? (fetchOptions.headers as Record<string, string>) : {}),
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const response = await fetchWithTimeout(`${BASE_URL}${path}`, {
    ...fetchOptions,
    headers,
  }, timeoutMs);

  if (response.status === 401 && retry) {
    // The server uses a long-lived access token (90 days). /api/auth/renew takes the
    // current access token via Authorization header and returns a fresh one.
    // Concurrent 401s coalesce onto a single in-flight renewal (see renewOnce).
    try {
      await renewOnce();
    } catch (err) {
      await clear();
      throw err instanceof ApiError ? err : new ApiError(401, 'Session expired');
    }

    // Retry original request with new token
    return request<T>(path, options, false);
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      message = body.error || body.message || message;
    } catch {}
    if (response.status >= 500) {
      console.error(`[api] unexpected error: ${path} → ${response.status} ${message}`);
    }
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
    fetchWithTimeout(`${BASE_URL}/api/auth/renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    }, DEFAULT_TIMEOUT_MS).then((r) => r.json()),

  logout: () =>
    request<void>('/api/auth/logout', { method: 'POST' }),

  logoutAll: () =>
    request<void>('/api/auth/logout-all', { method: 'POST' }),

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

  oauthGoogle: (idToken: string) =>
    request<any>('/api/auth/oauth/google', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    }),

  oauthApple: (identityToken: string, user?: { name?: { firstName?: string; lastName?: string }; email?: string }) =>
    request<any>('/api/auth/oauth/apple', {
      method: 'POST',
      body: JSON.stringify({ identityToken, user }),
    }),
};

// Account
export const account = {
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ accessToken?: string }>('/api/account/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  deleteAccount: () =>
    request<void>('/api/account/delete', { method: 'DELETE' }),
};

// Broadcast
export interface Broadcast {
  id: string;
  message: string;
  stores: string[];      // empty = everyone; else only users with a meal at one
  forceShow: boolean;    // show on every launch even after dismissal
  createdAt: string;
}
export const broadcast = {
  // Public endpoint — returns all active broadcasts.
  get: () => request<{ broadcasts: Broadcast[] }>('/api/broadcast', { method: 'GET' }),
};

// Bug report
export interface BugReportInput {
  description: string;
  /** Redacted recent session logs (from logBuffer.getSessionLogs()). */
  logs?: string;
  /** Auto-attached diagnostics (version, platform/OS, route, etc.). */
  context?: Record<string, unknown>;
}
export const bugReport = {
  submit: (input: BugReportInput) =>
    request<{ ok: true }>('/api/bug-report', {
      method: 'POST',
      body: JSON.stringify(input),
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
    request<{ creator: any | null; application: any | null; meals?: any[]; stats?: CreatorStats }>(
      '/api/creator/me', { method: 'GET' }
    ).then((r) => ({
      creator: r.creator ? mapCreator(r.creator) : null,
      application: r.application ?? null,
      meals: (r.meals ?? []).map(mapPresetMeal),
      stats: (r.stats ?? null) as CreatorStats | null,
    })),

  updateMe: (data: Partial<Creator>) =>
    request<any>('/api/creator/me', {
      method: 'PATCH',
      body: JSON.stringify({ photoUrl: data.photoUrl, bio: data.bio, displayName: data.displayName }),
    }),

  apply: (data: { displayName: string; handle: string; phone: string; findUs: string; photoUrl?: string }) =>
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

// Kroger
export const kroger = {
  status: () =>
    request<{ connected: boolean; locations: Record<string, { locationId: string; locationName: string | null }>; connectedAt?: string }>(
      '/api/kroger/status', { method: 'GET' }
    ),

  connect: (storeId?: string) =>
    request<{ redirectUrl: string }>('/api/kroger/connect', {
      method: 'POST',
      body: JSON.stringify({ mobile: true, storeId }),
    }),

  disconnect: () =>
    request<{ success: boolean }>('/api/kroger/disconnect', { method: 'POST' }),

  searchLocations: (term: string) =>
    request<{ locations: Array<{ locationId: string; name: string; chain?: string; storeId: string; address: string }> }>(
      `/api/kroger/locations?term=${encodeURIComponent(term)}`, { method: 'GET' }
    ),

  setLocation: (locationId: string, locationName: string, storeId: string) =>
    request<{ success: boolean; locationId: string; locationName: string; storeId: string }>('/api/kroger/set-location', {
      method: 'POST',
      body: JSON.stringify({ locationId, locationName, storeId }),
    }),

  addToCart: (ingredients: Array<{ ingredientName?: string; productName?: string; productQty?: number; qty?: number; quantity?: number }>, locationId?: string) =>
    request<{ added: string[]; notFound: string[]; cartAdded: boolean }>('/api/kroger/add-to-cart', {
      method: 'POST',
      body: JSON.stringify({ ingredients: ingredients.map((i) => ({ productName: i.ingredientName ?? i.productName, quantity: i.productQty ?? i.qty ?? i.quantity ?? 1 })), locationId }),
      // Server fans out to the Kroger API per ingredient — needs more headroom.
      timeoutMs: 60_000,
    }),

  addToCartDirect: (items: Array<{ upc: string; quantity: number }>, locationId?: string) =>
    request<{ added: number; cartAdded: boolean }>('/api/kroger/add-to-cart', {
      method: 'POST',
      body: JSON.stringify({ items, locationId }),
      timeoutMs: 60_000,
    }),

  searchProducts: (ingredients: Array<{ ingredientName?: string; productName?: string; productQty?: number; qty?: number; quantity?: number }>, locationId?: string, storeId?: string, mealNames?: string[]) =>
    request<{
      results: Array<{
        term: string;
        quantity: number;
        upc: string | null;
        description: string | null;
        exact: boolean;
        suggestions: Array<{ upc: string; description: string; size: string; price: number | null; stockLevel?: string; imageUrl?: string }>;
      }>;
    }>('/api/kroger/search-products', {
      method: 'POST',
      body: JSON.stringify({ ingredients, locationId, storeId, mealNames }),
      timeoutMs: 60_000,
    }),
};

export { ApiError };
