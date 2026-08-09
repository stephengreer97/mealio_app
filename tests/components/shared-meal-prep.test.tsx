// MEAL-102 — the preparation on the shared-meal screen.
//
// The third surface that prints an ingredient line, and the only one a person
// with no account ever sees: someone opens a shared link and reads the recipe.
// `meal-prep-lines.test.tsx` holds the meal sheet and
// `creator-review-queue.test.tsx` holds the draft; this holds the shared page.
//
// `normalizeIngredients` is deliberately NOT stubbed here. It is the mapper that
// turns the wire row into the row the screen renders, and it is where an
// additive field is most easily dropped — so this test covers the hop as well as
// the render, which the other two files do not.

import React from 'react';
import { act, render } from '@testing-library/react-native';

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name);
  return { Feather: icon, Ionicons: icon };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return {
    SafeAreaView: (props: any) => RealReact.createElement(RealView, props, props.children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

const mockGetMeal = jest.fn();
jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    // The real normalizeIngredients — see the header.
    shared: { getMeal: (...a: unknown[]) => mockGetMeal(...a), saveMeal: jest.fn() },
  };
});

jest.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

import SharedMealScreen from '../../src/screens/shared/SharedMealScreen';

/** The wire shape: what the server sends for a shared meal. */
const sharedMeal = (ingredients: unknown[]) => ({
  id: 'm1',
  name: 'Chili',
  storeId: 'heb',
  ingredients,
  tags: [],
  photoUrl: null,
  recipe: null,
});

async function open(ingredients: unknown[]) {
  mockGetMeal.mockResolvedValue({ meal: sharedMeal(ingredients) });
  const view = render(<SharedMealScreen token="tok" onClose={() => {}} />);
  await act(async () => {});
  return view;
}

describe('the shared meal page trails the preparation after the line', () => {
  it('prints it after the amount and the name', async () => {
    // This screen is amount-first, so it reads the way the website does.
    const { getByText } = await open([
      { ingredientName: 'Onion', qty: 1, productQty: 1, unit: 'qty', measure: '1', searchTerm: null, prep: 'finely diced' },
    ]);
    expect(getByText('1 Onion, finely diced')).toBeTruthy();
  });

  it('leaves a row with no preparation reading exactly as it did', async () => {
    const { getByText } = await open([
      { ingredientName: 'Onion', qty: 1, productQty: 1, unit: 'qty', measure: '1', searchTerm: null },
    ]);
    expect(getByText('1 Onion')).toBeTruthy();
  });
});
