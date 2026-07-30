import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
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
