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
  followers?: number;
  isFollowing?: boolean;
  createdAt?: string;
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
