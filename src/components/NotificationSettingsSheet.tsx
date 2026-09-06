import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, ScrollView, Switch, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { account } from '../lib/api';

/**
 * MEAL-217. Which notifications Mealio may send you.
 *
 * THE CATEGORIES COME FROM THE SERVER, not from this file. A list baked into
 * the app is a list that goes stale the moment a build ships: a category added
 * server-side would reach nobody until everyone updated, and one removed would
 * leave a switch behind that controls nothing. The server returns what it
 * actually sends, filtered to what this account can receive — a creator-only
 * category is not offered to someone who is not a creator, because a switch
 * that does nothing for you is worse than no switch.
 *
 * The master switch is stored separately from the per-category ones rather than
 * writing false into all of them, so turning it back on restores what you chose
 * instead of flattening it. That is why the rows stay visible, and disabled,
 * while it is off: they still say what you picked.
 */

type Category = { id: string; label: string; description: string };

export default function NotificationSettingsSheet({
  visible, onClose, deliverable = true,
}: {
  visible: boolean;
  onClose: () => void;
  /**
   * Can this device actually receive a push right now?
   *
   * False when registration failed -- the OS said yes and no token could be
   * obtained, which on Android means the build has no FCM credentials. The
   * screen is still worth opening in that state: the choices are per ACCOUNT,
   * they store fine, and they apply the moment a token exists. But it has to
   * say so, or it is a screen of switches that silently do nothing on the
   * device you are holding.
   */
  deliverable?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  /** Ids currently being written, so a row cannot be toggled twice mid-flight. */
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setLoading(true);
    setError(null);
    account.notificationPrefs()
      .then((r) => {
        if (!alive) return;
        setCategories(r.categories ?? []);
        setPrefs(r.prefs ?? {});
      })
      .catch(() => { if (alive) setError('Could not load your settings.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [visible]);

  /** Absent means ON — the server's rule, and it has to be the screen's too. */
  const isOn = useCallback((id: string) => prefs[id] !== false, [prefs]);
  const allOn = prefs.all !== false;

  const toggle = useCallback(async (id: string, next: boolean) => {
    // OPTIMISTIC, then reconciled against what the server stored. A switch that
    // waits for a round trip before moving feels broken on a slow connection,
    // and this is the kind of screen people flick through.
    const before = prefs;
    setPrefs((p) => ({ ...p, [id]: next }));
    setSaving((s) => ({ ...s, [id]: true }));
    try {
      const res = await account.setNotificationPref({ [id]: next });
      setPrefs(res.prefs ?? { ...before, [id]: next });
    } catch {
      // Put it back. Leaving it where the user flicked it would show a setting
      // that is not the one in force.
      setPrefs(before);
      setError('That did not save. Check your connection and try again.');
    } finally {
      setSaving((s) => { const { [id]: _gone, ...rest } = s; return rest; });
    }
  }, [prefs]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <View style={{ width: 28 }} />
          <Text style={styles.title}>Notifications</Text>
          <TouchableOpacity onPress={onClose} testID="notif-close" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.centre} testID="notif-loading">
            <ActivityIndicator color={Colors.brand} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            {error && <Text style={styles.error} testID="notif-error">{error}</Text>}

            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>All notifications</Text>
                <Text style={styles.rowDesc}>
                  Turn everything off without losing what you picked below.
                </Text>
              </View>
              <Switch
                testID="notif-toggle-all"
                value={allOn}
                disabled={!!saving.all}
                onValueChange={(v) => toggle('all', v)}
                trackColor={{ true: Colors.brand, false: Colors.border }}
              />
            </View>

            <View style={styles.divider} />

            {!deliverable && (
              <Text style={styles.notice} testID="notif-undeliverable">
                This device cannot receive notifications yet, so nothing here will
                reach it. Your choices are saved to your account and apply as soon
                as it can.
              </Text>
            )}

            {categories.length === 0 && !error && (
              // Honest rather than an empty screen. It is also the true state
              // for an account with nothing to receive.
              <Text style={styles.rowDesc} testID="notif-empty">
                There is nothing to choose from yet.
              </Text>
            )}

            {categories.map((c) => (
              <View key={c.id} style={styles.row} testID={`notif-row-${c.id}`}>
                <View style={styles.rowText}>
                  <Text style={[styles.rowLabel, !allOn && styles.dimmed]}>{c.label}</Text>
                  <Text style={[styles.rowDesc, !allOn && styles.dimmed]}>{c.description}</Text>
                </View>
                <Switch
                  testID={`notif-toggle-${c.id}`}
                  value={isOn(c.id)}
                  // Off, not hidden, while the master switch is off: the row
                  // still says what you chose, so turning everything back on
                  // holds no surprises.
                  disabled={!allOn || !!saving[c.id]}
                  onValueChange={(v) => toggle(c.id, v)}
                  trackColor={{ true: Colors.brand, false: Colors.border }}
                />
              </View>
            ))}

            <Text style={styles.footnote}>
              Turning a notification off here stops Mealio sending it. Your phone&apos;s own
              settings can switch them all off too.
            </Text>
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  title: { fontSize: 16, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  close: { fontSize: 18, color: Colors.text3 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 20, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 14 },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  rowDesc: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text3, marginTop: 2 },
  dimmed: { opacity: 0.45 },
  divider: { height: 1, backgroundColor: Colors.border, marginVertical: 6 },
  notice: {
    fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2,
    backgroundColor: '#f0f6ff', borderWidth: 1, borderColor: '#c8dcf8',
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    marginBottom: 10, lineHeight: 18,
  },
  error: {
    fontSize: 13, fontFamily: 'Inter_500Medium', color: '#b45309',
    backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fbbf24',
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8,
  },
  footnote: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, marginTop: 20, lineHeight: 17 },
});
