// MEAL-102 — driven through the real cart, a preparation reaches no store.
//
// tests/unit/ingredientPrep.test.ts builds the term the way WebViewCartSheet
// does and checks the store's own URL builders. This file removes the "the way
// WebViewCartSheet does" — the sheet itself computes the term here, and every
// URL it navigates to and every script it injects is recorded off the registry
// it really calls.
//
// That distinction is the point. The risk is not that a helper is wrong; it is
// that a call site somewhere in 4,800 lines splices the prep into a query. Only
// a recording at the registry seam can see all of them at once.
//
// Prep leaking into `searchTerm` or `ingredientName` does NOT add a wrong
// product — the add gate is exact-after-normalisation equality, so it matches
// nothing and drops the item into review looking like a matching bug.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    // A ref that records what the sheet injects. The other cart tests hand back
    // no ref at all, so `injectJavaScript` is a no-op there and nothing sees the
    // scripts — which is exactly the half of the pipeline this file is about.
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: (script: string) => {
        ((globalThis as any).__injected ||= []).push(script);
      },
      stopLoading: () => {},
      goBack: () => {},
      reload: () => {},
    }));
    if (props.source?.uri) ((globalThis as any).__navigated ||= []).push(props.source.uri);
    return RealReact.createElement(RealView, { testID: props.testID || 'mock-webview', ...props });
  });
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return { Ionicons: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name) };
});

jest.mock('react-native-keyboard-aware-scroll-view', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardAwareScrollView: ScrollView };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

/**
 * The REAL script registry, with every term it is handed recorded.
 *
 * Wrapping rather than stubbing is load-bearing: a `jest.fn()` returning ''
 * would pass this file just as happily against a cart that searched for the
 * prep, because there would be no URL to look at. What is recorded here is what
 * the shipped builders produced from what the shipped component asked for.
 */
jest.mock('../../src/lib/webview-scripts', () => {
  const actual = jest.requireActual('../../src/lib/webview-scripts');
  const record = (kind: string, term: unknown) =>
    ((globalThis as any).__terms ||= []).push({ kind, term });
  return {
    ...actual,
    getStoreScripts: (storeId: string) => {
      const s = actual.getStoreScripts(storeId);
      if (!s) return s;
      const wrapped: any = { ...s };
      for (const key of ['getSearchUrl', 'buildSearchScript', 'buildSearchAndAddScript', 'buildAddToCartScript']) {
        const fn = (s as any)[key];
        if (typeof fn !== 'function') continue;
        wrapped[key] = (...args: any[]) => {
          record(key, args[0]);
          const out = fn.apply(s, args);
          if (typeof out === 'string') ((globalThis as any).__built ||= []).push({ key, out });
          return out;
        };
      }
      return wrapped;
    },
  };
});

jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'run-prep'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';

/** Phrases the fixtures put in `prep`. None may appear anywhere upstream. */
const PREP_PHRASES = ['finely', 'diced', 'roughly', 'chopped', 'room temperature'];

const terms = () => ((globalThis as any).__terms ?? []) as Array<{ kind: string; term: unknown }>;
const built = () => ((globalThis as any).__built ?? []) as Array<{ key: string; out: string }>;
const injected = () => ((globalThis as any).__injected ?? []) as string[];
const navigated = () => ((globalThis as any).__navigated ?? []) as string[];

/** Every sheet rendered in a test, unmounted afterwards. A cart run arms real
 *  timeouts (the cart probe, the add jitter); left mounted across a dozen
 *  per-store cases they outlive the suite and jest force-exits the worker. */
const mounted: Array<{ unmount: () => void }> = [];

beforeEach(() => {
  // Fake timers, cleared below. A cart run arms real timeouts — the cart probe,
  // the add jitter — and twelve per-store runs leave enough of them pending that
  // jest force-exits the worker at the end of the suite. Nothing here waits on a
  // timer: the search is dispatched synchronously off the CART_COUNT message.
  jest.useFakeTimers();
  (globalThis as any).__terms = [];
  (globalThis as any).__built = [];
  (globalThis as any).__injected = [];
  (globalThis as any).__navigated = [];
});

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  jest.clearAllTimers();
  jest.useRealTimers();
});

/** Two meals, four prepped rows: chosen and unchosen, single and shared. */
const PREPPED_MEALS = [
  {
    id: 'm1',
    name: 'Chili',
    ingredients: [
      // Unchosen — the term IS the ingredient name, the riskiest of the two.
      { ingredientName: 'Onion', searchTerm: null, qty: 1, productQty: 1, unit: 'qty', measure: '1', prep: 'finely diced' },
      // Chosen — the term is the searchTerm.
      { ingredientName: 'Butter', searchTerm: 'Land O Lakes Butter', qty: 1, productQty: 1, unit: 'qty', measure: '1', prep: 'at room temperature' },
    ],
  },
  {
    id: 'm2',
    name: 'Soup',
    ingredients: [
      // Same product as Chili's onion but a different preparation — merged into
      // one cart line, so a prep on the merged entry would reach the term.
      { ingredientName: 'Onion', searchTerm: null, qty: 2, productQty: 2, unit: 'qty', measure: '2', prep: 'roughly chopped' },
    ],
  },
];

/**
 * The stores whose search really is a NAVIGATION, and the ones that type into
 * the page instead.
 *
 * The split is not cosmetic and cost this file a surviving mutant. Asserting
 * "no URL carries a preparation" against ALDI passes for a store that never
 * builds a search URL at all — it injects `buildSearchScript` and types. A
 * mutant that folded the prep into the ingredient name sailed through that
 * assertion while the term it searched for was "Onion, finely diced".
 *
 * So the navigating stores are asserted on their URLs (the server half's
 * standard: what actually went upstream), the typing stores on the script text,
 * and both on a guard that the search happened at all.
 */
const URL_STORES = ['heb', 'walmart', 'albertsons', 'amazon'];
const SCRIPT_STORES = ['aldi', 'wegmans'];
const ALL_STORES = [...URL_STORES, ...SCRIPT_STORES];

/** Render the sheet, start the run, and return a way to post bridge messages. */
function startRun(storeId = 'aldi') {
  const view = render(
    <WebViewCartSheet
      visible
      meals={PREPPED_MEALS as any}
      storeId={storeId}
      storeName={storeId}
      onClose={() => {}}
    />,
  );
  mounted.push(view);
  const post = (payload: Record<string, unknown>) => {
    const webview = view.getAllByTestId('mock-webview')[0];
    act(() => {
      webview.props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
    });
  };
  /**
   * Drive the sheet from open to dispatching searches.
   *
   * Two messages, both of which the store's own scripts really post: the login
   * probe's answer, then the before-snapshot's cart count — the search flow is
   * deliberately gated behind that baseline, so without it nothing is searched
   * and every assertion below would pass against a cart that never ran.
   */
  const beginSearching = () => {
    post({ type: 'LOGIN_STATUS', isLoggedIn: true });
    post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://example.test/cart' });
  };

  return { ...view, post, beginSearching };
}

describe('the cart never asks a store for a preparation', () => {
  it.each(ALL_STORES)('hands %s\'s builders only bare product terms', (storeId) => {
    const { beginSearching } = startRun(storeId);
    beginSearching();

    const asked = terms().map((t) => String(t.term));
    // Not vacuous: the run really reached the registry, and asked for the
    // products by name. Without this a cart that searched for nothing would
    // satisfy every assertion below.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).toContain('Onion');

    for (const term of asked) {
      for (const phrase of PREP_PHRASES) {
        expect(term.toLowerCase()).not.toContain(phrase);
      }
    }
  });

  it.each(URL_STORES)('navigates %s to a search URL with no preparation in it', (storeId) => {
    const { beginSearching } = startRun(storeId);
    beginSearching();

    const urls = [...navigated(), ...built().filter((b) => b.key === 'getSearchUrl').map((b) => b.out)];
    // The store was really searched, by a URL, for the bare product. This is the
    // guard the surviving mutant needed: without it "no URL carries a prep" is
    // true of a run that navigated nowhere.
    const searches = urls.filter((u) => /Onion/i.test(u));
    expect(searches.length).toBeGreaterThan(0);

    for (const url of urls) {
      for (const phrase of [...PREP_PHRASES, 'prep']) {
        expect(url.toLowerCase()).not.toContain(phrase);
        expect(decodeSafely(url).toLowerCase()).not.toContain(phrase);
      }
    }
  });

  it.each(SCRIPT_STORES)('injects %s no script carrying a preparation', (storeId) => {
    const { beginSearching } = startRun(storeId);
    beginSearching();

    const scripts = [...injected(), ...built().map((b) => b.out)];
    // These stores type the term into the page, so the term is INSIDE the
    // script — which is what makes the negative assertion meaningful here.
    expect(scripts.some((s) => s.includes('Onion'))).toBe(true);
    for (const script of scripts) {
      for (const phrase of PREP_PHRASES) {
        expect(script.toLowerCase()).not.toContain(phrase);
      }
    }
  });

  it('still shows the shopper what each meal wants done to the ingredient', () => {
    // The other half of the ticket, on the surface the risk lives on: the prep
    // is on screen, per meal, beside that meal's amount — while none of it
    // reached the term above. Both meals' onion lines merge into one cart row,
    // and each keeps its own preparation.
    const { getByText } = render(
      <WebViewCartSheet
        visible
        meals={[
          {
            id: 'm1',
            name: 'Chili',
            ingredients: [
              { ingredientName: 'Onion', searchTerm: 'Yellow Onion', qty: 1, productQty: 1, unit: 'qty', measure: '1', prep: 'finely diced' },
            ],
          },
          {
            id: 'm2',
            name: 'Soup',
            ingredients: [
              { ingredientName: 'Onion', searchTerm: 'Yellow Onion', qty: 2, productQty: 2, unit: 'qty', measure: '2', prep: 'roughly chopped' },
            ],
          },
        ] as any}
        storeId="aldi"
        storeName="ALDI"
        onClose={() => {}}
      />,
    );

    expect(getByText('Chili calls for 1, finely diced')).toBeTruthy();
    expect(getByText('Soup calls for 2, roughly chopped')).toBeTruthy();
    // The product name above them — which IS the search term — stays bare.
    expect(getByText('Yellow Onion')).toBeTruthy();
  });

  it('leaves a row with no preparation reading exactly as it did', () => {
    const { getByText } = render(
      <WebViewCartSheet
        visible
        meals={[
          {
            id: 'm1',
            name: 'Chili',
            ingredients: [
              { ingredientName: 'Onion', searchTerm: 'Yellow Onion', qty: 2, productQty: 2, unit: 'qty', measure: '2' },
            ],
          },
        ] as any}
        storeId="aldi"
        storeName="ALDI"
        onClose={() => {}}
      />,
    );
    expect(getByText('Chili calls for 2')).toBeTruthy();
  });
});

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
