import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { storeCatalog } from '../lib/api';
import { loadStoreCatalog, getCatalogVersion, getStores } from '../lib/store-catalog';
import { secureStoreCatalogCache } from '../lib/store-catalog/store';

// Loads the remote store catalog so adding a grocery store is a database row
// rather than an App Store release (MEAL-23).
//
// Renders nothing — it exists purely to own the fetch's lifecycle inside the
// auth tree, the same way AutomationConfigLoader does, and for the same reasons:
// /api/stores/catalog needs a token, so firing before sign-in would only 401,
// and reloading on sign-in means a user who was signed out when a store was
// published picks it up as soon as they're back.
//
// Failure is a non-event by design: loadStoreCatalog never throws, and on any
// error the app keeps its cached (or bundled) list. There is deliberately no
// loading state and nothing gates on this — the picker must open instantly on a
// cold start with no network, showing the list that shipped in the binary.
export default function StoreCatalogLoader() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
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
  }, [user?.id]);

  return null;
}
