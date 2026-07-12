// DEV-ONLY WebView fingerprint shim.
//
// The Android emulator renders WebGL through the host GPU (when launched with
// `-gpu host`), but the driver still advertises itself with the literal string
// "Android Emulator OpenGL ES Translator" in the WebGL UNMASKED_RENDERER value.
// Aggressive storefront anti-bot systems (DataDome/PerimeterX/Imperva) treat
// that substring — and the older "Google SwiftShader" software fallback — as a
// hard automation signal and serve Access Denied before our page scripts run.
// That makes the emulator useless for iterating on cart-automation logic.
//
// This shim rewrites only the two UNMASKED_* WebGL parameters to the values a
// real Pixel 9 (the device our WebView User-Agent already claims — see
// webview-user-agent-build.ts) reports, so the fingerprint is internally
// consistent. It is deliberately NOT a general anti-detection tool:
//
//   * It is gated behind __DEV__ so production builds never inject it.
//   * It self-activates ONLY when it detects an emulator renderer string, so
//     running a debug build on a real device is a no-op (no risk of mangling a
//     genuine device's fingerprint).
//
// It must run as injectedJavaScriptBeforeContentLoaded so the override is in
// place before the storefront's anti-bot script reads WebGL.

// WebGL enum values (avoids needing a context to name them).
//   UNMASKED_VENDOR_WEBGL   = 0x9245 (37445)
//   UNMASKED_RENDERER_WEBGL = 0x9246 (37446)
//
// Pixel 9 = Tensor G4 = Mali-G715, reported through ANGLE by Chrome.
const SPOOF_VENDOR = 'Google Inc. (ARM)';
const SPOOF_RENDERER = 'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)';

const SHIM_SOURCE = `(function () {
  try {
    var UNMASKED_VENDOR = 37445;
    var UNMASKED_RENDERER = 37446;
    var SPOOF_VENDOR = ${JSON.stringify(SPOOF_VENDOR)};
    var SPOOF_RENDERER = ${JSON.stringify(SPOOF_RENDERER)};

    // Read the live renderer once to decide whether we are on an emulator.
    // On a real device this returns a genuine GPU string and we bail out.
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

// The shim string to inject, or '' in production / when disabled. Assign the
// result to injectedJavaScriptBeforeContentLoaded on the store WebViews.
export const WEBVIEW_FINGERPRINT_SHIM: string = __DEV__ ? SHIM_SOURCE : '';
