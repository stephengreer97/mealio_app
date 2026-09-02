import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { getStoreScripts } from '../lib/webview-scripts';
import { isAuthRedirectUrl } from '../lib/webview-scripts/auth-urls';
import { getNetworkRail, NETWORK_SESSION_MESSAGE_TYPES } from '../lib/webview-scripts/network-rail';
import { getStoreWebViewUA } from '../lib/webview-user-agent';
import { WEBVIEW_FINGERPRINT_SHIM } from '../lib/webview-fingerprint-shim';

// ─────────────────────────────────────────────────────────────────────────────
// SilentSearchProbe
//
// A hidden WebView that looks ingredients up BEFORE the user opens the cart
// sheet, so the run has the answers waiting rather than fetching them.
//
// The cart sheet already prewarms while the user is on the quantity screen.
// This is the same work moved earlier — to the moment meals are ticked on the
// selection screen — which is several seconds of head start the sheet cannot
// give itself. Measured on a 36-ingredient run: the sheet's prewarm was still
// answering when the user tapped, and the run stood and waited 2.5s for it.
//
// It only ever READS. Nothing here can write to a cart, so a lookup for a meal
// the user then unticks is wasted time and nothing worse. What it must not be
// is wasted VOLUME — see the provider, which drops unsent terms when the
// selection changes and caps what one batch may ask for.
//
// Reports each answer as it lands, then onDone once. Never reports login: the
// provider only starts this probe for a store SilentLoginProbe has already
// confirmed signed in.
// ─────────────────────────────────────────────────────────────────────────────

/** One search hit, as the rail's script posts it. Structure is the rail's
 *  business — this probe only carries it. */
export type SearchCandidate = Record<string, unknown>;

export interface SilentSearchProbeProps {
  storeId: string;
  /** Terms to look up. Fixed for the life of the probe — the provider remounts
   *  with a new key rather than editing a batch already in flight. */
  terms: string[];
  onCandidates: (storeId: string, term: string, candidates: SearchCandidate[]) => void;
  /** Terminal: the batch finished, timed out, or could not start. */
  onDone: (storeId: string) => void;
}

export default function SilentSearchProbe({ storeId, terms, onCandidates, onDone }: SilentSearchProbeProps) {
  const scripts = getStoreScripts(storeId);
  const rail = getNetworkRail(storeId);
  const webviewRef = useRef<WebView>(null);
  const doneRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchStartedRef = useRef(false);
  const answeredRef = useRef(0);

  // THE QUIET PAGE, for the reason SilentLoginProbe uses it: this probe asks the
  // store's own endpoints and reads no DOM, so the storefront homepage is pure
  // cost. Measured 2026-09-02: a 1-second interval fired 47 SECONDS late in a
  // document sitting on the homepage, and 2.3s late on the quiet one.
  const probeUrl = scripts ? (scripts.railUrl || scripts.storeUrl) : 'about:blank';
  const [uri] = useState(probeUrl);

  const beforeContent = Platform.OS === 'android' ? WEBVIEW_FINGERPRINT_SHIM : undefined;

  const finish = useCallback((why: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    console.log('[Prewarm] search probe', storeId, 'finishing:', why, '—', answeredRef.current, 'of', terms.length, 'answered');
    onDone(storeId);
  }, [storeId, terms.length, onDone]);

  const armTimeout = useCallback((ms: number, onFire: () => void) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => { timeoutRef.current = null; onFire(); }, ms);
  }, []);

  useEffect(() => {
    if (!scripts || !rail || terms.length === 0) { finish('nothing to do'); return; }
    console.log('[Prewarm] search probe mounted for', storeId, '—', terms.length, 'terms →', probeUrl);
    return () => {
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onLoadEnd = useCallback((e: any) => {
    if (doneRef.current || !rail) return;
    const url = e?.nativeEvent?.url ?? '';
    // Never probe an intermediate auth/SSO page. Albertsons bounces through
    // …/sso/authorize?code=… on the way to the storefront, and a session probe
    // there answers nothing — SilentLoginProbe skips these for the same reason.
    if (isAuthRedirectUrl(url)) {
      console.log('[Prewarm] search probe', storeId, 'skipping auth redirect page', url);
      return;
    }
    if (searchStartedRef.current) return;
    if (!timeoutRef.current) {
      armTimeout(rail.budgets.sessionMs, () => finish('no session'));
    }
    webviewRef.current?.injectJavaScript(rail.sessionScript());
  }, [rail, storeId, armTimeout, finish]);

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    if (doneRef.current || !rail) return;
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg?.type && NETWORK_SESSION_MESSAGE_TYPES.includes(msg.type)) {
        if (searchStartedRef.current) return;
        // No fallback to the DOM check here, and none wanted: this probe has no
        // login question to answer. A session it cannot establish just means the
        // sheet does the looking up, which is what happened before this existed.
        if (!msg.ok || !msg.loggedIn || !msg.storeId || !msg.shoppingContext) {
          finish('no usable session (' + (msg.why || (msg.loggedIn === false ? 'signed out' : 'incomplete')) + ')');
          return;
        }
        const script = rail.searchBatch(terms, {
          storeId: String(msg.storeId),
          shoppingContext: String(msg.shoppingContext),
        });
        if (!script) { finish('no search script'); return; }
        searchStartedRef.current = true;
        console.log('[Prewarm] search probe', storeId, 'searching', terms.length, 'terms before the sheet opens');
        armTimeout(rail.budgets.searchMs(terms.length), () => finish('search timed out'));
        webviewRef.current?.injectJavaScript(script);
        return;
      }
      if (msg?.type === 'SEARCH_RESULT' && msg.source === 'network') {
        if (typeof msg.term === 'string' && Array.isArray(msg.candidates)) {
          answeredRef.current += 1;
          onCandidates(storeId, msg.term, msg.candidates as SearchCandidate[]);
        }
        return;
      }
      if (msg?.type === 'SEARCH_RESULT_FAILED') {
        // Not cached, so the run searches it again. A term the store would not
        // answer on spec may well answer when it is actually needed.
        //
        // The rail's own diagnostics are relayed whole rather than summarised:
        // `ms` is what separates an aborted slow answer from an instant throw,
        // and `worstTick` is what separates a slow store from a throttled
        // renderer — the two look identical from outside, and this probe is the
        // one place in the app whose WebView nobody can see.
        console.log('[Prewarm] search probe', storeId, 'term failed:', String(msg.term).slice(0, 30),
          '—', msg.why, 'status=', msg.status ?? null, 'ms=', msg.ms ?? null, 'vis=', msg.vis ?? null,
          'worstTick=', msg.worstTickMs ?? null, 'keyTail=', msg.keyTail ?? null,
          'variant=', msg.variant ?? null, 'detail=', msg.detail ?? null);
        return;
      }
      if (msg?.type === 'SEARCH_BATCH_DONE') {
        finish('batch done');
      }
    } catch {
      // Non-JSON message from the page — ignore.
    }
  }, [rail, storeId, terms, onCandidates, finish, armTimeout]);

  if (!scripts || !rail || terms.length === 0) return null;

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={webviewRef}
        source={{ uri }}
        style={{ flex: 1 }}
        onLoadEnd={onLoadEnd}
        onMessage={onMessage}
        onError={() => finish('webview error')}
        onHttpError={() => { /* transient sub-resource errors are common; wait for the batch or the timeout */ }}
        onShouldStartLoadWithRequest={(request) => (
          request.url.startsWith('http://') ||
          request.url.startsWith('https://') ||
          request.url.startsWith('about:')
        )}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        userAgent={getStoreWebViewUA()}
        injectedJavaScriptBeforeContentLoaded={beforeContent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * DRAWN. Two pixels in the corner at 1% opacity, not a full-size alpha-0 view
   * pushed offscreen.
   *
   * This probe was written with SilentLoginProbe's hiding — `opacity: 0` plus
   * `translateX: 100000` — and on the device every single search came back
   * `no_response`. Android stops drawing a view like that, Chromium then treats
   * the page as hidden, and the renderer is throttled to a standstill; the
   * requests never complete. WebViewCartSheet learned this on 2026-09-02 and
   * says so on `hiddenLayer`: a one-second interval fired 34 SECONDS late while
   * `document.visibilityState` still read 'visible', because Android WebView
   * only updates that on window visibility, never on being covered.
   *
   * So: invisible to the user, alive to Chromium. The rail is on robots.txt
   * doing pure fetches, so it has no use for a viewport.
   */
  hidden: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 2,
    height: 2,
    opacity: 0.01,
  },
});
