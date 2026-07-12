// Per-platform User-Agent string for any WebView that loads real grocery
// store pages. Must reflect the device's actual OS version — a stale UA (e.g.
// hardcoded "iOS 17_0" on a phone running iOS 26.x, or "Android 16" on a phone
// running Android 13) mismatches the TLS-handshake fingerprint and gets
// flagged by aggressive WAFs (Imperva at HEB) as a spoofing automation client,
// which then serves Access Denied before any client JS runs.
//
// Android-specific hazard: the native Chromium WebView broadcasts its REAL
// Chromium major version in the Sec-CH-UA client-hint HTTP header on every
// request, regardless of the userAgent string we set. So if our UA advertises a
// different Chrome major than the device's actual WebView, the UA and the
// client hints disagree — itself a spoofing signal. (iOS WKWebView sends no
// client hints, so it has no such second channel.) We therefore detect the real
// major at runtime (WebViewVersionProbe reads the system WebView's default UA)
// and build the store UA from it, so UA and Sec-CH-UA always agree. The
// hardcoded ANDROID_CHROME_MAJOR is only a fallback for the brief window before
// the probe reports, and a floor if detection ever fails.
//
// The version mapping / UA construction lives in webview-user-agent-build.ts
// (pure + unit-tested). This module is the Platform glue + runtime-version state.

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
  // Platform.Version on Android is the numeric SDK API level (e.g. 36), not
  // the OS version string — map it to the marketing release in the builder.
  const apiLevel =
    typeof Platform.Version === 'number'
      ? Platform.Version
      : parseInt(String(Platform.Version), 10) || 36;
  const chromeMajor = runtimeAndroidChromeMajor ?? ANDROID_CHROME_MAJOR;
  return buildAndroidUA(apiLevel, chromeMajor);
}
