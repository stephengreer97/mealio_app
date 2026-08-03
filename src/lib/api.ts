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
      body: JSON.stringify({ items, locationId, source: 'app' }),
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

// ─────────────────────────────────────────────────────────────────────────────
// Creator draft review queue (MEAL-89)
//
// The poller extracts recipes from a creator's own posts and queues them; this
// is how the app reads that queue and how a creator decides each one.
//
// Nothing here derives anything about a draft. Which fields are flagged, what
// the callout says and which span of the source it quotes are all decided
// server-side in `lib/import/draft-form.ts` and arrive already worded, because
// a second copy of those rules in this repository would drift behind whatever
// version of the app a creator happens to have installed — and the two would
// then disagree about which fields we verified.
// ─────────────────────────────────────────────────────────────────────────────

/** One flagged field, as the server worded it. Verified fields produce null. */
export interface DraftNotice {
  kind: 'adjusted' | 'unverified' | 'absent' | 'generated';
  /** Leading sentence. Empty when the quote says it all. */
  text: string;
  /** Source span to quote, already truncated. */
  evidence: string | null;
}

/** Index-aligned with the draft's own fields; `ingredients` with its rows. */
export interface DraftNotices {
  name: DraftNotice | null;
  recipe: DraftNotice | null;
  story: DraftNotice | null;
  photoUrl: DraftNotice | null;
  difficulty: DraftNotice | null;
  tags: DraftNotice | null;
  serves: DraftNotice | null;
  ingredients: (DraftNotice | null)[];
}

export interface DraftIngredient {
  ingredientName: string;
  qty: number;
  unit: string;
  measure: string | null;
  searchTerm?: string | null;
  productQty?: number;
}

export interface CreatorDraftBody {
  name: string;
  ingredients: DraftIngredient[];
  recipe: string | null;
  source: string;
  story: string | null;
  photoUrl: string | null;
  difficulty: number | null;
  tags: string[];
  serves: string | null;
}

export interface CreatorDraft {
  id: string;
  sourceUrl: string;
  draft: CreatorDraftBody;
  /** Counts, never a score — a "92% confident" badge is the anti-pattern. */
  summary: { total: number; verified: number; needALook: number };
  review: {
    notices: DraftNotices;
    /** "4 of 15 fields verified. 11 need a look." */
    summaryText: string;
  };
}

export const creatorDrafts = {
  /**
   * The queue, and how much of it there is.
   *
   * `waiting` and `drafts.length` are not the same number: the server reads at
   * most 200 rows and counts all of them. The badge takes `waiting` — badging
   * from the list rewrote a creator's 250 down to 200 the moment they opened
   * the queue, before they had decided anything.
   */
  list: () =>
    request<{
      waiting: number;
      drafts: CreatorDraft[];
      totals: { waiting: number; showing: number; flagged: number };
    }>('/api/creator/import-drafts', { method: 'GET' }),

  /**
   * Just the number, for the tab badge.
   *
   * Called on launch and on every foreground, so it is deliberately the cheap
   * shape: the server answers it with a HEAD count and sends no recipes. It
   * also answers 0 rather than failing for a user who is not a creator, so the
   * caller never has to know before asking.
   */
  count: () =>
    request<{ waiting: number }>('/api/creator/import-drafts?count=1', { method: 'GET' }),

  /**
   * Approve one draft, or decline one or several.
   *
   * `approve` takes exactly one id and the server refuses more. Bulk-approving
   * unreviewed extractions is what the per-field checks exist to prevent, so
   * there is no way to ask for it from here. Declining several is fine —
   * nothing is published either way.
   *
   * Safe to retry. Every decision is a conditional write server-side, so a
   * second tap on a slow connection publishes nothing new; it comes back with
   * `done: 0` and an error saying it was already decided.
   */
  decide: (action: 'approve' | 'cancel', ids: string[]) =>
    request<{ done: number; published: { id: string; name: string }[]; errors: string[]; waiting: number }>(
      '/api/creator/import-drafts',
      { method: 'POST', body: JSON.stringify({ action, ids }) },
    ),

  /** Fix a field without deciding the draft. It stays in the queue. */
  edit: (id: string, draft: CreatorDraftBody) =>
    request<{ draft: CreatorDraft }>('/api/creator/import-drafts', {
      method: 'PATCH',
      body: JSON.stringify({ id, draft }),
    }),
};

// Push notifications (MEAL-88). One row per device server-side, keyed on the
// Expo token; `previousToken` is what turns a rotation into a replacement
// instead of a second live device.
export const push = {
  register: (data: { token: string; platform?: string; deviceName?: string; previousToken?: string }) =>
    request<{ ok: true }>('/api/push/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Short timeout, unlike everything else here. Sign-out awaits this before it
  // clears the session, so the default 30 s is 30 s of frozen UI for anyone who
  // signs out with no connectivity. Failing fast is safe: the token is kept and
  // the next launch retries it.
  unregister: (token: string) =>
    request<{ ok: true }>('/api/push/register', {
      method: 'DELETE',
      body: JSON.stringify({ token }),
      timeoutMs: 8_000,
    }),
};

// Usage analytics. All best-effort: a logging failure must never surface to the
// caller or block an open / automation run.
export const usage = {
  logOpen: async (data: { source: 'app'; platform?: string; appVersion?: string }): Promise<void> => {
    try {
      await request<{ ok: boolean }>('/api/usage/open', { method: 'POST', body: JSON.stringify(data) });
    } catch { /* best-effort */ }
  },

  logAutomationStart: async (data: {
    storeId: string;
    source: 'app';
    mealCount?: number;
    itemsRequested?: number;
    configVersion?: number;
    appVersion?: string;
    platform?: 'ios' | 'android';
  }): Promise<string | null> => {
    try {
      const r = await request<{ runId: string }>('/api/usage/automation', {
        method: 'POST',
        body: JSON.stringify({ phase: 'start', ...data }),
      });
      return r?.runId ?? null;
    } catch { return null; }
  },

  logAutomationComplete: async (data: { runId: string; itemsAdded?: number; itemsRequested?: number; outcome: 'success' | 'partial' | 'failed' }): Promise<void> => {
    if (!data.runId) return;
    try {
      await request<{ ok: boolean }>('/api/usage/automation', {
        method: 'POST',
        body: JSON.stringify({ phase: 'complete', ...data }),
      });
    } catch { /* best-effort */ }
  },

  // Per-step funnel telemetry for one run. Batched by the caller (see
  // automation-telemetry.ts); ingest is idempotent on (runId, seq), so a retry
  // after a network blip can't double-count. Returns whether the batch landed so
  // the caller knows to re-queue it.
  logAutomationSteps: async (data: {
    runId: string;
    configVersion?: number;
    appVersion?: string;
    platform?: 'ios' | 'android';
    steps: Array<{
      seq: number;
      step: string;
      outcome: string;
      durationMs?: number;
      itemIndex?: number;
      detail?: Record<string, unknown>;
    }>;
  }): Promise<boolean> => {
    if (!data.runId || data.steps.length === 0) return true;
    try {
      // Shorter timeout than the default: telemetry must never hold a queue open
      // long enough to matter to a cart run that's already finishing.
      await request<{ ok: boolean }>('/api/usage/automation/steps', {
        method: 'POST',
        body: JSON.stringify(data),
        timeoutMs: 10_000,
      });
      return true;
    } catch (err) {
      // 4xx means the batch is unacceptable and retrying won't help (bad runId,
      // oversized); 5xx/timeout is worth another attempt.
      const status = err instanceof ApiError ? err.status : 0;
      return status >= 400 && status < 500;
    }
  },
};

// Remote automation config (selectors, URLs, timeouts, flags) for the WebView
// cart engine. Returns null on any failure — the caller keeps its cached or
// bundled config, so a config-server outage never blocks automation.
export const automation = {
  getConfig: async (): Promise<{ version: number; config: unknown } | null> => {
    try {
      const r = await request<{ version: number; config: unknown }>('/api/automation/config', {
        method: 'GET',
        timeoutMs: 10_000,
      });
      return r && typeof r.version === 'number' ? r : null;
    } catch { return null; }
  },
};

export { ApiError };
