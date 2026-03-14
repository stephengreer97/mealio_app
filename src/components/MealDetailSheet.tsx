import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  Linking,
  Share,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Colors, Radius } from '../constants/colors';
import { Meal, PresetMeal, Ingredient } from '../types';
import { meals as mealsApi, images as imagesApi, kroger as krogerApi } from '../lib/api';
import Button from './ui/Button';
import Input from './ui/Input';
import IngredientEditor from './IngredientEditor';
import PhotoPicker from './PhotoPicker';
import Tag from './ui/Tag';
import { ALL_TAGS } from '../constants/tags';

interface MealDetailSheetProps {
  visible: boolean;
  meal: Meal | PresetMeal | null;
  mode?: 'view' | 'edit';
  onClose: () => void;
  onSave?: (updated?: Meal) => void;
  onPressSave?: () => void;
  krogerLocationId?: string | null;
  onNeedKrogerStore?: () => void;
}

function DifficultyDots({ level }: { level: number }) {
  return (
    <View style={dotStyles.row}>
      {[1, 2, 3, 4, 5].map((i) => (
        <View key={i} style={[dotStyles.dot, i <= level ? dotStyles.filled : dotStyles.empty]} />
      ))}
    </View>
  );
}

const dotStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  filled: { backgroundColor: Colors.brand },
  empty: { backgroundColor: Colors.border },
});

export default function MealDetailSheet({
  visible,
  meal,
  mode = 'view',
  onClose,
  onSave,
  onPressSave,
  krogerLocationId,
  onNeedKrogerStore,
}: MealDetailSheetProps) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [krogerLoading, setKrogerLoading] = useState(false);

  // Edit form fields
  const [name, setName] = useState('');
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [author, setAuthor] = useState('');
  const [story, setStory] = useState('');
  const [recipe, setRecipe] = useState('');
  const [source, setSource] = useState('');
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [serves, setServes] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagSearch, setTagSearch] = useState('');
  const [photoPreview, setPhotoPreview] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [pendingPhotoBase64, setPendingPhotoBase64] = useState<string | null>(null);
  const [photoIsUrl, setPhotoIsUrl] = useState(false);

  function startEdit() {
    if (!meal) return;
    const m = meal as any;
    setName(meal.name);
    setIngredients([...meal.ingredients]);
    setAuthor(m.author ?? '');
    setStory(m.story ?? '');
    setRecipe(m.recipe ?? '');
    setSource(m.source ?? m.website ?? '');
    setDifficulty(m.difficulty ?? null);
    setServes(m.serves ?? '');
    setSelectedTags(m.tags ?? []);
    setTagSearch('');
    setPhotoPreview(meal.photoUrl ?? '');
    setPhotoUrl(meal.photoUrl ?? '');
    setPendingPhotoBase64(null);
    setPhotoIsUrl(false);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
  }

  async function handleSave() {
    if (!meal) return;
    if (!name.trim()) { Alert.alert('Error', 'Meal name is required'); return; }
    const validIngredients = ingredients.filter((i) => i.productName.trim());
    if (validIngredients.length === 0) { Alert.alert('Error', 'Add at least one ingredient'); return; }
    if (validIngredients.some((i) => i.quantity === undefined)) { Alert.alert('Error', 'All ingredients need a quantity'); return; }

    setLoading(true);
    try {
      let finalPhotoUrl: string | null = meal.photoUrl ?? null;
      if (photoIsUrl && photoUrl) {
        finalPhotoUrl = photoUrl;
      } else if (pendingPhotoBase64) {
        const { url } = await imagesApi.upload(pendingPhotoBase64);
        finalPhotoUrl = url;
      } else if (!photoPreview) {
        finalPhotoUrl = null;
      }

      const updatedMeal = await mealsApi.update(meal.id, {
        name: name.trim(),
        ingredients: validIngredients,
        photoUrl: finalPhotoUrl,
        author: author.trim() || null,
        story: story.trim() || null,
        recipe: recipe.trim() || null,
        website: source.trim() || null,
        difficulty,
        serves: serves.trim() || null,
        tags: selectedTags,
      } as any);
      setEditing(false);
      onSave?.(updatedMeal);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not save meal');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!meal) return;
    Alert.alert('Delete Meal', `Delete "${meal.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await mealsApi.delete(meal.id);
            onClose();
            onSave?.();
          } catch (err: any) {
            Alert.alert('Error', err.message || 'Could not delete meal');
          }
        },
      },
    ]);
  }

  async function handleShare() {
    if (!meal) return;
    setSharing(true);
    try {
      const { shareUrl } = await mealsApi.share(meal.id);
      await Share.share({ message: shareUrl, url: shareUrl });
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not generate share link');
    } finally {
      setSharing(false);
    }
  }

  async function handleAddToKroger() {
    if (!meal) return;
    if (!krogerLocationId) {
      onNeedKrogerStore?.();
      return;
    }
    setKrogerLoading(true);
    try {
      const result = await krogerApi.addToCart(meal.ingredients, krogerLocationId);
      const msg = result.added.length > 0
        ? `${result.added.length} item${result.added.length !== 1 ? 's' : ''} added to your Kroger cart.`
        : 'No items could be found at your Kroger store.';
      const extra = result.notFound.length > 0 ? `\n\nNot found: ${result.notFound.join(', ')}` : '';
      Alert.alert('Kroger Cart', msg + extra);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to add to Kroger cart');
    } finally {
      setKrogerLoading(false);
    }
  }

  const displayIngredients = meal?.ingredients ?? [];
  const m = meal as any;
  const authorName = m?.creatorSocial
    ? `@${m.creatorSocial}`
    : m?.creatorName ?? m?.author ?? null;
  const sourceStr: string | null = m?.source ?? m?.website ?? null;
  const sourceHost = sourceStr
    ? (() => { try { return new URL(sourceStr).hostname.replace('www.', ''); } catch { return sourceStr; } })()
    : null;
  const viewStory: string | null = m?.story ?? null;
  const viewRecipe: string | null = m?.recipe ?? null;
  const viewDifficulty: number | null = m?.difficulty ?? null;
  const viewServes: string | null = m?.serves ?? null;
  const viewTags: string[] = m?.tags ?? [];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => { setEditing(false); onClose(); }}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
          {mode === 'edit' && !editing && (
            <View style={styles.headerActions}>
              {krogerLocationId && (
                <TouchableOpacity onPress={handleAddToKroger} style={styles.headerBtn} disabled={krogerLoading}>
                  <Text style={[styles.headerBtnText, { color: '#0063a1' }, krogerLoading && { color: Colors.text3 }]}>
                    {krogerLoading ? 'Adding…' : 'Kroger'}
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={handleShare} style={styles.headerBtn} disabled={sharing}>
                <Text style={[styles.headerBtnText, sharing && { color: Colors.text3 }]}>
                  {sharing ? 'Sharing…' : 'Share'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={startEdit} style={styles.headerBtn}>
                <Text style={styles.headerBtnText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleDelete} style={styles.headerBtn}>
                <Text style={[styles.headerBtnText, { color: Colors.error }]}>Delete</Text>
              </TouchableOpacity>
            </View>
          )}
          {editing && (
            <TouchableOpacity onPress={cancelEdit} style={styles.headerBtn}>
              <Text style={styles.headerBtnText}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>

        {editing ? (
          <KeyboardAwareScrollView contentContainerStyle={styles.editScroll} keyboardShouldPersistTaps="handled" enableOnAndroid extraScrollHeight={24}>
              <Input
                label="Meal Name"
                placeholder="e.g. Lemon Herb Chicken"
                value={name}
                onChangeText={setName}
              />

              <Text style={styles.fieldLabel}>Photo (optional)</Text>
              <PhotoPicker
                mealName={name}
                previewUri={photoPreview}
                onPhotoReady={(uri, isUrl, base64) => {
                  setPhotoPreview(uri);
                  setPhotoIsUrl(isUrl);
                  if (isUrl) { setPhotoUrl(uri); setPendingPhotoBase64(null); }
                  else { setPendingPhotoBase64(base64 ?? null); setPhotoUrl(''); }
                }}
                onClear={() => { setPhotoPreview(''); setPhotoUrl(''); setPendingPhotoBase64(null); setPhotoIsUrl(false); }}
              />

              <IngredientEditor ingredients={ingredients} onChange={setIngredients} />

              <Input
                label="Author (optional)"
                placeholder="e.g. Gordon Ramsay"
                value={author}
                onChangeText={setAuthor}
              />

              <Input
                label="Serves (optional)"
                placeholder="e.g. 4 or 2-4"
                value={serves}
                onChangeText={setServes}
              />

              <Input
                label="Recipe URL (optional)"
                placeholder="https://example.com/recipe"
                value={source}
                onChangeText={setSource}
                keyboardType="url"
                autoCapitalize="none"
              />

              <Text style={styles.fieldLabel}>Story (optional)</Text>
              <TextInput
                style={styles.textArea}
                value={story}
                onChangeText={setStory}
                placeholder="e.g. Perfect for a summer BBQ…"
                placeholderTextColor={Colors.text3}
                multiline
              />

              <Text style={styles.fieldLabel}>Recipe Instructions (optional)</Text>
              <TextInput
                style={[styles.textArea, { minHeight: 120 }]}
                value={recipe}
                onChangeText={setRecipe}
                placeholder={'1. Boil 4 cups of water…\n2. Add pasta…'}
                placeholderTextColor={Colors.text3}
                multiline
              />

              <Text style={styles.fieldLabel}>Difficulty</Text>
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

              <Text style={styles.fieldLabel}>Tags</Text>
              <TextInput
                style={styles.tagSearchInput}
                placeholder="Search tags…"
                placeholderTextColor={Colors.text3}
                value={tagSearch}
                onChangeText={setTagSearch}
              />
              <ScrollView style={styles.tagScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
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
              <View style={styles.footer}>
                <Button label="Cancel" variant="secondary" onPress={cancelEdit} style={{ flex: 1, marginRight: 8 }} />
                <Button label="Save Changes" onPress={handleSave} loading={loading} style={{ flex: 2 }} />
              </View>
            </KeyboardAwareScrollView>
        ) : (
          <>
            <ScrollView contentContainerStyle={styles.scroll}>
              <View>
                {meal?.photoUrl ? (
                  <Image source={{ uri: meal.photoUrl }} style={styles.image} contentFit="cover" />
                ) : (
                  <View style={[styles.image, styles.imagePlaceholder]}>
                    <Text style={styles.placeholderEmoji}>🍽️</Text>
                  </View>
                )}
                {viewTags.length > 0 && (
                  <View style={styles.tagOverlay}>
                    {viewTags.map((tag) => (
                      <View key={tag} style={styles.tagPill}>
                        <Text style={styles.tagPillText}>{tag}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>

              <View style={styles.body}>
                <Text style={styles.mealName}>{meal?.name}</Text>

                {authorName && (
                  <View style={styles.metaRow}>
                    <Text style={styles.authorText}>by {authorName}</Text>
                  </View>
                )}

                {(viewDifficulty != null || viewServes || sourceHost) && (
                  <View style={[styles.metaRow, { marginBottom: 12 }]}>
                    {viewDifficulty != null && <DifficultyDots level={viewDifficulty} />}
                    {viewDifficulty != null && (viewServes || sourceHost) && <Text style={styles.metaDot}>·</Text>}
                    {viewServes && <Text style={styles.servesText}>{viewServes}</Text>}
                    {viewServes && sourceHost && <Text style={styles.metaDot}>·</Text>}
                    {sourceHost && (
                      <TouchableOpacity onPress={() => Linking.openURL(sourceStr!)}>
                        <Text style={styles.sourceText}>{sourceHost}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                {viewStory && (
                  <Text style={[styles.bodyText, styles.storyText]}>{viewStory}</Text>
                )}

                <Text style={styles.sectionLabel}>Ingredients ({displayIngredients.length})</Text>
                {displayIngredients.map((ing, i) => (
                  <View key={i} style={styles.ingredientRow}>
                    <View style={styles.bullet} />
                    <Text style={styles.ingredientText}>
                      {ing.quantity ? `×${ing.quantity} ` : ''}
                      {ing.productName}
                    </Text>
                  </View>
                ))}

                {viewRecipe && (
                  <>
                    <Text style={styles.sectionLabel}>Recipe</Text>
                    <Text style={styles.bodyText}>{viewRecipe}</Text>
                  </>
                )}
              </View>
            </ScrollView>

            {mode === 'view' && onPressSave && (
              <View style={styles.footer}>
                <Button label="Save to My Meals" onPress={onPressSave} />
              </View>
            )}
          </>
        )}
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
    padding: 16,
  },
  close: { fontSize: 20, color: Colors.text3, padding: 4 },
  headerActions: { flexDirection: 'row', gap: 16 },
  headerBtn: { padding: 4 },
  headerBtnText: { fontSize: 16, fontFamily: 'Inter_500Medium', color: Colors.brand },
  scroll: { paddingBottom: 24 },
  editScroll: { padding: 16, paddingBottom: 24 },
  image: { width: '100%', height: 220 },
  imagePlaceholder: { backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center' },
  placeholderEmoji: { fontSize: 60 },
  tagOverlay: {
    position: 'absolute',
    top: 10,
    right: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 5,
    maxWidth: '80%',
  },
  tagPill: {
    backgroundColor: 'rgba(0,0,0,0.52)',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tagPillText: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    color: '#fff',
    letterSpacing: 0,
  },
  body: { padding: 20 },
  mealName: { fontSize: 24, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  authorText: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.brand },
  metaDot: { fontSize: 13, color: Colors.text3 },
  sourceRow: { marginBottom: 12 },
  sourceText: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.brand, textDecorationLine: 'underline' },
  sectionLabel: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 16,
  },
  bodyText: { fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 22, marginBottom: 4 },
  storyText: { fontFamily: 'Inter_400Regular_Italic', marginBottom: 12 },
  ingredientRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  bullet: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.brand, marginTop: 7, marginRight: 10 },
  ingredientText: { flex: 1, fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.text1, lineHeight: 22 },
  footer: { flexDirection: 'row', padding: 20, borderTopWidth: 1, borderTopColor: Colors.border },
  // Edit form
  fieldLabel: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text2, marginBottom: 8, marginTop: 4 },
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
  diffRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  diffBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 10,
    borderRadius: 8, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised, gap: 4,
  },
  diffBtnActive: { borderColor: Colors.brand, backgroundColor: Colors.brandLight },
  dot: { width: 5, height: 5, borderRadius: 3 },
  dotFilled: { backgroundColor: Colors.brand },
  dotEmpty: { backgroundColor: Colors.border },
  diffLabel: { fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.text3 },
  servesText: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text3 },
  diffLabelActive: { color: Colors.brand },
  tagSearchInput: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised, paddingHorizontal: 12, paddingVertical: 8,
    fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text1, marginBottom: 8, letterSpacing: 0,
  },
  tagScroll: {
    maxHeight: 180, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised, paddingHorizontal: 8, paddingVertical: 6, marginBottom: 8,
  },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap' },
});
