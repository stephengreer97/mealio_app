// The first-run pitch (MEAL-84), and the flags that make it a *first*-run thing.
//
// Two things regress here and neither is visible in a screenshot:
//
//   • The copy drifting. These strings are a copy of `lib/pitch.ts` in
//     `mealio_central` (MEAL-86) — the whole point of duplicating a module
//     rather than writing app-native words is that both surfaces say the same
//     sentence. A reworded string on one side is a silent divergence, so the
//     canonical text is pinned here as literals. If one of these assertions
//     fails, the fix is to check the web original, not to update the literal.
//
//   • It showing twice. An explainer that reappears on every launch is worse
//     than none: it trains people to dismiss without reading, and it is the
//     kind of bug nobody reports, they just get annoyed. The flag lives in
//     SecureStore precisely so that it survives a restart, so "second launch"
//     is modelled here as a fresh render against storage that already has it.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

// ── Module mocks ─────────────────────────────────────────────────────────────

/** In-memory SecureStore. Deliberately shared: it is the "device". */
const mockStore = new Map<string, string>();
let mockGetFails = false;

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => {
    if (mockGetFails) throw new Error('keychain unavailable');
    return mockStore.get(k) ?? null;
  }),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
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

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    const RealReact = jest.requireActual('react');
    RealReact.useEffect(() => cb(), []);
  },
  useNavigation: () => ({ getParent: () => null, navigate: jest.fn() }),
  useRoute: () => ({ params: {} }),
}));

jest.mock('../../src/components/MealCard', () => () => null);
jest.mock('../../src/components/MealDetailSheet', () => () => null);
jest.mock('../../src/components/CreatorProfileSheet', () => () => null);
jest.mock('../../src/components/StoreSelectorSheet', () => () => null);
jest.mock('../../src/components/FilterSheet', () => ({
  __esModule: true,
  default: () => null,
  EMPTY_FILTERS: { tags: [], difficulty: [], authors: [], ingredients: [], excludeIngredients: [] },
}));

jest.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', tier: 'paid' }, refreshUser: jest.fn() }),
}));
jest.mock('../../src/lib/api', () => ({
  presetMeals: { list: jest.fn(async () => ({ meals: [], hasMore: false })) },
  creators: { featured: jest.fn(async () => []) },
  meals: { list: jest.fn(async () => []) },
}));

import DiscoverScreen from '../../src/screens/discover/DiscoverScreen';
import WelcomeSheet from '../../src/components/WelcomeSheet';
import { hasSeen, markSeen, resetFirstRun, FIRST_RUN_WELCOME } from '../../src/lib/firstRun';
import {
  PITCH_HEADLINE,
  PITCH_SUBHEAD,
  PITCH_STORES,
  PITCH_STEPS,
  PITCH_NOTHING_ORDERED,
  PITCH_FREE_TIER,
} from '../../src/constants/pitch';

beforeEach(() => {
  mockStore.clear();
  mockGetFails = false;
  jest.clearAllMocks();
});

// ── The words ────────────────────────────────────────────────────────────────

describe('the pitch says what mealio_central says', () => {
  it('carries the canonical headline and subhead', () => {
    expect(PITCH_HEADLINE).toBe("Shop meals. We'll fill the cart.");
    expect(PITCH_SUBHEAD).toBe(
      'Mealio is a recipe app that does the shopping part: pick a meal and the store '
      + 'you shop at, and every ingredient goes into your online cart there.',
    );
  });

  it('carries the canonical steps, limit and price', () => {
    expect(PITCH_STEPS.map((s) => s.title)).toEqual([
      'Find a meal you want to cook',
      'Pick the store you shop at',
      'Mealio fills your cart',
    ]);
    expect(PITCH_STEPS[0].body).toBe(
      'Browse recipes from cooks and creators. No account needed to look.',
    );
    expect(PITCH_STEPS[2].body).toBe('Every ingredient is added to your cart at that store.');
    expect(PITCH_NOTHING_ORDERED).toBe(
      'Nothing is ordered — the items land in your own cart at your own store, and '
      + 'you check out there.',
    );
    expect(PITCH_FREE_TIER).toBe('Free for up to three saved meals.');
  });

  it('names every store, because on mobile every one of them works', () => {
    // The web build has a second, shorter list (PITCH_STORES_WEB) because cart
    // automation for everything except Kroger runs in THIS app. Here the full
    // list is the true one — WEBVIEW_STORE_IDS plus the Kroger banners in
    // src/constants/stores.ts — so step 2 must interpolate PITCH_STORES.
    expect(PITCH_STORES).toBe(
      'H-E-B, Walmart, Kroger and its banners, Albertsons, Safeway, ALDI, Amazon '
      + 'Fresh and Wegmans',
    );
    expect(PITCH_STEPS[1].body).toBe(`Mealio works with ${PITCH_STORES}.`);
    // The giveaway for an accidental copy of the web list: it says "in the
    // mobile app", which is nonsense when read inside the mobile app.
    expect(PITCH_STEPS[1].body).not.toMatch(/mobile app/i);
  });
});

describe('WelcomeSheet', () => {
  it('shows the whole pitch — what it does, what it costs, what it will not do', () => {
    const r = render(<WelcomeSheet visible onDismiss={jest.fn()} />);
    expect(r.getByText(PITCH_HEADLINE)).toBeTruthy();
    expect(r.getByText(PITCH_SUBHEAD)).toBeTruthy();
    expect(r.getByText(`Mealio works with ${PITCH_STORES}.`)).toBeTruthy();
    expect(r.getByText(PITCH_NOTHING_ORDERED)).toBeTruthy();
    expect(r.getByText(PITCH_FREE_TIER)).toBeTruthy();
  });

  it('is dismissible from the button and from the backdrop', () => {
    const onDismiss = jest.fn();
    const r = render(<WelcomeSheet visible onDismiss={onDismiss} />);
    fireEvent.press(r.getByText('Browse meals'));
    fireEvent.press(r.getByTestId('welcome-backdrop'));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});

// ── The flags ────────────────────────────────────────────────────────────────

describe('first-run flags', () => {
  it('remembers across a restart, and resets', async () => {
    expect(await hasSeen(FIRST_RUN_WELCOME)).toBe(false);
    await markSeen(FIRST_RUN_WELCOME);
    expect(await hasSeen(FIRST_RUN_WELCOME)).toBe(true);
    await resetFirstRun();
    expect(await hasSeen(FIRST_RUN_WELCOME)).toBe(false);
  });

  it('treats unreadable storage as already seen, never as a fresh first run', async () => {
    // The failure mode this rules out: a keychain that errors turning a
    // once-ever explainer into one that opens on every single launch.
    mockGetFails = true;
    expect(await hasSeen(FIRST_RUN_WELCOME)).toBe(true);
  });
});

// ── The wiring ───────────────────────────────────────────────────────────────

describe('DiscoverScreen first run', () => {
  it('opens the pitch on a fresh install, once the meals have loaded', async () => {
    const r = render(<DiscoverScreen />);
    expect(await r.findByText(PITCH_HEADLINE)).toBeTruthy();
  });

  it('does not open it again on the next launch', async () => {
    const first = render(<DiscoverScreen />);
    fireEvent.press(await first.findByText('Browse meals'));
    await waitFor(() => expect(mockStore.has(FIRST_RUN_WELCOME)).toBe(true));
    first.unmount();

    // Same device, new process: the flag is all that carries over.
    const second = render(<DiscoverScreen />);
    await second.findByText('Trending Meals');
    expect(second.queryByText(PITCH_HEADLINE)).toBeNull();
  });

  it('leaves Discover usable behind it — the pitch gates nothing', async () => {
    const r = render(<DiscoverScreen />);
    await r.findByText(PITCH_HEADLINE);
    // The screen underneath finished loading and is interactive, not blocked
    // behind an onboarding route.
    expect(r.getByText('Trending Meals')).toBeTruthy();
    expect(r.getByPlaceholderText('Search meals or creators…')).toBeTruthy();
  });
});
