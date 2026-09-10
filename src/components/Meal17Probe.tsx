import React, { useCallback, useRef, useState } from 'react';
import { Modal, View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Colors } from '../constants/colors';
import { getStoreWebViewUA } from '../lib/webview-user-agent';

// MEAL-17, TEMPORARY. Delete with the spike.
//
// FIRST ATTEMPT WAS WRONG AND THE WAY IT WAS WRONG IS THE FINDING: calling the
// add-to-cart URL with fetch() from inside the walmart.com origin returns 200
// and the same 1761-byte SPA shell every time, for a real id, a bogus id and no
// id at all -- and adds NOTHING. The cart was untouched after nine such calls.
// The add is done by the page after it boots, so this only works as a top-level
// NAVIGATION. Which means: it cannot be fired quietly in the background, and a
// burst has to be a burst of navigations to mean anything.
//
// So this walks a queue of URLs, letting each one load and run, and reads the
// header cart count out of the page after each step. The count is the only
// honest answer to "did that land" -- the response body says nothing.

const SOUR_CREAM = '12335111';   // Great Value Original Sour Cream, 16 oz, $1.84
const DAISY_8OZ = '10309448';    // Daisy Pure and Natural, 8 oz, $1.74
const BOGUS = '99999999999';
const UPC = '736436852899';      // a real UPC from our own captured fixture

const MANY = [
  '12335111', '10309448', '10309449', '12335112', '10315017', '43365585',
  '2205441350', '1506667324',
];

const sc = (items: string) => 'https://www.walmart.com/sc/cart/addToCart?items=' + items;
const CART = 'https://www.walmart.com/cart';

type Step = { label: string; url: string };

const OFFER = '96A97D940D5B4635B56E67DD3D8D829F'; // the offerId for SOUR_CREAM

// Round two: the documented parameters this endpoint takes besides `items`,
// and the question of whether anything here can take a SEARCH TERM.
const MATRIX: Step[] = [
  { label: 'baseline', url: CART },
  { label: 'offers= (documented)', url: 'https://www.walmart.com/sc/cart/addToCart?offers=' + OFFER + '_1' },
  { label: 'read', url: CART },
  { label: 'items + storeId', url: sc(SOUR_CREAM + '_1') + '&storeId=2280' },
  { label: 'read', url: CART },
  { label: 'searchTerm= guess', url: 'https://www.walmart.com/sc/cart/addToCart?searchTerm=sour%20cream' },
  { label: 'read', url: CART },
  { label: 'q= guess', url: 'https://www.walmart.com/sc/cart/addToCart?q=sour%20cream' },
  { label: 'read', url: CART },
  { label: 'plain search page', url: 'https://www.walmart.com/search?q=sour%20cream' },
  { label: 'read', url: CART },
];

/**
 * Six adds back to back, then a read. The WAF question.
 *
 * EACH URL CARRIES A UNIQUE THROWAWAY PARAM. The first two bursts used the
 * identical URL six times and landed 2 of 6, then 0 of 6, with no challenge and
 * no error -- which reads like throttling and is more likely the WebView
 * serving the same URL from cache and never asking Walmart at all. Making the
 * URLs distinct separates those two: if all six land now, nothing was
 * throttling anything.
 */
const BURST: Step[] = [
  { label: 'baseline', url: CART },
  ...Array.from({ length: 6 }, (_, i) => ({
    label: 'burst ' + (i + 1),
    url: sc(SOUR_CREAM + '_1') + '&z=' + Date.now() + '-' + i,
  })),
  { label: 'read', url: CART },
];

/** Reads the header cart count, the title, and any challenge, after each load. */
const READ = [
  // NO CSS ATTRIBUTE SELECTORS. The first version used
  // [data-automation-id=cart-item-count] with the value unquoted, which is
  // invalid selector syntax: querySelector threw, the reader died before it
  // posted, and nineteen steps all reported "no report" while the pages were
  // loading perfectly well. Read the rendered text instead, and wrap the whole
  // thing so a throw still reports something.
  'function m17() {',
  '  try {',
  '    var body = document.body ? document.body.innerText : "";',
  '    var hit = body.match(/Cart \\((\\d+) items\\)/);',
  '    var badge = body.match(/\\$([0-9,]+\\.[0-9]{2})/);',
  '    window.ReactNativeWebView.postMessage(JSON.stringify({',
  '      title: String(document.title).slice(0, 60),',
  '      items: hit ? hit[1] : null,',
  '      dollars: badge ? badge[1] : null,',
  '      href: String(location.href).slice(0, 100),',
  '      blocked: body.indexOf("Robot or human") >= 0,',
  '      len: body.length',
  '    }));',
  '  } catch (e) {',
  '    window.ReactNativeWebView.postMessage(JSON.stringify({ error: String(e).slice(0, 80) }));',
  '  }',
  '}',
  'setTimeout(m17, 1200);',
  'setTimeout(m17, 3200);',
  'true;',
].join('\n');

export default function Meal17Probe({ mode, onClose }: { mode: 'matrix' | 'burst'; onClose: () => void }) {
  const queue = mode === 'matrix' ? MATRIX : BURST;
  const [idx, setIdx] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const startedAt = useRef(Date.now());

  const onMessage = useCallback((raw: string) => {
    let msg: any = {};
    try { msg = JSON.parse(raw); } catch { return; }
    const step = queue[Math.min(idx, queue.length - 1)];
  const finished = idx >= queue.length;
    const line = [
      step ? step.label : '?',
      'items=' + (msg.items ?? '?'),
      '$' + (msg.dollars ?? '?'),
      msg.blocked ? 'BLOCKED' : '',
      msg.error ? 'ERR ' + msg.error : '',
      '| ' + String(msg.title ?? '').slice(0, 34),
    ].join(' ');
    console.log('[MEAL17]', line, msg.href);
    setLog((prev) => [...prev, line]);
    // A burst means no waiting between adds; the matrix gives each step room.
    const gap = mode === 'burst' ? 200 : 1200;
    setTimeout(() => { if (!paused) setIdx((i) => (i === idx ? i + 1 : i)); }, gap);
  }, [idx, queue, mode, paused]);

  // ADVANCE ON A TIMER, not on the page reporting in. The first run of this
  // sat on step 1 forever: a heavy SPA that never posts leaves a
  // message-driven queue stuck, and a stuck queue looks exactly like a store
  // that stopped answering. The message is extra information when it comes.
  React.useEffect(() => {
    if (idx >= queue.length || paused) return;
    const dwell = mode === 'burst' ? 5000 : 6000;
    const t = setTimeout(() => {
      setLog((prev) => (prev.length && prev[prev.length - 1].indexOf(String(idx) + ':') === 0
        ? prev
        : [...prev, String(idx) + ': ' + queue[idx].label + ' (no report)']));
      setIdx((i) => (i === idx ? i + 1 : i));
    }, dwell);
    return () => clearTimeout(t);
  }, [idx, paused, mode, queue]);

  const step = queue[Math.min(idx, queue.length - 1)];
  const finished = idx >= queue.length;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.bar}>
          <TouchableOpacity onPress={onClose} style={styles.btn}><Text>Close</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => setPaused((p) => !p)} style={styles.btn}>
            <Text>{paused ? 'Resume' : 'Pause'}</Text>
          </TouchableOpacity>
          <Text style={styles.count}>
            {finished ? 'done (' + queue.length + ')' : idx + 1 + '/' + queue.length + ' ' + step.label}
          </Text>
        </View>
        <ScrollView style={styles.logBox}>
          {log.map((l, i) => <Text key={i} style={styles.line}>{l}</Text>)}
        </ScrollView>
        {step ? (
          <WebView
            key={Math.min(idx, queue.length - 1)}
            source={{ uri: step.url }}
            userAgent={getStoreWebViewUA()}
            injectedJavaScript={READ}
            onMessage={(e) => onMessage(e.nativeEvent.data)}
            style={styles.web}
          />
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8 },
  btn: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: Colors.surface, borderRadius: 8 },
  count: { fontSize: 12, color: Colors.text3, flex: 1 },
  logBox: { maxHeight: 300, paddingHorizontal: 8 },
  line: { fontSize: 11, color: Colors.text1, marginBottom: 2 },
  web: { flex: 1 },
});
