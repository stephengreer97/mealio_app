import React, { useCallback, useState } from 'react';
import { Platform, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { getStoreWebViewUA } from '../lib/webview-user-agent';
import { WEBVIEW_FINGERPRINT_SHIM } from '../lib/webview-fingerprint-shim';

// DEV-ONLY fingerprint probe. Mounts a hidden WebView carrying the SAME store
// User-Agent and the SAME before-content fingerprint shim that the real store
// WebViews use, then dumps every high-signal fingerprint surface a WAF can read
// (WebGL depth, canvas/audio hashes, navigator.platform/arch, hardwareConcurrency,
// client hints, WebRTC ICE candidates). It emits a single compact JSON line via
// console.log (readable in `adb logcat -s chromium`) and postMessage.
//
// Big surfaces (WebGL extension list, canvas pixels, audio buffer) are hashed to
// a short djb2 hex so the whole blob fits in one logcat line. Compare the emulator
// dump against a real device (or a known-good desktop Chrome) to see the exact
// tells. Delete this component + its App.tsx mount once the tells are closed.

// Where the probe loads. 'about:blank' makes no network request (good default), but
// see the caveat at the <WebView> below: secure-context APIs are absent there.
// Swap to 'http://localhost:8099/' (with the echo server running) to measure client
// hints and raw request headers.
const PROBE_URL = 'about:blank';

const PROBE_JS = `(function () {
  function h(s){var x=5381;for(var i=0;i<s.length;i++){x=((x<<5)+x+s.charCodeAt(i))|0;}return (x>>>0).toString(16);}
  var out = { t: 'MEALIO_FP' };
  function safe(fn){ try { return fn(); } catch(e){ return 'ERR:'+String(e && e.message || e); } }

  out.ua = safe(function(){ return navigator.userAgent; });
  out.platform = safe(function(){ return navigator.platform; });
  out.hwc = safe(function(){ return navigator.hardwareConcurrency; });
  out.devmem = safe(function(){ return navigator.deviceMemory; });
  out.maxTouch = safe(function(){ return navigator.maxTouchPoints; });
  out.lang = safe(function(){ return navigator.language; });
  out.langs = safe(function(){ return (navigator.languages||[]).join(','); });
  out.vendor = safe(function(){ return navigator.vendor; });
  out.webdriver = safe(function(){ return navigator.webdriver; });
  out.screen = safe(function(){ return [screen.width, screen.height, screen.availWidth, screen.availHeight, window.devicePixelRatio, screen.colorDepth].join('/'); });
  out.intl = safe(function(){ var r = Intl.DateTimeFormat().resolvedOptions(); return r.timeZone + '|' + r.locale; });

  // WebGL depth (this is what the string-only spoof leaves inconsistent).
  out.gl = safe(function(){
    var c = document.createElement('canvas');
    var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return 'no-webgl';
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    var uv = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '';
    var ur = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    var exts = (gl.getSupportedExtensions() || []);
    var prec = '';
    try { var p = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT); prec = p ? (p.precision+'/'+p.rangeMin+'/'+p.rangeMax) : ''; } catch(e){}
    return {
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: String(uv),
      unmaskedRenderer: String(ur),
      version: gl.getParameter(gl.VERSION),
      glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      lineWidth: (function(){ try { return Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE)).join(','); } catch(e){ return ''; } })(),
      extCount: exts.length,
      extHash: h(exts.join(',')),
      prec: prec,
      isGL2: (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext)
    };
  });

  // Canvas 2D pixel hash.
  // Ground truth stashed by the dev shim BEFORE it spoofed anything (emulator only).
  out.realGL = safe(function(){ return window.__mealioRealGL || 'not-stashed'; });

  // Anti-tamper self-check: everything here must look untouched to a bot sensor.
  out.tamper = safe(function(){
    var r = {};
    try { r.getParamTS = String(WebGLRenderingContext.prototype.getParameter); } catch(e){ r.getParamTS='ERR'; }
    try { r.toStringTS = String(Function.prototype.toString); } catch(e){ r.toStringTS='ERR'; }
    try {
      var d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
      r.platformGetterTS = d && d.get ? String(d.get) : 'no-getter';
    } catch(e){ r.platformGetterTS='ERR'; }
    // Foreign OWN props on the navigator instance are a spoof tell; should be [].
    try { r.navOwnProps = Object.getOwnPropertyNames(navigator).join(',') || '(none)'; } catch(e){ r.navOwnProps='ERR'; }
    return r;
  });

  out.canvasHash = safe(function(){
    var c = document.createElement('canvas'); c.width = 240; c.height = 60;
    var ctx = c.getContext('2d');
    ctx.textBaseline = 'top'; ctx.font = '14px Arial';
    ctx.fillStyle = '#f60'; ctx.fillRect(0,0,120,30);
    ctx.fillStyle = '#069'; ctx.fillText('Mealio \\uD83D\\uDED2 fp 1.0', 4, 4);
    ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.fillText('Mealio \\uD83D\\uDED2 fp 1.0', 6, 6);
    return h(c.toDataURL());
  });

  // Client hints (async).
  var pUAD = safe(function(){
    var uad = navigator.userAgentData;
    if (!uad || !uad.getHighEntropyValues) return Promise.resolve({ brands: (uad && uad.brands || []).map(function(b){return b.brand+' '+b.version;}).join(';'), mobile: uad && uad.mobile });
    return uad.getHighEntropyValues(['model','platform','platformVersion','uaFullVersion','architecture','bitness','fullVersionList','wow64']).then(function(v){
      return {
        brands: (uad.brands||[]).map(function(b){return b.brand+' '+b.version;}).join(';'),
        mobile: uad.mobile, model: v.model, platform: v.platform, platformVersion: v.platformVersion,
        uaFullVersion: v.uaFullVersion, architecture: v.architecture, bitness: v.bitness,
        fullVersionList: (v.fullVersionList||[]).map(function(b){return b.brand+' '+b.version;}).join(';')
      };
    }).catch(function(e){ return 'ERR:'+String(e); });
  });
  if (!pUAD || !pUAD.then) pUAD = Promise.resolve(pUAD);

  // AudioContext hash (async).
  var pAudio = new Promise(function(resolve){
    try {
      var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OAC) return resolve('no-audioctx');
      var ac = new OAC(1, 44100, 44100);
      var osc = ac.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
      var comp = ac.createDynamicsCompressor();
      osc.connect(comp); comp.connect(ac.destination); osc.start(0);
      ac.startRendering();
      ac.oncomplete = function(e){
        try { var d = e.renderedBuffer.getChannelData(0); var s = 0; for (var i=4000;i<5000;i++){ s += Math.abs(d[i]); } resolve(h(String(s))); }
        catch(err){ resolve('ERR:'+String(err)); }
      };
    } catch(e){ resolve('ERR:'+String(e)); }
  });

  // WebRTC ICE candidate IPs (async) — reveals mDNS obfuscation vs raw 10.0.2.x leak.
  var pRtc = new Promise(function(resolve){
    try {
      var RPC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (!RPC) return resolve('no-webrtc');
      var pc = new RPC({ iceServers: [] });
      var cands = [];
      pc.createDataChannel('x');
      pc.onicecandidate = function(e){
        if (!e.candidate) { done(); return; }
        var c = e.candidate.candidate || '';
        var m = /([0-9a-f]+\\.local|\\d{1,3}(?:\\.\\d{1,3}){3}|[0-9a-f:]{6,})/i.exec(c);
        if (m) cands.push(m[1]);
      };
      var settled = false;
      function done(){ if (settled) return; settled = true; resolve(cands.length ? cands.join(',') : 'none'); }
      pc.createOffer().then(function(o){ return pc.setLocalDescription(o); }).catch(function(e){ resolve('ERR:'+String(e)); });
      setTimeout(done, 1200);
    } catch(e){ resolve('ERR:'+String(e)); }
  });

  Promise.all([pUAD, pAudio, pRtc]).then(function(r){
    out.uaData = r[0]; out.audioHash = r[1]; out.webrtc = r[2];
    var json = JSON.stringify(out);
    try { console.log('MEALIO_FP ' + json); } catch(e){}
    try { window.ReactNativeWebView.postMessage(json); } catch(e){}
  });
})();
true;`;

export default function FingerprintProbe() {
  const [done, setDone] = useState(false);

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    // Also surface via RN console so it lands in Metro if logcat is noisy.
    console.log('MEALIO_FP', e.nativeEvent.data);
    setDone(true);
  }, []);

  // Android-only. Two reasons, and the first is a hard crash:
  //   1. react-native-webview 13.15.0's visitSource treats any source URL with no
  //      host as a FILE url and calls -[WKWebView loadFileURL:], so an about:blank
  //      source on iOS throws "about:blank is not a file URL" and crashes the app
  //      on launch. (Android's WebView loads about:blank fine.)
  //   2. The probe's whole purpose is inspecting the Android emulator's spoofed
  //      fingerprint; the shim no-ops on iOS, so there's nothing to measure here.
  if (!__DEV__ || done || Platform.OS !== 'android') return null;

  return (
    <View pointerEvents="none" style={{ position: 'absolute', width: 1, height: 1, opacity: 0, left: -1000, top: -1000 }}>
      <WebView
        // CAVEAT: about:blank is an INSECURE/opaque origin, so [SecureContext]-gated
        // APIs are absent here — navigator.userAgentData reads as undefined even
        // though it is present and correct on real https:// store pages. Do NOT
        // conclude anything about client hints from a run against this default.
        //
        // To measure client hints AND the exact HTTP headers a WAF sees, run the
        // local echo server (scratchpad/echo_server.py), expose it with
        // `adb reverse tcp:8099 tcp:8099`, and switch this to
        // 'http://localhost:8099/' — localhost DOES count as a secure context.
        source={{ uri: PROBE_URL }}
        userAgent={getStoreWebViewUA()}
        injectedJavaScriptBeforeContentLoaded={Platform.OS === 'android' ? WEBVIEW_FINGERPRINT_SHIM : undefined}
        injectedJavaScript={PROBE_JS}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
      />
    </View>
  );
}
