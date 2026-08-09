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

beforeEach(() => {
  (globalThis as any).__terms = [];
  (globalThis as any).__built = [];
  (globalThis as any).__injected = [];
  (globalThis as any).__navigated = [];
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

/** Render the sheet, start the run, and return a way to post bridge messages. */
function startRun(storeId = 'aldi') {
  const view = render(
    <WebViewCartSheet
      visible
      meals={PREPPED_MEALS as any}
      storeId={storeId}
      storeName="ALDI"
      onClose={() => {}}
    />,
  );
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
    post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://www.aldi.us/cart' });
  };

  return { ...view, post, beginSearching };
}

describe('the cart never asks a store for a preparation', () => {
  it('records terms at all — the recorder is wired to the real registry', () => {
    // Guards every assertion below from passing vacuously: if the sheet never
    // reached the registry, "no prep in any term" would be trivially true.
    const { beginSearching } = startRun();
    beginSearching();
    expect(terms().length).toBeGreaterThan(0);
  });

  it('hands the builders only bare product terms', () => {
    const { beginSearching } = startRun();
    beginSearching();

    const asked = terms().map((t) => String(t.term));
    expect(asked.length).toBeGreaterThan(0);
    for (const term of asked) {
      for (const phrase of PREP_PHRASES) {
        expect(term.toLowerCase()).not.toContain(phrase);
      }
    }
    // And they are the terms we expect, so "bare" is not "empty".
    expect(asked.some((t) => t === 'Onion' || t === 'Land O Lakes Butter')).toBe(true);
  });

  it('navigates to no URL carrying a preparation', () => {
    const { beginSearching } = startRun();
    beginSearching();

    const urls = [...navigated(), ...built().filter((b) => b.key === 'getSearchUrl').map((b) => b.out)];
    for (const url of urls) {
      for (const phrase of [...PREP_PHRASES, 'prep']) {
        expect(url.toLowerCase()).not.toContain(phrase);
        expect(decodeSafely(url).toLowerCase()).not.toContain(phrase);
      }
    }
  });

  it('injects no script carrying a preparation', () => {
    const { beginSearching } = startRun();
    beginSearching();

    const scripts = [...injected(), ...built().map((b) => b.out)];
    expect(scripts.length).toBeGreaterThan(0);
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
