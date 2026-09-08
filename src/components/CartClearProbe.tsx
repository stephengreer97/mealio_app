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

interface Props {
  storeId: string;
  /** Passed to rails that support it, so a measurement need not empty a cart. */
  limit?: number;
  onDone: (result: Record<string, unknown> | { error: string }) => void;
}

export default function CartClearProbe({ storeId, limit, onDone }: Props) {
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
    if (!rail?.clearCart) {
      finish({ error: `no measured way to empty a ${storeId} cart` });
      return;
    }
    // Rails that take a limit read it off the second argument; the others
    // ignore it, which is why it is not on the interface.
    const script = (rail.clearCart as (s?: string | null, o?: { limit?: number }) => string | null)(
      storeId, limit ? { limit } : undefined,
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
            if (msg?.type === 'CART_CLEARED') finish(msg);
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
