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
  dropdown?: { type: string; selectedText: string; selectedValue: string } | null;
  // For sold-by-weight products (HEB Deli / Fish Market / bulk): the weight in
  // lb the user chose to BUY, remembered across runs. Distinct from measure/unit
  // (the recipe amount, display-only) and productQty (the count for normal
  // items). Once set, the item auto-adds at this weight instead of re-prompting.
  purchaseWeight?: number | null;
  // The dropdown's weight increment (lb) — the editor steps purchaseWeight by it.
  weightStep?: number | null;
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
  /** Whether anything is polled at all. Operator-set; a creator can only ever clear it. */
  importOptIn?: boolean | null;
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
  appendOptIn: boolean;
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
