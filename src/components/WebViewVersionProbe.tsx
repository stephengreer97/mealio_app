import React, { useCallback, useState } from 'react';
import { Platform, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { setAndroidChromeMajor } from '../lib/webview-user-agent';

// Reads the system WebView's REAL Chromium major once at app start and feeds it
// to the store User-Agent builder, so our spoofed UA's Chrome/<major> matches
// the version the native WebView broadcasts in its Sec-CH-UA client-hint header.
// A mismatch between the two is a bot tell (see webview-user-agent.ts).
//
// Android-only: iOS WKWebView sends no client hints, so there's nothing to keep
// in sync there. Renders an invisible, ~zero-size WebView with NO userAgent
// override — so it carries the untouched system default UA (which contains the
// real "Chrome/<major>") — reads the version, reports it, then unmounts.

const PROBE_JS = `(function () {
  try {
    var major = '';
    var uad = navigator.userAgentData;
    if (uad && uad.brands) {
      for (var i = 0; i < uad.brands.length; i++) {
        var b = uad.brands[i];
        if (b && /Chromium/i.test(b.brand)) { major = String(b.version); break; }
      }
    }
    if (!major) {
      var m = /Chrome\\/(\\d+)/.exec(navigator.userAgent);
      if (m) major = m[1];
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({ chromeMajor: major }));
  } catch (e) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify({ error: String(e) })); } catch (_) {}
  }
})();
true;`;

export default function WebViewVersionProbe() {
  const [done, setDone] = useState(false);

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(e.nativeEvent.data || '{}');
      const major = parseInt(String(data.chromeMajor), 10);
      if (Number.isFinite(major) && major > 0) setAndroidChromeMajor(major);
    } catch {
      // ignore malformed payloads; UA falls back to the maintained constant
    }
    setDone(true); // one-shot: unmount after the first report
  }, []);

  if (Platform.OS !== 'android' || done) return null;

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', width: 1, height: 1, opacity: 0, left: -1000, top: -1000 }}
    >
      <WebView
        source={{ uri: 'about:blank' }}
        injectedJavaScript={PROBE_JS}
        onMessage={onMessage}
        javaScriptEnabled
        // Deliberately NO userAgent prop: we need the untouched system default UA.
      />
    </View>
  );
}
