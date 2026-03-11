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
  productName: string;
  searchTerm?: string;
  quantity?: number;
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
  quarterlySaves?: number;
  allTimeSaves?: number;
  sharePercent?: number;
  isFollowing?: boolean;
  createdAt?: string;
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
