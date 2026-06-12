import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { Ionicons } from '@expo/vector-icons';

import { Colors } from '../../constants/colors';
import FixtureCaptureSheet from '../../components/FixtureCaptureSheet';
import { FIXTURE_CAPTURE_STORES, StoreId } from '../../lib/fixture-capture-config';

const STORAGE_KEY_SERVER = 'mealio_capture_server_url';

/**
 * Admin-only screen. Gated at the navigator level — only rendered when
 * the AuthContext reports isAdmin === true.
 *
 * Today it surfaces fixture-capture controls. Future admin features can
 * be added as additional sections on this same screen.
 */
export default function AdminScreen() {
  const [serverUrl, setServerUrl] = useState<string>('');
  const [editingUrl, setEditingUrl] = useState<string>('');
  const [reachableStatus, setReachableStatus] = useState<'unknown' | 'ok' | 'fail'>('unknown');
  const [reachableMessage, setReachableMessage] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [captureFor, setCaptureFor] = useState<StoreId | null>(null);
  const [captured, setCaptured] = useState<Record<string, Set<string>>>({});

  // Load the saved server URL on mount.
  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(STORAGE_KEY_SERVER);
        if (stored) {
          setServerUrl(stored);
          setEditingUrl(stored);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  // After URL is set, fetch per-store capture status.
  useEffect(() => {
    if (!serverUrl) return;
    (async () => {
      const next: Record<string, Set<string>> = {};
      for (const id of Object.keys(FIXTURE_CAPTURE_STORES)) {
        try {
          const res = await fetch(`${serverUrl.replace(/\/$/, '')}/list/${id}`);
          const body = await res.json();
          next[id] = new Set<string>(body?.files ?? []);
        } catch {
          next[id] = new Set();
        }
      }
      setCaptured(next);
    })();
  }, [serverUrl, reachableStatus]);

  const saveServerUrl = useCallback(async () => {
    const trimmed = editingUrl.trim().replace(/\/$/, '');
    if (!trimmed) {
      Alert.alert('Server URL required', 'Enter the dev machine URL, e.g. http://192.168.1.42:8080');
      return;
    }
    if (!/^https?:\/\//.test(trimmed)) {
      Alert.alert('Bad URL', 'URL must start with http:// or https://');
      return;
    }
    setServerUrl(trimmed);
    try { await SecureStore.setItemAsync(STORAGE_KEY_SERVER, trimmed); } catch {}
    setReachableStatus('unknown');
    setReachableMessage('');
  }, [editingUrl]);

  const testConnection = useCallback(async () => {
    if (!serverUrl) {
      Alert.alert('No URL', 'Save a dev server URL first.');
      return;
    }
    setTesting(true);
    setReachableMessage(`Pinging ${serverUrl}/ping …`);

    // Manual abort timer because RN fetch doesn't honor AbortSignal.timeout
    // on all platforms.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);

    try {
      const url = `${serverUrl.replace(/\/$/, '')}/ping`;
      const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
      clearTimeout(timer);
      const text = await res.text();
      let body: any = {};
      try { body = JSON.parse(text); } catch {
        // not JSON — show the first 80 chars so the user can tell what came back
        setReachableStatus('fail');
        setReachableMessage(`✗ Got HTTP ${res.status} but body was not JSON: ${text.slice(0, 80)}`);
        return;
      }
      if (res.ok && body?.ok) {
        setReachableStatus('ok');
        setReachableMessage(`✓ Connected (port ${body.port})`);
      } else {
        setReachableStatus('fail');
        setReachableMessage(`✗ Server responded ${res.status}: ${JSON.stringify(body).slice(0, 80)}`);
      }
    } catch (err: any) {
      clearTimeout(timer);
      setReachableStatus('fail');
      if (err?.name === 'AbortError') {
        setReachableMessage(`✗ Timed out after 5s. Phone might not be reaching the server.`);
      } else {
        setReachableMessage(`✗ Fetch error: ${err?.name ?? ''} ${err?.message ?? String(err)}`);
      }
    } finally {
      setTesting(false);
    }
  }, [serverUrl]);

  const onCaptured = useCallback(
    (filename: string) => {
      if (!captureFor) return;
      setCaptured((prev) => {
        const next = { ...prev };
        const set = new Set(next[captureFor] ?? []);
        set.add(filename);
        next[captureFor] = set;
        return next;
      });
    },
    [captureFor],
  );

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Admin</Text>
        <Text style={styles.subtitle}>Tools that bypass anti-bot detection by running in the real iOS WebView.</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Dev capture server</Text>
          <Text style={styles.helpText}>
            On your dev machine, run <Text style={styles.mono}>npm run capture:server</Text>. Copy one of the
            printed http://… URLs and paste it here.
          </Text>
          <TextInput
            style={styles.input}
            value={editingUrl}
            onChangeText={setEditingUrl}
            placeholder="http://192.168.1.42:8080"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <View style={styles.row}>
            <TouchableOpacity onPress={saveServerUrl} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={testConnection}
              style={[styles.secondaryBtn, !serverUrl && styles.btnDisabled]}
              disabled={!serverUrl || testing}
            >
              {testing ? <ActivityIndicator color={Colors.text1} /> : <Text style={styles.secondaryBtnText}>Test connection</Text>}
            </TouchableOpacity>
          </View>
          {reachableMessage ? (
            <Text
              style={[
                styles.statusText,
                reachableStatus === 'ok' && { color: Colors.success },
                reachableStatus === 'fail' && { color: Colors.error },
              ]}
            >
              {reachableMessage}
            </Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Fixture capture</Text>
          <Text style={styles.helpText}>
            Tap a store to walk through its fixtures in a real iOS WebView. Log in once, then capture each
            page. The HTML is uploaded to your dev server and written to{' '}
            <Text style={styles.mono}>tests/fixtures/&lt;store&gt;/</Text>.
          </Text>
          {Object.entries(FIXTURE_CAPTURE_STORES).map(([id, cfg]) => {
            const capturedCount = captured[id]?.size ?? 0;
            const total = cfg.fixtures.length;
            return (
              <TouchableOpacity
                key={id}
                style={styles.storeRow}
                disabled={!serverUrl}
                onPress={() => setCaptureFor(id as StoreId)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.storeName}>{id}</Text>
                  <Text style={styles.storeMeta}>
                    {capturedCount}/{total} captured
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={Colors.text3} />
              </TouchableOpacity>
            );
          })}
          {!serverUrl && (
            <Text style={[styles.statusText, { color: Colors.text3, fontStyle: 'italic' }]}>
              Set the dev capture server URL above first.
            </Text>
          )}
        </View>
      </ScrollView>

      {captureFor && (
        <FixtureCaptureSheet
          visible
          storeId={captureFor}
          captureServerUrl={serverUrl}
          onClose={() => setCaptureFor(null)}
          onCaptured={onCaptured}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 26, fontWeight: '700', color: Colors.text1 },
  subtitle: { fontSize: 13, color: Colors.text2, marginTop: 4, marginBottom: 18 },
  section: {
    backgroundColor: Colors.surfaceRaised,
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: Colors.text1, marginBottom: 6 },
  helpText: { fontSize: 12, color: Colors.text2, lineHeight: 17, marginBottom: 10 },
  mono: { fontFamily: 'Courier', fontSize: 12, color: Colors.text1 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderStrong,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    backgroundColor: Colors.surface,
    color: Colors.text1,
  },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 8 },
  primaryBtn: {
    backgroundColor: Colors.brand,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 10,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  secondaryBtn: {
    backgroundColor: Colors.surface,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderStrong,
  },
  secondaryBtnText: { color: Colors.text1, fontSize: 14 },
  btnDisabled: { opacity: 0.4 },
  statusText: { fontSize: 12, color: Colors.text2, marginTop: 8 },
  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  storeName: { fontSize: 15, fontWeight: '500', color: Colors.text1, textTransform: 'capitalize' },
  storeMeta: { fontSize: 12, color: Colors.text3, marginTop: 2 },
});
