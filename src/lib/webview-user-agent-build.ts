// Pure builders for the WebView User-Agent string. Deliberately free of any
// react-native import so they are unit-testable in the node jest project; the
// Platform glue that picks iOS vs Android and reads the live device version
// lives in webview-user-agent.ts.
//
// Why this matters: a stale OS version in the UA mismatches the device's
// actual TLS-handshake fingerprint, and aggressive WAFs (Imperva at HEB) flag
// that mismatch as a spoofing automation client and serve Access Denied before
// any page JS runs. The iOS UA already derives its version from the device;
// these helpers do the same for Android.

// Android SDK API level (what Platform.Version returns on Android) → the
// marketing Android release that appears in a real Chrome WebView UA.
const API_TO_ANDROID_RELEASE: Record<number, string> = {
  24: '7',
  25: '7.1',
  26: '8',
  27: '8.1',
  28: '9',
  29: '10',
  30: '11',
  31: '12',
  32: '12',
  33: '13',
  34: '14',
  35: '15',
  36: '16',
};

const OLDEST_KNOWN_API = 24;
const NEWEST_KNOWN_API = 36;

export function androidReleaseFromApiLevel(apiLevel: number): string {
  const known = API_TO_ANDROID_RELEASE[apiLevel];
  if (known) return known;
  // Future levels we haven't mapped yet: from API 33 on, the release number
  // tracks (level - 20) — 33→13 … 36→16 — so extend that rule forward rather
  // than advertise a stale "16" on a newer OS we don't recognize.
  if (apiLevel > NEWEST_KNOWN_API) return String(apiLevel - 20);
  // Anything older than we support → conservative floor.
  return API_TO_ANDROID_RELEASE[OLDEST_KNOWN_API];
}

// Chrome major version baked into the Android WebView UA. RN cannot read the
// system WebView's real version, so this is a maintained constant. The system
// WebView auto-updates via Play, so most devices track close to current
// Chrome. Refresh this every few months; aim for "widely deployed", not
// bleeding edge, so we blend in rather than appear ahead of the rollout curve.
// Last refreshed: 2026-06 → Chrome 138.
export const ANDROID_CHROME_MAJOR = 138;

export function buildAndroidUA(apiLevel: number, chromeMajor: number = ANDROID_CHROME_MAJOR): string {
  const release = androidReleaseFromApiLevel(apiLevel);
  return `Mozilla/5.0 (Linux; Android ${release}; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Mobile Safari/537.36`;
}

export function buildIosUA(version: string): string {
  const cpuVer = version.replace(/\./g, '_');
  return `Mozilla/5.0 (iPhone; CPU iPhone OS ${cpuVer} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Mobile/15E148 Safari/604.1`;
}
