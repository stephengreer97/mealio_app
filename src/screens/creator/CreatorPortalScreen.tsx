import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
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
import { Ionicons, Feather } from '@expo/vector-icons';
import PhotoPicker from '../../components/PhotoPicker';
import { Colors, Radius } from '../../constants/colors';
import { Creator, CreatorStats, PresetMeal, Ingredient } from '../../types';
import { creators as creatorsApi } from '../../lib/api';
import MealDetailSheet from '../../components/MealDetailSheet';
import PushOptInCard from '../../components/PushOptInCard';
import PublishedLinkSheet from '../../components/PublishedLinkSheet';
import PlatformLinksCard from '../../components/PlatformLinksCard';
import YouTubeConnectCard from '../../components/YouTubeConnectCard';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import IngredientEditor from '../../components/IngredientEditor';
import TagPicker from '../../components/TagPicker';
import { MAX_MEAL_TAGS } from '../../constants/tags';
import { servesChangeError } from '../../constants/serves';

export default function CreatorPortalScreen() {
  const [creator, setCreator] = useState<Creator | null>(null);
  const [stats, setStats] = useState<CreatorStats | null>(null);
  const [meals, setMeals] = useState<PresetMeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [earningsOpen, setEarningsOpen] = useState(false);
  const [viewingMeal, setViewingMeal] = useState<PresetMeal | null>(null);
  const [mealDetailVisible, setMealDetailVisible] = useState(false);
  const [publishedMeal, setPublishedMeal] = useState<PresetMeal | null>(null);
  const [publishedVisible, setPublishedVisible] = useState(false);

  // Form state
  const [formVisible, setFormVisible] = useState(false);
  const [editingMeal, setEditingMeal] = useState<PresetMeal | null>(null);
  const [mealName, setMealName] = useState('');
  const [mealStory, setMealStory] = useState('');
  const [mealRecipe, setMealRecipe] = useState('');
  const [mealSource, setMealSource] = useState('');
  const [mealServes, setMealServes] = useState('');
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
      setMeals((mealData ?? []).slice().sort((a, b) => (b.trendingScore ?? 0) - (a.trendingScore ?? 0)));
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
    setMealServes('');
    setMealIngredients([{ ingredientName: '', searchTerm: null, qty: 1, productQty: 1, unit: 'qty', measure: null }]);
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
    setMealServes((meal as any).serves ?? '');
    setMealIngredients(meal.ingredients.length ? [...meal.ingredients] : [{ ingredientName: '', searchTerm: null, qty: 1, productQty: 1, unit: 'qty', measure: null }]);
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
    const validIngredients = mealIngredients.filter((i) => i.ingredientName.trim());
    if (validIngredients.length === 0) {
      Alert.alert('Error', 'At least one ingredient is required');
      return;
    }
    const seenIng = new Set<string>();
    const hasDupIngs = validIngredients.some((i) => {
      const key = i.ingredientName.trim().toLowerCase();
      if (seenIng.has(key)) return true;
      seenIng.add(key);
      return false;
    });
    if (hasDupIngs) {
      Alert.alert('Error', 'Two or more ingredients have the same name. Please make each name unique.');
      return;
    }
    // Checked here so the rule is stated before Save Meal is pressed rather than
    // arriving as the server's sentence in an Alert afterwards. Only when this
    // save is changing it: a meal published before the rule existed can carry
    // "2 1/2 cups", and refusing to save a name correction because of a field
    // the creator never opened is exactly what the route grandfathers against.
    const servesProblem = servesChangeError(mealServes, (editingMeal as any)?.serves ?? null);
    if (servesProblem) {
      Alert.alert('Error', servesProblem);
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
        serves: mealServes.trim() || undefined,
        ingredients: validIngredients,
        tags: mealTags,
        difficulty: mealDifficulty ?? undefined,
        photoUrl: finalPhotoUrl ?? undefined,
      };

      let published: PresetMeal | null = null;
      if (editingMeal) {
        await creatorsApi.creatorMeals.update(editingMeal.id, data);
      } else {
        published = await creatorsApi.creatorMeals.create(data);
      }
      setFormVisible(false);
      await loadData();
      // A newly published meal is the one moment the creator can still edit the
      // caption of the video it came from, so hand them the link right here.
      // Wait for the form sheet to finish dismissing before opening another modal.
      if (published) {
        setPublishedMeal(published);
        setTimeout(() => setPublishedVisible(true), 400);
      }
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

  return (
    <SafeAreaView style={styles.safe}>
      <FlatList
        data={meals}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <>
            <Text style={styles.pageTitle}>Creator Portal</Text>

            {/* Push opt-in soft ask. Self-hiding — see PushOptInCard. */}
            <PushOptInCard />

            {creator && stats && (
              <>
                <View style={styles.statsGrid}>
                  <Card style={styles.statCard}>
                    <Text style={styles.statValue}>{stats.followers ?? 0}</Text>
                    <Text style={styles.statLabel}>Followers</Text>
                  </Card>
                  <Card style={styles.statCard}>
                    <Text style={styles.statValue}>{stats.savesAnnual ?? 0}</Text>
                    <Text style={styles.statLabel}>Saves (12 mo)</Text>
                  </Card>
                  <Card style={styles.statCard}>
                    <Text style={styles.statValue}>{stats.savesAll ?? 0}</Text>
                    <Text style={styles.statLabel}>All-Time Saves</Text>
                  </Card>
                </View>

                {/* Referral link */}
                <Card style={styles.referralCard}>
                  <Text style={styles.referralLabel}>YOUR REFERRAL LINK</Text>
                  {creator.handle ? (
                    <>
                      <Text style={styles.referralLink}>mealio.co/{creator.handle}</Text>
                      <TouchableOpacity
                        style={styles.referralShareBtn}
                        onPress={() =>
                          Share.share({
                            message: `https://mealio.co/${creator.handle}`,
                            url: `https://mealio.co/${creator.handle}`,
                          })
                        }
                        activeOpacity={0.85}
                      >
                        <Feather name="share-2" size={14} color="#fff" style={{ marginRight: 6 }} />
                        <Text style={styles.referralShareText}>Share your link</Text>
                      </TouchableOpacity>
                      <Text style={styles.referralHint}>New signups from this link are credited to you.</Text>
                    </>
                  ) : (
                    <Text style={styles.referralHint}>
                      Set your handle at mealio.co/creator to get your referral link.
                    </Text>
                  )}
                </Card>

                {/* How earnings work */}
                <TouchableOpacity
                  style={styles.earningsRow}
                  onPress={() => setEarningsOpen((v) => !v)}
                  activeOpacity={0.8}
                >
                  <Feather name="dollar-sign" size={16} color={Colors.brand} style={{ marginRight: 6 }} />
                  <Text style={styles.earningsRowLabel}>How earnings work</Text>
                  <View style={styles.shareBadge}>
                    <Text style={styles.shareBadgeText}>{(stats.sharePercent ?? 0).toFixed(1)}% share</Text>
                  </View>
                  <Feather name={earningsOpen ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.text3} />
                </TouchableOpacity>
                {earningsOpen && (
                  <View style={styles.earningsBody}>
                    <Text style={styles.earningsText}>
                      Each quarter, 1/3 of subscription profit goes to the creator pool. Your share is based entirely on your meal saves over the last 12 months as a percentage of all creator meal saves over the same rolling window.
                    </Text>
                    <View style={styles.earningsFactorRow}>
                      <Feather name="trending-up" size={14} color={Colors.brand} />
                      <Text style={styles.earningsFactorText}>
                        Saves (last 12 months): {(stats.savesAnnual ?? 0).toLocaleString()} of {(stats.totalCreatorAnnualSaves ?? 0).toLocaleString()}
                      </Text>
                    </View>
                    <Text style={[styles.earningsText, { marginTop: 8 }]}>
                      Your share: <Text style={styles.earningsShareEmphasis}>{(stats.sharePercent ?? 0).toFixed(2)}%</Text> of the creator pool
                    </Text>
                    <Text style={[styles.earningsText, { marginTop: 8 }]}>
                      Payouts above $25 are issued at quarter end via Tremendous.
                    </Text>
                  </View>
                )}
              </>
            )}

            {/*
              Where a creator publishes, and the one setting that lets Mealio
              write back to it. Both are creator-owned decisions that had no
              route at all in the app — an app-only creator could not move a link
              that had changed, and could not say whether Mealio may edit their
              YouTube descriptions.

              Below the stats and above the meals: they are settings, not the
              thing the screen is for. `onSaved` re-reads the row so the boxes
              show the links as stored (normalised server-side) and the polled
              sentence reflects an import the save may have just paused.

              The YouTube card hides itself for a creator with no channel, so
              nothing here decides that.
            */}
            {creator && (
              <>
                <PlatformLinksCard creator={creator} onSaved={loadData} />
                <YouTubeConnectCard />
              </>
            )}

            <View style={styles.mealsHeader}>
              <Text style={styles.mealsTitle}>Your Meals ({meals.length})</Text>
              <Button label="+ New Meal" size="sm" onPress={openCreate} />
            </View>
          </>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.mealRow}
            onPress={() => { setViewingMeal(item); setMealDetailVisible(true); }}
            activeOpacity={0.8}
          >
            {item.photoUrl ? (
              <Image source={{ uri: item.photoUrl }} style={styles.mealThumb} contentFit="cover" />
            ) : (
              <View style={[styles.mealThumb, styles.mealThumbPlaceholder]}>
                <Feather name="image" size={20} color={Colors.text3} />
              </View>
            )}
            <View style={styles.mealInfo}>
              <Text style={styles.mealName} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.mealMeta}>
                Trending Score · {item.trendingScore ?? 0}
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
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No meals yet. Create your first meal!</Text>
            </View>
          ) : null
        }
      />

      {/* View meal detail */}
      <MealDetailSheet
        visible={mealDetailVisible}
        meal={viewingMeal}
        mode="view"
        onClose={() => setMealDetailVisible(false)}
        hideShare
      />

      {/* Share-your-link prompt, shown once right after publishing */}
      <PublishedLinkSheet
        visible={publishedVisible}
        meal={publishedMeal}
        onClose={() => { setPublishedVisible(false); setPublishedMeal(null); }}
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

              {/* Source URL */}
              <Input
                label="Recipe URL (optional)"
                placeholder="https://yourblog.com/recipe"
                value={mealSource}
                onChangeText={setMealSource}
                keyboardType="url"
                autoCapitalize="none"
              />

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

              {/* Serves */}
              <Input
                label="Serves (optional)"
                placeholder="e.g. 4 or 2-4"
                value={mealServes}
                onChangeText={setMealServes}
              />

              {/* Story */}
              <Text style={styles.fieldLabel}>Story <Text style={styles.optional}>(optional)</Text></Text>
              <TextInput
                style={styles.textArea}
                value={mealStory}
                onChangeText={setMealStory}
                placeholder={"The story behind the meal or a simple one liner. e.g.\nPerfect for a summer BBQ\nGreat budget-friendly weeknight dinner\nHigh protein, low carb – great for meal prep"}
                placeholderTextColor={Colors.text3}
                multiline
                numberOfLines={3}
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
                  <Text>"Walmart Bananas" · "Fresh Herbs"</Text>
                </Text>
              </View>

              <IngredientEditor ingredients={mealIngredients} onChange={setMealIngredients} />

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

              {/* Tags */}
              <Text style={styles.fieldLabel}>
                Tags <Text style={styles.optional}>(up to {MAX_MEAL_TAGS})</Text>
              </Text>
              <TagPicker
                selected={mealTags}
                onChange={setMealTags}
                search={tagSearch}
                onSearchChange={setTagSearch}
              />

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
  referralCard: { padding: 14, marginBottom: 12 },
  referralLabel: { fontSize: 11, fontFamily: 'Inter_700Bold', color: Colors.text3, letterSpacing: 0.5, marginBottom: 6 },
  referralLink: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: Colors.brand, marginBottom: 12 },
  referralShareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.brand,
    borderRadius: Radius.button,
    paddingVertical: 10,
  },
  referralShareText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: '#fff' },
  referralHint: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, marginTop: 8 },
  earningsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceRaised,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    marginBottom: 8,
  },
  earningsRowLabel: { flex: 1, fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  shareBadge: {
    backgroundColor: Colors.brandLight,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 8,
  },
  shareBadgeText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.brand },
  earningsBody: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    marginBottom: 16,
    gap: 8,
  },
  earningsText: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 19 },
  earningsShareEmphasis: { fontFamily: 'Inter_600SemiBold', color: Colors.brand },
  earningsFactorRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  earningsFactorText: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text1 },
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
  modalFooter: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
});
