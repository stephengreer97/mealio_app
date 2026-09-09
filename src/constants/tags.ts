export const ALL_TAGS = [
  'Under 10 Min', 'Under 30 Min', 'Under 45 Min', 'Over 1 Hour',
  'One Pot', 'Sheet Pan', 'Slow Cooker', 'Air Fryer', 'Grilled', 'No Cook',
  'Instant Pot', 'Baked', 'Stovetop', 'Deep Fried', 'Steamed',
  'Breakfast', 'Brunch', 'Lunch', 'Dinner', 'Snack', 'Dessert', 'Side Dish',
  'Appetizer', 'Soup', 'Salad', 'Sandwich', 'Wrap', 'Pasta', 'Tacos',
  'Pizza', 'Burger', 'Stir Fry', 'Smoothie', 'Bowl',
  'Healthy', 'Keto', 'Low Carb', 'High Protein', 'Vegetarian', 'Vegan',
  'Gluten-Free', 'Dairy-Free', 'Paleo', 'Low Calorie', 'High Fiber',
  'Whole30', 'Mediterranean', 'Low Sodium', 'Nut-Free', 'Sugar-Free', 'Low Fat',
  'Chicken', 'Beef', 'Pork', 'Seafood', 'Fish', 'Turkey', 'Tofu', 'Eggs', 'Lamb',
  'American', 'Mexican', 'Italian', 'Asian', 'Indian', 'Thai', 'Japanese',
  'Chinese', 'Korean', 'Greek', 'French', 'Middle Eastern', 'Southern', 'Tex-Mex', 'BBQ',
  'Meal Prep', 'Budget Friendly', '5 Ingredients', 'Family Friendly', 'Date Night',
  'Comfort Food', 'Kid Friendly', 'Game Day', 'Freezer Friendly', 'Make Ahead',
  'Quick Cleanup', 'Leftovers Good',
];

/**
 * The tags worth a chip on Discover, in the order they earn the space.
 *
 * Not the whole vocabulary: 88 tags is a filter sheet, not a row you swipe. The
 * order is how people say what they want for dinner -- time first, then the
 * meal slot, then a diet, then a protein, then a cuisine -- and Discover shows
 * the first 15 of these that the catalogue actually has meals for, so a chip
 * that could only ever come back empty never appears.
 *
 * They filter as ANY-OF, which is both what `?tags=` has always meant on the
 * server and the only thing that can work here: a meal carries at most
 * MAX_MEAL_TAGS of them, so requiring two would already ask for two of a meal's
 * three, and three would ask for the impossible.
 */
export const POPULAR_TAGS = [
  'Under 30 Min', 'Dinner', 'Breakfast', 'Dessert',
  'Vegetarian', 'Vegan', 'Gluten-Free', 'Healthy', 'High Protein',
  'Chicken', 'Beef', 'Seafood',
  'Mexican', 'Italian', 'Asian',
  'One Pot', 'Comfort Food', 'Kid Friendly', 'Budget Friendly', 'Meal Prep',
];

/** How many of POPULAR_TAGS the Discover chip row shows. */
export const DISCOVER_TAG_CHIPS = 15;

/**
 * How many tags one meal carries.
 *
 * This is a server rule, mirrored here the same way `ALL_TAGS` mirrors the
 * vocabulary: `POST /api/creator/meals` refuses a list longer than this outright
 * — it does not keep the first three — so a picker that let a creator choose a
 * fourth would be offering something Save Meal cannot do.
 *
 * Three is also what the meal card renders. Before the server enforced it, a
 * fourth tag was invisible on the card and still matched a Discover filter.
 */
export const MAX_MEAL_TAGS = 3;

export const DIFFICULTY_LEVELS = [1, 2, 3, 4, 5] as const;
export type DifficultyLevel = typeof DIFFICULTY_LEVELS[number];
