import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  FlatList,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { Colors, Radius } from '../constants/colors';
import { STORES } from '../constants/stores';
import { presetMeals, meals as mealsApi } from '../lib/api';
import { PresetMeal } from '../types';
import Button from './ui/Button';

const RECENT_STORES_KEY = 'recentStores';

async function getRecentStores(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(RECENT_STORES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function recordRecentStore(storeId: string): Promise<void> {
  try {
    const recent = await getRecentStores();
    const updated = [storeId, ...recent.filter((id) => id !== storeId)].slice(0, 10);
    await SecureStore.setItemAsync(RECENT_STORES_KEY, JSON.stringify(updated));
  } catch {}
}

function sortedStores(recentIds: string[]) {
  const recent = recentIds
    .map((id) => STORES.find((s) => s.id === id))
    .filter(Boolean) as typeof STORES;
  const rest = STORES.filter((s) => !recentIds.includes(s.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...recent, ...rest];
}

interface StoreSelectorSheetProps {
  visible: boolean;
  meal: PresetMeal | null;
  onClose: () => void;
  onSaved?: () => void;
}

export default function StoreSelectorSheet({ visible, meal, onClose, onSaved }: StoreSelectorSheetProps) {
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [orderedStores, setOrderedStores] = useState(STORES);

  useEffect(() => {
    if (visible) {
      getRecentStores().then((recent) => setOrderedStores(sortedStores(recent)));
    }
  }, [visible]);

  async function handleSave() {
    if (!meal || !selectedStore) return;
    setLoading(true);
    try {
      // Create the actual user meal
      await mealsApi.create({
        name: meal.name,
        storeId: selectedStore,
        ingredients: meal.ingredients,
        photoUrl: meal.photoUrl ?? null,
        presetMealId: meal.id,
        ...(meal.author     ? { author:     meal.author }     : {}),
        ...(meal.story      ? { story:      meal.story }      : {}),
        ...(meal.difficulty != null ? { difficulty: meal.difficulty } : {}),
        ...(meal.tags?.length ? { tags: meal.tags }           : {}),
        ...(meal.source     ? { website:    meal.source }     : {}),
        ...(meal.recipe     ? { recipe:     meal.recipe }     : {}),
        ...(meal.creatorId  ? { creatorId:  meal.creatorId }  : {}),
      } as any);

      // Record analytics save (fire-and-forget)
      presetMeals.save(meal.id, selectedStore).catch(() => {});

      await recordRecentStore(selectedStore);
      Alert.alert('Saved!', `"${meal.name}" added to My Meals.`);
      onSaved?.();
      onClose();
      setSelectedStore(null);
    } catch (err: any) {
      if (err.status === 403) {
        Alert.alert('Limit Reached', 'You\'ve reached the free tier meal limit. Upgrade to save more meals.');
      } else {
        Alert.alert('Error', err.message || 'Could not save meal');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.title}>Save to My Meals</Text>
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.subtitle}>Which store do you shop at?</Text>

        <FlatList
          data={orderedStores}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.storeBtn, selectedStore === item.id && styles.storeBtnSelected]}
              onPress={() => setSelectedStore(item.id)}
            >
              <View style={[styles.dot, { backgroundColor: item.color }]} />
              <Text style={[styles.storeName, selectedStore === item.id && styles.storeNameSelected]}>
                {item.name}
              </Text>
              {selectedStore === item.id && <Text style={styles.check}>✓</Text>}
            </TouchableOpacity>
          )}
        />

        <View style={styles.footer}>
          <Button
            label="Save Meal"
            onPress={handleSave}
            loading={loading}
            disabled={!selectedStore}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: { fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  close: { fontSize: 20, color: Colors.text3 },
  subtitle: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    padding: 20,
    paddingBottom: 8,
  },
  list: { paddingHorizontal: 20 },
  storeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 10,
    backgroundColor: Colors.surfaceRaised,
  },
  storeBtnSelected: {
    borderColor: Colors.brand,
    backgroundColor: Colors.brandLight,
  },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: 12 },
  storeName: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Inter_500Medium',
    color: Colors.text1,
  },
  storeNameSelected: { color: Colors.brand },
  check: { fontSize: 18, color: Colors.brand },
  footer: { padding: 20 },
});
