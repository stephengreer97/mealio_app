// The previous account's CONTENT must not stay on screen (MEAL-154).
//
// MEAL-146 closed the diagnostic half of the shared-phone hand-over: A's log
// buffer, cart run, prewarm cache and queued saves no longer follow B. This is
// the visible half, and it needs no bug report to surface — B is simply looking
// at A's groceries.
//
// The path is the same one:
//
//   RootNavigator registers the `mealio://verified?token=…` listener app-wide
//   and its handler calls `loginWithToken` with no signed-in check. A is signed
//   in on a shared phone, B taps the verification link in their own email, and
//   `user` goes A → B without passing through null.
//
// `user` stays truthy across that, so RootNavigator used to reconcile the same
// `<MainTabs />` element and nothing under it unmounted. MyMealsScreen reloads
// only in a `useFocusEffect` with no deps, and the tab B lands on is the tab A
// left open, so it never refocuses: A's saved meals are still rendered.
// DiscoverScreen's saved-meal map and free-tier count have the same shape, and
// CreatorPortalScreen and AdminScreen load once on mount and never reload.
//
// The fix keys the tab tree on the account id, so the whole thing remounts and
// every screen refetches through the load path it already has. What is pinned
// here is the OBSERVABLE consequence — whose meals are on the screen — on both
// sides:
//
//   A → B     A's meals are gone and B's are there
//   A → A     nothing is thrown away (a token renewal / refreshUser hands down a
//             new User object for the same person several times a session, and
//             remounting there would discard a live user's work)
//   null → B  an ordinary sign-in still lands on the new account's own content
//
// The harness enters at the deep link itself — the real `Linking` listener
// RootNavigator registers, driving the real AuthProvider — because "the account
// changed" has to be produced the way the app produces it, not simulated by
// re-rendering with a different prop.

import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// ── Module mocks ─────────────────────────────────────────────────────────────

/** In-memory keychain: "the device". A's stored session is seeded into it. */
const mockKeychain = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockKeychain.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockKeychain.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockKeychain.delete(k); }),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));

jest.mock('expo-splash-screen', () => ({ hideAsync: jest.fn(), preventAutoHideAsync: jest.fn() }));

/**
 * The deep-link listener RootNavigator registers app-wide, captured at
 * subscribe time so a test can deliver a URL to it. This is the real entry
 * point: `handleDeepLink` matches `verified?token=…` and awaits
 * `loginWithToken`, with no check for whether anyone is already signed in.
 */
let deliverUrl: ((event: { url: string }) => void) | null = null;
jest.mock('expo-linking', () => ({
  getInitialURL: jest.fn(async () => null),
  addEventListener: jest.fn((_event: string, handler: any) => {
    deliverUrl = handler;
    return { remove: jest.fn() };
  }),
  openURL: jest.fn(),
  openSettings: jest.fn(),
}));

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    const RealReact = jest.requireActual('react');
    RealReact.useEffect(() => cb(), []);
  },
  useNavigation: () => ({ getParent: () => null, navigate: jest.fn(), setParams: jest.fn() }),
  useRoute: () => ({ params: {} }),
}));

// The guest stack is constructed at module scope in RootNavigator but never
// rendered here (every test is signed in), and the real factory needs the
// navigation internals the mock above replaces.
jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({ Navigator: () => null, Screen: () => null }),
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

jest.mock('react-native-keyboard-aware-scroll-view', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardAwareScrollView: ScrollView };
});

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, props) };
});

/**
 * The one component both screens under test render their content through.
 * Reduced to the two account-scoped facts this file is about: whose meal it is,
 * and — on Discover — which of this account's stores it is already saved to.
 */
jest.mock('../../src/components/MealCard', () => {
  const RealReact = jest.requireActual('react');
  const { Text: RealText } = jest.requireActual('react-native');
  return (props: any) =>
    RealReact.createElement(
      RealText,
      { onPress: props.onPress, testID: props.testID },
      props.savedAt?.length ? `${props.meal.name} — saved to ${props.savedAt.join(', ')}` : props.meal.name,
    );
});

jest.mock('../../src/components/MealDetailSheet', () => () => null);
jest.mock('../../src/components/KrogerCartReviewSheet', () => () => null);
jest.mock('../../src/components/WebViewCartSheet', () => () => null);
jest.mock('../../src/components/ProductChooserSheet', () => () => null);
jest.mock('../../src/components/PhotoPicker', () => () => null);
jest.mock('../../src/components/StoreSelectorSheet', () => () => null);
jest.mock('../../src/components/CreatorProfileSheet', () => () => null);
jest.mock('../../src/components/WelcomeSheet', () => () => null);
jest.mock('../../src/components/FilterSheet', () => ({
  __esModule: true,
  default: () => null,
  EMPTY_FILTERS: { tags: [], difficulty: [], authors: [], ingredients: [], excludeIngredients: [] },
}));
jest.mock('../../src/screens/shared/SharedMealScreen', () => () => null);
jest.mock('../../src/navigation/AuthStack', () => () => null);

jest.mock('../../src/context/CartJobContext', () => ({
  useCartJob: () => ({ startJob: jest.fn(), closeJob: jest.fn(), isActive: false }),
}));
jest.mock('../../src/context/LoginPrewarmContext', () => ({
  useLoginPrewarm: () => ({ checkStore: jest.fn(), getStatus: () => 'unknown', statusFor: () => 'unknown' }),
}));

/**
 * The tab tree, stood in for by the two screens the ticket names.
 *
 * A real `Tab.Navigator` needs a NavigationContainer and would only ever show
 * one screen at a time, which would hide half of what is being asserted. What
 * matters for this fix is that RootNavigator's element for the tab tree is the
 * thing keyed on the account — a mock receives that key exactly as the real
 * MainTabs does — and that the screens beneath it remount with it. The real
 * MainTabs is rendered in main-tabs-draft-badge.test.tsx.
 *
 * `mounts` is not the assertion; it is how the two negative cases below tell a
 * remount from a re-render, since their whole point is that the content does
 * NOT change.
 */
jest.mock('../../src/navigation/MainTabs', () => {
  const RealReact = jest.requireActual('react');
  const MyMeals = jest.requireActual('../../src/screens/mymeals/MyMealsScreen').default;
  const Discover = jest.requireActual('../../src/screens/discover/DiscoverScreen').default;
  return {
    __esModule: true,
    default: () => {
      RealReact.useEffect(() => { (globalThis as any).__tabMounts += 1; }, []);
      return RealReact.createElement(
        RealReact.Fragment,
        null,
        RealReact.createElement(MyMeals),
        RealReact.createElement(Discover),
      );
    },
  };
});

const mockListMeals = jest.fn();
const mockVerify = jest.fn();
const mockGetMe = jest.fn();
const mockPresetList = jest.fn();

jest.mock('../../src/lib/api', () => ({
  meals: {
    list: (...a: unknown[]) => mockListMeals(...a),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  presetMeals: {
    list: (...a: unknown[]) => mockPresetList(...a),
    getById: jest.fn(),
  },
  creators: {
    getMe: (...a: unknown[]) => mockGetMe(...a),
    featured: jest.fn(async () => []),
  },
  kroger: { status: jest.fn(async () => ({ connected: false, locations: {} })) },
  images: { upload: jest.fn() },
  auth: {
    login: jest.fn(),
    logout: jest.fn(async () => ({ ok: true })),
    verify: (...a: unknown[]) => mockVerify(...a),
    renew: jest.fn(async () => ({})),
    verify2FA: jest.fn(),
  },
  usage: { logOpen: jest.fn(async () => {}) },
}));

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
  getOffering: jest.fn(),
  purchasePackage: jest.fn(),
}));

jest.mock('../../src/lib/push', () => ({ unregisterDevice: jest.fn(async () => {}) }));

import { Alert } from 'react-native';
import { AuthProvider } from '../../src/context/AuthContext';
import RootNavigator from '../../src/navigation/RootNavigator';

// ── The two accounts ────────────────────────────────────────────────────────

const USER_A = { id: 'user-A', email: 'a@example.com', tier: 'paid' as const };
const USER_B = { id: 'user-B', email: 'b@example.com', tier: 'paid' as const };

/**
 * A's saved meal, and the preset it was saved from.
 *
 * Named distinctly from that preset on purpose: the preset appears in Discover's
 * public grid for both accounts, so a shared name would make a query for "A's
 * meal" match content that is nobody's private business and is supposed to
 * survive the hand-over.
 */
const A_MEAL = {
  id: 'meal-A',
  name: "A's Prenatal Smoothie",
  storeId: 'heb',
  presetMealId: 'preset-1',
  createdAt: '2026-01-01T00:00:00Z',
  ingredients: [{ ingredientName: 'prenatal vitamins', searchTerm: null, qty: 1, unit: 'qty', measure: null }],
};

/** B's, from a different preset, so Discover's saved map differs too. */
const B_MEAL = {
  id: 'meal-B',
  name: "B's Miso Salmon",
  storeId: 'heb',
  presetMealId: 'preset-2',
  createdAt: '2026-02-01T00:00:00Z',
  ingredients: [{ ingredientName: 'salmon', searchTerm: null, qty: 1, unit: 'qty', measure: null }],
};

/** The Discover grid both accounts see — public content, the same for everyone. */
const PRESETS = [
  { id: 'preset-1', name: 'Prenatal Vitamin Smoothie', tags: [], ingredients: [] },
  { id: 'preset-2', name: 'Miso Salmon', tags: [], ingredients: [] },
];

beforeAll(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

beforeEach(() => {
  mockKeychain.clear();
  deliverUrl = null;
  (globalThis as any).__tabMounts = 0;
  mockListMeals.mockReset();
  mockVerify.mockReset();
  mockGetMe.mockReset();
  mockGetMe.mockResolvedValue({ creator: null, meals: [], stats: null });
  mockPresetList.mockReset();
  mockPresetList.mockResolvedValue({ meals: PRESETS, hasMore: false });
});

/** A's session, restored from the keychain the way a relaunch restores it. */
async function launchSignedInAsA() {
  mockKeychain.set('mealio_access_token', 'token-user-A');
  mockKeychain.set('mealio_user', JSON.stringify(USER_A));
  mockVerify.mockResolvedValueOnce({ user: USER_A });
  mockListMeals.mockResolvedValue([A_MEAL]);

  const utils = render(
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>,
  );
  await waitFor(() => expect(utils.queryByText(A_MEAL.name)).not.toBeNull());
  return utils;
}

/**
 * B taps the verification link in their own email, on A's phone.
 *
 * `auth.verify` is how `loginWithToken` finds out whose token it is, so
 * answering it as B is what makes this an account switch rather than a renewal.
 */
async function tapVerificationLinkAs(
  user: { id: string; email: string; tier?: string },
  meals: unknown[],
) {
  mockVerify.mockResolvedValueOnce({ user });
  mockListMeals.mockResolvedValue(meals);
  await act(async () => {
    deliverUrl!({ url: `mealio://verified?token=token-${user.id}` });
    await Promise.resolve();
  });
}

const mounted = () => (globalThis as any).__tabMounts as number;

// ── A → B ───────────────────────────────────────────────────────────────────

describe('B takes the phone over through the verification link', () => {
  it("replaces A's saved meals with B's on the screen that was already open", async () => {
    const utils = await launchSignedInAsA();
    expect(utils.queryByText(A_MEAL.name)).not.toBeNull();

    await tapVerificationLinkAs(USER_B, [B_MEAL]);

    // The whole ticket, in two lines: whatever B is looking at, it is not A's.
    await waitFor(() => expect(utils.queryByText(B_MEAL.name)).not.toBeNull());
    expect(utils.queryByText(A_MEAL.name)).toBeNull();
  });

  it("does not leave A's saved-to badges on Discover's public grid", async () => {
    // Discover's own content is public and identical for both accounts — what is
    // A's is the saved map laid over it, which says which of these recipes this
    // person has already saved and where. It is loaded in a `useFocusEffect`
    // with no deps, exactly like My Meals.
    const utils = await launchSignedInAsA();
    await waitFor(() => expect(utils.queryByText(/Prenatal Vitamin Smoothie — saved to/)).not.toBeNull());

    await tapVerificationLinkAs(USER_B, [B_MEAL]);

    await waitFor(() => expect(utils.queryByText(/Miso Salmon — saved to/)).not.toBeNull());
    expect(utils.queryByText(/Prenatal Vitamin Smoothie — saved to/)).toBeNull();
  });

  it('re-reads the meals under the new account rather than trusting what it has', async () => {
    // The refetch, not just the clear: an empty screen would also satisfy the
    // assertions above, and B seeing nothing is not the fix either.
    await launchSignedInAsA();
    const before = mockListMeals.mock.calls.length;

    await tapVerificationLinkAs(USER_B, [B_MEAL]);

    expect(mockListMeals.mock.calls.length).toBeGreaterThan(before);
    expect(mounted()).toBe(2);
  });

  it("does not hand A's content back when A takes the phone again", async () => {
    // A hand-over is not undone by handing the phone back — B's session ends the
    // same way A's did.
    const utils = await launchSignedInAsA();
    await tapVerificationLinkAs(USER_B, [B_MEAL]);
    await waitFor(() => expect(utils.queryByText(B_MEAL.name)).not.toBeNull());

    await tapVerificationLinkAs(USER_A, [A_MEAL]);

    await waitFor(() => expect(utils.queryByText(A_MEAL.name)).not.toBeNull());
    expect(utils.queryByText(B_MEAL.name)).toBeNull();
  });
});

// ── A → A: nothing may be thrown away ───────────────────────────────────────

describe('the same account being re-set', () => {
  it('keeps A on screen when A re-opens their own verification link', async () => {
    // Same entry point as the leak, but the token resolves to the person already
    // here. Nothing ended, so nothing is discarded — and the tab tree is not
    // remounted, which on a real phone would drop a half-filled New Meal form
    // and the user's place in the list.
    const utils = await launchSignedInAsA();
    expect(mounted()).toBe(1);

    await tapVerificationLinkAs(USER_A, [A_MEAL]);

    expect(utils.queryByText(A_MEAL.name)).not.toBeNull();
    expect(mounted()).toBe(1);
  });

  it('survives a token renewal handing down a new User object for the same person', async () => {
    // A renewal and a `refreshUser` both produce a brand new User for the same
    // id, several times a session. Keying on the object rather than the id would
    // remount the whole tab tree every time one landed.
    const utils = await launchSignedInAsA();

    await tapVerificationLinkAs({ ...USER_A }, [A_MEAL]);
    await tapVerificationLinkAs({ ...USER_A }, [A_MEAL]);

    expect(utils.queryByText(A_MEAL.name)).not.toBeNull();
    expect(mounted()).toBe(1);
  });

  it("survives the same person's profile coming back with different values", async () => {
    // Not only a new object with identical contents. `refreshUser` runs straight
    // after a purchase and after a subscription lapses, so the tier genuinely
    // comes back changed on the same account — which rules out keying on
    // anything derived from the user's fields rather than on the id alone. It is
    // also the worst possible moment to throw the screen away: whatever they
    // were part-way through is still there.
    const utils = await launchSignedInAsA();

    await tapVerificationLinkAs({ ...USER_A, tier: 'free' }, [A_MEAL]);

    expect(utils.queryByText(A_MEAL.name)).not.toBeNull();
    expect(mounted()).toBe(1);
  });
});

// ── null → B: an ordinary sign-in ───────────────────────────────────────────

describe('signing in from signed out', () => {
  it('lands a first sign-in through the verification link on their own meals', async () => {
    // The link's ordinary purpose: a new account confirming their email on a
    // phone nobody is signed in on. There is no tab tree to remount yet, and
    // nothing about the fix may get in the way of one appearing.
    mockListMeals.mockResolvedValue([]);
    const utils = render(
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>,
    );
    await act(async () => { await Promise.resolve(); });
    expect(utils.queryByText(A_MEAL.name)).toBeNull();

    await tapVerificationLinkAs(USER_B, [B_MEAL]);

    await waitFor(() => expect(utils.queryByText(B_MEAL.name)).not.toBeNull());
    expect(mounted()).toBe(1);
  });
});
