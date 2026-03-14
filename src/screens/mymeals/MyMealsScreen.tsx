import React, { useState, useCallback, useEffect } from 'react';
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
import { meals as mealsApi, payments as paymentsApi, kroger as krogerApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { STORES, isKrogerBrand } from '../../constants/stores';
import { ALL_TAGS } from '../../constants/tags';
import MealCard from '../../components/MealCard';
import MealDetailSheet from '../../components/MealDetailSheet';
import KrogerCartReviewSheet from '../../components/KrogerCartReviewSheet';
import IngredientEditor from '../../components/IngredientEditor';
import PhotoPicker from '../../components/PhotoPicker';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import Tag from '../../components/ui/Tag';

const FREE_LIMIT = 3;

export default function MyMealsScreen() {
  const { user, isCreator } = useAuth();
  const [allMeals, setAllMeals] = useState<Meal[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStore, setSelectedStore] = useState<string>(STORES[0].id);
  const [selectedMeal, setSelectedMeal] = useState<Meal | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [krogerConnected, setKrogerConnected] = useState(false);
  const [krogerLocations, setKrogerLocations] = useState<Record<string, { locationId: string; locationName: string }>>({});

  // Multi-select / Kroger cart
  const [selectedMealIds, setSelectedMealIds] = useState<Set<string>>(new Set());
  const [reviewVisible, setReviewVisible] = useState(false);

  // Kroger store picker
  const [krogerPickerVisible, setKrogerPickerVisible] = useState(false);
  const [krogerZip, setKrogerZip] = useState('');
  const [krogerLocationsList, setKrogerLocationsList] = useState<Array<{ locationId: string; name: string; storeId: string; address: string }>>([]);
  const [krogerSearching, setKrogerSearching] = useState(false);
  const [krogerSaving, setKrogerSaving] = useState(false);

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
      krogerApi.status().then(d => {
        setKrogerConnected(d.connected);
        if (d.connected) {
          setKrogerLocations(d.locations ?? {});
        } else {
          setKrogerLocations({});
        }
      }).catch(() => {});
    }, [])
  );

  // Refresh Kroger status when returning from OAuth in browser
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url === 'mealio://kroger/connected') {
        krogerApi.status().then(d => {
          setKrogerConnected(d.connected);
          if (d.connected) {
            setKrogerLocations(d.locations ?? {});
            if (!d.locations?.[selectedStore]) {
              setKrogerZip('');
              setKrogerLocationsList([]);
              setKrogerPickerVisible(true);
            }
          }
        }).catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  async function handleKrogerConnect() {
    try {
      const { redirectUrl } = await krogerApi.connect(selectedStore);
      await Linking.openURL(redirectUrl);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not connect to Kroger');
    }
  }

  async function handleCartButtonPress() {
    let connected = krogerConnected;
    let locations = krogerLocations;

    // If state says not connected, do a live check first — the async status
    // fetch from useFocusEffect or the OAuth deep link handler may not have
    // resolved yet (e.g. user taps quickly after returning from browser).
    if (!connected) {
      try {
        const d = await krogerApi.status();
        connected = d.connected;
        locations = d.locations ?? {};
        if (connected) {
          setKrogerConnected(true);
          setKrogerLocations(locations);
        }
      } catch {}
    }

    if (!connected) {
      const storeName = selectedStore_?.name ?? 'This store';
      Alert.alert(
        `Connect ${storeName}`,
        `${storeName} is part of the Kroger family of stores. To add meals to your cart, you'll need to connect your Kroger account.\n\nYou'll be taken to Kroger's sign-in page in your browser and returned to Mealio once connected.`,
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Connect Account', onPress: handleKrogerConnect },
        ]
      );
      return;
    }
    const currentLocationId = locations[selectedStore]?.locationId ?? null;
    if (!currentLocationId) {
      setKrogerZip('');
      setKrogerLocationsList([]);
      setKrogerPickerVisible(true);
      return;
    }
    setReviewVisible(true);
  }

  async function handleKrogerSearchStores() {
    if (!krogerZip.trim()) return;
    setKrogerSearching(true);
    setKrogerLocationsList([]);
    try {
      const { locations } = await krogerApi.searchLocations(krogerZip.trim());
      setKrogerLocationsList(locations);
      if (locations.length === 0) Alert.alert('No stores found', 'No Kroger-family stores found near that ZIP code.');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not search stores');
    } finally {
      setKrogerSearching(false);
    }
  }

  async function handleKrogerSaveLocation(loc: { locationId: string; name: string; storeId: string; address: string }) {
    setKrogerSaving(true);
    try {
      await krogerApi.setLocation(loc.locationId, loc.name, loc.storeId);
      setKrogerLocations(prev => ({ ...prev, [loc.storeId]: { locationId: loc.locationId, locationName: loc.name } }));
      setKrogerPickerVisible(false);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not save store');
    } finally {
      setKrogerSaving(false);
    }
  }

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
  const storesWithMeals = STORES
    .filter((s) => allMeals.some((m) => m.storeId === s.id))
    .sort((a, b) => allMeals.filter((m) => m.storeId === b.id).length - allMeals.filter((m) => m.storeId === a.id).length);
  const displayStores = storesWithMeals.length > 0 ? storesWithMeals : STORES.slice(0, 5);
  const isKroger = isKrogerBrand(selectedStore);
  const selectedMeals = storeMeals.filter((m) => selectedMealIds.has(m.id));
  const selectedStore_ = STORES.find((s) => s.id === selectedStore);

  function openMeal(meal: Meal) {
    setSelectedMeal(meal);
    setDetailVisible(true);
  }

  function toggleMealSelect(id: string) {
    setSelectedMealIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const renderMeal = useCallback(({ item, index }: { item: Meal; index: number }) => {
    if (index % 2 !== 0) return null;
    const next = storeMeals[index + 1] ?? null;
    return (
      <View style={styles.mealRow}>
        <MealCard
          meal={item}
          onPress={isKroger ? () => toggleMealSelect(item.id) : () => openMeal(item)}
          subtitle={item.author ?? undefined}
          selected={isKroger ? selectedMealIds.has(item.id) : undefined}
          onView={isKroger ? () => openMeal(item) : undefined}
        />
        {next ? (
          <MealCard
            meal={next}
            onPress={isKroger ? () => toggleMealSelect(next.id) : () => openMeal(next)}
            subtitle={next.author ?? undefined}
            selected={isKroger ? selectedMealIds.has(next.id) : undefined}
            onView={isKroger ? () => openMeal(next) : undefined}
          />
        ) : (
          <View style={{ flex: 1, marginHorizontal: 4 }} />
        )}
      </View>
    );
  }, [storeMeals, isKroger, selectedMealIds]);

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
            onPress={() => { setSelectedStore(store.id); setSelectedMealIds(new Set()); }}
          >
            <View style={[styles.storeDot, { backgroundColor: store.color }]} />
            <Text style={[styles.storeTabText, selectedStore === store.id && styles.storeTabTextActive]}>
              {store.name}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {!isKroger && (
        <View style={styles.krogerNotice}>
          <Text style={styles.krogerNoticeText}>
            <Text style={styles.krogerNoticeBold}>{selectedStore_?.name ?? 'This store'}</Text>
            {' '}does not currently support one-click add to cart. Try the Mealio desktop browser extension for one-click add to cart. Stay tuned for updates!
          </Text>
        </View>
      )}

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
        extraData={selectedMealIds}
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

      {isKroger && selectedMealIds.size > 0 && (
        <TouchableOpacity style={[styles.floatingCart, { backgroundColor: selectedStore_?.color ?? Colors.brand }]} onPress={handleCartButtonPress} activeOpacity={0.88}>
          <Ionicons name="cart" size={18} color="#fff" />
          <Text style={styles.floatingCartText}>
            Add {selectedMealIds.size} meal{selectedMealIds.size !== 1 ? 's' : ''} to {selectedStore_?.name ?? 'cart'}
          </Text>
        </TouchableOpacity>
      )}

      <MealDetailSheet
        visible={detailVisible}
        meal={selectedMeal}
        mode="edit"
        onClose={() => setDetailVisible(false)}
        onSave={(updated) => { loadMeals(); if (updated) setSelectedMeal(updated); }}
        krogerLocationId={krogerLocations[selectedMeal?.storeId ?? '']?.locationId ?? null}
        onNeedKrogerStore={() => { setKrogerZip(''); setKrogerLocationsList([]); setKrogerPickerVisible(true); }}
        hideShare={isCreator}
      />

      <KrogerCartReviewSheet
        visible={reviewVisible}
        meals={selectedMeals}
        locationId={krogerLocations[selectedStore]?.locationId ?? ''}
        storeId={selectedStore}
        storeName={selectedStore_?.name ?? 'Kroger'}
        onClose={() => { setReviewVisible(false); setSelectedMealIds(new Set()); }}
        onMealUpdated={(updated) => {
          setAllMeals((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
        }}
      />

      {/* Kroger store picker */}
      <Modal visible={krogerPickerVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setKrogerPickerVisible(false)}>
        <SafeAreaView style={styles.safe}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select Your Store</Text>
            <TouchableOpacity onPress={() => setKrogerPickerVisible(false)}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.sectionLabel}>Find a nearby {selectedStore_?.name ?? 'Kroger'} store</Text>
            <View style={styles.krogerZipRow}>
              <TextInput
                style={styles.krogerZipInput}
                placeholder="ZIP code"
                placeholderTextColor={Colors.text3}
                value={krogerZip}
                onChangeText={setKrogerZip}
                keyboardType="numeric"
                maxLength={10}
                returnKeyType="search"
                onSubmitEditing={handleKrogerSearchStores}
              />
              <TouchableOpacity
                style={[styles.krogerSearchBtn, (!krogerZip.trim() || krogerSearching) && { opacity: 0.5 }]}
                onPress={handleKrogerSearchStores}
                disabled={!krogerZip.trim() || krogerSearching}
              >
                <Text style={styles.krogerSearchBtnText}>{krogerSearching ? '…' : 'Search'}</Text>
              </TouchableOpacity>
            </View>
            {krogerLocationsList.map((loc) => (
              <TouchableOpacity
                key={loc.locationId}
                style={[styles.krogerLocRow, krogerLocations[loc.storeId]?.locationId === loc.locationId && styles.krogerLocRowActive]}
                onPress={() => handleKrogerSaveLocation(loc)}
                disabled={krogerSaving}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.krogerLocName}>{loc.name}</Text>
                  <Text style={styles.krogerLocAddr} numberOfLines={1}>{loc.address}</Text>
                </View>
                {krogerLocations[loc.storeId]?.locationId === loc.locationId
                  ? <Ionicons name="checkmark" size={18} color={Colors.brand} />
                  : <Ionicons name="chevron-forward" size={16} color={Colors.text3} />
                }
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>

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
  krogerNotice: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    backgroundColor: '#fff8e1',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#ffe082',
  },
  krogerNoticeText: {
    fontSize: 13,
    color: '#7a5c00',
    lineHeight: 19,
  },
  krogerNoticeBold: {
    fontWeight: '600',
  },
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
  floatingCart: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    backgroundColor: Colors.brand,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  floatingCartText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: '#fff',
  },
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
  krogerZipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  krogerZipInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
  },
  krogerSearchBtn: {
    backgroundColor: Colors.brand,
    borderRadius: Radius.input,
    paddingHorizontal: 16,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  krogerSearchBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: '#fff' },
  krogerLocRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
    backgroundColor: Colors.surfaceRaised,
    gap: 10,
  },
  krogerLocRowActive: { borderColor: Colors.brand, backgroundColor: Colors.brandLight },
  krogerLocName: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1, marginBottom: 2 },
  krogerLocAddr: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3 },
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
