import React, { useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TextInput,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../../constants/colors';
import { Meal, Ingredient } from '../../types';
import { meals as mealsApi, payments as paymentsApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { STORES } from '../../constants/stores';
import { ALL_TAGS } from '../../constants/tags';
import MealCard from '../../components/MealCard';
import MealDetailSheet from '../../components/MealDetailSheet';
import IngredientEditor from '../../components/IngredientEditor';
import PhotoPicker from '../../components/PhotoPicker';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import Tag from '../../components/ui/Tag';

const FREE_LIMIT = 3;

export default function MyMealsScreen() {
  const { user } = useAuth();
  const [allMeals, setAllMeals] = useState<Meal[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStore, setSelectedStore] = useState<string>(STORES[0].id);
  const [selectedMeal, setSelectedMeal] = useState<Meal | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);

  // Create meal form
  const [formVisible, setFormVisible] = useState(false);
  const [mealName, setMealName] = useState('');
  const [formStore, setFormStore] = useState('');
  const [ingredients, setIngredients] = useState<Ingredient[]>([{ productName: '', quantity: 1 }]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [mealAuthor, setMealAuthor] = useState('');
  const [mealStory, setMealStory] = useState('');
  const [mealRecipe, setMealRecipe] = useState('');
  const [mealSource, setMealSource] = useState('');
  const [tagSearch, setTagSearch] = useState('');
  const [storePickerVisible, setStorePickerVisible] = useState(false);
  const [storeSearch, setStoreSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [photoPreview, setPhotoPreview] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [pendingPhotoBase64, setPendingPhotoBase64] = useState<string | null>(null);
  const [photoIsUrl, setPhotoIsUrl] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadMeals();
    }, [])
  );

  async function loadMeals() {
    try {
      const data = await mealsApi.list();
      const seen = new Set<string>();
      const active = data.filter((m) => !m.deletedAt && !seen.has(m.id) && seen.add(m.id));
      setAllMeals(active);
      // Auto-select first store that has meals (if current selection has none)
      setSelectedStore((prev) => {
        const hasMealsAtCurrent = active.some((m) => m.storeId === prev);
        if (hasMealsAtCurrent) return prev;
        const firstWithMeals = STORES.find((s) => active.some((m) => m.storeId === s.id));
        return firstWithMeals ? firstWithMeals.id : prev;
      });
    } catch (err: any) {
      if (err.status !== 401) {
        Alert.alert('Error', err.message || 'Could not load meals');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  function handleRefresh() {
    setRefreshing(true);
    loadMeals();
  }

  async function handleUpgrade() {
    try {
      const { portalUrl } = await paymentsApi.portal();
      if (portalUrl) await Linking.openURL(portalUrl);
    } catch {}
  }

  function openCreate() {
    setMealName('');
    setFormStore('');
    setIngredients([{ productName: '', quantity: 1 }]);
    setSelectedTags([]);
    setDifficulty(null);
    setMealAuthor('');
    setMealStory('');
    setMealRecipe('');
    setMealSource('');
    setTagSearch('');
    setStoreSearch('');
    setPhotoPreview('');
    setPhotoUrl('');
    setPendingPhotoBase64(null);
    setPhotoIsUrl(false);
    setFormVisible(true);
  }

  async function handleCreate() {
    if (!mealName.trim()) {
      Alert.alert('Error', 'Meal name is required.');
      return;
    }
    if (!formStore) {
      Alert.alert('Error', 'Please select a store.');
      return;
    }
    const validIngredients = ingredients.filter((i) => i.productName.trim());
    if (validIngredients.length === 0) {
      Alert.alert('Error', 'Add at least one ingredient.');
      return;
    }
    if (validIngredients.some((i) => i.quantity === undefined)) {
      Alert.alert('Error', 'All ingredients need a quantity.');
      return;
    }
    setSaving(true);
    try {
      let finalPhotoUrl: string | null = null;
      if (photoIsUrl && photoUrl) {
        finalPhotoUrl = photoUrl;
      } else if (pendingPhotoBase64) {
        const { images: imagesApi } = await import('../../lib/api');
        const { url } = await imagesApi.upload(pendingPhotoBase64);
        finalPhotoUrl = url;
      }
      await mealsApi.create({
        name: mealName.trim(),
        storeId: formStore,
        ingredients: validIngredients,
        photoUrl: finalPhotoUrl,
        ...(selectedTags.length ? { tags: selectedTags } : {}),
        ...(difficulty != null ? { difficulty } : {}),
        ...(mealAuthor.trim() ? { author: mealAuthor.trim() } : {}),
        ...(mealStory.trim() ? { story: mealStory.trim() } : {}),
        ...(mealRecipe.trim() ? { recipe: mealRecipe.trim() } : {}),
        ...(mealSource.trim() ? { website: mealSource.trim() } : {}),
      } as any);
      setFormVisible(false);
      setSelectedStore(formStore);
      await loadMeals();
    } catch (err: any) {
      if (err.status === 403) {
        Alert.alert('Limit Reached', "You've reached the free tier meal limit. Upgrade to save more meals.");
      } else {
        Alert.alert('Error', err.message || 'Could not create meal');
      }
    } finally {
      setSaving(false);
    }
  }

  const storeMeals = allMeals.filter((m) => m.storeId === selectedStore);
  const storesWithMeals = STORES.filter((s) => allMeals.some((m) => m.storeId === s.id));
  const displayStores = storesWithMeals.length > 0 ? storesWithMeals : STORES.slice(0, 5);

  function openMeal(meal: Meal) {
    setSelectedMeal(meal);
    setDetailVisible(true);
  }

  const renderMeal = useCallback(({ item, index }: { item: Meal; index: number }) => {
    if (index % 2 !== 0) return null;
    const next = storeMeals[index + 1] ?? null;
    return (
      <View style={styles.mealRow}>
        <MealCard meal={item} onPress={() => openMeal(item)} subtitle={item.author ?? undefined} />
        {next ? <MealCard meal={next} onPress={() => openMeal(next)} subtitle={next.author ?? undefined} /> : <View style={{ flex: 1, marginHorizontal: 4 }} />}
      </View>
    );
  }, [storeMeals]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>My Meals</Text>
        <TouchableOpacity style={styles.addBtn} onPress={openCreate}>
          <Ionicons name="add" size={24} color={Colors.brand} />
        </TouchableOpacity>
      </View>

      {/* Store tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.storeTabsScroll}
        contentContainerStyle={styles.storeTabs}
      >
        {displayStores.map((store) => (
          <TouchableOpacity
            key={store.id}
            style={[styles.storeTab, selectedStore === store.id && styles.storeTabActive]}
            onPress={() => setSelectedStore(store.id)}
          >
            <View style={[styles.storeDot, { backgroundColor: store.color }]} />
            <Text style={[styles.storeTabText, selectedStore === store.id && styles.storeTabTextActive]}>
              {store.name}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {user?.tier !== 'paid' && (
        <View style={styles.tierBanner}>
          <View style={styles.tierBarRow}>
            <View style={styles.tierBarOuter}>
              <View style={[styles.tierBarFill, { width: `${Math.min(allMeals.length / FREE_LIMIT, 1) * 100}%` as any }]} />
            </View>
            <Text style={styles.tierCountText}>{allMeals.length}/{FREE_LIMIT}</Text>
          </View>
          <View style={styles.tierTextRow}>
            <Text style={styles.tierLabel}>
              {allMeals.length >= FREE_LIMIT
                ? 'Meal limit reached'
                : `${allMeals.length} of ${FREE_LIMIT} free meals saved`}
            </Text>
            <TouchableOpacity onPress={handleUpgrade}>
              <Text style={styles.upgradeLink}>Upgrade for unlimited →</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <FlatList
        data={storeMeals}
        keyExtractor={(item) => item.id}
        renderItem={renderMeal}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.brand} />}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🛒</Text>
              <Text style={styles.emptyTitle}>No meals yet</Text>
              <Text style={styles.emptyBody}>
                Save meals from Discover or tap + to create your own.
              </Text>
            </View>
          ) : null
        }
      />

      <MealDetailSheet
        visible={detailVisible}
        meal={selectedMeal}
        mode="edit"
        onClose={() => setDetailVisible(false)}
        onSave={(updated) => { loadMeals(); if (updated) setSelectedMeal(updated); }}
      />

      {/* Create meal modal */}
      <Modal visible={formVisible} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={styles.safe}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New Meal</Text>
              <TouchableOpacity onPress={() => setFormVisible(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Input
                label="Meal Name"
                placeholder="e.g. Lemon Herb Chicken"
                value={mealName}
                onChangeText={setMealName}
              />

              <Text style={styles.sectionLabel}>Photo (optional)</Text>
              <PhotoPicker
                mealName={mealName}
                previewUri={photoPreview}
                onPhotoReady={(uri, isUrl, base64) => {
                  setPhotoPreview(uri);
                  setPhotoIsUrl(isUrl);
                  if (isUrl) { setPhotoUrl(uri); setPendingPhotoBase64(null); }
                  else { setPendingPhotoBase64(base64 ?? null); setPhotoUrl(''); }
                }}
                onClear={() => { setPhotoPreview(''); setPhotoUrl(''); setPendingPhotoBase64(null); setPhotoIsUrl(false); }}
              />

              {/* Store selector */}
              <Text style={styles.sectionLabel}>Store *</Text>
              <TouchableOpacity
                style={styles.dropdown}
                onPress={() => { setStoreSearch(''); setStorePickerVisible(true); }}
              >
                {formStore ? (
                  <View style={styles.dropdownSelected}>
                    <View style={[styles.storeDot, { backgroundColor: STORES.find(s => s.id === formStore)?.color ?? Colors.border }]} />
                    <Text style={styles.dropdownSelectedText}>{STORES.find(s => s.id === formStore)?.name}</Text>
                  </View>
                ) : (
                  <Text style={styles.dropdownPlaceholder}>Select a store…</Text>
                )}
                <Ionicons name="chevron-down" size={18} color={Colors.text3} />
              </TouchableOpacity>

              <IngredientEditor ingredients={ingredients} onChange={setIngredients} />

              <Input
                label="Author (optional)"
                placeholder="e.g. Gordon Ramsay"
                value={mealAuthor}
                onChangeText={setMealAuthor}
              />

              <Input
                label="Recipe URL (optional)"
                placeholder="https://example.com/recipe"
                value={mealSource}
                onChangeText={setMealSource}
                keyboardType="url"
                autoCapitalize="none"
              />

              <Text style={styles.sectionLabel}>Story (optional)</Text>
              <TextInput
                style={styles.textArea}
                value={mealStory}
                onChangeText={setMealStory}
                placeholder="e.g. Perfect for a summer BBQ…"
                placeholderTextColor={Colors.text3}
                multiline
              />

              <Text style={styles.sectionLabel}>Recipe Instructions (optional)</Text>
              <TextInput
                style={[styles.textArea, { minHeight: 120 }]}
                value={mealRecipe}
                onChangeText={setMealRecipe}
                placeholder={'1. Boil 4 cups of water…\n2. Add pasta…'}
                placeholderTextColor={Colors.text3}
                multiline
              />

              {/* Difficulty */}
              <Text style={styles.sectionLabel}>Difficulty</Text>
              <View style={styles.diffRow}>
                {[1, 2, 3, 4, 5].map((d) => (
                  <TouchableOpacity
                    key={d}
                    style={[styles.diffBtn, difficulty === d && styles.diffBtnActive]}
                    onPress={() => setDifficulty(difficulty === d ? null : d)}
                  >
                    <View style={{ flexDirection: 'row', gap: 2 }}>
                      {[1, 2, 3, 4, 5].map((i) => (
                        <View key={i} style={[styles.dot, i <= d ? styles.dotFilled : styles.dotEmpty]} />
                      ))}
                    </View>
                    <Text style={[styles.diffLabel, difficulty === d && styles.diffLabelActive]}>{d}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Tags */}
              <Text style={styles.sectionLabel}>Tags</Text>
              <TextInput
                style={styles.tagSearchInput}
                placeholder="Search tags…"
                placeholderTextColor={Colors.text3}
                value={tagSearch}
                onChangeText={setTagSearch}
              />
              <ScrollView
                style={styles.tagScroll}
                nestedScrollEnabled
                showsVerticalScrollIndicator={false}
              >
                <View style={styles.tagsRow}>
                  {(tagSearch.trim()
                    ? ALL_TAGS.filter((t) => t.toLowerCase().includes(tagSearch.toLowerCase()))
                    : ALL_TAGS
                  ).map((tag) => (
                    <Tag
                      key={tag}
                      label={tag}
                      selected={selectedTags.includes(tag)}
                      onPress={() =>
                        setSelectedTags((prev) =>
                          prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
                        )
                      }
                    />
                  ))}
                </View>
              </ScrollView>
            </ScrollView>

            <View style={styles.modalFooter}>
              <Button
                label="Cancel"
                variant="secondary"
                onPress={() => setFormVisible(false)}
                style={{ flex: 1, marginRight: 8 }}
              />
              <Button label="Create Meal" onPress={handleCreate} loading={saving} style={{ flex: 2 }} />
            </View>

            {/* Store picker overlay — rendered inside the modal to avoid nested Modal issues */}
            {storePickerVisible && (
              <View style={styles.pickerOverlay}>
                <TouchableOpacity style={styles.pickerBackdrop} onPress={() => setStorePickerVisible(false)} />
                <View style={styles.pickerSheet}>
                  <View style={styles.pickerHeader}>
                    <Text style={styles.pickerTitle}>Select Store</Text>
                    <TouchableOpacity onPress={() => setStorePickerVisible(false)}>
                      <Ionicons name="close" size={22} color={Colors.text2} />
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    style={styles.pickerSearch}
                    placeholder="Search stores…"
                    placeholderTextColor={Colors.text3}
                    value={storeSearch}
                    onChangeText={setStoreSearch}
                  />
                  <FlatList
                    data={STORES.filter((s) =>
                      !storeSearch.trim() || s.name.toLowerCase().includes(storeSearch.toLowerCase())
                    )}
                    keyExtractor={(s) => s.id}
                    renderItem={({ item }) => (
                      <TouchableOpacity
                        style={[styles.pickerRow, formStore === item.id && styles.pickerRowActive]}
                        onPress={() => { setFormStore(item.id); setStorePickerVisible(false); }}
                      >
                        <View style={[styles.storeDot, { backgroundColor: item.color }]} />
                        <Text style={[styles.pickerRowText, formStore === item.id && styles.pickerRowTextActive]}>
                          {item.name}
                        </Text>
                        {formStore === item.id && <Ionicons name="checkmark" size={18} color={Colors.brand} />}
                      </TouchableOpacity>
                    )}
                    keyboardShouldPersistTaps="handled"
                  />
                </View>
              </View>
            )}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  title: { fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  addBtn: { padding: 4 },
  storeTabsScroll: { flexGrow: 0, flexShrink: 0 },
  storeTabs: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  storeTab: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
    gap: 6,
  },
  storeTabActive: {
    borderColor: Colors.brand,
    backgroundColor: Colors.brandLight,
  },
  storeDot: { width: 8, height: 8, borderRadius: 4 },
  storeTabText: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text2 },
  storeTabTextActive: { color: Colors.brand },
  tierBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: Colors.brandLight,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#fccdd4',
  },
  tierBarRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  tierBarOuter: {
    flex: 1,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#fccdd4',
    overflow: 'hidden',
  },
  tierBarFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: Colors.brand,
  },
  tierCountText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.brand },
  tierTextRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tierLabel: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text2 },
  upgradeLink: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.brand },
  list: { paddingHorizontal: 12, paddingBottom: 20 },
  mealRow: { flexDirection: 'row', justifyContent: 'space-between' },
  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 40 },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 8 },
  emptyBody: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    textAlign: 'center',
    lineHeight: 22,
  },
  // Modal
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  modalTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  modalClose: { fontSize: 20, color: Colors.text3 },
  modalScroll: { padding: 16, paddingBottom: 24 },
  modalFooter: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  sectionLabel: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text2,
    marginBottom: 10,
    marginTop: 4,
  },
  dropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
  },
  dropdownSelected: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dropdownSelectedText: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text1 },
  dropdownPlaceholder: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  pickerOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'flex-end',
    zIndex: 100,
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
    paddingBottom: 32,
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  pickerTitle: { fontSize: 17, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  pickerSearch: {
    margin: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    letterSpacing: 0,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  pickerRowActive: { backgroundColor: Colors.brandLight },
  pickerRowText: { flex: 1, fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.text1 },
  pickerRowTextActive: { fontFamily: 'Inter_600SemiBold', color: Colors.brand },
  diffRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  diffBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
    gap: 4,
  },
  diffBtnActive: { borderColor: Colors.brand, backgroundColor: Colors.brandLight },
  dot: { width: 5, height: 5, borderRadius: 3 },
  dotFilled: { backgroundColor: Colors.brand },
  dotEmpty: { backgroundColor: Colors.border },
  diffLabel: { fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.text3 },
  diffLabelActive: { color: Colors.brand },
  textArea: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    padding: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    minHeight: 80,
    textAlignVertical: 'top',
    marginBottom: 4,
    letterSpacing: 0,
  },
  tagSearchInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    marginBottom: 8,
    letterSpacing: 0,
  },
  tagScroll: {
    maxHeight: 180,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 8,
  },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap' },
});
