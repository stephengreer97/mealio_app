import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  FlatList,
  TouchableOpacity,
  Modal,
  Alert,
  TextInput,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import PhotoPicker from '../../components/PhotoPicker';
import { Colors, Radius } from '../../constants/colors';
import { Creator, PresetMeal, Ingredient } from '../../types';
import { creators as creatorsApi } from '../../lib/api';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import IngredientEditor from '../../components/IngredientEditor';
import Tag from '../../components/ui/Tag';
import { ALL_TAGS } from '../../constants/tags';

export default function CreatorPortalScreen() {
  const [creator, setCreator] = useState<Creator | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [meals, setMeals] = useState<PresetMeal[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [formVisible, setFormVisible] = useState(false);
  const [editingMeal, setEditingMeal] = useState<PresetMeal | null>(null);
  const [mealName, setMealName] = useState('');
  const [mealStory, setMealStory] = useState('');
  const [mealRecipe, setMealRecipe] = useState('');
  const [mealSource, setMealSource] = useState('');
  const [mealIngredients, setMealIngredients] = useState<Ingredient[]>([]);
  const [mealTags, setMealTags] = useState<string[]>([]);
  const [mealDifficulty, setMealDifficulty] = useState<number | null>(null);
  const [mealPhotoUrl, setMealPhotoUrl] = useState('');
  const [mealPhotoPreview, setMealPhotoPreview] = useState('');
  const [pendingPhotoBase64, setPendingPhotoBase64] = useState<string | null>(null);
  const [tagSearch, setTagSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingPhotoIsUrl, setPendingPhotoIsUrl] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const { creator: c, meals: mealData, stats: s } = await creatorsApi.getMe();
      setCreator(c);
      setMeals(mealData ?? []);
      setStats(s);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not load creator data');
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditingMeal(null);
    setMealName('');
    setMealStory('');
    setMealRecipe('');
    setMealSource('');
    setMealIngredients([{ productName: '', quantity: 1 }]);
    setMealTags([]);
    setMealDifficulty(null);
    setMealPhotoUrl('');
    setMealPhotoPreview('');
    setPendingPhotoBase64(null);
    setTagSearch('');
    setFormVisible(true);
  }

  function openEdit(meal: PresetMeal) {
    setEditingMeal(meal);
    setMealName(meal.name);
    setMealStory(meal.story ?? '');
    setMealRecipe(meal.recipe ?? '');
    setMealSource(meal.source ?? '');
    setMealIngredients(meal.ingredients.length ? [...meal.ingredients] : [{ productName: '', quantity: 1 }]);
    setMealTags([...(meal.tags ?? [])]);
    setMealDifficulty(meal.difficulty ?? null);
    setMealPhotoUrl(meal.photoUrl ?? '');
    setMealPhotoPreview(meal.photoUrl ?? '');
    setPendingPhotoBase64(null);
    setTagSearch('');
    setFormVisible(true);
  }

  async function uploadPendingPhoto(): Promise<string | null> {
    if (!pendingPhotoBase64) return mealPhotoUrl || null;
    const { images: imagesApi } = await import('../../lib/api');
    const { url } = await imagesApi.upload(pendingPhotoBase64);
    return url;
  }

  async function handleSaveMeal() {
    if (!mealName.trim()) {
      Alert.alert('Error', 'Meal name is required');
      return;
    }
    const validIngredients = mealIngredients.filter((i) => i.productName.trim());
    if (validIngredients.length === 0) {
      Alert.alert('Error', 'At least one ingredient is required');
      return;
    }

    setSaving(true);
    try {
      // If generated photo (already a URL), use directly; otherwise upload base64
      const finalPhotoUrl = pendingPhotoIsUrl ? mealPhotoUrl || null : await uploadPendingPhoto();
      const data = {
        name: mealName.trim(),
        story: mealStory.trim() || undefined,
        recipe: mealRecipe.trim() || undefined,
        source: mealSource.trim() || undefined,
        ingredients: validIngredients,
        tags: mealTags,
        difficulty: mealDifficulty ?? undefined,
        photoUrl: finalPhotoUrl ?? undefined,
      };

      if (editingMeal) {
        await creatorsApi.creatorMeals.update(editingMeal.id, data);
      } else {
        await creatorsApi.creatorMeals.create(data);
      }
      setFormVisible(false);
      await loadData();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not save meal');
    } finally {
      setSaving(false);
    }
  }

  async function handleShareMeal(meal: PresetMeal) {
    const url = `https://mealio.co/meal/p/${meal.id}`;
    try {
      await Share.share({ message: url, url });
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not share meal');
    }
  }

  async function handleDeleteMeal(meal: PresetMeal) {
    Alert.alert('Delete Meal', `Delete "${meal.name}" from your creator meals?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await creatorsApi.creatorMeals.delete(meal.id);
            await loadData();
          } catch (err: any) {
            Alert.alert('Error', err.message || 'Could not delete meal');
          }
        },
      },
    ]);
  }

  const filteredTags = tagSearch.trim()
    ? ALL_TAGS.filter((t) => t.toLowerCase().includes(tagSearch.toLowerCase()))
    : ALL_TAGS;

  return (
    <SafeAreaView style={styles.safe}>
      <FlatList
        data={meals}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <>
            <Text style={styles.pageTitle}>Creator Portal</Text>

            {creator && stats && (
              <View style={styles.statsGrid}>
                <Card style={styles.statCard}>
                  <Text style={styles.statValue}>{stats.followers ?? 0}</Text>
                  <Text style={styles.statLabel}>Followers</Text>
                </Card>
                <Card style={styles.statCard}>
                  <Text style={styles.statValue}>{stats.savesQtr ?? 0}</Text>
                  <Text style={styles.statLabel}>Quarterly Saves</Text>
                </Card>
                <Card style={styles.statCard}>
                  <Text style={styles.statValue}>{stats.savesAll ?? 0}</Text>
                  <Text style={styles.statLabel}>All-Time Saves</Text>
                </Card>
                <Card style={styles.statCard}>
                  <Text style={styles.statValue}>{(stats.combinedSharePct ?? 0).toFixed(1)}%</Text>
                  <Text style={styles.statLabel}>Revenue Share</Text>
                </Card>
              </View>
            )}

            <View style={styles.mealsHeader}>
              <Text style={styles.mealsTitle}>Your Meals ({meals.length})</Text>
              <Button label="+ New Meal" size="sm" onPress={openCreate} />
            </View>
          </>
        }
        renderItem={({ item }) => (
          <View style={styles.mealRow}>
            {item.photoUrl ? (
              <Image source={{ uri: item.photoUrl }} style={styles.mealThumb} contentFit="cover" />
            ) : (
              <View style={[styles.mealThumb, styles.mealThumbPlaceholder]}>
                <Text style={{ fontSize: 18 }}>🍽️</Text>
              </View>
            )}
            <View style={styles.mealInfo}>
              <Text style={styles.mealName} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.mealMeta}>
                Trending Score - {item.trendingScore ?? 0}
              </Text>
            </View>
            <TouchableOpacity onPress={() => handleShareMeal(item)} style={styles.actionIcon}>
              <Ionicons name="share-outline" size={20} color={Colors.text3} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => openEdit(item)} style={styles.actionIcon}>
              <Ionicons name="pencil-outline" size={20} color={Colors.brand} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => handleDeleteMeal(item)} style={styles.actionIcon}>
              <Ionicons name="trash-outline" size={20} color={Colors.error} />
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No meals yet. Create your first meal!</Text>
            </View>
          ) : null
        }
      />

      {/* Meal form modal */}
      <Modal visible={formVisible} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={styles.safe}>
          <KeyboardAwareScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled" enableOnAndroid extraScrollHeight={24}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editingMeal ? 'Edit Meal' : 'New Meal'}</Text>
              <TouchableOpacity onPress={() => setFormVisible(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>


              <Input label="Meal Name *" placeholder="e.g. Lemon Herb Chicken" value={mealName} onChangeText={setMealName} />

              {/* Photo */}
              <Text style={styles.fieldLabel}>Photo <Text style={styles.optional}>(optional)</Text></Text>
              <PhotoPicker
                mealName={mealName}
                previewUri={mealPhotoPreview}
                onPhotoReady={(uri, isUrl, base64) => {
                  setMealPhotoPreview(uri);
                  setPendingPhotoIsUrl(isUrl);
                  if (isUrl) { setMealPhotoUrl(uri); setPendingPhotoBase64(null); }
                  else { setPendingPhotoBase64(base64 ?? null); setMealPhotoUrl(''); }
                }}
                onClear={() => { setMealPhotoPreview(''); setMealPhotoUrl(''); setPendingPhotoBase64(null); setPendingPhotoIsUrl(false); }}
              />

              {/* Ingredient naming hint */}
              <View style={styles.ingredientHint}>
                <Text style={styles.hintText}>
                  Name each ingredient as it would appear in a grocery store search — specific enough to find the right product, but generic enough to work across stores.
                </Text>
                <Text style={styles.hintExamples}>
                  <Text style={styles.hintGood}>✓ Good: </Text>
                  <Text>"Chicken Stock, 32 oz" · "Garlic" · "Rotisserie Chicken"{'\n'}</Text>
                  <Text style={styles.hintBad}>✗ Avoid: </Text>
                  <Text>"Costco Bananas" · "Fresh Herbs"</Text>
                </Text>
              </View>

              <IngredientEditor ingredients={mealIngredients} onChange={setMealIngredients} />

              {/* Story */}
              <Text style={styles.fieldLabel}>Story <Text style={styles.optional}>(optional)</Text></Text>
              <TextInput
                style={styles.textArea}
                value={mealStory}
                onChangeText={setMealStory}
                placeholder="e.g. Perfect for a summer BBQ, or the story behind this meal…"
                placeholderTextColor={Colors.text3}
                multiline
                numberOfLines={3}
              />

              {/* Recipe */}
              <Text style={styles.fieldLabel}>Recipe Instructions <Text style={styles.optional}>(optional)</Text></Text>
              <TextInput
                style={[styles.textArea, { minHeight: 120 }]}
                value={mealRecipe}
                onChangeText={setMealRecipe}
                placeholder={'1. Boil 4 cups of water…\n2. Add 200g of noodles…'}
                placeholderTextColor={Colors.text3}
                multiline
              />

              {/* Source URL */}
              <Input
                label="Recipe URL (optional)"
                placeholder="https://yourblog.com/recipe"
                value={mealSource}
                onChangeText={setMealSource}
                keyboardType="url"
                autoCapitalize="none"
              />

              {/* Difficulty */}
              <Text style={styles.fieldLabel}>Difficulty <Text style={styles.optional}>(optional)</Text></Text>
              <View style={styles.diffRow}>
                {[1, 2, 3, 4, 5].map((d) => (
                  <TouchableOpacity
                    key={d}
                    style={[styles.diffBtn, mealDifficulty === d && styles.diffBtnActive]}
                    onPress={() => setMealDifficulty(mealDifficulty === d ? null : d)}
                  >
                    <View style={{ flexDirection: 'row', gap: 2 }}>
                      {[1, 2, 3, 4, 5].map((i) => (
                        <View key={i} style={[styles.dot, i <= d ? styles.dotFilled : styles.dotEmpty]} />
                      ))}
                    </View>
                    <Text style={[styles.diffLabel, mealDifficulty === d && styles.diffLabelActive]}>{d}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Tags */}
              <Text style={styles.fieldLabel}>Tags</Text>
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
                  {filteredTags.map((tag) => (
                    <Tag
                      key={tag}
                      label={tag}
                      selected={mealTags.includes(tag)}
                      onPress={() =>
                        setMealTags((prev) =>
                          prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
                        )
                      }
                    />
                  ))}
                </View>
              </ScrollView>

            <View style={styles.modalFooter}>
              <Button
                label="Cancel"
                variant="secondary"
                onPress={() => setFormVisible(false)}
                style={{ flex: 1, marginRight: 8 }}
              />
              <Button
                label="Save Meal"
                onPress={handleSaveMeal}
                loading={saving}
                style={{ flex: 2 }}
              />
            </View>
          </KeyboardAwareScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  list: { padding: 16, paddingBottom: 40 },
  pageTitle: { fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 16 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  statCard: { flex: 1, minWidth: '45%', alignItems: 'center', padding: 16 },
  statValue: { fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.brand, marginBottom: 4 },
  statLabel: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, textAlign: 'center' },
  mealsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  mealsTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  mealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: Colors.surfaceRaised,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
    gap: 10,
  },
  mealThumb: { width: 48, height: 48, borderRadius: 8, backgroundColor: Colors.surface },
  mealThumbPlaceholder: { justifyContent: 'center', alignItems: 'center' },
  mealInfo: { flex: 1 },
  mealName: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.text1, marginBottom: 3 },
  mealMeta: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  actionIcon: { padding: 8 },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.text3 },
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
  fieldLabel: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text2,
    marginBottom: 8,
    marginTop: 12,
  },
  optional: { fontFamily: 'Inter_400Regular', color: Colors.text3 },
  // Photo
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  photoPreview: { width: 60, height: 60, borderRadius: 8 },
  photoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.brand,
    backgroundColor: Colors.brandLight,
  },
  photoBtnText: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.brand },
  // Ingredient hint
  ingredientHint: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.input,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  hintText: { fontSize: 12.5, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 18, marginBottom: 6 },
  hintExamples: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, lineHeight: 18 },
  hintGood: { fontFamily: 'Inter_600SemiBold', color: '#16A34A' },
  hintBad: { fontFamily: 'Inter_600SemiBold', color: Colors.error },
  // Text area
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
  // Difficulty
  diffRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
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
  // Tags
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
  modalFooter: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
});
