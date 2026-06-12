// Per-platform User-Agent string for any WebView that loads real grocery
// store pages. Must reflect the device's actual iOS version — a stale UA
// (e.g. hardcoded "iOS 17_0" on a phone running iOS 26.x) mismatches the
// TLS handshake fingerprint and gets flagged by aggressive WAFs (Imperva
// at HEB) as a spoofing automation client, which then serves Access Denied
// before any client JS runs.
//
// Computed once at module load; Platform.Version does not change at runtime.

import { Platform } from 'react-native';

export const STORE_WEBVIEW_UA: string = (() => {
  if (Platform.OS === 'ios') {
    const v = String(Platform.Version || '17.0');
    const cpuVer = v.replace(/\./g, '_');
    return `Mozilla/5.0 (iPhone; CPU iPhone OS ${cpuVer} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v} Mobile/15E148 Safari/604.1`;
  }
  // Android UA is still static — Platform.Version on Android returns the
  // SDK API level (a number), not the OS version string, and Chrome WebView's
  // version is not exposed by RN. Dynamic Android UA is tracked separately.
  // Refreshed periodically; aim is "currently widely deployed", not bleeding
  // edge, so we blend in rather than appear ahead of the rollout curve.
  return 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';
})();
