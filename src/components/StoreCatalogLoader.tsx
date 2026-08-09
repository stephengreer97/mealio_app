import { useEffect } from 'react';
import { storeCatalog } from '../lib/api';
import { loadStoreCatalog, getCatalogVersion, getStores } from '../lib/store-catalog';
import { secureStoreCatalogCache } from '../lib/store-catalog/store';

// Loads the remote store catalog so adding a grocery store is a database row
// rather than an App Store release (MEAL-23).
//
// Renders nothing — it exists purely to own the fetch's lifecycle. Unlike
// AutomationConfigLoader this sits OUTSIDE the auth tree and is not keyed on the
// user, because GET /api/stores is public: which stores exist is not a fact
// about an account. That matters for the signed-out deep link into a shared
// meal, which offers the same picker.
//
// One fetch per launch. There is no refresh-on-sign-in because the response
// does not vary by user, and a store published mid-session lands on the next
// cold start — the same latency the App Store release used to have, minus the
// release.
//
// Failure is a non-event by design: loadStoreCatalog never throws, and on any
// error the app keeps its cached (or bundled) list. There is deliberately no
// loading state and nothing gates on this — the picker must open instantly on a
// cold start with no network, showing the list that shipped in the binary.
export default function StoreCatalogLoader() {
  useEffect(() => {
    let cancelled = false;
    void loadStoreCatalog(storeCatalog.get, secureStoreCatalogCache).then(() => {
      if (cancelled) return;
      const version = getCatalogVersion();
      // Version 0 means nothing remote applied — either nothing has been
      // published or the fetch failed. Both are normal; logged so a device's
      // actual catalog is visible in a bug report's attached logs.
      console.log(
        `[store-catalog] active version: ${version || 'bundled list'} — ${getStores().length} store(s)`,
      );
    });
    return () => { cancelled = true; };
  }, []);

  return null;
}
