// MEAL-7. A VISIBLE storefront WebView that reports every API call the site
// makes, so a route can be WATCHED rather than guessed at.
//
// WHY THIS EXISTS. The Wegmans add route was found by watching the site; every
// guessed variant ("/carts/{id}", "/carts/items", PUT, PATCH) came back as a
// bare "Failed to fetch", because that gateway rejects an unknown route before
// it adds CORS headers. So a wrong guess and an unreachable host look identical
// from inside the page, and guessing cannot converge.
//
// The removal call is the same problem again: quantity 0 answers 500 where the
// identical body with a 1 answers 200, so the shape is right and the ROUTE is
// something else. This probe loads the real cart in the real signed-in session
// the rails already use, and prints what the page itself sends when someone taps
// the bin icon.
//
// Dev-only, reached from Account behind `__DEV__`.

import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { getStoreScripts } from '../lib/webview-scripts';
import { getStoreWebViewUA } from '../lib/webview-user-agent';

interface Props {
  storeId: string;
  /** Where to start. Defaults to the store's own storefront. */
  path?: string;
  /**
   * Run with the WebView's OWN User-Agent instead of our spoofed Chrome one.
   *
   * THE LAST VARIABLE between our client and the Chrome that works. Android's
   * WebView identifies itself in its default UA with a "; wv" token, and
   * getStoreWebViewUA strips it so we read as Chrome. The environment does not
   * change with the string: Imperva's challenge runs IN the page and can see
   * what it is running in, so a UA claiming Chrome inside a WebView is a
   * mismatch rather than a disguise.
   *
   * Setting this tells the truth instead, which is the only way to find out
   * whether the disguise is what is being refused.
   */
  honestUa?: boolean;
  onClose: () => void;
}

interface Seen {
  method: string;
  url: string;
  body: string | null;
  status: number | null;
  /** Request header NAMES the site sent. Values are never reported: an auth
   *  header is the session, and this panel is a log. */
  headers?: string[] | null;
}

// Hooks fetch AND XMLHttpRequest before any page script runs. Written without
// backticks or backslashes: this is a template literal, and both die in it.
const CAPTURE = `
(function () {
  if (window.__mealioCap) return;
  window.__mealioCap = true;
  var post = function (o) {
    o.type = 'NET_SEEN';
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };
  var interesting = function (u) {
    u = String(u || '');
    if (u.indexOf('/commerce/') !== -1) return true;
    if (u.indexOf('cart') !== -1) return true;
    if (u.indexOf('lineitem') !== -1) return true;
    // THE GATEWAY ITSELF. Added 2026-09-11 for the H-E-B question: when our own
    // request to /graphql is refused and the same store works in Chrome, the
    // thing worth watching is what the SITE sends to the identical endpoint from
    // inside this same WebView.
    if (u.indexOf('/graphql') !== -1) return true;
    return false;
  };
  // HEADER NAMES, NEVER VALUES. Which headers the site sends is the question;
  // what is in them is the session.
  var namesOf = function (h) {
    var out = [];
    try {
      if (!h) return out;
      if (typeof h.forEach === 'function' && typeof h.get === 'function') {
        h.forEach(function (_v, k) { out.push(String(k).toLowerCase()); });
        return out.sort();
      }
      if (Array.isArray(h)) {
        for (var i = 0; i < h.length; i++) if (h[i] && h[i][0]) out.push(String(h[i][0]).toLowerCase());
        return out.sort();
      }
      for (var k2 in h) if (Object.prototype.hasOwnProperty.call(h, k2)) out.push(String(k2).toLowerCase());
    } catch (e) {}
    return out.sort();
  };
  var bodyOf = function (b) {
    if (b == null) return null;
    try { return typeof b === 'string' ? b.slice(0, 1200) : JSON.stringify(b).slice(0, 1200); }
    catch (e) { return '[unserialisable]'; }
  };
  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = (input && input.url) ? input.url : String(input);
    var method = (init && init.method) || (input && input.method) || 'GET';
    var body = bodyOf(init && init.body);
    // A Request object carries its own headers; an init object carries them too.
    var hdrs = namesOf((init && init.headers) || (input && input.headers));
    return realFetch.apply(this, arguments).then(function (r) {
      if (interesting(url)) post({ via: 'fetch', method: method, url: url, body: body, status: r.status, headers: hdrs });
      return r;
    }, function (e) {
      if (interesting(url)) post({ via: 'fetch', method: method, url: url, body: body, status: null, headers: hdrs, failed: String(e).slice(0, 80) });
      throw e;
    });
  };
  var RealXHR = window.XMLHttpRequest;
  if (RealXHR) {
    var open = RealXHR.prototype.open;
    var send = RealXHR.prototype.send;
    var setH = RealXHR.prototype.setRequestHeader;
    RealXHR.prototype.open = function (m, u) { this.__m = m; this.__u = u; this.__h = []; return open.apply(this, arguments); };
    RealXHR.prototype.setRequestHeader = function (k) {
      try { (this.__h = this.__h || []).push(String(k).toLowerCase()); } catch (e) {}
      return setH.apply(this, arguments);
    };
    RealXHR.prototype.send = function (b) {
      var self = this;
      this.addEventListener('loadend', function () {
        if (interesting(self.__u)) {
          post({ via: 'xhr', method: self.__m, url: self.__u, body: bodyOf(b), status: self.status,
                 headers: (self.__h || []).slice().sort() });
        }
      });
      return send.apply(this, arguments);
    };
  }
})(); true;
`;

export default function StorefrontCaptureProbe({ storeId, path, honestUa, onClose }: Props) {
  const webviewRef = useRef<WebView>(null);
  const [seen, setSeen] = useState<Seen[]>([]);
  const [uri] = useState(() => {
    const scripts = getStoreScripts(storeId);
    const base = scripts?.storeUrl ?? 'about:blank';
    if (!path) return base;
    try { return new URL(path, base).toString(); } catch { return base; }
  });

  // Writes come first: a GET poll can bury the one POST that matters.
  const writes = seen.filter((s) => s.method && s.method.toUpperCase() !== 'GET');

  return (
    // A MODAL, not an absolute View. Account renders this inside its ScrollView,
    // where `top: 0` is the top of the scrolled CONTENT rather than the screen --
    // so the header with these controls sat above the viewport and could not be
    // tapped at all, while the WebView below it looked perfectly fine.
    <Modal visible transparent={false} animationType="none" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: '#fff', paddingTop: 34 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 10, gap: 12 }}>
        <Pressable onPress={onClose} style={{ paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#eee', borderRadius: 6 }}>
          <Text>Close</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            // The console is the transcript: the panel below can only show so
            // much, and the body is the part that matters.
            console.log('[NetCapture]', storeId, JSON.stringify(writes.slice(-6)));
          }}
          style={{ paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#eee', borderRadius: 6 }}
        >
          <Text>Dump writes ({writes.length})</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            // CLICK IT FROM THE PAGE. adb taps do not reach this WebView's web
            // content, and the point is not the gesture -- it is the site's own
            // handler running and making its own request. aria-label is how the
            // cart names the bin: "Remove <product> from the cart" for a line at
            // quantity 1, versus "Remove 1 ea from N ea of ..." for a decrement.
            webviewRef.current?.injectJavaScript(
              "(function(){var b=document.querySelector('[aria-label^=\"Remove \"][aria-label$=\" from the cart\"]');" +
              "if(!b){window.ReactNativeWebView.postMessage(JSON.stringify({type:'NET_SEEN',method:'NOTE',url:'no remove button found',body:null,status:null}));return;}" +
              "window.ReactNativeWebView.postMessage(JSON.stringify({type:'NET_SEEN',method:'NOTE',url:'clicking '+b.getAttribute('aria-label'),body:null,status:null}));" +
              "b.click();})(); true;",
            );
          }}
          style={{ paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#fdd', borderRadius: 6 }}
        >
          <Text>Click remove</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            // THE STORE THE COOKIE SWEEP CANNOT REACH.
            //
            // Imperva's challenge script keeps state in the page's own
            // localStorage as well as in cookies, and store-session-epoch.ts
            // already records that localStorage survives
            // CookieManager.clearAll. So a jar swept clean of reese84,
            // incap_ses, visid_incap, nlbi AND _iidt can still present a device
            // verdict this app has no other way to drop -- which is exactly the
            // shape of a 403 that outlived every cookie we know how to clear.
            webviewRef.current?.injectJavaScript(
              '(function(){var n=0;' +
              'try{n+=localStorage.length;localStorage.clear();}catch(e){}' +
              'try{n+=sessionStorage.length;sessionStorage.clear();}catch(e){}' +
              'try{if(indexedDB&&indexedDB.databases){indexedDB.databases().then(function(d){' +
              'for(var i=0;i<d.length;i++){try{indexedDB.deleteDatabase(d[i].name);}catch(e){}}});}}catch(e){}' +
              "window.ReactNativeWebView.postMessage(JSON.stringify({type:'NET_SEEN',method:'NOTE'," +
              "url:'cleared '+n+' storage keys, reloading',body:null,status:null}));" +
              'setTimeout(function(){location.reload();},300);})(); true;',
            );
          }}
          style={{ paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#ffe8bf', borderRadius: 6 }}
        >
          <Text>Clear storage</Text>
        </Pressable>
        <Text style={{ fontSize: 12 }}>{seen.length} calls{honestUa ? ' · honest UA' : ''}</Text>
      </View>
      <WebView
        ref={webviewRef}
        source={{ uri }}
        style={{ flex: 1 }}
        injectedJavaScriptBeforeContentLoaded={CAPTURE}
        onMessage={(e) => {
          try {
            const msg = JSON.parse(e.nativeEvent.data);
            if (msg?.type !== 'NET_SEEN') return;
            console.log('[NetSeen]', msg.method, String(msg.url).slice(0, 120), msg.status,
              'headers:', (msg.headers || []).join(','),
              msg.body ? String(msg.body).slice(0, 400) : '');
            setSeen((prev) => [...prev, msg as Seen]);
          } catch { /* not ours */ }
        }}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        // Omitted entirely when honest: passing undefined is what leaves the
        // system default in place, and the default is the point.
        {...(honestUa ? {} : { userAgent: getStoreWebViewUA() })}
      />
      <ScrollView style={{ maxHeight: 120, backgroundColor: '#111' }}>
        {writes.slice(-8).map((s, i) => (
          <Text key={i} style={{ color: '#0f0', fontSize: 9 }}>
            {s.method} {s.status} {String(s.url).slice(-70)}
          </Text>
        ))}
      </ScrollView>
    </View>
    </Modal>
  );
}
