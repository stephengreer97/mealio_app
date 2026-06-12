import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

import { Colors } from '../constants/colors';
import { FIXTURE_CAPTURE_STORES, StoreId } from '../lib/fixture-capture-config';
import { STORE_WEBVIEW_UA } from '../lib/webview-user-agent';

interface Props {
  visible: boolean;
  storeId: StoreId;
  captureServerUrl: string;
  onClose: () => void;
  /** Called after each successful save with the captured filename */
  onCaptured?: (filename: string) => void;
}

/**
 * Full-screen WebView walk-through for capturing HTML fixtures from the
 * real iOS Safari WebView. Each fixture's URL is navigated in sequence;
 * the user logs in / browses normally, taps "Capture", and the page's
 * outerHTML is POSTed to the dev capture server.
 *
 * The WebView is the same iOS WebView the WebViewCartSheet uses, so its
 * TLS/UA/HTTP fingerprint matches exactly what production sees — anti-bot
 * vendors have no automation signals to flag.
 */
export default function FixtureCaptureSheet({
  visible,
  storeId,
  captureServerUrl,
  onClose,
  onCaptured,
}: Props) {
  const insets = useSafeAreaInsets();
  const store = FIXTURE_CAPTURE_STORES[storeId];
  const [fixtureIdx, setFixtureIdx] = useState(0);
  const [webviewUri, setWebviewUri] = useState(store?.loginUrl ?? 'about:blank');
  const [isCapturing, setIsCapturing] = useState(false);
  const [lastStatus, setLastStatus] = useState<string | null>(null);
  const webviewRef = useRef<WebView>(null);

  const currentFixture = store?.fixtures[fixtureIdx];
  const totalFixtures = store?.fixtures.length ?? 0;

  // Reset state when the modal opens or store changes.
  React.useEffect(() => {
    if (visible && store) {
      setFixtureIdx(0);
      setWebviewUri(store.loginUrl);
      setLastStatus(null);
    }
  }, [visible, storeId, store]);

  /**
   * Inject a small script that reads outerHTML and posts it back.
   * @param delayMs Optional delay before reading the DOM — useful for
   * fleeting states (e.g. an open stepper that auto-collapses). The user
   * triggers their interaction in the WebView, then taps the timed capture,
   * giving them ~delayMs to perform the click. During the wait the DOM is
   * NOT read yet, so any visible UI change up to the trigger moment is what
   * gets captured.
   */
  const captureCurrentPage = useCallback(
    (delayMs = 0) => {
      if (!currentFixture || isCapturing) return;
      setIsCapturing(true);
      setLastStatus(delayMs > 0 ? `Capturing in ${(delayMs / 1000).toFixed(1)}s…` : 'Reading page HTML…');
      const script = `
        (function() {
          var DELAY = ${delayMs};
          function snap() {
            try {
              var html = document.documentElement.outerHTML;
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'CAPTURE_HTML',
                html: html,
                url: window.location.href,
              }));
            } catch (e) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'CAPTURE_ERROR',
                error: String(e),
              }));
            }
          }
          if (DELAY > 0) setTimeout(snap, DELAY); else snap();
        })();
        true;
      `;
      webviewRef.current?.injectJavaScript(script);
    },
    [currentFixture, isCapturing],
  );

  /** Skip the current fixture without capturing. Advances to the next one. */
  const skipCurrent = useCallback(() => {
    if (fixtureIdx + 1 < totalFixtures) {
      const next = store!.fixtures[fixtureIdx + 1];
      setFixtureIdx((i) => i + 1);
      setWebviewUri(next.url);
      setLastStatus(`Skipped ${currentFixture?.file ?? ''}`);
    } else {
      setLastStatus(`Skipped ${currentFixture?.file ?? ''} (last fixture)`);
    }
  }, [currentFixture, fixtureIdx, store, totalFixtures]);

  const onMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data);
        if (msg.type === 'CAPTURE_HTML' && currentFixture) {
          setLastStatus(`Uploading ${currentFixture.file}…`);
          const res = await fetch(`${captureServerUrl.replace(/\/$/, '')}/save-fixture`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              store: storeId,
              name: currentFixture.file,
              html: msg.html,
            }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok || !body.ok) {
            throw new Error(body?.error || `HTTP ${res.status}`);
          }
          setLastStatus(`✓ Saved ${currentFixture.file} (${(body.bytes / 1024).toFixed(1)} KB)`);
          onCaptured?.(currentFixture.file);
          // Advance to the next fixture; if none, leave the user on this page.
          if (fixtureIdx + 1 < totalFixtures) {
            setFixtureIdx((i) => i + 1);
            const next = store!.fixtures[fixtureIdx + 1];
            setWebviewUri(next.url);
          }
        } else if (msg.type === 'CAPTURE_ERROR') {
          setLastStatus(`✗ Error reading page: ${msg.error}`);
        }
      } catch (err: any) {
        setLastStatus(`✗ ${err?.message ?? String(err)}`);
      } finally {
        setIsCapturing(false);
      }
    },
    [captureServerUrl, currentFixture, fixtureIdx, onCaptured, store, storeId, totalFixtures],
  );

  const goToFixture = useCallback(
    (idx: number) => {
      if (!store || idx < 0 || idx >= totalFixtures) return;
      setFixtureIdx(idx);
      setWebviewUri(store.fixtures[idx].url);
    },
    [store, totalFixtures],
  );

  if (!store) return null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      {/* Manually apply insets — Modal in fullScreen mode on iOS doesn't
          propagate SafeAreaProvider context, so we use useSafeAreaInsets()
          directly to push the top bar below the notch and the bottom
          toolbar above the home indicator. */}
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
            <Ionicons name="close" size={28} color={Colors.text1} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.storeName}>{storeId}</Text>
            <Text style={styles.progress}>
              Fixture {fixtureIdx + 1} of {totalFixtures}: {currentFixture?.file ?? '—'}
            </Text>
          </View>
        </View>

        {currentFixture?.instruction && (
          <View style={styles.instructionBox}>
            <Text style={styles.instructionText}>{currentFixture.instruction}</Text>
          </View>
        )}

        <WebView
          ref={webviewRef}
          source={{ uri: webviewUri }}
          style={{ flex: 1 }}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          userAgent={STORE_WEBVIEW_UA}
        />

        {lastStatus && (
          <View style={styles.statusBar}>
            <Text style={styles.statusText} numberOfLines={2}>{lastStatus}</Text>
          </View>
        )}

        {/* Row 1: capture buttons (primary actions) */}
        <View style={styles.captureRow}>
          <TouchableOpacity
            onPress={() => captureCurrentPage(0)}
            disabled={isCapturing}
            style={[styles.captureBtn, isCapturing && styles.btnDisabled]}
          >
            {isCapturing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="camera" size={18} color="#fff" />
                <Text style={[styles.btnLabel, { color: '#fff' }]}>Capture</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => captureCurrentPage(currentFixture?.suggestedDelayMs ?? 2000)}
            disabled={isCapturing}
            style={[styles.captureBtn, styles.delayedBtn, isCapturing && styles.btnDisabled]}
          >
            <Ionicons name="time-outline" size={18} color="#fff" />
            <Text style={[styles.btnLabel, { color: '#fff' }]}>
              Capture in {((currentFixture?.suggestedDelayMs ?? 2000) / 1000).toFixed(1)}s
            </Text>
          </TouchableOpacity>
        </View>

        {/* Row 2: navigation (prev / skip / next) */}
        <View style={styles.toolbar}>
          <TouchableOpacity
            onPress={() => goToFixture(fixtureIdx - 1)}
            disabled={fixtureIdx === 0 || isCapturing}
            style={[styles.toolbarBtn, (fixtureIdx === 0 || isCapturing) && styles.btnDisabled]}
          >
            <Ionicons name="chevron-back" size={20} color={Colors.text1} />
            <Text style={styles.btnLabel}>Prev</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={skipCurrent}
            disabled={isCapturing}
            style={[styles.toolbarBtn, isCapturing && styles.btnDisabled]}
          >
            <Text
              style={[
                styles.btnLabel,
                currentFixture?.optional && { color: Colors.text2 },
              ]}
            >
              {currentFixture?.optional ? 'Skip (optional)' : 'Skip'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => goToFixture(fixtureIdx + 1)}
            disabled={fixtureIdx + 1 >= totalFixtures || isCapturing}
            style={[styles.toolbarBtn, (fixtureIdx + 1 >= totalFixtures || isCapturing) && styles.btnDisabled]}
          >
            <Text style={styles.btnLabel}>Next</Text>
            <Ionicons name="chevron-forward" size={20} color={Colors.text1} />
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
    backgroundColor: '#fafafa',
  },
  iconBtn: { padding: 6, marginRight: 4 },
  storeName: { fontSize: 16, fontWeight: '600', color: Colors.text1, textTransform: 'capitalize' },
  progress: { fontSize: 12, color: Colors.text3, marginTop: 2 },
  instructionBox: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#fff7e6',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f3d8a0',
  },
  instructionText: { fontSize: 12, color: '#8a5b00', lineHeight: 17 },
  statusBar: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: '#f5f5f5',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  statusText: { fontSize: 12, color: Colors.text2 },
  captureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
    backgroundColor: '#fafafa',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#fff',
  },
  toolbarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
  },
  captureBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#1a56a4',
    flex: 1,
    justifyContent: 'center',
  },
  delayedBtn: {
    backgroundColor: '#5b7ca0',
  },
  btnLabel: { fontSize: 14, color: Colors.text1, marginHorizontal: 6 },
  btnDisabled: { opacity: 0.4 },
});
