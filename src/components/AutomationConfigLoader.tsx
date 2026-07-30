import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { automation } from '../lib/api';
import { loadAutomationConfig, getConfigVersion } from '../lib/automation-config';
import { secureStoreConfigCache } from '../lib/automation-config/store';

// Loads the remote automation config (store selectors, URLs, timeouts, flags) so
// a storefront change becomes a config push instead of an App Store release.
//
// Renders nothing — it exists purely to own the fetch's lifecycle inside the auth
// tree. Keyed on the user because /api/automation/config requires a token: firing
// before sign-in would just 401 and fall back to the bundled defaults, which is
// safe but pointless. Reloading on sign-in also means a user who was signed out
// while a config fix shipped picks it up as soon as they're back.
//
// Failure is a non-event by design: loadAutomationConfig never throws, and on any
// error the app keeps its cached (or bundled) config. There is deliberately no
// loading state and nothing gates on this — a config-server outage must never
// prevent someone from building a cart.
export default function AutomationConfigLoader() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void loadAutomationConfig(automation.getConfig, secureStoreConfigCache).then(() => {
      if (cancelled) return;
      const version = getConfigVersion();
      // Version 0 means nothing remote applied — either no push has been made or
      // the fetch failed. Both are normal; logged so a device's actual config
      // version is visible in a bug report's attached logs.
      console.log(`[automation-config] active version: ${version || 'bundled defaults'}`);
    });
    return () => { cancelled = true; };
  }, [user?.id]);

  return null;
}
