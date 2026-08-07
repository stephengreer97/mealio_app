// Signing out has to abandon the queued ingredient saves too (MEAL-142).
//
// Ending the cart run stops the WebView from writing anything more, but the run
// is not the only writer. Every "Add & Update Meal Ingredient" choice hands
// MyMealsScreen a PATCH, and those PATCHes sit on a per-meal promise chain in a
// ref — saves for one meal are serialised, so a run that chose several products
// for the same meal leaves several queued, each a full round trip (plus a renew
// attempt on 401).
//
// Nothing used to cancel that chain. After a sign-out the token is gone, so a
// still-queued save is GUARANTEED to fail, and its failure path logs the product
// name, the ingredient name and the meal id:
//
//   [MyMeals] failed to save chosen product "…" for ingredient "…" (meal m1)
//
// which lands in the console ring buffer arbitrarily late: after logout's clears,
// after CartJobProvider's clear-again, potentially after the next person has
// signed in. Same leak as the run itself, minus 600 lines: A minimises an H-E-B
// run mid-choose, signs out, hands the phone to B; B files a report from Help and
// it carries A's product names under B's token-verified userId.
//
// Two halves, one per writer:
//   • a save still QUEUED must never be sent at all (dropping only the log line
//     would leave pointless doomed 401 traffic behind);
//   • a save already IN FLIGHT when they left cannot be retracted, so when it
//     fails it must not write their product names into the next person's buffer.

import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

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

/**
 * A real context, so `user` can go away the way it really does — from above.
 * RootNavigator renders MainTabs only `if (user)`, so a sign-out UNMOUNTS this
 * screen rather than re-rendering it signed-out; `signOut` below reproduces
 * exactly that, and the guard has to survive it.
 */
jest.mock('../../src/context/AuthContext', () => {
  const RealReact = jest.requireActual('react');
  const Ctx = RealReact.createContext({ user: null, isCreator: false, refreshUser: () => {} });
  return {
    __esModule: true,
    AuthTestContext: Ctx,
    useAuth: () => RealReact.useContext(Ctx),
  };
});

const mockStartJob = jest.fn();
jest.mock('../../src/context/CartJobContext', () => ({ useCartJob: () => ({ startJob: mockStartJob }) }));
jest.mock('../../src/context/LoginPrewarmContext', () => ({
  useLoginPrewarm: () => ({ checkStore: jest.fn(), statusFor: () => 'unknown' }),
}));

const mockListMeals = jest.fn();
const mockUpdateMeal = jest.fn();
const mockKrogerStatus = jest.fn();
jest.mock('../../src/lib/api', () => ({
  meals: {
    list: (...a: unknown[]) => mockListMeals(...a),
    create: jest.fn(),
    update: (...a: unknown[]) => mockUpdateMeal(...a),
    delete: jest.fn(),
  },
  kroger: { status: (...a: unknown[]) => mockKrogerStatus(...a) },
  images: { upload: jest.fn() },
}));

import MyMealsScreen from '../../src/screens/mymeals/MyMealsScreen';
import { clearSessionLogs, getSessionLogs, installConsoleCapture } from '../../src/lib/logBuffer';

const { AuthTestContext } = jest.requireMock('../../src/context/AuthContext') as any;

const USER_A = { id: 'user-A', tier: 'paid' };

const MEAL = {
  id: 'm1',
  name: 'Beef Tacos',
  storeId: 'heb',
  createdAt: '2026-01-01T00:00:00Z',
  ingredients: [
    { ingredientName: 'prenatal vitamins', searchTerm: null, qty: 1, unit: 'qty', measure: null },
    { ingredientName: 'sour cream', searchTerm: null, qty: 1, unit: 'qty', measure: null },
  ],
};

/** The two products A chose before walking away. */
const A_PRODUCT_1 = 'Kirkland Prenatal Vitamins';
const A_PRODUCT_2 = 'H-E-B Select Sour Cream';

/** `meals.update` never settles on its own — each call parks here. */
type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const pendingUpdates: Deferred[] = [];

/**
 * The real nesting: the screen exists only while there is a user. `keepMounted`
 * holds it on screen through a sign-out instead — not a path the app has today,
 * but the one the `!user` guard stands watch over (see the test that uses it).
 * The element types have to match across an update or React remounts the screen,
 * which would hide the difference between the two shapes.
 */
function App({ user, keepMounted = false }: { user: typeof USER_A | null; keepMounted?: boolean }) {
  return (
    <AuthTestContext.Provider value={{ user, isCreator: false, refreshUser: jest.fn() }}>
      {user || keepMounted ? <MyMealsScreen /> : <Text>Sign in</Text>}
    </AuthTestContext.Provider>
  );
}

beforeAll(() => { installConsoleCapture(); });

beforeEach(() => {
  mockStore.clear();
  mockStartJob.mockClear();
  pendingUpdates.length = 0;
  mockListMeals.mockReset();
  mockListMeals.mockResolvedValue([MEAL]);
  mockUpdateMeal.mockReset();
  mockUpdateMeal.mockImplementation(
    () => new Promise((resolve, reject) => { pendingUpdates.push({ resolve, reject }); }),
  );
  mockKrogerStatus.mockReset();
  mockKrogerStatus.mockResolvedValue({ connected: false, locations: {} });
  clearSessionLogs();
});

/** Start the H-E-B choose run the floating button starts, and return its job. */
async function startChooseRun() {
  const r = render(<App user={USER_A} />);
  fireEvent.press(await r.findByText('Beef Tacos'));
  fireEvent.press(await r.findByText('Choose Products for 1 meal'));
  fireEvent.press(await r.findByText('Choose products (2)'));
  await act(async () => { await Promise.resolve(); });
  expect(mockStartJob).toHaveBeenCalledTimes(1);
  return { r, job: mockStartJob.mock.calls[0][0] as any };
}

/** What RootNavigator does when `user` goes null: swap the stack, unmount here. */
async function signOut(r: ReturnType<typeof render>) {
  await act(async () => { r.update(<App user={null} />); });
  expect(r.queryByText('Beef Tacos')).toBeNull();
}

const FAILURE_LINE = '[MyMeals] failed to save chosen product';

describe('signing out mid-choose', () => {
  it('never sends the saves still queued behind the one in flight', async () => {
    const { r, job } = await startChooseRun();

    // Two choices on the SAME meal: the first save goes out, the second queues
    // behind it (they serialise so they cannot clobber each other).
    void job.onIngredientChosen('prenatal vitamins', ['m1'], A_PRODUCT_1);
    void job.onIngredientChosen('sour cream', ['m1'], A_PRODUCT_2);
    await act(async () => { await Promise.resolve(); });
    expect(mockUpdateMeal).toHaveBeenCalledTimes(1);

    // A signs out and hands the phone over, second save still queued.
    await signOut(r);

    // The first save comes back 401 — its token went with A.
    await act(async () => {
      pendingUpdates[0].reject(Object.assign(new Error('Unauthorized'), { status: 401 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The queued save is dropped where it stands: no second request, so no
    // doomed 401 + renew round trip, and nothing to log when it fails.
    expect(mockUpdateMeal).toHaveBeenCalledTimes(1);
    expect(pendingUpdates).toHaveLength(1);
    expect(getSessionLogs()).not.toContain(FAILURE_LINE);
    expect(getSessionLogs()).not.toContain(A_PRODUCT_2);
  });

  it('keeps a save that failed after the hand-over out of the next report', async () => {
    // The one already in flight cannot be recalled — but when it fails, its
    // product and ingredient names must not reach a buffer that now belongs to
    // whoever signed in next.
    const { r, job } = await startChooseRun();
    void job.onIngredientChosen('prenatal vitamins', ['m1'], A_PRODUCT_1);
    await act(async () => { await Promise.resolve(); });
    expect(mockUpdateMeal).toHaveBeenCalledTimes(1);

    await signOut(r);
    clearSessionLogs(); // as logout does — everything after this is B's buffer

    await act(async () => {
      pendingUpdates[0].reject(Object.assign(new Error('Unauthorized'), { status: 401 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getSessionLogs()).not.toContain(FAILURE_LINE);
    expect(getSessionLogs()).not.toContain(A_PRODUCT_1);
    expect(getSessionLogs()).not.toContain('prenatal vitamins');
  });
});

describe('however the sign-out reaches this screen', () => {
  it('abandons the saves even if the screen is left mounted signed-out', async () => {
    // Today a sign-out unmounts this screen (RootNavigator renders MainTabs only
    // `if (user)`), which is what the tests above go through. This pins the
    // invariant on the other shape too — mounted, no user — so moving the screen
    // under a navigator that keeps it alive cannot quietly reopen the leak.
    const { r, job } = await startChooseRun();
    void job.onIngredientChosen('prenatal vitamins', ['m1'], A_PRODUCT_1);
    void job.onIngredientChosen('sour cream', ['m1'], A_PRODUCT_2);
    await act(async () => { await Promise.resolve(); });
    expect(mockUpdateMeal).toHaveBeenCalledTimes(1);

    // Same screen instance, no user: this must NOT unmount, or it would just be
    // the test above again.
    await act(async () => { r.update(<App user={null} keepMounted />); });
    expect(r.queryByText('Beef Tacos')).not.toBeNull();

    await act(async () => {
      pendingUpdates[0].reject(Object.assign(new Error('Unauthorized'), { status: 401 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUpdateMeal).toHaveBeenCalledTimes(1);
    expect(getSessionLogs()).not.toContain(FAILURE_LINE);
  });
});

describe('while still signed in', () => {
  it('still saves, and still says so when a save fails', async () => {
    // The guard must not swallow the ordinary path: a failure while the person
    // who chose the product is still there is exactly what a bug report needs.
    const { job } = await startChooseRun();

    void job.onIngredientChosen('prenatal vitamins', ['m1'], A_PRODUCT_1);
    void job.onIngredientChosen('sour cream', ['m1'], A_PRODUCT_2);
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      pendingUpdates[0].reject(Object.assign(new Error('Unauthorized'), { status: 401 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The queue moved on to the second save rather than stalling…
    expect(mockUpdateMeal).toHaveBeenCalledTimes(2);
    // …and the first failure is on the record, with what failed.
    expect(getSessionLogs()).toContain(FAILURE_LINE);
    expect(getSessionLogs()).toContain(A_PRODUCT_1);
  });
});
