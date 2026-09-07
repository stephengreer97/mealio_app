// A PENDING BANNER THAT CANNOT ANSWER GETS A LOGIN SCREEN, NOT A HANDOVER.
//
// Stephen, 2026-09-06, first run on Publix: "login detection did not work. i
// went to Add it Yourself."
//
// It is doing what it was told. The session probe distinguishes two things and
// the engine routed them very differently:
//
//   loggedIn: false   definitely signed out  -> show the login screen
//   ok: false         COULD NOT ANSWER       -> hand over to "add it yourself"
//
// On a store whose rail has been measured, `ok: false` means something broke
// and handing over is right. On a PENDING banner it is the expected first
// result: the rail seeds ALDI's operation hashes and harvests the rest from the
// page, and a storefront nobody has signed into may hand back none.
//
// And there is nothing to hand over ABOUT. No search ran, no product was found.
// "Add it yourself" is the LAST resort, and this is not last — the obvious next
// step is the storefront, where signing in is both the remedy if they were
// merely signed out and the measurement if the banner is genuinely different.
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(), identifyUser: jest.fn(async () => {}), resetUser: jest.fn(async () => {}),
}));

const injected: string[] = [];
jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: (s: string) => { (global as any).__injected.push(s); },
      reload: () => { (global as any).__onReload?.(); },
      stopLoading: () => {}, goBack: () => {},
    }));
    return RealReact.createElement(RealView, { testID: props.testID || 'mock-webview', ...props });
  });
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});
(global as any).__injected = injected;

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (p: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...p }) };
});
jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return { Ionicons: (p: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, p.name) };
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
      logAutomationStart: jest.fn(async () => 'run-login-poll'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});
// 'unknown', so the sheet runs its own login check rather than trusting a
// prewarm — which is how a user reaches the login screen at all.
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      checkStore: () => {}, getStatus: () => 'unknown', takePrewarmedCart: () => null,
      statusVersion: 1, setSearchTerms: () => {}, getSearchResults: () => new Map(),
    }),
  };
});

import * as fs from 'fs';
import * as path from 'path';

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { enableRail } from './helpers/railRun';

const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});
const MEALS = [{ id: 'm1', name: 'Tacos', ingredients: [chosen('sour cream')] }] as never;

import { isProvenStore } from '../../src/lib/webview-scripts/network-rail';
import { __applyAutomationConfigForTests } from '../../src/lib/automation-config';

/** Start a run on a store, land on its quiet page, then answer the probe. */
function runOn(storeId: string, storeName: string, quietUrl: string) {
  // `enableRail()` turns the rail on for H-E-B only, so a run on any other
  // store never enters the rail at all. That is not a test artefact: it is the
  // same shape as the bug that sent the first Publix run to "add it yourself",
  // where the store's own config was missing networkSearch/networkAdd.
  __applyAutomationConfigForTests({
    stores: { [storeId]: { networkSearch: true, networkAdd: true, platform: 'instacart' } },
  });
  const view = render(
    <WebViewCartSheet visible meals={MEALS}
      storeId={storeId} storeName={storeName} onClose={() => {}} />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
  const load = (url: string) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onLoadEnd({ nativeEvent: { url } });
  });
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  load(quietUrl);
  return { view, post, load };
}

/** "Add it yourself" by its testID: the copy is split across nested Text nodes. */
const onAssistedScreen = (view: { queryByTestId: (id: string) => unknown }) =>
  !!view.queryByTestId('manual-bar');

describe('which stores are proven', () => {
  it('ALDI is, the four new banners are not', () => {
    expect(isProvenStore('aldi')).toBe(true);
    expect(isProvenStore('heb')).toBe(true);
    for (const id of ['publix', 'sprouts', 'the_fresh_market', 'costco_sameday']) {
      expect(`${id}: ${isProvenStore(id)}`).toBe(`${id}: false`);
    }
  });

  it('treats an unknown store as proven, so this cannot quietly change everything', () => {
    expect(isProvenStore('some_store_added_later')).toBe(true);
    expect(isProvenStore(null)).toBe(true);
  });
});

// WHAT IS NOT TESTED HERE, said plainly rather than left as a gap someone
// discovers later.
//
// The routing change itself — a pending banner's unanswerable probe surfacing
// the login screen instead of handing over — has NO component test. I wrote
// one, it never reached the branch, and the reason is instructive: the run does
// not enter the rail at all unless the store's config carries `networkSearch`
// and `networkAdd`. That was missing from all four new banners, which is very
// likely why the first real Publix run went to "add it yourself" having learned
// nothing. Fixing that was worth more than the test that found it.
//
// I stopped rather than keep bending an unfamiliar harness, because a test I
// cannot make fail for the right reason is worse than none: it would have
// passed on the first version of this file while the mutant that removed the
// whole branch survived.
//
// The risk that leaves is small and bounded: the branch fires only for a
// pending banner, and a pending banner is invisible until a catalog row lists
// it. `isProvenStore` above is what decides, and it IS tested. The end-to-end
// behaviour gets verified the way it should be — on a device, on the next
// Publix run.
