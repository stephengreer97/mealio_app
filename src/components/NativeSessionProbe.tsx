import React, { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import CookieManager from '@react-native-cookies/cookies';
import { Colors } from '../constants/colors';
import { getStoreWebViewUA } from '../lib/webview-user-agent';

/**
 * CAN THE SESSION BE READ WITHOUT A WEBVIEW AT ALL?
 *
 * Stephen, 2026-09-11: "are we 1000% sure there is no way to check cart or login
 * status purely over network for these stores?"
 *
 * Nobody had tested it, so the answer was reasoning rather than evidence. This
 * is the evidence. It asks the SAME session question the rail asks, from React
 * Native's own fetch instead of from inside a Chromium renderer, and reports
 * what came back.
 *
 * WHY IT MATTERS, measured on his Pixel 6 the same day:
 *
 *   09:06:00.230  webview: mounting now           +2ms
 *   09:06:08.729  webview: navigation started  +8501ms   <- renderer startup
 *   09:06:08.729  onLoadEnd                    +8501ms   <- the page itself: 0ms
 *
 * The page load is free. Building the renderer is 8.5 seconds, and at cart-open
 * time TWO of them are built at once -- the cart sheet's, and SilentLoginProbe's,
 * which on ALDI is loading the full storefront. If a plain fetch can answer the
 * login question, that second renderer stops existing.
 *
 * WHAT IS ALREADY KNOWN, so this probe only has to settle what is not:
 *   - Native can read store cookies. WebViewCartSheet already does it at the
 *     CookieManager.get call, and the logs print real cookie names.
 *   - On Android, RN's fetch goes through OkHttp with ForwardingCookieHandler,
 *     backed by the same android.webkit.CookieManager the WebView writes to, so
 *     the session cookies ride along with no work.
 *   - The WAFs do not block a plain client on these endpoints: curl with no
 *     cookies got 200 from Albertsons userinfo and a 400 (an API shape error,
 *     not a challenge page) from the Instacart graphql endpoint.
 *
 * WHAT IT CANNOT SETTLE, and the reason it reports rather than concludes:
 *   - OkHttp's TLS/HTTP-2 fingerprint is not Chromium's, and an AUTHENTICATED
 *     request is the one a WAF looks hardest at. curl getting through is
 *     encouraging, not proof.
 *   - iOS keeps WKWebView's cookies apart from NSURLSession's. Android is the
 *     easy case; a green result here says nothing about iOS.
 *
 * TWO STORES, deliberately. Albertsons is a plain GET and H-E-B is an ordinary
 * GraphQL POST, so both are replicable natively in a few lines. ALDI needs the
 * persisted-query hashes out of the storefront bundle and Walmart's login check
 * is localStorage with no request at all, so neither can be answered this way
 * without more work -- which is itself part of the answer.
 *
 * READ-ONLY. It asks who you are. It writes nothing, to any cart, ever.
 */

type Probe = {
  label: string;
  origin: string;
  /** Runs the request and says what the response means. */
  run: (ua: string) => Promise<{ status: number | null; loggedIn: boolean | null; detail: string }>;
};

const PROBES: Probe[] = [
  {
    label: 'Tom Thumb: userinfo (GET)',
    origin: 'https://www.tomthumb.com',
    // The same path albertsons-network.ts builds: /bin/safeway/unified/userinfo
    // with a cache-buster and the banner taken from the host.
    run: async (ua) => {
      // THE BANNER IS THE ACCOUNT. albertsons.com and tomthumb.com are separate
      // origins with separate cookie jars, and Stephen's runs are on Tom Thumb
      // (storeId 2574) -- so the first cut of this probed a banner he has no
      // session on and read the correct answer for that banner as a failure of
      // native fetch. __albBanner() derives this from the host for the same
      // reason.
      const url = 'https://www.tomthumb.com/bin/safeway/unified/userinfo?rand='
        + Math.floor(1e6 * Math.random()) + '&banner=tomthumb';
      const r = await fetch(url, {
        credentials: 'include',
        headers: { 'User-Agent': ua, accept: 'text/plain, application/json, */*' },
      });
      // The rail's own reading, copied rather than invented: the site treats
      // 401/403 here as signed out, and a 200 with no SWY_SHOP_TOKEN is the
      // expired-session answer -- the site tears the session down on it.
      //
      // The FIRST cut of this looked for `customerId`, which this endpoint does
      // not return, so a signed-in session reported signed out. The response was
      // plainly personalised (a zipcode, a store id, emailVerified) and the
      // verdict still said no, which is exactly the shape of a probe measuring
      // the wrong thing.
      if (r.status === 401 || r.status === 403) {
        return { status: r.status, loggedIn: false, detail: 'the site reads this status as signed out' };
      }
      const text = await r.text();
      let j: Record<string, unknown> | null = null;
      try { j = JSON.parse(text); } catch { /* an HTML body is itself the answer */ }
      if (!j) return { status: r.status, loggedIn: null, detail: `non-JSON body, ${text.length} chars` };
      // PRESENCE, NEVER THE VALUE. SWY_SHOP_TOKEN is the session itself.
      const signedIn = !!j.SWY_SHOP_TOKEN;
      return {
        status: r.status,
        loggedIn: signedIn,
        detail: `${Object.keys(j).length} keys, SWY_SHOP_TOKEN ${signedIn ? 'present' : 'absent'}`,
      };
    },
  },
  {
    label: 'H-E-B: myPreferredStore (GraphQL POST)',
    origin: 'https://www.heb.com',
    // Byte for byte the query buildHebSessionScript sends. A signed-out session
    // has no `me`, which is exactly how the rail decides the login question.
    run: async (ua) => {
      const r = await fetch('https://www.heb.com/graphql', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          accept: '*/*',
          'User-Agent': ua,
          'apollographql-client-name': 'WebPlatform-Solar (Production)',
        },
        body: JSON.stringify({
          operationName: 'myPreferredStore',
          variables: {},
          query: 'query myPreferredStore { me { id preferredStore { storeNumber } } }',
        }),
      });
      const text = await r.text();
      let j: { data?: { me?: { id?: string } }; errors?: unknown[] } | null = null;
      try { j = JSON.parse(text); } catch { /* fall through */ }
      if (!j) return { status: r.status, loggedIn: null, detail: `non-JSON, ${text.slice(0, 80)}` };
      if (j.errors?.length) return { status: r.status, loggedIn: null, detail: `graphql errors: ${JSON.stringify(j.errors).slice(0, 120)}` };
      return {
        status: r.status,
        loggedIn: !!j.data?.me?.id,
        detail: j.data?.me?.id ? 'me.id present' : 'me is null (signed out, or the cookie did not travel)',
      };
    },
  },
];

type Row = {
  label: string;
  cookieNames: string[];
  status: number | null;
  loggedIn: boolean | null;
  ms: number;
  detail: string;
};

export default function NativeSessionProbe({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [done, setDone] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      const ua = getStoreWebViewUA();
      for (const p of PROBES) {
        // Reported alongside the result, because "signed out" and "the cookie
        // never travelled" look identical in the response and are opposite
        // conclusions. An empty jar here means this probe proves nothing.
        let cookieNames: string[] = [];
        try {
          const jar = await CookieManager.get(p.origin, true);
          cookieNames = Object.keys(jar).sort();
        } catch { /* reported as an empty jar */ }

        const t0 = Date.now();
        let row: Row;
        try {
          const out = await p.run(ua);
          row = { label: p.label, cookieNames, ms: Date.now() - t0, ...out };
        } catch (e) {
          row = {
            label: p.label, cookieNames, status: null, loggedIn: null,
            ms: Date.now() - t0, detail: `threw: ${String(e).slice(0, 140)}`,
          };
        }
        console.log('[NativeSession]', row.label, 'status=', row.status,
          'loggedIn=', row.loggedIn, 'ms=', row.ms,
          'cookies=', row.cookieNames.length, '—', row.detail);
        setRows((r) => [...r, row]);
      }
      setDone(true);
    })();
  }, []);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <Text style={styles.title}>Session over native fetch</Text>
        <Text style={styles.sub}>
          Read-only. Asks the same login question the rail asks, from RN{"'"}s own fetch
          instead of a WebView. Nothing is written to any cart.
        </Text>
        <ScrollView style={{ flex: 1 }}>
          {rows.map((r, i) => (
            <View key={i} style={styles.card}>
              <Text style={styles.cardTitle}>{r.label}</Text>
              <Text style={styles.line}>status: {r.status ?? 'none'} · {r.ms}ms</Text>
              <Text style={styles.line}>
                cookies visible to native: {r.cookieNames.length}
                {r.cookieNames.length ? ` (${r.cookieNames.slice(0, 4).join(', ')}…)` : ''}
              </Text>
              <Text style={[styles.verdict, r.loggedIn === true && styles.ok, r.loggedIn === false && styles.no]}>
                {r.loggedIn === true ? 'SIGNED IN over native fetch'
                  : r.loggedIn === false ? 'signed out (or the cookie did not travel)'
                  : 'inconclusive'}
              </Text>
              <Text style={styles.detail}>{r.detail}</Text>
              {r.cookieNames.length === 0 && (
                <Text style={styles.warn}>
                  No cookies for this origin, so this row proves nothing either way.
                  Open the store in the app once, then run it again.
                </Text>
              )}
            </View>
          ))}
          {!done && <Text style={styles.line}>running…</Text>}
        </ScrollView>
        <TouchableOpacity onPress={onClose} style={styles.close}>
          <Text style={styles.closeText}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, backgroundColor: Colors.bg },
  title: { fontSize: 18, fontFamily: 'Inter_600SemiBold', color: Colors.text1, marginBottom: 4 },
  sub: { fontSize: 12, color: Colors.text3, marginBottom: 12, lineHeight: 17 },
  card: { borderWidth: 1, borderColor: Colors.border, borderRadius: 8, padding: 12, marginBottom: 10 },
  cardTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1, marginBottom: 6 },
  line: { fontSize: 12, color: Colors.text2, marginBottom: 2 },
  verdict: { fontSize: 13, fontFamily: 'Inter_600SemiBold', marginTop: 6, color: Colors.text2 },
  ok: { color: '#137333' },
  no: { color: '#a50e0e' },
  detail: { fontSize: 11, color: Colors.text3, marginTop: 4 },
  warn: { fontSize: 11, color: '#a05a00', marginTop: 6 },
  close: { padding: 14, alignItems: 'center' },
  closeText: { fontSize: 15, color: Colors.brand, fontFamily: 'Inter_600SemiBold' },
});
