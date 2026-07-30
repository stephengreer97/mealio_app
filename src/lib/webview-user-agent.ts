// Per-platform User-Agent string for any WebView that loads real grocery
// store pages. Nothing device-specific is hardcoded: on iOS the UA is built from
// the live OS version, and on Android it deliberately carries no device identity
// at all because that is what real Chrome does (UA reduction — see
// webview-user-agent-build.ts). A stale or invented iOS version in the UA
// mismatches the device and gets flagged by aggressive WAFs (Imperva at HEB) as a
// spoofing automation client.
//
// Android-specific hazard: the native Chromium WebView broadcasts its REAL
// Chromium major version in the Sec-CH-UA client-hint HTTP header on every
// request, regardless of the userAgent string we set. So if our UA advertises a
// different Chrome major than the device's actual WebView, the UA and the
// client hints disagree — itself a spoofing signal. (iOS WKWebView sends no
// client hints, so it has no such second channel.) We therefore detect the real
// major at runtime (WebViewVersionProbe reads the system WebView's default UA)
// and build the store UA from it, so UA and Sec-CH-UA always agree. The
// ANDROID_CHROME_MAJOR constant is only a fallback for the brief window before
// the probe reports, and a floor if detection ever fails.
//
// UA construction lives in webview-user-agent-build.ts (pure + unit-tested).
// This module is the Platform glue + runtime-version state.

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { buildAndroidUA, buildIosUA, ANDROID_CHROME_MAJOR } from './webview-user-agent-build';

const PERSIST_KEY = 'mealio.webviewChromeMajor';

// Real Android WebView Chromium major, detected at runtime. Null until the
// probe (or the persisted value) reports; getStoreWebViewUA falls back to the
// maintained constant in that window.
let runtimeAndroidChromeMajor: number | null = null;

// Best-effort hydrate of the last-detected major, so the first store WebView of
// a session already matches before the probe re-confirms. Async; the fallback
// constant covers the gap on a truly-first launch.
SecureStore.getItemAsync(PERSIST_KEY)
  .then((v) => {
    const n = v ? parseInt(v, 10) : NaN;
    if (runtimeAndroidChromeMajor == null && Number.isFinite(n) && n > 0) {
      runtimeAndroidChromeMajor = n;
    }
  })
  .catch(() => {});

// Called by WebViewVersionProbe once it reads the system WebView's real major.
export function setAndroidChromeMajor(major: number): void {
  if (!Number.isFinite(major) || major <= 0) return;
  runtimeAndroidChromeMajor = major;
  SecureStore.setItemAsync(PERSIST_KEY, String(major)).catch(() => {});
}

// The store WebView User-Agent. A function (not a module-load const) so it picks
// up the runtime-detected Android major once available. Platform.Version does
// not change at runtime, so the OS-version parts are still effectively static.
export function getStoreWebViewUA(): string {
  if (Platform.OS === 'ios') {
    // Platform.Version on iOS is the OS version string, e.g. "26.1".
    return buildIosUA(String(Platform.Version || '17.0'));
  }
  // Android: the UA carries no device identity at all (Chrome freezes it to
  // "Android 10; K" — see webview-user-agent-build.ts), so the OS version and
  // model are deliberately NOT read here. The real values reach the storefront
  // through the high-entropy client hints that the native patch fills in from
  // android.os.Build. The only runtime input is the WebView's real Chrome major.
  return buildAndroidUA(runtimeAndroidChromeMajor ?? ANDROID_CHROME_MAJOR);
}
