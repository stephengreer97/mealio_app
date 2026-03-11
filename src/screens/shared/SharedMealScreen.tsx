import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  FlatList,
  Alert,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../../constants/colors';
import { shared as sharedApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { STORES } from '../../constants/stores';
import { Ingredient } from '../../types';
import Button from '../../components/ui/Button';
import * as SecureStore from 'expo-secure-store';

const RECENT_STORES_KEY = 'recentStores';

async function getRecentStores(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(RECENT_STORES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function recordRecentStore(storeId: string) {
  try {
    const recent = await getRecentStores();
    const updated = [storeId, ...recent.filter(id => id !== storeId)].slice(0, 10);
    await SecureStore.setItemAsync(RECENT_STORES_KEY, JSON.stringify(updated));
  } catch {}
}

function sortedStores(recentIds: string[]) {
  const recent = recentIds.map(id => STORES.find(s => s.id === id)).filter(Boolean) as typeof STORES;
  const rest = STORES.filter(s => !recentIds.includes(s.id)).slice().sort((a, b) => a.name.localeCompare(b.name));
  return [...recent, ...rest];
}

interface Props {
  token: string | null;
  onClose: () => void;
}

interface SharedMeal {
  id: string;
  name: string;
  store_id: string;
  ingredients: Ingredient[];
  author: string | null;
  difficulty: number | null;
  website: string | null;
  recipe: string | null;
  photo_url: string | null;
}

export default function SharedMealScreen({ token, onClose }: Props) {
  const { user } = useAuth();
  const [meal, setMeal] = useState<SharedMeal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Store picker state
  const [pickerVisible, setPickerVisible] = useState(false);
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const [orderedStores, setOrderedStores] = useState(STORES);
  const [saving, setSaving] = useState(false);

  const visible = !!token;

  useEffect(() => {
    if (token) {
      setMeal(null);
      setError(null);
      setLoading(true);
      setPickerVisible(false);
      setSelectedStore(null);
      fetchMeal(token);
    }
  }, [token]);

  useEffect(() => {
    if (pickerVisible) {
      getRecentStores().then(recent => setOrderedStores(sortedStores(recent)));
    }
  }, [pickerVisible]);

  async function fetchMeal(t: string) {
    try {
      const { meal: m } = await sharedApi.getMeal(t);
      setMeal(m);
    } catch (err: any) {
      setError(err.message || 'Could not load meal');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!token || !selectedStore) return;
    setSaving(true);
    try {
      await sharedApi.saveMeal(token, selectedStore);
      await recordRecentStore(selectedStore);
      setPickerVisible(false);
      Alert.alert('Saved!', `"${meal?.name}" added to My Meals.`, [
        { text: 'OK', onPress: onClose },
      ]);
    } catch (err: any) {
      if (err.status === 403) {
        Alert.alert('Limit Reached', 'You\'ve reached the free tier meal limit. Upgrade to save more meals.');
      } else {
        Alert.alert('Error', err.message || 'Could not save meal');
      }
    } finally {
      setSaving(false);
    }
  }

  const difficulty = meal?.difficulty ?? null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Shared Meal</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={24} color={Colors.text2} />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={Colors.brand} />
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <Text style={styles.errorIcon}>😕</Text>
            <Text style={styles.errorTitle}>Meal not found</Text>
            <Text style={styles.errorSub}>This share link may have expired or been removed.</Text>
          </View>
        ) : meal ? (
          <>
            <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
              {/* Photo */}
              {meal.photo_url ? (
                <Image source={{ uri: meal.photo_url }} style={styles.photo} contentFit="cover" />
              ) : (
                <View style={[styles.photo, styles.photoPlaceholder]}>
                  <Text style={styles.photoPlaceholderIcon}>🍽️</Text>
                </View>
              )}

              <View style={styles.body}>
                {/* Name */}
                <Text style={styles.mealName}>{meal.name}</Text>

                {/* Author + difficulty row */}
                <View style={styles.metaRow}>
                  {meal.author ? (
                    <Text style={styles.author}>by {meal.author}</Text>
                  ) : null}
                  {difficulty != null && (
                    <View style={styles.diffRow}>
                      {[1, 2, 3, 4, 5].map(i => (
                        <View
                          key={i}
                          style={[styles.diffDot, i <= difficulty ? styles.diffDotFilled : styles.diffDotEmpty]}
                        />
                      ))}
                    </View>
                  )}
                </View>

                {/* Ingredients */}
                <Text style={styles.sectionTitle}>Ingredients</Text>
                {meal.ingredients.map((ing, idx) => (
                  <View key={idx} style={styles.ingredientRow}>
                    <View style={styles.bullet} />
                    <Text style={styles.ingredientText}>
                      {ing.productName}
                      {ing.quantity != null && ing.quantity > 1 ? ` × ${ing.quantity}` : ''}
                    </Text>
                  </View>
                ))}

                {/* Recipe instructions */}
                {meal.recipe ? (
                  <>
                    <Text style={styles.sectionTitle}>Recipe</Text>
                    <Text style={styles.recipeText}>{meal.recipe}</Text>
                  </>
                ) : null}

                {/* Recipe URL */}
                {meal.website ? (
                  <TouchableOpacity
                    style={styles.linkBtn}
                    onPress={() => Linking.openURL(meal.website!)}
                  >
                    <Ionicons name="open-outline" size={15} color={Colors.brand} />
                    <Text style={styles.linkText}>View full recipe</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </ScrollView>

            {/* Footer */}
            <View style={styles.footer}>
              {!user ? (
                <Text style={styles.loginPrompt}>Sign in to save this meal to your account</Text>
              ) : (
                <Button
                  label="Save to My Meals"
                  onPress={() => setPickerVisible(true)}
                />
              )}
            </View>

            {/* Store picker overlay */}
            {pickerVisible && (
              <View style={styles.pickerOverlay}>
                <TouchableOpacity
                  style={styles.pickerBackdrop}
                  onPress={() => setPickerVisible(false)}
                  activeOpacity={1}
                />
                <View style={styles.pickerSheet}>
                  <View style={styles.pickerHeader}>
                    <Text style={styles.pickerTitle}>Which store do you shop at?</Text>
                    <TouchableOpacity onPress={() => setPickerVisible(false)}>
                      <Ionicons name="close" size={22} color={Colors.text2} />
                    </TouchableOpacity>
                  </View>
                  <FlatList
                    data={orderedStores}
                    keyExtractor={s => s.id}
                    style={styles.storeList}
                    renderItem={({ item }) => (
                      <TouchableOpacity
                        style={[styles.storeBtn, selectedStore === item.id && styles.storeBtnSelected]}
                        onPress={() => setSelectedStore(item.id)}
                      >
                        <View style={[styles.storeDot, { backgroundColor: item.color }]} />
                        <Text style={[styles.storeName, selectedStore === item.id && styles.storeNameSelected]}>
                          {item.name}
                        </Text>
                        {selectedStore === item.id && <Text style={styles.storeCheck}>✓</Text>}
                      </TouchableOpacity>
                    )}
                  />
                  <View style={styles.pickerFooter}>
                    <Button
                      label="Save Meal"
                      onPress={handleSave}
                      loading={saving}
                      disabled={!selectedStore}
                    />
                  </View>
                </View>
              </View>
            )}
          </>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: 17, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  closeBtn: { padding: 4 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  errorIcon: { fontSize: 48, marginBottom: 12 },
  errorTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 6 },
  errorSub: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text3, textAlign: 'center' },
  scroll: { paddingBottom: 20 },
  photo: { width: '100%', height: 240 },
  photoPlaceholder: {
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoPlaceholderIcon: { fontSize: 56 },
  body: { padding: 16 },
  mealName: { fontSize: 26, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 },
  author: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text2 },
  diffRow: { flexDirection: 'row', gap: 4 },
  diffDot: { width: 8, height: 8, borderRadius: 4 },
  diffDotFilled: { backgroundColor: Colors.brand },
  diffDotEmpty: { backgroundColor: Colors.border },
  sectionTitle: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
    color: Colors.text1,
    marginBottom: 10,
    marginTop: 4,
  },
  ingredientRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  bullet: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.brand, marginRight: 10 },
  ingredientText: { fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.text1 },
  recipeText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    lineHeight: 22,
    marginBottom: 12,
  },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    marginTop: 4,
  },
  linkText: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.brand },
  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  loginPrompt: {
    textAlign: 'center',
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    paddingVertical: 8,
  },
  // Store picker overlay
  pickerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  pickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  pickerSheet: {
    backgroundColor: Colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  pickerTitle: { fontSize: 17, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  storeList: { paddingHorizontal: 16 },
  storeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    marginTop: 8,
    backgroundColor: Colors.surfaceRaised,
  },
  storeBtnSelected: { borderColor: Colors.brand, backgroundColor: Colors.brandLight },
  storeDot: { width: 12, height: 12, borderRadius: 6, marginRight: 12 },
  storeName: { flex: 1, fontSize: 15, fontFamily: 'Inter_500Medium', color: Colors.text1 },
  storeNameSelected: { color: Colors.brand },
  storeCheck: { fontSize: 16, color: Colors.brand },
  pickerFooter: { padding: 16 },
});
