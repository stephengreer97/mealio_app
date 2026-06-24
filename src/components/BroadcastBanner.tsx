import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { Ionicons } from '@expo/vector-icons';
import { broadcast as broadcastApi, meals as mealsApi, type Broadcast } from '../lib/api';
import { Colors } from '../constants/colors';

// SecureStore key holding a JSON array of dismissed broadcast IDs. Dismissal is
// keyed by ID (not message text), so reusing wording still re-shows. forceShow
// broadcasts ignore this list and reappear every launch.
const DISMISS_KEY = 'broadcast_dismissed_ids';

async function readDismissed(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(DISMISS_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Stacked, dismissible banners for active broadcasts. Mounted once at the top of
 * the logged-in app. Each banner respects store targeting (only shown if the user
 * has a saved meal at a targeted store) and per-ID dismissal. Renders nothing
 * (no layout impact) when there's nothing to show.
 */
export default function BroadcastBanner() {
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState<Broadcast[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { broadcasts } = await broadcastApi.get();
        if (!broadcasts?.length) return;

        const dismissed = await readDismissed();
        let candidates = broadcasts.filter(
          (b) => b.message?.trim() && (b.forceShow || !dismissed.includes(b.id)),
        );
        if (candidates.length === 0) return;

        // Store targeting — fetch the user's meal stores once if any candidate targets stores.
        if (candidates.some((b) => b.stores?.length)) {
          let userStores: string[] = [];
          let mealsOk = true;
          try {
            const userMeals = await mealsApi.list();
            userStores = userMeals.map((m) => m.storeId).filter(Boolean);
          } catch {
            mealsOk = false; // couldn't verify — drop targeted ones, keep untargeted
          }
          candidates = candidates.filter(
            (b) => !b.stores?.length || (mealsOk && userStores.some((s) => b.stores.includes(s))),
          );
        }

        if (!cancelled && candidates.length) setVisible(candidates);
      } catch {
        // Broadcast is best-effort; never block the app on it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (visible.length === 0) return null;

  const dismiss = async (b: Broadcast) => {
    // forceShow broadcasts come back next launch, so only hide them for the session.
    if (!b.forceShow) {
      const ids = await readDismissed();
      if (!ids.includes(b.id)) {
        SecureStore.setItemAsync(DISMISS_KEY, JSON.stringify([...ids, b.id])).catch(() => {});
      }
    }
    setVisible((prev) => prev.filter((x) => x.id !== b.id));
  };

  return (
    <View style={{ backgroundColor: Colors.brand, paddingTop: insets.top }}>
      {visible.map((b, i) => (
        <View key={b.id} style={[styles.bar, i > 0 && styles.divider]}>
          <Ionicons name="megaphone-outline" size={16} color="#fff" style={{ marginRight: 8 }} />
          <Text style={styles.text}>{b.message}</Text>
          <TouchableOpacity onPress={() => dismiss(b)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.25)',
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
