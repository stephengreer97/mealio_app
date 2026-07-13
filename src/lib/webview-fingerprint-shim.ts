// WebView fingerprint normalization for store WebViews.
//
// Two layers, both injected as injectedJavaScriptBeforeContentLoaded so they run
// before the storefront's anti-bot script:
//
//   1. PRODUCTION Android fingerprint normalization (ships in all builds).
//      Aggressive WAFs (Imperva at H-E-B) block our Android WebView while the
//      SAME automation on iOS (WKWebView) passes on the SAME IP — so it's a
//      client-fingerprint gap, not IP/behavior. We already align the UA version
//      and the Sec-CH-UA brand (Chromium + Google Chrome, via the native
//      react-native-webview patch). The remaining measured tell: when an
//      overridden UA is set, the Android WebView returns EMPTY high-entropy
//      client hints — getHighEntropyValues() gives model:"" and
//      platformVersion:"" — even though the UA names a "Pixel 9". A real Pixel 9
//      Chrome returns model:"Pixel 9" / platformVersion:"16.0.0". That mismatch
//      is a strong automation signal, and it's JS-readable (Imperva's challenge
//      script calls getHighEntropyValues), so we fix it here. iOS has no
//      userAgentData, so this whole layer no-ops there (leaving the working iOS
//      path untouched). On the first storefront hit the high-entropy HTTP
//      headers aren't sent yet (no prior Accept-CH), so the JS API is the only
//      surface that leaks model — which is exactly what this patches.
//
//   2. DEV-ONLY emulator WebGL spoof (__DEV__ builds only). The Android emulator
//      advertises "Android Emulator OpenGL ES Translator" in WebGL
//      UNMASKED_RENDERER, an instant automation tell. Self-activates only when
//      an emulator renderer is detected, so a debug build on a real device is a
//      no-op. Lets us iterate against real WAFs on the emulator.

// ── 1. Production Android fingerprint normalization ─────────────────────────
const PROD_FINGERPRINT_SOURCE = `(function () {
  try {
    var uad = navigator.userAgentData;
    if (!uad) return; // iOS / non-Chromium: no client hints to normalize.
    var ua = navigator.userAgent || '';
    var mModel = /Android [^;]+; ([^)]+)\\)/.exec(ua);
    var model = mModel ? mModel[1].trim() : '';
    var mVer = /Android (\\d+(?:\\.\\d+)*)/.exec(ua);
    var platformVersion = mVer ? mVer[1].split('.').concat(['0', '0']).slice(0, 3).join('.') : '';
    var mChrome = /Chrome\\/(\\d+(?:\\.\\d+)*)/.exec(ua);
    var full = mChrome ? mChrome[1].split('.').concat(['0', '0', '0']).slice(0, 4).join('.') : '';

    if (typeof uad.getHighEntropyValues === 'function') {
      var orig = uad.getHighEntropyValues.bind(uad);
      var patched = function (hints) {
        return orig(hints).then(function (v) {
          try {
            if (model) v.model = model;
            if (platformVersion) v.platformVersion = platformVersion;
            if (full) v.uaFullVersion = full;
            if (full && Array.isArray(v.fullVersionList)) {
              v.fullVersionList = v.fullVersionList.map(function (b) {
                return /Chromium|Google Chrome/i.test(b.brand) ? { brand: b.brand, version: full } : b;
              });
            }
          } catch (e) {}
          return v;
        });
      };
      try { uad.getHighEntropyValues = patched; }
      catch (e) { try { Object.defineProperty(uad, 'getHighEntropyValues', { value: patched, configurable: true }); } catch (e2) {} }
    }

    // A real Chrome never reports webdriver true.
    try {
      if (navigator.webdriver) {
        Object.defineProperty(navigator, 'webdriver', { get: function () { return false; }, configurable: true });
      }
    } catch (e) {}
  } catch (e) {}
})();
true;`;

// ── 2. Dev-only emulator WebGL spoof ────────────────────────────────────────
// Pixel 9 = Tensor G4 = Mali-G715, reported through ANGLE by Chrome.
const SPOOF_VENDOR = 'Google Inc. (ARM)';
const SPOOF_RENDERER = 'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)';

const DEV_WEBGL_SOURCE = `(function () {
  try {
    var UNMASKED_VENDOR = 37445;   // UNMASKED_VENDOR_WEBGL
    var UNMASKED_RENDERER = 37446; // UNMASKED_RENDERER_WEBGL
    var SPOOF_VENDOR = ${JSON.stringify(SPOOF_VENDOR)};
    var SPOOF_RENDERER = ${JSON.stringify(SPOOF_RENDERER)};

    var live = '';
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) live = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
      }
    } catch (e) {}

    var isEmulator = /Android Emulator|SwiftShader|ATI Technologies|OpenGL ES Translator/i.test(live);
    if (!isEmulator) return;

    function patch(proto) {
      if (!proto || proto.__mealioFp) return;
      var orig = proto.getParameter;
      proto.getParameter = function (p) {
        if (p === UNMASKED_VENDOR) return SPOOF_VENDOR;
        if (p === UNMASKED_RENDERER) return SPOOF_RENDERER;
        return orig.apply(this, arguments);
      };
      proto.__mealioFp = true;
    }
    if (window.WebGLRenderingContext) patch(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);
  } catch (e) {}
})();
true;`;

// Production fingerprint normalization always ships; the emulator WebGL spoof is
// appended only in dev builds. Injected as injectedJavaScriptBeforeContentLoaded
// on the store WebViews.
export const WEBVIEW_FINGERPRINT_SHIM: string =
  PROD_FINGERPRINT_SOURCE + '\n' + (__DEV__ ? DEV_WEBGL_SOURCE : '');
