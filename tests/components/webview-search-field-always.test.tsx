// The search field on the reconcile screen: always there, never announced.
//
// This file used to pin a GLOW that pointed at a row of placeholder text, back
// when the search field was hidden behind it and only offered on an empty list.
// Stephen, 2026-09-09: get rid of the "Other: type a product name…" row, and get
// rid of the glow. The field is simply present now, which is what makes both
// unnecessary — a control whose job is to reveal another control is a step for
// its own sake, and a pulse that is always able to fire is decoration.
//
// So the property under test is inverted and kept: the field and its button are
// there on EVERY list, and nothing pulses at them.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: () => {}, stopLoading: () => {}, goBack: () => {}, reload: () => {},
    }));
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

jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'run-glow'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});

jest.mock('../../src/lib/automation-config', () => {
  const actual = jest.requireActual('../../src/lib/automation-config');
  return {
    ...actual,
    getAutomationConfig: () => {
      const base = actual.getAutomationConfig();
      return { ...base, flags: { ...base.flags, parallelAdd: false, presearchAdd: false } };
    },
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { enableRail, SESSION_OK } from './helpers/railRun';

const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

/** Drive one item to the review screen with whatever candidates are given. */
async function runToReview(candidates: unknown[]) {
  const view = render(
    <WebViewCartSheet
      visible
      meals={[{ id: 'm1', name: 'Tacos', ingredients: [chosen('sour cream')] }] as never}
      storeId="heb"
      storeName="H-E-B"
      onClose={() => {}}
    />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  enableRail();
  // Twice: the session probe answers the login check, then the run's own
  // session read after the baseline.
  post(SESSION_OK);
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post(SESSION_OK);
  post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates });
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  act(() => { fireEvent.press(view.getByText(/review 1 ingredient/i)); });
  return view;
}

const candidate = (name: string, over: Record<string, unknown> = {}) => ({
  productName: name, imageUrl: null, outOfStock: false, preferences: null, price: '$2', ...over,
});

describe('the search field on reconcile', () => {
  it('is there when the store found nothing', async () => {
    const view = await runToReview([]);
    expect(view.queryByTestId('custom-search-btn')).toBeTruthy();
  });

  it('is there when the store DID find something', async () => {
    // The case that made this worth changing. A search offered only on an empty
    // list is unavailable exactly when the user disagrees with what the store
    // found, which is most of the times they want it.
    const view = await runToReview([candidate('Some Other Brand Cream')]);
    expect(view.queryByTestId('custom-search-btn')).toBeTruthy();
  });

  it('is there for an out-of-stock product, which is still a product', async () => {
    const view = await runToReview([candidate('sour cream', { outOfStock: true })]);
    expect(view.queryByTestId('custom-search-btn')).toBeTruthy();
  });

  it('never pulses, and the row that used to reveal it is gone', async () => {
    for (const list of [[], [candidate('Some Other Brand Cream')]]) {
      const view = await runToReview(list);
      expect(view.queryByTestId('custom-row-glow')).toBeNull();
      expect(view.queryByText(/other: type a product name/i)).toBeNull();
      expect(view.queryByText(/try a different search/i)).toBeNull();
      view.unmount();
    }
  });
});
