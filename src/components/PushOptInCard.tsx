import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { Feather } from '@expo/vector-icons';
import { Colors, Radius } from '../constants/colors';
import { FEATURE_PUSH_PROMPT } from '../constants/features';
import { enablePush, getPermission, supportsRemotePush } from '../lib/push';
import Button from './ui/Button';

// ─────────────────────────────────────────────────────────────────────────────
// PushOptInCard — the in-app soft ask (MEAL-88)
//
// Placed in the Creator Portal, not on launch. A first-launch prompt arrives
// before the user knows what the app is, gets reflexively dismissed, and on iOS
// there is no second chance. Here the person reading it publishes meals, is
// looking at their own portal, and the card can name exactly what it will send.
//
// The system prompt only fires after a tap on THIS card, so saying "not now"
// costs nothing — the OS prompt is still unspent and Account → Notifications can
// still turn it on later.
//
// Renders nothing at all once granted, once dismissed, or where remote push
// cannot work (Expo Go). Nothing here nags: dismissal is permanent.
// ─────────────────────────────────────────────────────────────────────────────

const DISMISS_KEY = 'push_prompt_dismissed';

export default function PushOptInCard() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!FEATURE_PUSH_PROMPT || !supportsRemotePush()) return;
      // 'denied' is deliberately not shown either: re-asking someone who already
      // said no is the definition of nagging, and the OS would no-op anyway.
      if ((await getPermission()) !== 'undetermined') return;
      const dismissed = await SecureStore.getItemAsync(DISMISS_KEY).catch(() => null);
      if (!cancelled && !dismissed) setVisible(true);
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleEnable() {
    setBusy(true);
    try {
      await enablePush();
    } finally {
      // Whatever the answer, the card's job is done — a denial must not leave a
      // button that now does nothing.
      setBusy(false);
      setVisible(false);
    }
  }

  async function handleDismiss() {
    setVisible(false);
    await SecureStore.setItemAsync(DISMISS_KEY, '1').catch(() => {});
  }

  if (!visible) return null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Feather name="bell" size={16} color={Colors.brand} style={{ marginRight: 6 }} />
        <Text style={styles.title}>Know when a recipe needs you</Text>
        <TouchableOpacity onPress={handleDismiss} hitSlop={8} accessibilityLabel="Dismiss">
          <Feather name="x" size={16} color={Colors.text3} />
        </TouchableOpacity>
      </View>
      <Text style={styles.body}>
        Turn on notifications and we'll tell you when one of your recipes is imported and waiting for
        your review — instead of you having to check the portal.
      </Text>
      <View style={styles.actions}>
        <Button label="Not now" variant="ghost" size="sm" onPress={handleDismiss} />
        <Button label="Turn on notifications" size="sm" loading={busy} onPress={handleEnable} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.brandLight,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    marginBottom: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  title: { flex: 1, fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  body: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 19 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 12 },
});
