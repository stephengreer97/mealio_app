import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { getStoreScripts } from '../lib/webview-scripts';
import { isAuthRedirectUrl } from '../lib/webview-scripts/auth-urls';
import { getNetworkRail, NETWORK_SESSION_MESSAGE_TYPES } from '../lib/webview-scripts/network-rail';
import { getStoreWebViewUA } from '../lib/webview-user-agent';
import { WEBVIEW_FINGERPRINT_SHIM } from '../lib/webview-fingerprint-shim';
import {
  getCartPageUrl,
  buildCartPageCountScript,
  buildOpenCartScript,
  buildInlineCartScript,
  CartItem,
} from '../lib/webview-scripts/cart-count';

// ─────────────────────────────────────────────────────────────────────────────
// SilentLoginProbe
//
// A completely hidden WebView that silently (a) determines whether the user is
// already logged in to a store and (b) — when logged in — pre-captures the cart
// "before" snapshot, WITHOUT ever showing UI or submitting credentials.
//
// It loads the store home page and injects the same `checkLoginScript` the cart
// engine uses. On a logged-in result it continues in the SAME session to read
// the cart (the same URL/click/inline path the live before-snapshot uses) and
// reports { count, items } so add-to-cart can skip the cart round-trip. Reading
// the DOM never triggers store 2FA (that only fires on a login submission).
//
// Reports exactly once via onResult (with an optional cart) or onError.
// ─────────────────────────────────────────────────────────────────────────────

// Login check: generous. Kept at 20s as a safety net for a cold, heavy homepage
// even though the Albertsons check itself is now passive (MEAL-42) rather than
// the old click-and-wait that ran 5–15s.
const LOGIN_TIMEOUT_MS = 20000;
// Cart pre-capture: bounded separately; a miss just means no baseline (we still
// report logged-in), so we don't want it to hang the queue.
const CART_TIMEOUT_MS = 15000;
/**
 * How many times one cart capture will inject the count script (MEAL-189).
 *
 * A cap on LOADS, not on distinct URLs, because the failure being retried is a
 * same-URL re-render. 5 covers the chains observed — HEB's re-render, /cart ->
 * homedge -> cart, and Amazon's /gp/aw/c -> expanded-Fresh hop, which needs two
 * on its own — while still bounding a redirect loop. Injections stop as soon as
 * any CART_COUNT posts, so in practice this only counts retries that said
 * nothing.
 */
const MAX_CART_INJECTIONS = 5;

export interface PrewarmedCart {
  count: number | null;
  items: CartItem[];
  /** Cart URL the count ran on (click-path stores); lets the live after-probe
   *  skip re-walking the click chain. */
  url?: string;
}

export interface SilentLoginProbeProps {
  storeId: string;
  /** Fired the instant login is determined, BEFORE the (slower) cart capture, so
   *  the add-to-cart flow can use the logged-in status without waiting for the
   *  cart snapshot. */
  onLogin: (storeId: string, isLoggedIn: boolean) => void;
  /** Terminal: the probe is fully done (cart captured, or logged out / timed
   *  out). Carries the cart baseline when one was captured. */
  onResult: (storeId: string, isLoggedIn: boolean, cart?: PrewarmedCart) => void;
  onError: (storeId: string) => void;
}

export default function SilentLoginProbe({ storeId, onLogin, onResult, onError }: SilentLoginProbeProps) {
  const scripts = getStoreScripts(storeId);
  const webviewRef = useRef<WebView>(null);
  const resolvedRef = useRef(false);
  const loginReportedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 'login' until LOGIN_STATUS:true flips us into pre-capturing the cart.
  const phaseRef = useRef<'login' | 'cart'>('login');
  const cartMethodRef = useRef<'url' | 'click' | 'inline' | null>(null);
  // How many times this capture has injected the count script (MEAL-189).
  // Counted, not latched, and NOT keyed on the URL — see the note in onLoadEnd.
  const cartInjectionsRef = useRef(0);
  // THE QUIET PAGE, for the same reason the run uses it: this probe asks the
  // store's own endpoints and reads no DOM, so the storefront homepage is pure
  // cost. Measured 2026-09-02: a 1-second interval fired 47 SECONDS late in a
  // document sitting on the homepage, and 2.3 s late on the quiet one.
  const probeUrl = scripts ? (scripts.railUrl || scripts.storeUrl) : 'about:blank';
  const [uri, setUri] = useState(probeUrl);

  const beforeContent = Platform.OS === 'android' ? WEBVIEW_FINGERPRINT_SHIM : undefined;

  const finish = useCallback(
    (outcome: { isLoggedIn: boolean; cart?: PrewarmedCart } | 'error') => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      if (outcome === 'error') { console.log('[Prewarm] probe', storeId, 'finishing: ERROR'); onError(storeId); }
      else {
        console.log('[Prewarm] probe', storeId, 'finishing: loggedIn=', outcome.isLoggedIn, 'cart=', outcome.cart ? `${outcome.cart.count} count / ${outcome.cart.items.length} lines` : 'none');
        onResult(storeId, outcome.isLoggedIn, outcome.cart);
      }
    },
    [storeId, onResult, onError],
  );

  // Report login the instant it's known — before cart capture — so the flow can
  // use it without waiting. Fires at most once.
  const reportLogin = useCallback((isLoggedIn: boolean) => {
    if (loginReportedRef.current) return;
    loginReportedRef.current = true;
    console.log('[Prewarm] probe', storeId, 'login determined (early): loggedIn=', isLoggedIn);
    onLogin(storeId, isLoggedIn);
  }, [storeId, onLogin]);

  const armTimeout = useCallback((ms: number, onFire: () => void) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => { timeoutRef.current = null; onFire(); }, ms);
  }, []);

  // Logged in → keep going in the same session and read the cart the same way
  // the live before-snapshot does. If the store has no usable cart method we
  // still report logged-in (just without a baseline).
  const startCartCapture = useCallback(() => {
    const inline = buildInlineCartScript(storeId);
    const cartUrl = getCartPageUrl(storeId);
    const click = buildOpenCartScript(storeId);
    const countScript = buildCartPageCountScript(storeId);
    phaseRef.current = 'cart';
    cartInjectionsRef.current = 0;
    armTimeout(CART_TIMEOUT_MS, () => {
      console.log('[Prewarm] probe', storeId, 'cart pre-capture timed out — reporting logged-in without a baseline');
      finish({ isLoggedIn: true });
    });
    // ASK THE RAIL FIRST. The probe is ALREADY on a signed-in store page — it
    // just answered the login question from there — so the cart is one request
    // away. Navigating to /cart to count was the second page load in a prewarm
    // and the same one the cart run was making a moment later.
    const rail = getNetworkRail(storeId);
    if (rail) {
      cartMethodRef.current = 'inline';   // "no navigation coming", which is what that branch means
      console.log('[Prewarm] probe', storeId, 'cart capture: over the network, no page load');
      webviewRef.current?.injectJavaScript(rail.cartRead());
      return;
    }
    if (inline) {
      // Self-contained open+count+close (ALDI side panel).
      cartMethodRef.current = 'inline';
      console.log('[Prewarm] probe', storeId, 'cart capture: inline panel');
      webviewRef.current?.injectJavaScript(inline);
    } else if (countScript && cartUrl) {
      // URL cart (HEB, Albertsons family): navigate, then count on load.
      cartMethodRef.current = 'url';
      console.log('[Prewarm] probe', storeId, 'cart capture: navigate to', cartUrl);
      setUri(cartUrl + (cartUrl.includes('?') ? '&' : '?') + '_t=' + Date.now());
    } else if (countScript && click) {
      // Click cart (Amazon Fresh): click the cart icon, then count on load.
      cartMethodRef.current = 'click';
      console.log('[Prewarm] probe', storeId, 'cart capture: click cart icon');
      webviewRef.current?.injectJavaScript(click);
    } else {
      console.log('[Prewarm] probe', storeId, 'no cart method — reporting logged-in without a baseline');
      finish({ isLoggedIn: true });
    }
  }, [storeId, armTimeout, finish]);

  useEffect(() => {
    if (!scripts) { finish('error'); return; }
    console.log('[Prewarm] probe mounted for', storeId, '→ loading', probeUrl);
    return () => {
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onLoadEnd = useCallback((e: any) => {
    if (resolvedRef.current || !scripts) return;
    const url = e?.nativeEvent?.url ?? '';
    if (phaseRef.current === 'login') {
      if (!timeoutRef.current) {
        armTimeout(LOGIN_TIMEOUT_MS, () => {
          console.log('[Prewarm] probe', storeId, 'timed out — no LOGIN_STATUS');
          finish('error');
        });
      }
      // Don't check on an intermediate auth/SSO page. Albertsons bounces through
      // …/sso/authorize?code=… on the way to the storefront; that page carries no
      // site header, so the check finds no account control, burns its full 3s
      // poll, and posts isLoggedIn:false — which reportLogin/finish below latch
      // permanently, showing a login wall to an already-signed-in user. Wait for
      // the redirect to land instead; onLoadEnd fires again for the real page.
      // (WebViewCartSheet has skipped these URLs for a while; the probe never did.)
      if (isAuthRedirectUrl(url)) {
        console.log('[Prewarm] probe', storeId, 'onLoadEnd (login) — skipping auth redirect page', url);
        return;
      }
      // Re-inject on every load so a login/SSO redirect chain still gets checked
      // once it settles on the store page. Idempotent; posts once it has an answer.
      // A store with a network rail is asked over the network, not read off the
      // DOM. The rail's session probe is a positive fact about the session — a
      // token the origin accepts, proven by an actual cart read — where the DOM
      // check infers from markup that exists in both states. That inference is
      // the weakest link in the whole flow, because the cart engine treats a
      // prewarm 'loggedOut' as terminal and surfaces a login wall without ever
      // asking again (WebViewCartSheet, `pre === 'loggedOut'`). Getting it wrong
      // costs a signed-in user their entire run.
      //
      // The DOM check is still the fallback, and reachable: see onMessage, where
      // a session probe that cannot answer hands the page back to it rather than
      // guessing.
      const rail = getNetworkRail(storeId);
      if (rail) {
        console.log('[Prewarm] probe', storeId, 'onLoadEnd (login) — asking over the network');
        webviewRef.current?.injectJavaScript(rail.sessionScript());
      } else {
        console.log('[Prewarm] probe', storeId, 'onLoadEnd (login) — injecting check script');
        webviewRef.current?.injectJavaScript(scripts.checkLoginScript);
      }
    } else if (cartMethodRef.current === 'url' || cartMethodRef.current === 'click') {
      // Same skip as the login branch above, and two tickets converge on it.
      //
      // The count scripts REFUSE to answer on a page that is not the cart —
      // silently, when that page is an auth interstitial, because a verdict there
      // would burn the probe's one pending slot. This branch used to latch on its
      // first injection, which made that silence terminal; MEAL-189 made it retry
      // instead, but the skip below is still worth keeping: an interstitial is
      // never the cart, so injecting there only spends a retry.
      //
      // Without this check: cart URL -> interstitial -> inject -> latch set ->
      // script returns silently -> the real cart page that loads next never gets
      // the script -> the probe sits out CART_TIMEOUT_MS (15s) and reports
      // logged-in with no baseline. The guard would have turned a wrong answer
      // into no answer AND no retry, which is not the trade it is supposed to
      // make. Skipping before the latch keeps the single injection for the
      // landing page.
      //
      // MEAL-136 needed it for a redirect landing off /erums/cart; MEAL-152 for
      // the same shape on Walmart, HEB and Wegmans. Both branches wrote this skip
      // independently and identically, which is why the merge kept one copy.
      if (isAuthRedirectUrl(url)) {
        console.log('[Prewarm] probe', storeId, 'onLoadEnd (cart) — skipping auth redirect page', url);
        return;
      }
      // RE-INJECT ON EVERY LOAD UNTIL SOMETHING ANSWERS, capped (MEAL-189).
      //
      // Strict one-shot assumed one injection yields one answer. It does not:
      // the page can navigate, or re-render, after a good injection, and the
      // injected context dies with the old document before it can post. Latch
      // spent, no retry, and the probe burns its full CART_TIMEOUT_MS reporting
      // logged-in with no baseline. That is Stephen's 21:31 run — `injecting
      // count script`, ~13s of nothing, `cart pre-capture timed out`.
      //
      // NOT KEYED ON THE URL, and that is the whole point. A first version of
      // this keyed on it, reasoning that the same page loading twice is not new
      // information. It is, and this repo already says so: the cart sheet lets
      // same-URL reloads through while a count is pending, because "HEB
      // re-renders the cart page (same URL) a beat after load, which kills the
      // injected count script before it polls/posts" (WebViewCartSheet.tsx, the
      // cartCountPendingRef clause in onLoadEnd). That is the documented,
      // field-observed shape of this failure, and a per-URL key excludes exactly
      // it — the one leg with evidence behind it.
      //
      // Re-injecting the same document is safe: `finish` latches on resolvedRef,
      // so a second CART_COUNT is dropped, and two copies polling the same DOM
      // cannot produce a worse answer than one. Injection also stops the instant
      // anything posts, because onLoadEnd bails on resolvedRef above — so this
      // only ever retries an injection that said nothing at all.
      //
      // The cap is what the one-shot was really protecting against: a redirect
      // loop injecting on every hop for the whole timeout.
      if (cartInjectionsRef.current >= MAX_CART_INJECTIONS) {
        console.log('[Prewarm] probe', storeId, 'onLoadEnd (cart) — injection cap reached, not re-injecting', url);
        return;
      }
      // Cart page has loaded — count it.
      const countScript = buildCartPageCountScript(storeId);
      if (countScript) {
        cartInjectionsRef.current += 1;
        // The URL is the diagnostic that was missing. Without it the log cannot
        // tell "script never ran" from "ran and was destroyed by a navigation"
        // from "ran and refused silently", which is why MEAL-189's cause had to
        // be inferred rather than read.
        console.log('[Prewarm] probe', storeId, 'onLoadEnd (cart) — injecting count script #',
          cartInjectionsRef.current, 'into', url);
        webviewRef.current?.injectJavaScript(countScript);
      }
    }
  }, [scripts, storeId, armTimeout, finish]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(e.nativeEvent.data);
        if (msg?.type === 'LOGIN_DEBUG' || msg?.type === 'EXTRACT_DEBUG') {
          // Surface the store scripts' own diagnostics in the prewarm context
          // (the probe otherwise swallows them) so we can see why it decides.
          console.log('[Prewarm] probe', storeId, msg.type, JSON.stringify(msg));
          return;
        }
        if (msg?.type && NETWORK_SESSION_MESSAGE_TYPES.includes(msg.type)) {
          console.log('[Prewarm] probe', storeId, msg.type, JSON.stringify(msg).slice(0, 220));
          if (!msg.ok) {
            // The probe could not answer — most often the page had not finished
            // its bootstrap, so the session globals were simply absent. That is
            // NOT a signed-out user, and saying so here would wall one. Hand the
            // page to the DOM check instead, which is what this store used before
            // the rail existed.
            console.log('[Prewarm] probe', storeId, 'network session inconclusive —', msg.why, '— falling back to the DOM check');
            const fb = getStoreScripts(storeId);
            if (fb?.checkLoginScript) webviewRef.current?.injectJavaScript(fb.checkLoginScript);
            return;
          }
          reportLogin(!!msg.loggedIn);
          if (!msg.loggedIn) { finish({ isLoggedIn: false }); return; }
          // ONE CART READ, whatever the store says.
          //
          // Albertsons answers this probe TWICE -- an early reply the instant
          // /userinfo returns, then a refined one about 1.3s later once its API
          // keys are resolved. reportLogin latches, so the login answer was
          // right; startCartCapture did not, so the probe fired the cart read
          // twice. Two requests into the one store measured to degrade under
          // exactly that, and a re-armed deadline on top:
          //
          //   probe albertsons cart capture: over the network, no page load
          //   probe albertsons ALB_SESSION {"verified":true,...}
          //   probe albertsons cart capture: over the network, no page load
          //
          // phaseRef is the latch it already had; it just was not read.
          if (phaseRef.current !== 'login') return;
          startCartCapture();
          return;
        }
        if (msg?.type === 'LOGIN_STATUS') {
          console.log('[Prewarm] probe', storeId, 'LOGIN_STATUS', msg.isLoggedIn);
          reportLogin(!!msg.isLoggedIn);
          // DELIBERATELY NOT LATCHED, unlike the rail branch above.
          //
          // The DOM check is re-injected on every page load, so a second
          // LOGIN_STATUS:true can arrive after a capture has already burned its
          // whole injection budget on a redirect chain without ever getting an
          // answer. Starting again is that capture's only recovery, and
          // startCartCapture resets the counter to give it a fresh five
          // (prewarm-cart-injection-latch.test.tsx pins it).
          //
          // The rail's duplicate is a different animal: not a retry after
          // silence, but the same store answering the same question twice in
          // 1.3s, and a second read there is pure cost.
          if (msg.isLoggedIn) startCartCapture();
          else finish({ isLoggedIn: false });
        } else if (msg?.type === 'CART_COUNT' && phaseRef.current === 'cart') {
          // Log reason/url, not just the count: a bare "count= null" is
          // indistinguishable from a selector miss, whereas
          // `reason=not_cart_page url=<host>` names a wrong DOMAIN_MAP host as a
          // wrong host (MEAL-136) and a redirect off the cart page as a redirect
          // (MEAL-152). This is the likelier of the two log sites to hit it — the
          // prewarm probe is where most before-baselines come from — and `finish`
          // below drops both fields from the cached baseline, so this line is the
          // only place they survive.
          console.log('[Prewarm] probe', storeId, 'CART_COUNT count=', msg.count, 'reason=', msg.reason ?? null, 'url=', msg.url);
          finish({
            isLoggedIn: true,
            cart: {
              count: typeof msg.count === 'number' ? msg.count : null,
              items: Array.isArray(msg.items) ? msg.items : [],
              url: typeof msg.url === 'string' ? msg.url : undefined,
            },
          });
        }
      } catch {
        // Non-JSON message from the page — ignore.
      }
    },
    [finish, storeId, startCartCapture, reportLogin],
  );

  if (!scripts) return null;

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={webviewRef}
        source={{ uri }}
        style={{ flex: 1 }}
        onLoadEnd={onLoadEnd}
        onMessage={onMessage}
        onError={() => finish('error')}
        onHttpError={() => { /* transient sub-resource errors are common; wait for the check or timeout */ }}
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
  // Full-size (so pages that gate rendering on viewport still load) but pushed
  // far offscreen and non-interactive — never visible to the user.
  hidden: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    opacity: 0,
    transform: [{ translateX: 100000 }],
  },
});
