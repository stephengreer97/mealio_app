// A first-run user arriving from a shared link (MEAL-84).
//
// `RootNavigator` renders the app and its deep-link sheets as siblings, both RN
// Modals, and DiscoverScreen's first-run welcome is a third. Cold-open
// `mealio://meal/p/<id>` on a fresh install and two of them race with no
// ordering between them: `getInitialURL` resolves and fetches the preset while
// Discover independently finishes loading and pops the pitch. Stacked Modals
// block touch events on iOS — the 300ms close-first dance in `handleDeepLink`
// is there because that bug was paid for once already — so the user who came in
// through the highest-intent channel there is could end up able to dismiss
// neither sheet on their first launch.
//
// Two things are pinned here, and losing either one is the bug:
//
//   • The welcome does not open while a deep link owns the screen.
//   • It is not lost. The shown-once flag is spent by a dismissal, never by
//     being suppressed, so it arrives after the meal sheet closes.
//
// A normal first run — no link — is covered in first-run-welcome.test.tsx and
// re-checked here through the whole navigator, because "suppress the welcome"
// is one careless condition away from "suppress the welcome always".

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// ── Module mocks ─────────────────────────────────────────────────────────────

const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));

/** The launch URL, and the listener for warm links. Set per test. */
let mockInitialUrl: string | null = null;
jest.mock('expo-linking', () => ({
  getInitialURL: jest.fn(async () => mockInitialUrl),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  openURL: jest.fn(),
}));

jest.mock('expo-splash-screen', () => ({ hideAsync: jest.fn() }));

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

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    const RealReact = jest.requireActual('react');
    RealReact.useEffect(() => cb(), []);
  },
  useNavigation: () => ({ getParent: () => null, navigate: jest.fn() }),
  useRoute: () => ({ params: {} }),
}));

// The guest stack is never rendered here (these tests are signed in), and the
// real factory needs the navigation internals the mock above replaces.
jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({ Navigator: () => null, Screen: () => null }),
}));

/** The tabs, standing in for the real thing — what matters is that Discover,
 *  and therefore the welcome, renders inside the navigator's provider. */
jest.mock('../../src/navigation/MainTabs', () => {
  const RealReact = jest.requireActual('react');
  const Discover = jest.requireActual('../../src/screens/discover/DiscoverScreen').default;
  return () => RealReact.createElement(Discover);
});
jest.mock('../../src/navigation/AuthStack', () => () => null);
jest.mock('../../src/screens/shared/SharedMealScreen', () => () => null);

/** The preset sheet, reduced to "is it up, and can it be closed". */
jest.mock('../../src/components/MealDetailSheet', () => {
  const RealReact = jest.requireActual('react');
  const { Text: RealText } = jest.requireActual('react-native');
  return (props: any) =>
    props.visible
      ? RealReact.createElement(RealText, { onPress: props.onClose }, 'PRESET SHEET')
      : null;
});
jest.mock('../../src/components/StoreSelectorSheet', () => () => null);
jest.mock('../../src/components/CreatorProfileSheet', () => () => null);
jest.mock('../../src/components/MealCard', () => () => null);
jest.mock('../../src/components/FilterSheet', () => ({
  __esModule: true,
  default: () => null,
  EMPTY_FILTERS: { tags: [], difficulty: [], authors: [], ingredients: [], excludeIngredients: [] },
}));

jest.mock('../../src/lib/purchases', () => ({ getOffering: jest.fn(), purchasePackage: jest.fn() }));
jest.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', tier: 'paid' },
    isLoading: false,
    loginWithToken: jest.fn(),
    refreshUser: jest.fn(),
  }),
}));

const mockGetPreset = jest.fn();
jest.mock('../../src/lib/api', () => ({
  presetMeals: {
    list: jest.fn(async () => ({ meals: [], hasMore: false })),
    getById: (...a: unknown[]) => mockGetPreset(...a),
  },
  creators: { featured: jest.fn(async () => []) },
  meals: { list: jest.fn(async () => []) },
}));

import RootNavigator from '../../src/navigation/RootNavigator';
import { PITCH_HEADLINE } from '../../src/constants/pitch';
import { FIRST_RUN_WELCOME } from '../../src/lib/firstRun';

beforeEach(() => {
  mockStore.clear();
  mockInitialUrl = null;
  mockGetPreset.mockReset();
  mockGetPreset.mockResolvedValue({ id: 'p1', name: 'Shared Tacos', ingredients: [] });
});

describe('cold open from a shared preset link, on a fresh install', () => {
  it('does not stack the pitch on the meal sheet', async () => {
    mockInitialUrl = 'mealio://meal/p/p1';
    const r = render(<RootNavigator />);

    expect(await r.findByText('PRESET SHEET')).toBeTruthy();
    // Discover has finished loading behind it — the welcome's own trigger has
    // fired and been held, not simply not reached yet.
    await r.findByText('Trending Meals');
    expect(r.queryByText(PITCH_HEADLINE)).toBeNull();
  });

  it('gives the pitch once the meal sheet is dismissed, not instead of it', async () => {
    mockInitialUrl = 'mealio://meal/p/p1';
    const r = render(<RootNavigator />);

    fireEvent.press(await r.findByText('PRESET SHEET'));

    expect(await r.findByText(PITCH_HEADLINE)).toBeTruthy();
    // And it is still a first run until they actually dismiss it: suppressing
    // it must never spend the one showing there is.
    expect(mockStore.has(FIRST_RUN_WELCOME)).toBe(false);
  });
});

describe('a launch with no deep link', () => {
  it('shows the pitch, exactly as before', async () => {
    const r = render(<RootNavigator />);
    expect(await r.findByText(PITCH_HEADLINE)).toBeTruthy();
    expect(r.queryByText('PRESET SHEET')).toBeNull();
  });

  it('does not show it again on the next launch', async () => {
    const first = render(<RootNavigator />);
    fireEvent.press(await first.findByText('Browse meals'));
    await waitFor(() => expect(mockStore.has(FIRST_RUN_WELCOME)).toBe(true));
    first.unmount();

    const second = render(<RootNavigator />);
    await second.findByText('Trending Meals');
    expect(second.queryByText(PITCH_HEADLINE)).toBeNull();
  });
});

describe('a bad or expired link', () => {
  it('lets go of the screen, so the pitch is not held forever', async () => {
    mockInitialUrl = 'mealio://meal/p/gone';
    mockGetPreset.mockRejectedValue(new Error('404'));
    const r = render(<RootNavigator />);

    expect(await r.findByText(PITCH_HEADLINE)).toBeTruthy();
    expect(r.queryByText('PRESET SHEET')).toBeNull();
  });
});

describe('a link that arrives while the pitch is up', () => {
  it('takes the screen, and hands it back', async () => {
    const r = render(<RootNavigator />);
    await r.findByText(PITCH_HEADLINE);

    // Warm link — the listener this navigator registered at mount.
    const Linking = require('expo-linking');
    const calls = (Linking.addEventListener as jest.Mock).mock.calls;
    const onUrl = calls[calls.length - 1][1];
    await act(async () => { onUrl({ url: 'mealio://meal/p/p1' }); });

    expect(await r.findByText('PRESET SHEET')).toBeTruthy();
    expect(r.queryByText(PITCH_HEADLINE)).toBeNull();

    fireEvent.press(r.getByText('PRESET SHEET'));
    expect(await r.findByText(PITCH_HEADLINE)).toBeTruthy();
  });
});
