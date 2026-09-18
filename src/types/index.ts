export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  tier?: 'free' | 'paid';
  isAdmin?: boolean;
  createdAt?: string;
}

export interface Ingredient {
  ingredientName: string;
  // Product-name alias some call sites read defensively. The normalizer folds
  // product_name / productName / name into ingredientName, so this is rarely set.
  productName?: string;
  searchTerm?: string | null;
  qty: number;
  productQty: number;
  unit: string;
  measure?: string | null;
  /**
   * What the recipe asks be done to the product — "finely diced", "drained and
   * rinsed" (MEAL-102). Rendered after the name the way a recipe writes it.
   *
   * **Never a search term, and never part of one.** The add gate in
   * `WebViewCartSheet` is exact-after-normalisation equality against
   * `searchTerm ?? ingredientName`; prep reaching either field does not fetch a
   * worse product, it matches nothing at all and drops the item into review
   * looking like a matching bug rather than the data bug it is. So prep is
   * carried beside the name and concatenated into it at no point.
   *
   * **Optional, and absent rather than null when there is none** — `string`,
   * not `string | null`. Every ingredient written before this field existed has
   * no `prep` key, and a row with nothing to say has to serialise identically to
   * one of those, because these objects are written straight back on save. See
   * `normalizeIngredients`, which omits the key rather than writing `prep: null`.
   */
  prep?: string;
  dropdown?: { type: string; selectedText: string; selectedValue: string } | null;
  // For sold-by-weight products (HEB Deli / Fish Market / bulk): the weight in
  // lb the user chose to BUY, remembered across runs. Distinct from measure/unit
  // (the recipe amount, display-only) and productQty (the count for normal
  // items). Once set, the item auto-adds at this weight instead of re-prompting.
  purchaseWeight?: number | null;
  // The dropdown's weight increment (lb) — the editor steps purchaseWeight by it.
  weightStep?: number | null;
  /**
   * The product the user actually chose, as the STORE identifies it, keyed by
   * rail (MEAL-19). `searchTerm` is the display name of that product and is a
   * description; this is the identity. Only the Kroger rail writes one today.
   *
   * **Optional, and absent rather than empty when there is none** — same rule
   * as `prep` above and for the same reason: the ingredient array is PATCHed
   * back whole with no migration, so a row nobody has chosen a product for must
   * serialise the way it did before this field existed. See
   * `src/lib/storeProducts.ts` for why it is keyed at all.
   */
  storeProducts?: Record<string, { upc: string; name: string }>;
}

export interface Meal {
  id: string;
  name: string;
  storeId: string;
  ingredients: Ingredient[];
  photoUrl?: string | null;
  deletedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  presetMealId?: string | null;
  // Optional enrichment fields
  author?: string | null;
  story?: string | null;
  recipe?: string | null;
  website?: string | null;
  difficulty?: number | null;
  serves?: string | null;
  tags?: string[];
}

export interface PresetMeal {
  id: string;
  name: string;
  description?: string | null;
  story?: string | null;
  recipe?: string | null;
  source?: string | null;
  photoUrl?: string | null;
  ingredients: Ingredient[];
  tags?: string[];
  difficulty?: number | null;
  serves?: string | null;
  author?: string | null;
  creatorId?: string | null;
  creatorName?: string | null;
  creatorSocial?: string | null;
  creatorPhotoUrl?: string | null;
  creator?: Creator;
  saves?: number;
  trendingScore?: number;
  createdAt?: string;
}

export interface Creator {
  id: string;
  userId?: string;
  displayName: string;
  bio?: string | null;
  photoUrl?: string | null;
  socialHandle?: string | null;
  handle?: string | null;
  followers?: number;
  isFollowing?: boolean;
  createdAt?: string;
  // The four places a creator publishes, and the two columns that say which one
  // of them Mealio reads. Returned by `GET /api/creator/me` only — a creator
  // looking at somebody else's profile gets none of these, so they are optional
  // and absent rather than null on those responses.
  websiteUrl?: string | null;
  youtubeUrl?: string | null;
  instagramUrl?: string | null;
  tiktokUrl?: string | null;
  /** One of the four sources, or 'none' — the off switch. Operator-set. */
  primarySource?: string | null;
  /** Whether anything is polled at all. */
  importOptIn?: boolean | null;
  /**
   * The feed Mealio follows on the creator's website, set once `POST
   * /api/creator/website` has read the site and found it importable. A website
   * is only a source Mealio can read when this is set and on the same site.
   */
  feedUrl?: string | null;
}

/**
 * The creator's own view of their YouTube connection (`GET /api/creator/youtube`).
 *
 * `hasChannel` is the only thing that decides whether the card is shown at all,
 * and it is broader than `connected`: a link the creator gave us says a channel
 * exists even before a grant does.
 */
export interface YouTubeConnection {
  hasChannel: boolean;
  connected: boolean;
  channel: { id: string | null; title: string | null } | null;
  /** Non-null means the grant stopped working and has to be made again. */
  brokenReason: string | null;
  /** False on a grant made without the write scope — the append offer cannot be turned on. */
  canWriteDescriptions: boolean;
  /**
   * The grant carries `youtube.force-ssl`, so a video with a thin description
   * can be read from its captions (MEAL-138). Absent on an older server.
   */
  canReadCaptions?: boolean;
  appendOptIn: boolean;
}

/**
 * An Instagram or TikTok connection (`GET /api/creator/{instagram|tiktok}`).
 */
export interface PlatformConnection {
  connected: boolean;
  account: { id: string | null; name: string | null } | null;
  /** Non-null means the creator has to reconnect before anything can be read. */
  brokenReason: string | null;
  /** When the grant lapses if it is not renewed. Instagram only, in practice. */
  expiresAt: string | null;
  /** False when this deployment has no app credentials for the platform. */
  configured?: boolean;
}

/** The three sources that are connected with an OAuth grant rather than a link. */
export type ConnectedPlatform = 'youtube' | 'instagram' | 'tiktok';

/**
 * What `POST /api/creator/{platform}/complete` says about a connect round trip.
 *
 * A handled failure is a 200 carrying `ok: false` and a sentence the creator
 * can read; `message` is shown verbatim.
 */
export type ConnectCompleteResult =
  | { ok: true; outcome: 'connected' }
  | { ok: false; outcome: 'failed' | 'cancelled'; reason?: string | null; message?: string | null };

/** `POST /api/creator/website`: the site was read, and either kept or refused. */
export type WebsiteCheckResult =
  | {
      ok: true;
      websiteUrl: string;
      feedUrl: string;
      outcome?: string;
      checked?: number;
      passed?: number;
      /** The server's sentence about what it found, shown under the box. */
      detail?: string | null;
    }
  | { ok: false; error: string; outcome?: string };

/**
 * One post in a creator's back catalogue (`POST /api/creator/sync/catalog`).
 * Mirrors `CatalogEntry` in the server's `lib/admin-sync.ts`.
 */
export interface CatalogEntry {
  itemId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  /** What has happened to this post, when anything has. */
  record: {
    status: string;
    detail: string | null;
    at: string | null;
    firstSeenAt: string | null;
    draftId: string | null;
    /** An import of this post is running right now. */
    inFlight: boolean;
  } | null;
}

export type CatalogResult =
  | {
      ok: true;
      source: string;
      entries: CatalogEntry[];
      truncated?: boolean;
      /** Where the next window starts, or null/absent when the list is complete. */
      nextPageToken?: string | null;
    }
  | { ok: false; reason: string; detail: string };

export type SyncItemStatus = 'pending' | 'drafted' | 'rejected' | 'failed' | 'skipped';

export interface SyncItem {
  itemId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  status: SyncItemStatus;
  detail: string | null;
  draftId: string | null;
  mealName: string | null;
  needALook: number | null;
}

export interface SyncRun {
  id: string;
  source: string;
  status: 'queued' | 'running' | 'done';
  items: SyncItem[];
  createdAt?: string | null;
  finishedAt?: string | null;
}

export interface SyncRunTotals {
  selected: number;
  pending: number;
  drafted: number;
  rejected: number;
  failed: number;
  skipped: number;
  needALook?: number;
}

/** What the app sends for one ticked post when starting an import. */
export interface SyncSelection {
  itemId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  /** Read this post again even though it was refused or declined before. */
  reselect?: true;
}

// Profit share is based entirely on the creator's meal saves over a rolling
// 12-month window as a share of all creators' saves in the same window.
export interface CreatorStats {
  followers: number;
  savesAnnual: number;             // this creator's saves in the last 365 days
  savesAll: number;                // this creator's all-time saves
  totalCreatorAnnualSaves: number; // all creators' saves in the last 365 days (denominator)
  annualPct: number;               // savesAnnual / totalCreatorAnnualSaves * 100
  sharePercent: number;            // profit-share percentage (== annualPct)
}

export interface CreatorApplication {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: User;
}
