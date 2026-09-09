// MEAL-7. A hidden WebView that empties (or measures emptying) one store's cart.
//
// WHY THIS EXISTS. `clearCart` was defined on four rails and CALLED BY NOTHING:
// four implementations, none of which had ever run. Code that has never executed
// is a hypothesis with good syntax, and the canary's cleanup step depends on it
// being more than that.
//
// Dev-only, and reached from Account behind `__DEV__`, so it is compiled out of
// every release build.
//
// MEASUREMENT MODE MATTERS. Walmart's removal semantics were never recorded, so
// the first run against a real cart passes `limit: 1` and touches one line
// rather than twenty. A store that ignores a zero answers 200 and leaves the
// line -- exactly what Albertsons does -- and only a re-read tells them apart,
// which is why every clear script re-reads and reports what is LEFT.

import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { getNetworkRail } from '../lib/webview-scripts/network-rail';
import { getStoreScripts } from '../lib/webview-scripts';
import { getStoreWebViewUA } from '../lib/webview-user-agent';
import { takeAddedIds, clearAddedIds } from '../lib/canary-added-ids';

interface Props {
  storeId: string;
  /**
   * Remove only what the last run(s) added, read from the store's remembered
   * list. The canary sets this; a measurement run leaves it off and empties.
   */
  scoped?: boolean;
  /**
   * RECOVERY MODE: put these lines back instead of taking anything out. Used
   * once, to undo a cleanup that removed the user's own groceries.
   */
  restore?: Array<{ sku: string; quantity: number }>;
  /** Passed to rails that support it, so a measurement need not empty a cart. */
  limit?: number;
  onDone: (result: Record<string, unknown> | { error: string }) => void;
}

export default function CartClearProbe({ storeId, limit, scoped, restore, onDone }: Props) {
  const webviewRef = useRef<WebView>(null);
  const doneRef = useRef(false);
  const [uri] = useState(() => {
    const scripts = getStoreScripts(storeId);
    // The STOREFRONT, not the quiet page: a cart write needs the session and,
    // on Walmart, the cart id that only the storefront's own localStorage has.
    return scripts?.storeUrl ?? 'about:blank';
  });

  const finish = (result: Record<string, unknown> | { error: string }) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(result);
  };

  useEffect(() => {
    const t = setTimeout(() => finish({ error: 'timed out waiting for CART_CLEARED' }), 90_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onLoadEnd = () => {
    if (doneRef.current) return;
    const rail = getNetworkRail(storeId);
    if (restore && restore.length) {
      // THROUGH THE RAIL, not by importing the store's module: this component is
      // shared, and a shared component that names one store is how store
      // knowledge leaks everywhere (storeBoundaries enforces it).
      const script = rail?.restoreLines?.(restore);
      if (!script) { finish({ error: `no measured way to restore ${storeId} lines` }); return; }
      setTimeout(() => webviewRef.current?.injectJavaScript(script), 1500);
      return;
    }
    if (!rail?.clearCart) {
      finish({ error: `no measured way to empty a ${storeId} cart` });
      return;
    }
    void (async () => {
      const only = scoped ? await takeAddedIds(storeId) : [];
      if (scoped && !only.length) {
        // NOT a fall-through to the unscoped clear. Nothing recorded and
        // "remove everything" must never be the same branch: the second empties
        // a real basket.
        finish({ ok: null, why: 'nothing recorded for this store to clean up' });
        return;
      }
      runClear(rail, only);
    })();
  };

  const runClear = (rail: NonNullable<ReturnType<typeof getNetworkRail>>, only: string[]) => {
    // Rails that take a limit read it off the second argument; the others
    // ignore it, which is why it is not on the interface.
    const script = (rail.clearCart as (
      s?: string | null, o?: { limit?: number; only?: string[] },
    ) => string | null)(
      storeId,
      (limit || only.length) ? { limit: limit || undefined, only: only.length ? only : undefined } : undefined,
    );
    if (!script) { finish({ error: 'rail returned no script' }); return; }
    setTimeout(() => webviewRef.current?.injectJavaScript(script), 1500);
  };

  return (
    <View style={{ position: 'absolute', left: 0, top: 0, width: 414, height: 896, opacity: 0.01 }} pointerEvents="none">
      <WebView
        ref={webviewRef}
        source={{ uri }}
        style={{ width: 414, height: 896 }}
        onLoadEnd={onLoadEnd}
        onMessage={(e) => {
          try {
            const msg = JSON.parse(e.nativeEvent.data);
            if (msg?.type === 'CART_CLEARED') {
              // Only once it actually cleared: a failed cleanup must stay owed,
              // or the next run's list would silently lose these lines.
              if (scoped && msg.ok === true) void clearAddedIds(storeId);
              finish(msg);
            }
          } catch { /* not ours */ }
        }}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        userAgent={getStoreWebViewUA()}
      />
    </View>
  );
}
