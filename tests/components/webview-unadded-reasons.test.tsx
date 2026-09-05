// MEAL-202: the "Items Not Added" gate says WHY, per item.
//
// It used to carry one blanket sentence for every item — "this may be because
// the item is out of stock or the store no longer carries it" — which is a guess
// covering two possibilities out of five, and wrong for most of them. The
// network rail reports a real per-item reason, so the screen can stop guessing.
//
// The distinction is not cosmetic. "Out of stock" and "no exact match" ask the
// user for completely different things: the first is nothing they can fix by
// choosing better, the second is exactly that. A screen that says the same thing
// for both sends half its readers to do the wrong thing.

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
      logAutomationStart: jest.fn(async () => 'run-unadded-reasons'),
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

/**
 * Drive a serial run to the "Items Not Added" gate. `candidatesFor` decides each
 * item's fate: an out-of-stock candidate, a non-matching one, or none at all —
 * the three the gate has to tell apart.
 */
async function runToGate(items: string[], candidatesFor: (t: string) => unknown[]) {
  const view = render(
    <WebViewCartSheet
      visible
      meals={[{ id: 'm1', name: 'Tacos', ingredients: items.map(chosen) }] as never}
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
  // Over the rail. Twice: the session probe answers the login check, then the
  // run's own session read after the baseline.
  enableRail();
  post(SESSION_OK);
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post(SESSION_OK);
  // One answer per term, then the batch closes and the pass reconciles — that is
  // what puts the unmatched items on the gate.
  for (const t of items) {
    post({ type: 'SEARCH_RESULT', source: 'network', term: t, candidates: candidatesFor(t) });
  }
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: items.length });
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  return view;
}

const candidate = (name: string, over: Record<string, unknown> = {}) => ({
  productName: name, imageUrl: null, outOfStock: false, preferences: null, price: '$2', ...over,
});

describe('the Items Not Added gate explains each item', () => {
  it('says out of stock, rather than guessing', async () => {
    // The store HAS it and will not sell it today. Choosing again cannot help,
    // which is why this must not read like a bad match.
    const view = await runToGate(['sour cream'], () => [candidate('sour cream', { outOfStock: true })]);
    expect(view.queryByText(/out of stock at H-E-B/i)).toBeTruthy();
  });

  it('says there was no match, rather than out of stock', async () => {
    const view = await runToGate(['sour cream'], () => []);
    expect(view.queryByText(/H-E-B had no match for this/i)).toBeTruthy();
    expect(view.queryByText(/out of stock/i)).toBeNull();
  });

  it('asks the user to pick when the match was only inexact', async () => {
    // This one IS fixable by choosing, and the sentence has to say so — it is
    // the opposite instruction from the out-of-stock case.
    const view = await runToGate(['sour cream'], () => [candidate('Some Other Brand Cream')]);
    expect(view.queryByText(/no exact match: pick the right product/i)).toBeTruthy();
  });

  it('drops the blanket guess once every item can say why', async () => {
    // The old sentence offered two explanations for problems that are now named,
    // and one of them would be wrong.
    const view = await runToGate(['sour cream'], () => [candidate('sour cream', { outOfStock: true })]);
    expect(view.queryByText(/this may be because the item is out of stock/i)).toBeNull();
  });

  it('tells them apart on one screen', async () => {
    // The case that matters: two items, two different problems, two different
    // things for the user to do about them.
    const view = await runToGate(['sour cream', 'tortillas'], (t) =>
      t === 'sour cream' ? [candidate('sour cream', { outOfStock: true })] : []);
    expect(view.queryByText(/out of stock at H-E-B/i)).toBeTruthy();
    expect(view.queryByText(/H-E-B had no match for this/i)).toBeTruthy();
  });
});
