// Choose Products is explained before it runs, once (MEAL-84).
//
// Choose Products is a new user's first real interaction with Mealio: up to a
// dozen modal screens in a row, each asking which store product matches an
// ingredient. Read cold it looks like the cart being filled one slow item at a
// time — the reassurance that it is one-time matching, and that nothing is going
// into a cart, used to appear on the *completion* screen, which is no use to the
// person deciding whether to abandon at ingredient three.
//
// Three properties, and they are the ones that rot:
//
//   • It comes before the flow, not during it. Asserted as: the run has not
//     started while the sheet is up.
//   • It does not gate. Every exit — the button, "Not now", the backdrop — is
//     available, and the primary one starts the exact run the floating button
//     always started.
//   • It happens once per device. Both the taken path and the skipped path mark
//     it seen, because "shown once" has to mean once however it was closed. This
//     is the one that regresses silently: nobody files a bug about an explainer
//     they have learned to dismiss.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    const RealReact = jest.requireActual('react');
    RealReact.useEffect(() => cb(), []);
  },
}));

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, null, props.name);
  return { Ionicons: icon, Feather: icon, MaterialIcons: icon };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, props) };
});

// A card that can be tapped, since selecting meals is how the flow is reached.
jest.mock('../../src/components/MealCard', () => {
  const RealReact = jest.requireActual('react');
  const { Text: RealText } = jest.requireActual('react-native');
  return (props: any) =>
    RealReact.createElement(RealText, { onPress: props.onPress, testID: props.testID }, props.meal.name);
});

jest.mock('../../src/components/MealDetailSheet', () => () => null);
jest.mock('../../src/components/KrogerCartReviewSheet', () => () => null);
jest.mock('../../src/components/WebViewCartSheet', () => () => null);
jest.mock('../../src/components/ProductChooserSheet', () => () => null);
jest.mock('../../src/components/PhotoPicker', () => () => null);

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('../../src/lib/purchases', () => ({ getOffering: jest.fn(), purchasePackage: jest.fn() }));

jest.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', tier: 'paid' }, isCreator: false, refreshUser: jest.fn() }),
}));

const mockStartJob = jest.fn();
jest.mock('../../src/context/CartJobContext', () => ({ useCartJob: () => ({ startJob: mockStartJob }) }));
jest.mock('../../src/context/LoginPrewarmContext', () => ({
  useLoginPrewarm: () => ({ checkStore: jest.fn(), statusFor: () => 'unknown' }),
}));

const mockListMeals = jest.fn();
jest.mock('../../src/lib/api', () => ({
  meals: { list: (...a: unknown[]) => mockListMeals(...a), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  kroger: { status: jest.fn(async () => ({ connected: false, locations: {} })) },
  images: { upload: jest.fn() },
}));

import MyMealsScreen from '../../src/screens/mymeals/MyMealsScreen';
import { FIRST_RUN_CHOOSE_PRODUCTS } from '../../src/lib/firstRun';

/** H-E-B: a WebView store, so the floating button drives the cart engine. */
const UNCHOSEN_MEAL = {
  id: 'm1',
  name: 'Beef Tacos',
  storeId: 'heb',
  createdAt: '2026-01-01T00:00:00Z',
  ingredients: [
    { ingredientName: 'Sour cream', searchTerm: null, qty: 1, unit: 'qty', measure: null },
    { ingredientName: 'Tortillas', searchTerm: null, qty: 1, unit: 'qty', measure: null },
  ],
};

const CHOSEN_MEAL = {
  ...UNCHOSEN_MEAL,
  id: 'm2',
  name: 'Chosen Chili',
  ingredients: UNCHOSEN_MEAL.ingredients.map((i) => ({ ...i, searchTerm: 'H-E-B Sour Cream' })),
};

beforeEach(() => {
  mockStore.clear();
  mockStartJob.mockClear();
  mockListMeals.mockReset();
  mockListMeals.mockResolvedValue([UNCHOSEN_MEAL]);
});

/** Renders My Meals and selects the first meal, revealing the floating button. */
async function selectMeal(name = 'Beef Tacos') {
  const r = render(<MyMealsScreen />);
  fireEvent.press(await r.findByText(name));
  return r;
}

describe('the first Choose Products run is explained first', () => {
  it('holds the run and says what it is', async () => {
    const r = await selectMeal();
    fireEvent.press(await r.findByText('Choose Products for 1 meal'));

    // The three things the ticket says a new user cannot currently find out.
    expect(await r.findByText('First, match your ingredients')).toBeTruthy();
    expect(r.getByText(/You do this once/)).toBeTruthy();          // it is setup
    expect(r.getByText(/At the end/)).toBeTruthy();                // it ends somewhere
    expect(r.getByText(/Nothing is ordered/)).toBeTruthy();        // it is not the cart
    // …and it says it BEFORE, which is the whole point: nothing has run yet.
    expect(mockStartJob).not.toHaveBeenCalled();
  });

  it('counts the work so twelve screens are not a surprise', async () => {
    const r = await selectMeal();
    fireEvent.press(await r.findByText('Choose Products for 1 meal'));
    // Two unchosen ingredients on the one selected meal.
    expect(await r.findByText('Choose products (2)')).toBeTruthy();
  });

  it('starts the same run the button always started', async () => {
    const r = await selectMeal();
    fireEvent.press(await r.findByText('Choose Products for 1 meal'));
    fireEvent.press(await r.findByText('Choose products (2)'));

    await waitFor(() => expect(mockStartJob).toHaveBeenCalledTimes(1));
    expect(mockStartJob.mock.calls[0][0]).toMatchObject({ storeId: 'heb', storeName: 'H-E-B' });
  });
});

describe('it is a first-run thing', () => {
  it('does not reappear on the next run once it has been through', async () => {
    const first = await selectMeal();
    fireEvent.press(await first.findByText('Choose Products for 1 meal'));
    fireEvent.press(await first.findByText('Choose products (2)'));
    await waitFor(() => expect(mockStore.has(FIRST_RUN_CHOOSE_PRODUCTS)).toBe(true));
    first.unmount();

    // Same device, new launch — the flag is all that carries over.
    mockStartJob.mockClear();
    const second = await selectMeal();
    fireEvent.press(await second.findByText('Choose Products for 1 meal'));

    await waitFor(() => expect(mockStartJob).toHaveBeenCalledTimes(1));
    expect(second.queryByText('First, match your ingredients')).toBeNull();
  });

  it('leaves an add-to-cart run — which explains itself — alone', async () => {
    mockListMeals.mockResolvedValue([CHOSEN_MEAL]);
    const r = await selectMeal('Chosen Chili');
    fireEvent.press(await r.findByText('Add 1 meal to H-E-B cart'));

    await waitFor(() => expect(mockStartJob).toHaveBeenCalledTimes(1));
    expect(r.queryByText('First, match your ingredients')).toBeNull();
    // An add-to-cart run must not burn the explainer either: the person has
    // still never seen it.
    expect(mockStore.has(FIRST_RUN_CHOOSE_PRODUCTS)).toBe(false);
  });
});

describe('the skip path', () => {
  it('backs out without starting anything', async () => {
    const r = await selectMeal();
    fireEvent.press(await r.findByText('Choose Products for 1 meal'));
    fireEvent.press(await r.findByText('Not now'));

    await waitFor(() => expect(r.queryByText('First, match your ingredients')).toBeNull());
    expect(mockStartJob).not.toHaveBeenCalled();
  });

  it('does not ask again — skipping is an answer, not a deferral', async () => {
    const r = await selectMeal();
    fireEvent.press(await r.findByText('Choose Products for 1 meal'));
    fireEvent.press(await r.findByText('Not now'));
    await waitFor(() => expect(mockStore.has(FIRST_RUN_CHOOSE_PRODUCTS)).toBe(true));

    // Straight into the flow this time, from the same tap.
    fireEvent.press(r.getByText('Choose Products for 1 meal'));
    await waitFor(() => expect(mockStartJob).toHaveBeenCalledTimes(1));
    expect(r.queryByText('First, match your ingredients')).toBeNull();
  });

  it('is dismissible from the backdrop too', async () => {
    const r = await selectMeal();
    fireEvent.press(await r.findByText('Choose Products for 1 meal'));
    fireEvent.press(await r.findByTestId('choose-products-intro-backdrop'));

    await waitFor(() => expect(r.queryByText('First, match your ingredients')).toBeNull());
    expect(mockStartJob).not.toHaveBeenCalled();
  });
});
