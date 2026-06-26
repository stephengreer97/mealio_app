// Per-platform User-Agent string for any WebView that loads real grocery
// store pages. Must reflect the device's actual OS version — a stale UA (e.g.
// hardcoded "iOS 17_0" on a phone running iOS 26.x, or "Android 16" on a phone
// running Android 13) mismatches the TLS-handshake fingerprint and gets
// flagged by aggressive WAFs (Imperva at HEB) as a spoofing automation client,
// which then serves Access Denied before any client JS runs.
//
// The version mapping / UA construction lives in webview-user-agent-build.ts
// (pure + unit-tested). This module is just the Platform glue.
//
// Computed once at module load; Platform.Version does not change at runtime.

import { Platform } from 'react-native';
import { buildAndroidUA, buildIosUA } from './webview-user-agent-build';

export const STORE_WEBVIEW_UA: string = (() => {
  if (Platform.OS === 'ios') {
    // Platform.Version on iOS is the OS version string, e.g. "26.1".
    return buildIosUA(String(Platform.Version || '17.0'));
  }
  // Platform.Version on Android is the numeric SDK API level (e.g. 36), not
  // the OS version string — map it to the marketing release in the builder.
  const apiLevel =
    typeof Platform.Version === 'number'
      ? Platform.Version
      : parseInt(String(Platform.Version), 10) || 36;
  return buildAndroidUA(apiLevel);
})();
