import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { Ionicons } from '@expo/vector-icons';
import { broadcast as broadcastApi, meals as mealsApi } from '../lib/api';
import { Colors } from '../constants/colors';

// SecureStore key holding the last broadcast message the user dismissed, so the
// same message doesn't reappear (a new/changed message will, since it won't match).
const DISMISS_KEY = 'broadcast_dismissed';

/**
 * Dismissible banner that surfaces the server broadcast message. Mounted once at
 * the top of the logged-in app. Respects store targeting: when the broadcast has
 * a non-empty store list, it only shows if the user has a saved meal at one of
 * those stores. Renders nothing (no layout impact) when there's nothing to show.
 */
export default function BroadcastBanner() {
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { message: msg, stores } = await broadcastApi.get();
        if (!msg) return;

        const dismissed = await SecureStore.getItemAsync(DISMISS_KEY).catch(() => null);
        if (dismissed === msg) return;

        // Store targeting — only show if the user has a meal at a targeted store.
        if (stores && stores.length > 0) {
          let userStores: string[] = [];
          try {
            const userMeals = await mealsApi.list();
            userStores = userMeals.map((m) => m.storeId).filter(Boolean);
          } catch {
            // Couldn't load meals — don't risk showing a targeted message to the
            // wrong audience; skip it this session.
            return;
          }
          if (!userStores.some((s) => stores.includes(s))) return;
        }

        if (!cancelled) setMessage(msg);
      } catch {
        // Broadcast is best-effort; never block the app on it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!message) return null;

  const dismiss = () => {
    SecureStore.setItemAsync(DISMISS_KEY, message).catch(() => {});
    setMessage(null);
  };

  return (
    <View style={[styles.bar, { paddingTop: insets.top + 10 }]}>
      <Ionicons name="megaphone-outline" size={16} color="#fff" style={{ marginRight: 8 }} />
      <Text style={styles.text}>{message}</Text>
      <TouchableOpacity onPress={dismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="close" size={18} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.brand,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  text: {
    flex: 1,
    color: '#fff',
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    marginRight: 8,
    lineHeight: 18,
  },
});
