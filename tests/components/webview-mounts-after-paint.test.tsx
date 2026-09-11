// THE STORE WEBVIEW MOUNTS AFTER THE QTY SCREEN, NOT WITH IT.
//
// Stephen, 2026-09-11, on ALDI: "it takes about 2 seconds for the ingredients to
// show up and for the add ingredients to aldi cart button to be clickable."
//
// The ingredients were never slow. From his own run:
//
//   +0.001s   open: meals=1 consolidated=14      <- the list is ready
//   +5.292s   onLoadEnd aldi.us/robots.txt
//
// and aldi.us/robots.txt fetches in 0.17s, so none of that gap is the network.
// It is Android building a Chromium renderer process, at the moment the sheet
// was mounting and the qty screen was trying to paint fourteen rows. The button
// is gated on nothing but activeCount, so what he waited on was the thread.
//
// This file overrides the central InteractionManager stub with one that NEVER
// fires, which is the only way to see the deferral: the stub in
// tests/setup/native-modules.js runs callbacks straight through, because under
// jest there is no frame loop for them to wait on, and testing the deferral
// through that stub would be circular.
//
// So what is pinned here is the backstop path, and with it the thing that
// matters: on the first commit there is no WebView, and the qty screen is
// already complete and interactive without one.
import { render, act } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native/Libraries/Interaction/InteractionManager', () => {
  const never = { cancel: () => {} };
  const api = {
    runAfterInteractions: () => never,   // deliberately never calls back
    createInteractionHandle: () => 1,
    clearInteractionHandle: () => {},
  };
  return { __esModule: true, default: api, ...api };
});

jest.mock('react-native-webview', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: R.forwardRef((props: Record<string, unknown>, ref: unknown) => {
      R.useImperativeHandle(ref, () => ({ injectJavaScript: () => {} }));
      return R.createElement(View, { testID: 'mock-webview', ...props });
    }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { __applyAutomationConfigForTests, __resetAutomationConfigForTests } from '../../src/lib/automation-config';

const meal = {
  id: 'm1', name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
    { ingredientName: 'Tortillas', searchTerm: 'tortillas', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
};

const open = () => render(
  <WebViewCartSheet visible meals={[meal] as never} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
);

describe('the qty screen does not wait for a Chromium renderer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __applyAutomationConfigForTests({
      stores: { heb: { networkSearch: true, networkAdd: true, cartSkuConfirm: true } },
    });
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    __resetAutomationConfigForTests();
  });

  it('renders the ingredients and the button with no WebView mounted at all', () => {
    const v = open();
    // Let the sheet's own mount effects settle into the qty step. One
    // millisecond, which is nowhere near the 800ms backstop below, so the
    // WebView still has no way to appear.
    act(() => { jest.advanceTimersByTime(1); });

    // Nothing to build a renderer for yet.
    expect(v.queryAllByTestId('mock-webview').length).toBe(0);

    // And the screen is already done: both ingredients listed, and the CTA
    // present. This is the whole point — the user can read the list and tap the
    // button while the WebView does not yet exist.
    // The qty row shows `searchTerm ?? ingredientName`, so these are the
    // lowercase search terms rather than the display names.
    expect(v.getByText(/sour cream/i)).toBeTruthy();
    expect(v.getByText(/tortillas/i)).toBeTruthy();
    expect(v.getByText(/Add Ingredients to H-E-B Cart/)).toBeTruthy();
  });

  it('mounts it on the backstop when interactions never settle', () => {
    // runAfterInteractions waits for EVERY interaction handle to clear, and one
    // animation that never settles would otherwise mean a cart run with no
    // WebView at all — worse than the delay being fixed. The timer is the floor
    // under that, not the mechanism.
    const v = open();
    expect(v.queryAllByTestId('mock-webview').length).toBe(0);

    act(() => { jest.advanceTimersByTime(799); });
    expect(v.queryAllByTestId('mock-webview').length).toBe(0);

    act(() => { jest.advanceTimersByTime(2); });
    expect(v.queryAllByTestId('mock-webview').length).toBeGreaterThan(0);
  });
});
