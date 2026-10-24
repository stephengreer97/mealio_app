import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TextInput,
  TouchableOpacity,
  FlatList,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { Colors, Radius } from '../constants/colors';
import { Store } from '../constants/stores';
import { useStores } from '../lib/store-catalog/useStores';
import { filterStores } from '../lib/storeSearch';
import { presetMeals, meals as mealsApi } from '../lib/api';
import { PresetMeal } from '../types';
import Button from './ui/Button';
import { getDefaultStore, rememberDefaultStore } from '../lib/defaultStore';

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
    const updated = [storeId, ...recent.filter((id) => id !== storeId)].slice(0, 3);
    await SecureStore.setItemAsync(RECENT_STORES_KEY, JSON.stringify(updated));
  } catch {}
}

type StoreItem = Store;
type SectionHeader = { type: 'header'; label: string };
type ListItem = StoreItem | SectionHeader;

// `stores` is passed rather than read from the module, so the list rebuilds
// against the catalog that is live when the sheet opens — including one that
// arrived after this module was first imported.
function buildListItems(recentIds: string[], stores: StoreItem[]): ListItem[] {
  const recent = recentIds
    .map((id) => stores.find((s) => s.id === id))
    .filter(Boolean) as StoreItem[];
  const all = stores.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (recent.length === 0) return all;
  const recentIdSet = new Set(recent.map((s) => s.id));
  return [
    { type: 'header', label: 'Recent' },
    ...recent,
    { type: 'header', label: 'All Stores' },
    ...all.filter((s) => !recentIdSet.has(s.id)),
  ];
}

interface StoreSelectorSheetProps {
  visible: boolean;
  meal: PresetMeal | null;
  onClose: () => void;
  onSaved?: () => void;
}

export default function StoreSelectorSheet({ visible, meal, onClose, onSaved }: StoreSelectorSheetProps) {
  const [selectedStoreChoice, setSelectedStore] = useState<string | null>(null);
  const selectedStore = selectedStoreChoice;
  const [loading, setLoading] = useState(false);
  const stores = useStores();
  const [query, setQuery] = useState('');
  const [recentIds, setRecentIds] = useState<string[]>([]);
  /**
   * The account's store, once known. A save goes straight there and this sheet
   * never shows its list; only an account with no store yet is asked, and that
   * first choice becomes its store. `null` = asked and there is none.
   */
  const [accountStore, setAccountStore] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!visible) { setAccountStore(undefined); return; }
    let live = true;
    getDefaultStore().then((store) => {
      if (!live) return;
      setAccountStore(store);
      if (store) void handleSave(store);
    });
    return () => { live = false; };
    // handleSave reads `meal`, which is what opening the sheet is about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (visible) getRecentStores().then(setRecentIds);
    // Opening the sheet again starts from the whole list. A query left over from
    // the last save would hide most of the catalogue with no obvious cause.
    if (!visible) setQuery('');
  }, [visible]);

  /**
   * Searching flattens the list on purpose.
   *
   * Recent / All Stores is a good shape for browsing forty stores and a bad one
   * for four results: a "Recent" heading over one row and "All Stores" over
   * three reads as two lists when the user is looking at one answer. So a query
   * gets matches in alphabetical order and nothing else.
   */
  const searching = query.trim() !== '';
  const listItems: ListItem[] = React.useMemo(() => {
    if (searching) {
      return filterStores(stores, query).slice().sort((a, b) => a.name.localeCompare(b.name));
    }
    return buildListItems(recentIds, stores);
  }, [searching, query, stores, recentIds]);

  async function handleSave(storeOverride?: string) {
    const selectedStore = storeOverride ?? selectedStoreChoice;
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
        ...(meal.serves     ? { serves:     meal.serves }     : {}),
      } as any);

      // Record analytics save (fire-and-forget)
      presetMeals.save(meal.id, selectedStore).catch(() => {});

      await recordRecentStore(selectedStore);
      // A first save gives the account its store (the server adopted it).
      if (!storeOverride) rememberDefaultStore(selectedStore);
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
      // A direct save has no sheet on screen to return to.
      if (storeOverride) onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    // Shown only while the account has no store: with one, the save above has
    // already gone straight there.
    <Modal visible={visible && accountStore === null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.title}>Save to My Meals</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.subtitle}>Choose your store. Every meal goes there, and you can change it on My Meals.</Text>

        <View style={styles.searchRow}>
          <Ionicons name="search-outline" size={18} color={Colors.text3} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search stores"
            placeholderTextColor={Colors.text3}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            testID="store-search"
            // NO `clearButtonMode`: it is iOS-only and draws a NATIVE clear
            // button inside the field, which would sit beside the one below and
            // give iOS two X icons where Android has one (fixed once already on
            // the Discover search box).
          />
          {query.length > 0 && (
            <TouchableOpacity
              testID="store-search-clear"
              accessibilityRole="button"
              accessibilityLabel="Clear store search"
              onPress={() => setQuery('')}
              style={styles.searchClear}
            >
              <Ionicons name="close-circle" size={16} color={Colors.text3} />
            </TouchableOpacity>
          )}
        </View>

        <FlatList
          data={listItems}
          keyExtractor={(item) => ('type' in item ? `header-${item.label}` : item.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            if ('type' in item) {
              return <Text style={styles.sectionHeader}>{item.label}</Text>;
            }
            return (
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
            );
          }}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            searching ? (
              <Text style={styles.noResults} testID="store-search-empty">
                No stores match "{query.trim()}". Try the chain's name: searching Kroger or Albertsons finds the stores they own.
              </Text>
            ) : null
          }
        />

        <View style={styles.footer}>
          <Button
            label="Save Meal"
            onPress={() => void handleSave()}
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
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginBottom: 12,
    paddingHorizontal: 12,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  searchIcon: { marginRight: 8 },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
  },
  searchClear: { paddingLeft: 8, paddingVertical: 8 },
  noResults: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    textAlign: 'center',
    marginTop: 24,
    lineHeight: 20,
  },
  list: { paddingHorizontal: 20 },
  sectionHeader: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text3,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 12,
    marginBottom: 6,
  },
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
