import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import { useSessionEnd } from './useSessionEnd';
import SilentLoginProbe, { PrewarmedCart } from '../components/SilentLoginProbe';
import { getStoreScripts } from '../lib/webview-scripts';
import { isWebViewStore } from '../constants/stores';

// ─────────────────────────────────────────────────────────────────────────────
// LoginPrewarmProvider
//
// Silently pre-checks whether the user is already logged in to a store, so the
// add-to-cart flow doesn't have to discover it live. Results are cached for the
// APP SESSION ONLY (a fresh launch re-checks).
//
// A store is probed at most once per session, one at a time (a single hidden
// WebView), because loading several store pages at once both overwhelms the
// native WebView init and looks more automated to store anti-bot.
//
// Triggers (from MyMealsScreen): on launch we check the store with the most
// saved meals; switching store tabs checks that store too. The cart engine
// reads getStatus() at add-to-cart time to decide whether to surface login
// immediately (see WebViewCartSheet).
// ─────────────────────────────────────────────────────────────────────────────

export type LoginPrewarmStatus =
  | 'unknown'   // never checked this session (or scheduled but not yet started)
  | 'checking'  // probe in flight
  | 'loggedIn'
  | 'loggedOut'
  | 'error';    // probe failed/timed out — treat as unknown, but don't re-probe

interface LoginPrewarmValue {
  /** Silently check login for a store (WebView stores only). No-op if already
   *  checked/checking this session. */
  checkStore: (storeId: string) => void;
  /** Last known status for a store this session. */
  getStatus: (storeId: string) => LoginPrewarmStatus;
  /** A cart "before" snapshot pre-captured during the silent login check, if one
   *  exists. Consumes it (one-shot) so the next run — after this one has changed
   *  the cart — live-snapshots instead of reusing a stale baseline. Returns null
   *  when there's nothing pre-captured. */
  takePrewarmedCart: (storeId: string) => PrewarmedCart | null;
  /** Bumped whenever any probe settles. Consumers depend on it to re-evaluate a
   *  status they read imperatively (e.g. start pre-search parking the moment a
   *  slow store's login check finally resolves logged-in, without waiting for the
   *  next render). */
  statusVersion: number;
}

// Default is a working no-op so consumers rendered outside the provider (e.g.
// isolated tests, the inline cart mount) don't crash and just get 'unknown'.
const LoginPrewarmContext = createContext<LoginPrewarmValue>({
  checkStore: () => {},
  getStatus: () => 'unknown',
  takePrewarmedCart: () => null,
  statusVersion: 0,
});

export function useLoginPrewarm(): LoginPrewarmValue {
  return useContext(LoginPrewarmContext);
}

export function LoginPrewarmProvider({ children }: { children: React.ReactNode }) {
  // The end of a session has to stop the probe — see the effect below. Safe to
  // read here: App.tsx mounts this provider inside AuthProvider (it has to be,
  // since prewarming is only ever triggered from a signed-in screen).
  const { user } = useAuth();
  // Read during render, not in an effect, because a child's effects run BEFORE
  // this provider's: a checkStore arriving from a child after `user` went null
  // (MyMealsScreen's loadMeals resolves and prewarms the top store) must already
  // see the sign-out here, not one commit later.
  const userRef = useRef(user);
  userRef.current = user;
  // Session cache. A ref (not state) because consumers read it imperatively at
  // add-to-cart time; the provider only needs to re-render to (un)mount the probe.
  const statusRef = useRef<Map<string, LoginPrewarmStatus>>(new Map());
  const queueRef = useRef<string[]>([]);
  // Cart baselines pre-captured on a logged-in probe. Valid for the whole
  // session: the only thing that invalidates a baseline is US adding to the cart,
  // and that's handled by consuming it one-shot (below) so the next run
  // live-snapshots. Cleared naturally on app restart (in-memory).
  const cartRef = useRef<Map<string, PrewarmedCart>>(new Map());
  // storeId currently being probed (mounts the hidden SilentLoginProbe), or null.
  const [current, setCurrent] = useState<string | null>(null);
  const currentRef = useRef<string | null>(null);
  // Bumped on every settle so consumers can react to a status change.
  const [statusVersion, setStatusVersion] = useState(0);

  const getStatus = useCallback(
    (storeId: string): LoginPrewarmStatus => statusRef.current.get(storeId) ?? 'unknown',
    [],
  );

  const takePrewarmedCart = useCallback((storeId: string): PrewarmedCart | null => {
    const cart = cartRef.current.get(storeId);
    if (!cart) return null;
    cartRef.current.delete(storeId); // one-shot: the cart changes once we add
    console.log('[Prewarm] using prewarmed cart baseline for', storeId, '(', cart.items.length, 'lines )');
    return cart;
  }, []);

  // Start the head of the queue if nothing is in flight.
  const pump = useCallback(() => {
    if (currentRef.current != null) return;
    // Nobody is signed in, so nothing here is worth probing for and the lines it
    // would write belong to no account. Belt and braces, and no test can kill it:
    // both ways into pump are already shut — checkStore refuses below, and the
    // deferred `setTimeout(pump, 0)` a settling probe leaves behind finds the
    // queue emptied by the sign-out effect. Kept for the next caller pump grows.
    if (!userRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    currentRef.current = next;
    statusRef.current.set(next, 'checking');
    console.log('[Prewarm] starting silent login probe for', next);
    setCurrent(next);
  }, []);

  const checkStore = useCallback(
    (storeId: string) => {
      if (!storeId) return;
      // Silent on purpose, unlike every other skip below: the point of stopping
      // here is that no `[Prewarm]` line lands in a buffer that now belongs to
      // whoever signs in next, and a skip line is still a line.
      if (!userRef.current) return;
      // Only WebView stores have a login check; Kroger-family stores use the API.
      if (!isWebViewStore(storeId) || !getStoreScripts(storeId)) {
        console.log('[Prewarm] checkStore skip', storeId, '— not a WebView store / no scripts');
        return;
      }
      // Check each store at most once per session (matches session-only caching).
      const status = statusRef.current.get(storeId) ?? 'unknown';
      if (status !== 'unknown') {
        console.log('[Prewarm] checkStore skip', storeId, '— already', status);
        return;
      }
      if (currentRef.current === storeId || queueRef.current.includes(storeId)) {
        console.log('[Prewarm] checkStore skip', storeId, '— already queued/in-flight');
        return;
      }
      console.log('[Prewarm] checkStore queue', storeId, '(inflight=', currentRef.current, 'queue=', queueRef.current.length, ')');
      queueRef.current.push(storeId);
      pump();
    },
    [pump],
  );

  const settle = useCallback(
    (storeId: string, status: LoginPrewarmStatus) => {
      console.log('[Prewarm] probe result', storeId, '→', status);
      statusRef.current.set(storeId, status);
      setStatusVersion((v) => v + 1);
      currentRef.current = null;
      setCurrent(null);
      // Start the next queued probe (deferred so the current probe unmounts first).
      setTimeout(() => pump(), 0);
    },
    [pump],
  );

  // Login determined early (before cart capture): publish the status now so the
  // add-to-cart flow can skip its own login check, while the probe stays mounted
  // finishing the cart snapshot. Does NOT dequeue — the terminal handleResult does.
  const handleLogin = useCallback((storeId: string, isLoggedIn: boolean) => {
    console.log('[Prewarm] login published early', storeId, '→', isLoggedIn ? 'loggedIn' : 'loggedOut');
    statusRef.current.set(storeId, isLoggedIn ? 'loggedIn' : 'loggedOut');
    setStatusVersion((v) => v + 1);
  }, []);

  const handleResult = useCallback(
    (storeId: string, isLoggedIn: boolean, cart?: PrewarmedCart) => {
      if (isLoggedIn && cart) cartRef.current.set(storeId, cart);
      settle(storeId, isLoggedIn ? 'loggedIn' : 'loggedOut');
    },
    [settle],
  );
  const handleError = useCallback((storeId: string) => {
    // Don't downgrade a login we already confirmed early — cart capture can error
    // after the login result is known; the login status still stands.
    const prior = statusRef.current.get(storeId);
    settle(storeId, prior === 'loggedIn' ? 'loggedIn' : 'error');
  }, [settle]);

  // ── The end of a session stops the probe and drops the cache ───────────────
  //
  // The fourth writer that outlived a sign-out (MEAL-142). AuthContext empties
  // the console ring buffer, but this provider had no idea auth existed:
  // a hidden probe could be in flight or queued straight through a sign-out and
  // keep writing `[Prewarm]` lines into the buffer logout had just cleared —
  // store login status, and LOGIN_DEBUG/EXTRACT_DEBUG dumps that go through
  // JSON.stringify and so can carry cart contents. Same leak as the cart run and
  // the ingredient saves, at smaller volume: the next person on a shared phone
  // files a report from Help and it carries the previous person's data under
  // their own token-verified userId.
  //
  // Clearing setCurrent(null) unmounts SilentLoginProbe, and the WebView goes
  // with it, so there is no window for it to report late.
  //
  // The cached state goes too. The store login is device-level rather than
  // Mealio-account-level, so the baseline is not really the next person's
  // secret — they would see that cart on the store's own site anyway — but it
  // can be stale, and stale-by-default is the better failure here. Dropping
  // statusRef just means the next account re-probes, under its own name.
  //
  // No unmount cleanup to match this: this provider sits ABOVE
  // NavigationContainer (App.tsx), so the end of a session re-renders it rather
  // than unmounting it (probed — this fires, unlike MyMealsScreen's equivalent,
  // which never does). Every ref here is reachable only through this provider,
  // so unmounting is self-clearing, and the deferred pump cannot render a probe
  // into a tree that is gone.
  //
  // Keyed on the session ENDING, not on `user` going null (MEAL-146). B taking
  // over via the verification deep link never passes through null, and A's
  // probe, A's store login statuses and A's captured cart baseline are no more
  // B's than they are the login screen's. The `!userRef.current` guards in
  // `checkStore` and `pump` are the sign-out half of this and stay as they are:
  // they refuse work when nobody is signed in, which an A → B hand-over is not.
  // What stops A's queue reaching B is this reset.
  //
  // One window is left open, deliberately, and it is worth naming rather than
  // implying it is shut. A probe already mounted cannot write past this commit,
  // and a checkStore arriving after a sign-out is refused — but AuthContext
  // clears the buffer and only THEN changes the user, so a microtask already
  // queued when it does (MyMealsScreen's loadMeals resolving, and prewarming the
  // top store) runs before React's render and still sees the old user in
  // `userRef`. It starts a probe, and three lines survive into the emptied
  // buffer: "checkStore queue heb", "starting silent login probe for heb",
  // "probe mounted for heb". Then this effect fires and tears it down (measured:
  // mounted for one commit, status left 'unknown'), so nothing that names a
  // product or a cart gets out — a store name does. CartJobProvider closes its
  // equivalent window by clearing again after teardown; that is not repeated
  // here, because the payload does not warrant a second mechanism in this
  // provider. If the chain gets a fifth link, this is where it starts.
  useSessionEnd(() => {
    queueRef.current = [];
    statusRef.current.clear();
    cartRef.current.clear();
    currentRef.current = null;
    setCurrent(null);
  });

  const value = useMemo<LoginPrewarmValue>(
    () => ({ checkStore, getStatus, takePrewarmedCart, statusVersion }),
    [checkStore, getStatus, takePrewarmedCart, statusVersion],
  );

  return (
    <LoginPrewarmContext.Provider value={value}>
      {children}
      {current && (
        <SilentLoginProbe
          key={current}
          storeId={current}
          onLogin={handleLogin}
          onResult={handleResult}
          onError={handleError}
        />
      )}
    </LoginPrewarmContext.Provider>
  );
}
