// Pure builders for the WebView User-Agent string. Deliberately free of any
// react-native import so they are unit-testable in the node jest project; the
// Platform glue that picks iOS vs Android and reads the live device version
// lives in webview-user-agent.ts.
//
// ── Android: the UA carries NO device identity, by design ────────────────────
// Since "User-Agent Reduction" (fully shipped by Chrome ~110), real Chrome on
// Android FREEZES the device-identifying parts of the UA: the Android version is
// always the literal "10" and the device model is always the literal "K",
// regardless of the actual hardware. Per Chrome's own documentation the reduced
// string is exactly:
//
//   Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko)
//   Chrome/<major>.0.0.0 Mobile Safari/537.36
//
// So advertising a real ("Android 16; Pixel 8") or invented device in the UA is
// itself an automation tell: no real Chrome has sent that shape for years. We
// therefore send the frozen string and let the REAL device identity travel where
// Chrome actually puts it — the high-entropy UA Client Hints (model,
// platformVersion), which the native react-native-webview patch fills in from
// android.os.Build. That split means:
//
//   • Nothing device-specific is hardcoded here, and nothing needs to be: the UA
//     is byte-identical on every Android device, which is exactly what Chrome does.
//   • The device identity IS fully dynamic — it comes from Build.MODEL /
//     Build.VERSION.RELEASE at runtime, not from a table in this file.
//
// The only dynamic part of the Android UA is the Chrome major version, which must
// match the WebView's real Chromium build (WebViewVersionProbe detects it at
// runtime) because the native layer broadcasts that real version in the Sec-CH-UA
// header on every request — a UA/client-hint disagreement is a spoofing signal.

// Frozen device identity in the reduced Chrome-on-Android UA. These are protocol
// constants defined by Chrome's UA reduction, NOT a claim about this device — every
// real Chrome on every Android phone sends these exact two values.
const FROZEN_ANDROID_RELEASE = '10';
const FROZEN_ANDROID_MODEL = 'K';

// Last-resort fallback for the Chrome major, used only in the brief window before
// WebViewVersionProbe reports the WebView's real Chromium version (and if that
// detection ever fails). Keep it "widely deployed" rather than bleeding edge so we
// blend in rather than appear ahead of the rollout curve. Refresh occasionally.
// Last refreshed: 2026-06 → Chrome 138.
export const ANDROID_CHROME_MAJOR = 138;

export function buildAndroidUA(chromeMajor: number = ANDROID_CHROME_MAJOR): string {
  const major = Number.isFinite(chromeMajor) && chromeMajor > 0 ? Math.floor(chromeMajor) : ANDROID_CHROME_MAJOR;
  return (
    `Mozilla/5.0 (Linux; Android ${FROZEN_ANDROID_RELEASE}; ${FROZEN_ANDROID_MODEL}) ` +
    `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
  );
}

export function buildIosUA(version: string): string {
  // iOS Safari does NOT freeze its UA the way Chrome-on-Android does — it still
  // reports the real OS version — so this stays derived from the live device.
  // Real Mobile Safari reports only major.minor (e.g. "17.5", never the "17.5.1"
  // patch), so trim any patch component and pad a bare major to major.minor.
  // A patch digit / missing minor in the UA is a small automation tell, and
  // Platform.Version can hand us either form.
  const parts = version.split('.');
  const mm = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : `${parts[0] || '17'}.0`;
  const cpuVer = mm.replace(/\./g, '_');
  return `Mozilla/5.0 (iPhone; CPU iPhone OS ${cpuVer} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${mm} Mobile/15E148 Safari/604.1`;
}
