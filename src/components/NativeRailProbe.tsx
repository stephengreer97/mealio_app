import React, { useCallback, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import CookieManager from '@react-native-cookies/cookies';
import { Colors } from '../constants/colors';
import { getStoreWebViewUA } from '../lib/webview-user-agent';
import { NativeCandidate, NativeRail, NativeSession } from '../lib/native-rail/types';
import { nativeRailFor } from '../lib/native-rail';

/**
 * ALL FOUR JOBS, EVERY STORE, NO WEBVIEW.
 *
 * Stephen, 2026-09-11: "I want you to test login detection, cart read, search,
 * and add without a webview for every store."
 *
 * Walmart is absent on his instruction the same day ("Walmart is on pause for
 * now") -- its bot detection is why walmart.io is the intended path there.
 *
 * WHAT EACH ROW MEANS
 *   login      the session question, and the identifiers the rest need
 *   cart read  the before-snapshot every run takes
 *   search     one term, the hot path
 *   add        THE ONLY WRITE, behind its own tap
 *
 * The cookie count sits beside every store for the reason it did in the first
 * probe: "signed out" and "the cookie never travelled" are the same response and
 * opposite conclusions. An empty jar means the row proves nothing.
 *
 * ADD IS NOT RUN BY DEFAULT, and that is not timidity. Everything else here is a
 * question; add changes a cart the user actually shops from. It writes ONE unit
 * of the first candidate the search returned, names what it wrote, and the
 * Account screen already carries a per-store canary clear to undo it.
 */

/**
 * Asked for by id, through the registry.
 *
 * The first cut imported four store modules directly, which made this shared
 * component reach into every store and broke the boundary rule -- the whole
 * point of which is that a change to one store cannot bring down another. A
 * probe is not exempt from that just because it is behind __DEV__.
 */
const RAILS: NativeRail[] = ['heb', 'aldi', 'tom_thumb', 'wegmans']
  .map((id) => nativeRailFor(id))
  .filter((r): r is NativeRail => r !== null);

/** A term every grocer stocks, so a zero result means the search failed. */
const TERM = 'milk';

type Step = { label: string; ok: boolean | null; status: number | null; ms: number; detail: string };
type Row = {
  rail: NativeRail;
  cookies: number;
  steps: Step[];
  session?: NativeSession;
  firstCandidate?: NativeCandidate | null;
};

export default function NativeRailProbe({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const runReads = useCallback(async () => {
    setRunning(true);
    setRows([]);
    setDone(false);
    const ua = getStoreWebViewUA();
    for (const rail of RAILS) {
      let cookies = 0;
      try { cookies = Object.keys(await CookieManager.get(rail.origin, true)).length; } catch { /* zero */ }

      const steps: Step[] = [];
      const push = (label: string, r: { ok: boolean; status: number | null; ms: number; detail: string }) => {
        steps.push({ label, ok: r.ok, status: r.status, ms: r.ms, detail: r.detail });
        console.log('[NativeRail]', rail.id, label, 'ok=', r.ok, 'status=', r.status, 'ms=', r.ms, '-', r.detail);
      };

      const sess = await rail.session(ua);
      push('login', sess);
      const session = sess.session;
      let firstCandidate: NativeCandidate | null = null;

      // The later steps need identifiers the login step produced. Without a
      // session there is nothing to ask WITH, so they are skipped rather than
      // failed -- a skipped step and a broken one are different findings.
      // EVERY STEP RUNS, AND THE RAIL DECIDES WHAT IT NEEDS.
      //
      // The harness used to skip cart read whenever login failed, which is
      // sensible for a store whose cart needs a session and wrong for the one
      // case that mattered: Wegmans' cart read IS the experiment -- does the
      // commerce API answer cookies alone -- and a failed login is its normal
      // state. So the probe that existed to test it never ran once.
      //
      // A rail that genuinely needs a session says so itself ("no session from
      // the login step"), which is a finding. The harness deciding on its behalf
      // is not.
      const s2 = session ?? { loggedIn: false };
      const cart = await rail.cartRead(ua, s2);
      push('cart read', cart);
      const found = await rail.search(ua, s2, TERM);
      push('search', found);
      firstCandidate = found.candidates?.[0] ?? null;

      setRows((r) => [...r, { rail, cookies, steps, session, firstCandidate }]);
    }
    setRunning(false);
    setDone(true);
  }, []);

  /** The write. One unit, one product, named in the result. */
  const runAdd = useCallback(async (idx: number) => {
    const row = rows[idx];
    if (!row?.session?.loggedIn || !row.firstCandidate) return;
    const ua = getStoreWebViewUA();
    const out = await row.rail.add(ua, row.session, row.firstCandidate);
    console.log('[NativeRail]', row.rail.id, 'add', 'ok=', out.ok, 'status=', out.status, 'ms=', out.ms, '-', out.detail);
    setRows((rs) => rs.map((r, i) => (i === idx
      ? { ...r, steps: [...r.steps.filter((s) => s.label !== 'add'),
          { label: 'add', ok: out.ok, status: out.status, ms: out.ms, detail: out.detail }] }
      : r)));
  }, [rows]);

  /**
   * SET OR ADD? The one question this rail's add path is still refusing to
   * answer, asked in the only shape that is safe against real shopping: write a
   * line back to the quantity it already holds. Under SET nothing changes at
   * all; under ADD the line doubles and the result says so in capitals.
   */
  const runQtyProbe = useCallback(async (idx: number) => {
    const row = rows[idx];
    if (!row?.session?.loggedIn || !row.rail.measureQtySemantics) return;
    const out = await row.rail.measureQtySemantics(getStoreWebViewUA(), row.session);
    console.log('[NativeRail]', row.rail.id, 'qty-semantics', out.semantics ?? 'inconclusive',
      'item=', out.itemName, 'before=', out.before, 'after=', out.after, '-', out.detail);
    setRows((rs) => rs.map((r, i) => (i === idx
      ? { ...r, steps: [...r.steps.filter((s2) => s2.label !== 'qty semantics'),
          { label: 'qty semantics', ok: out.ok, status: out.status, ms: out.ms, detail: out.detail }] }
      : r)));
  }, [rows]);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <Text style={styles.title}>Native rail: all four jobs, no WebView</Text>
        <Text style={styles.sub}>
          Login, cart read and search are read-only and run together. Add writes one
          unit to a real cart and has its own button. Walmart is not here on purpose.
        </Text>

        <TouchableOpacity onPress={runReads} disabled={running} style={[styles.run, running && styles.runOff]}>
          <Text style={styles.runText}>{running ? 'running…' : 'Run login, cart read, search'}</Text>
        </TouchableOpacity>

        <ScrollView style={{ flex: 1 }}>
          {rows.map((row, i) => (
            <View key={row.rail.id} style={styles.card}>
              <Text style={styles.cardTitle}>{row.rail.label}</Text>
              <Text style={styles.line}>cookies visible to native: {row.cookies}</Text>
              {row.cookies === 0 && (
                <Text style={styles.warn}>
                  Empty jar, so nothing below proves anything. Open this store in the app once first.
                </Text>
              )}
              {row.steps.map((s) => (
                <View key={s.label} style={styles.step}>
                  <Text style={[styles.stepLabel,
                    s.ok === true && styles.ok, s.ok === false && styles.no]}>
                    {s.ok === true ? 'PASS' : s.ok === false ? 'FAIL' : 'skip'} · {s.label}
                    {s.status != null ? ` · ${s.status}` : ''}{s.ms ? ` · ${s.ms}ms` : ''}
                  </Text>
                  <Text style={styles.detail}>{s.detail}</Text>
                </View>
              ))}
              {row.firstCandidate && (
                <TouchableOpacity onPress={() => runAdd(i)} style={styles.addBtn}>
                  <Text style={styles.addText}>
                    Add 1 to cart: {row.firstCandidate.productName.slice(0, 34)}
                  </Text>
                </TouchableOpacity>
              )}
              {row.session?.loggedIn && row.rail.measureQtySemantics && (
                <TouchableOpacity onPress={() => runQtyProbe(i)} style={styles.addBtn}>
                  <Text style={styles.addText}>Measure: does the write SET or ADD?</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
          {done && rows.length === 0 && <Text style={styles.line}>no rails ran</Text>}
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
  run: { backgroundColor: Colors.brand, borderRadius: 8, padding: 12, alignItems: 'center', marginBottom: 12 },
  runOff: { opacity: 0.5 },
  runText: { color: '#fff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  card: { borderWidth: 1, borderColor: Colors.border, borderRadius: 8, padding: 12, marginBottom: 10 },
  cardTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.text1, marginBottom: 6 },
  line: { fontSize: 12, color: Colors.text2, marginBottom: 2 },
  step: { marginTop: 8 },
  stepLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: Colors.text2 },
  ok: { color: '#137333' },
  no: { color: '#a50e0e' },
  detail: { fontSize: 11, color: Colors.text3, marginTop: 2 },
  warn: { fontSize: 11, color: '#a05a00', marginTop: 4 },
  addBtn: { marginTop: 10, borderWidth: 1, borderColor: Colors.borderStrong, borderRadius: 6, padding: 9, alignItems: 'center' },
  addText: { fontSize: 12, color: Colors.text1, fontFamily: 'Inter_600SemiBold' },
  close: { padding: 14, alignItems: 'center' },
  closeText: { fontSize: 15, color: Colors.brand, fontFamily: 'Inter_600SemiBold' },
});
