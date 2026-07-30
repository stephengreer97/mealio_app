// WebView fingerprint normalization for store WebViews.
//
// Two layers, both injected as injectedJavaScriptBeforeContentLoaded so they run
// before the storefront's anti-bot script:
//
//   1. PRODUCTION normalization (ships in all builds) — deliberately TINY.
//      Device identity is NOT handled here. The native react-native-webview patch
//      owns it: it sets UA Client Hints (brands, model, platformVersion) from
//      android.os.Build, which is the authoritative fix because native metadata is
//      real WebView configuration rather than JS tampering, so it cannot be
//      detected by a sensor probing for patched functions. Chrome's reduced UA
//      carries no device identity at all (frozen to "Android 10; K" — see
//      webview-user-agent-build.ts), so client hints are the only channel, and the
//      values there are the device's REAL ones. Consequently this layer must NOT
//      derive model/platformVersion from the UA: doing so would now inject the
//      frozen placeholders ("K" / "10.0.0") over the correct native values.
//      What remains is the one thing native can't express: navigator.webdriver.
//
//   2. DEV-ONLY emulator normalization (__DEV__ builds only). Self-activates only
//      when an emulator WebGL renderer is detected, so a debug build on a real
//      device is a complete no-op. The emulator is the only place we spoof, because
//      it is the only place the truth is wrong: an x86_64 QEMU guest with a
//      software GLES translator and a "sdk_gphone64_x86_64" model.
//
// Measured 2026-07: navigator.userAgentData is present and correctly populated on
// any SECURE context (https:// store pages, and http://localhost). It is absent
// ONLY on insecure/opaque origins such as about:blank, because NavigatorUAData is
// [SecureContext]-gated — a property of the context, NOT a WebView tell. (An
// earlier reading of "userAgentData is undefined" came from probing about:blank and
// was a measurement artifact.) iOS has no userAgentData and no Chrome UA, so this
// whole module no-ops there, leaving the working iOS path untouched.

// ── 1. Production normalization ─────────────────────────────────────────────
const PROD_FINGERPRINT_SOURCE = `(function () {
  try {
    // A real Chrome never reports webdriver true. Nothing else belongs here —
    // client hints are set natively from the real device (see header comment).
    if (navigator.webdriver) {
      Object.defineProperty(navigator, 'webdriver', { get: function () { return false; }, configurable: true });
    }
  } catch (e) {}
})();
true;`;

// ── 2. Dev-only emulator normalization ──────────────────────────────────────
// Covers the surfaces that differ ONLY on the x86_64 emulator:
//   • WebGL vendor/renderer strings + the numeric caps that must agree with them.
//   • navigator.platform (x86_64 → armv8l), hardwareConcurrency, languages — the
//     legacy surfaces client hints don't cover.
//   • The client-hint model, which natively (and correctly) reports the emulator's
//     real "sdk_gphone64_x86_64" — an instant tell, so dev overrides it.
//
// EMULATOR_SPOOF_MODEL should match the AVD's hardware profile so the claimed model
// stays consistent with the emulated screen geometry. It is referenced ONLY inside
// the emulator-gated branch, so no real device ever reports it.
const EMULATOR_SPOOF_MODEL = 'Pixel 8';
// Pixel 8 = Tensor G3 = Immortalis-G715, reported as "Mali-G715" through ANGLE by
// Chrome. Tensor G3 is 1x X3 + 4x A715 + 4x A510 = 9 cores.
const SPOOF_VENDOR = 'Google Inc. (ARM)';
const SPOOF_RENDERER = 'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)';
const SPOOF_CORES = 9;

const DEV_EMULATOR_SOURCE = `(function () {
  try {
    // ── Anti-tamper masking ────────────────────────────────────────────────
    // Imperva's Advanced Bot Protection sensor (the reese84 token at H-E-B) probes
    // for spoofing by calling Function.prototype.toString on the functions it is
    // about to trust: a real native method stringifies to "function x() { [native
    // code] }", while our replacements would reveal their JS source and expose the
    // spoof as tampering — worse than the tell we're hiding. Route toString through
    // a masking wrapper (itself masked, so it can't be caught by the same probe).
    var _natToString = Function.prototype.toString;
    var _masked = new WeakMap();
    function maskFn(fn, name) {
      try { _masked.set(fn, 'function ' + name + '() { [native code] }'); } catch (e) {}
      return fn;
    }
    var _patchedToString = function toString() {
      try { if (_masked.has(this)) return _masked.get(this); } catch (e) {}
      return _natToString.call(this);
    };
    maskFn(_patchedToString, 'toString');
    try { Function.prototype.toString = _patchedToString; } catch (e) {}

    // Redefine a property on its PROTOTYPE (where real Chrome defines it) rather
    // than as an own property of the instance — Object.getOwnPropertyNames(navigator)
    // showing extra own props is itself a spoof signal — and mask the getter.
    function defineOnProto(proto, prop, value) {
      try {
        var getter = function () { return value; };
        maskFn(getter, 'get ' + prop);
        Object.defineProperty(proto, prop, { get: getter, configurable: true, enumerable: true });
      } catch (e) {}
    }
    var UNMASKED_VENDOR = 37445;   // UNMASKED_VENDOR_WEBGL
    var UNMASKED_RENDERER = 37446; // UNMASKED_RENDERER_WEBGL
    var SPOOF_VENDOR = ${JSON.stringify(SPOOF_VENDOR)};
    var SPOOF_RENDERER = ${JSON.stringify(SPOOF_RENDERER)};
    var SPOOF_MODEL = ${JSON.stringify(EMULATOR_SPOOF_MODEL)};
    var SPOOF_CORES = ${SPOOF_CORES};
    // Numeric caps the emulator (software translator, 8192 / line 1..8191) reports
    // that a real Mali-G715 does not: Mali maxes textures/renderbuffers/viewport at
    // 16384 and supports only line width 1..1. Faking the RENDERER string without
    // these is itself a contradiction a WAF can catch, so align them too.
    var MAX_TEXTURE_SIZE = 3379, MAX_CUBE_MAP_TEXTURE_SIZE = 34076, MAX_RENDERBUFFER_SIZE = 34024;
    var ALIASED_LINE_WIDTH_RANGE = 33902, MAX_VIEWPORT_DIMS = 3386;

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

    // Dev evidence: stash the REAL (pre-spoof) GL identity + caps so FingerprintProbe
    // can report ground truth. Without this the probe only ever sees our own spoof,
    // so we can't tell whether the host GPU is actually being used.
    try {
      var c2 = document.createElement('canvas');
      var g2 = c2.getContext('webgl2') || c2.getContext('webgl');
      if (g2) {
        var d2 = g2.getExtension('WEBGL_debug_renderer_info');
        window.__mealioRealGL = {
          renderer: d2 ? String(g2.getParameter(d2.UNMASKED_RENDERER_WEBGL)) : '',
          vendor: d2 ? String(g2.getParameter(d2.UNMASKED_VENDOR_WEBGL)) : '',
          maxTex: g2.getParameter(g2.MAX_TEXTURE_SIZE),
          extCount: (g2.getSupportedExtensions() || []).length
        };
      }
    } catch (e) {}

    function patch(proto) {
      if (!proto || proto.__mealioFp) return;
      var orig = proto.getParameter;
      var patched = function getParameter(p) {
        if (p === UNMASKED_VENDOR) return SPOOF_VENDOR;
        if (p === UNMASKED_RENDERER) return SPOOF_RENDERER;
        if (p === MAX_TEXTURE_SIZE || p === MAX_CUBE_MAP_TEXTURE_SIZE || p === MAX_RENDERBUFFER_SIZE) return 16384;
        if (p === ALIASED_LINE_WIDTH_RANGE) return new Float32Array([1, 1]);
        if (p === MAX_VIEWPORT_DIMS) return new Int32Array([16384, 16384]);
        return orig.apply(this, arguments);
      };
      maskFn(patched, 'getParameter');
      proto.getParameter = patched;
      // Non-enumerable marker: a plain assignment would show up in for-in /
      // getOwnPropertyNames on the prototype as a foreign property.
      try { Object.defineProperty(proto, '__mealioFp', { value: true, enumerable: false, configurable: true }); } catch (e) {}
    }
    if (window.WebGLRenderingContext) patch(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);

    // Emulator-only navigator coherence. Real devices already report ARM and their
    // true core count, and never reach this (isEmulator gate above).
    var navProto = (window.Navigator && Navigator.prototype) || navigator;
    defineOnProto(navProto, 'platform', 'Linux armv8l');
    if (navigator.hardwareConcurrency !== SPOOF_CORES) defineOnProto(navProto, 'hardwareConcurrency', SPOOF_CORES);
    if (!navigator.languages || navigator.languages.length < 2) {
      defineOnProto(navProto, 'languages', Object.freeze(['en-US', 'en']));
    }

    // Client-hint model: natively (and correctly) reports the emulator's real
    // "sdk_gphone64_x86_64". Override to the AVD's profile so it matches the
    // emulated screen geometry. Emulator-only — on a real device the native value
    // is already the truth and is left completely alone.
    try {
      var uad = navigator.userAgentData;
      if (uad && typeof uad.getHighEntropyValues === 'function') {
        var origHEV = uad.getHighEntropyValues.bind(uad);
        var patchedHEV = function getHighEntropyValues(hints) {
          return origHEV(hints).then(function (v) {
            try { if (v && typeof v === 'object' && 'model' in v) v.model = SPOOF_MODEL; } catch (e) {}
            return v;
          });
        };
        maskFn(patchedHEV, 'getHighEntropyValues');
        try { uad.getHighEntropyValues = patchedHEV; }
        catch (e) { try { Object.defineProperty(uad, 'getHighEntropyValues', { value: patchedHEV, configurable: true }); } catch (e2) {} }
      }
    } catch (e) {}
  } catch (e) {}
})();
true;`;

// Production normalization always ships; the emulator layer is appended only in
// dev builds. Injected as injectedJavaScriptBeforeContentLoaded on store WebViews.
export const WEBVIEW_FINGERPRINT_SHIM: string =
  PROD_FINGERPRINT_SOURCE + '\n' + (__DEV__ ? DEV_EMULATOR_SOURCE : '');
