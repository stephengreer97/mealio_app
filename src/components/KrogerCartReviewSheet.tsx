import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Linking,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Colors, Radius } from '../constants/colors';
import { Meal, Ingredient } from '../types';
import { kroger as krogerApi, meals as mealsApi } from '../lib/api';
import { STORES } from '../constants/stores';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatWeightName(description: string, averageWeightPerUnit: string | null | undefined, size: string | null | undefined): string {
  const fallback = size && !description.includes(size) ? `${description}, ${size}` : description;
  if (!averageWeightPerUnit) return fallback;
  const numMatch = averageWeightPerUnit.match(/^([\d.]+)/);
  if (!numMatch) return fallback;
  const unitMatch = size?.match(/[a-zA-Z]+/);
  const unit = unitMatch?.[0] ?? 'lb';
  const unitLabel = unit === 'lb' ? 'lbs' : unit;
  return `${description}, avg ${numMatch[1]} ${unitLabel}`;
}

function formatSuggestionLabel(s: { description: string; size?: string | null; soldBy?: string | null; averageWeightPerUnit?: string | null }): string {
  if (s.soldBy === 'WEIGHT') return formatWeightName(s.description, s.averageWeightPerUnit, s.size);
  return s.size && !s.description.includes(s.size) ? `${s.description}, ${s.size}` : s.description;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface MealIngredientQty {
  mealId: string;
  mealName: string;
  qty: number;
}

interface ConsolidatedIngredient {
  ingredientName: string;
  productQty: number;
  unit: string;
  measure: string | null;
  searchTerm: string | null;
  mealIds: string[];
  mealNames: string[];
  mealIngredients: MealIngredientQty[];
}

interface SearchResult {
  term: string;
  searchTerm: string | null;
  quantity: number;
  upc: string | null;
  description: string | null;
  exact: boolean;
  reason?: 'matched' | 'out_of_stock' | 'no_results' | 'low_confidence';
  unit: string;
  measure: string | null;
  suggestions: Array<{
    upc: string;
    description: string;
    size?: string | null;
    soldBy?: string | null;
    averageWeightPerUnit?: string | null;
    price: number | null;
    stockLevel?: string | null;
    imageUrl?: string | null;
  }>;
  mealIds: string[];
  mealNames: string[];
  mealIngredients: MealIngredientQty[];
}

interface KrogerCartReviewSheetProps {
  visible: boolean;
  meals: Array<Pick<Meal, 'id' | 'name' | 'ingredients'>>;
  locationId: string;
  storeId: string;
  storeName: string;
  onClose: () => void;
  onMealUpdated?: (updated: Meal) => void;
}

type Step = 'qty' | 'searching' | 'searchResult' | 'review' | 'adding' | 'done';

// ── Store URLs ────────────────────────────────────────────────────────────────

// Native app URL schemes for each Kroger-family store.
// canOpenURL returns true if the app is installed (requires LSApplicationQueriesSchemes on iOS).
const STORE_APP_SCHEMES: Record<string, string> = {
  kroger:        'kroger://',
  harris_teeter: 'harristeeter://',
  king_soopers:  'kingsoopers://',
  fred_meyer:    'fredmeyer://',
  ralphs:        'ralphs://',
  smiths:        'smithsfoodanddrug://',
  frys:          'frysfood://',
  marianos:      'marianos://',
  pick_n_save:   'picknsave://',
  dillons:       'dillons://',
  bakers:        'bakersplus://',
  city_market:   'citymarket://',
  pay_less:      'payless://',
  metro_market:  'metromarket://',
  carrs:         'carrs://',
  qfc:           'qfc://',
};

const STORE_URLS: Record<string, string> = {
  kroger:        'kroger.com',
  ralphs:        'ralphs.com',
  fred_meyer:    'fredmeyer.com',
  king_soopers:  'kingsoopers.com',
  smiths:        'smithsfoodanddrug.com',
  frys:          'frysfood.com',
  qfc:           'qfc.com',
  city_market:   'citymarket.com',
  dillons:       'dillons.com',
  bakers:        'bakersplus.com',
  marianos:      'marianos.com',
  pick_n_save:   'picknsave.com',
  metro_market:  'metromarket.net',
  pay_less:      'pay-less.com',
  harris_teeter: 'harristeeter.com',
  carrs:         'carrsqc.com',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function normIngName(ing: any): string {
  return ing.ingredientName ?? ing.productName ?? ing.product_name ?? ing.name ?? '';
}

function normProductQty(ing: any): number {
  return ing.productQty ?? ing.qty ?? ing.quantity ?? 1;
}

function consolidateIngredients(meals: Array<Pick<Meal, 'id' | 'name' | 'ingredients'>>): ConsolidatedIngredient[] {
  const map = new Map<string, ConsolidatedIngredient>();
  for (const meal of meals) {
    for (const ing of meal.ingredients as any[]) {
      const name = normIngName(ing);
      const key = `${name.toLowerCase().trim()}::${(ing.searchTerm ?? '').toLowerCase().trim()}`;
      if (!key) continue;
      const qty = normProductQty(ing);
      if (map.has(key)) {
        const e = map.get(key)!;
        e.productQty += qty;
        const existing = e.mealIngredients.find((m) => m.mealId === meal.id);
        if (existing) {
          existing.qty += qty;
        } else {
          e.mealIngredients.push({ mealId: meal.id, mealName: meal.name, qty });
          e.mealIds.push(meal.id);
          e.mealNames.push(meal.name);
        }
      } else {
        map.set(key, {
          ingredientName: name,
          productQty: qty,
          unit: ing.unit ?? 'qty',
          measure: ing.measure ?? null,
          searchTerm: ing.searchTerm ?? null,
          mealIds: [meal.id],
          mealNames: [meal.name],
          mealIngredients: [{ mealId: meal.id, mealName: meal.name, qty }],
        });
      }
    }
  }
  return [...map.values()];
}

// ── Spinner component (no CSS animations in RN, use ActivityIndicator styled with store color) ──

function StoreSpinner({ color }: { color: string }) {
  return <ActivityIndicator size="large" color={color} />;
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function KrogerCartReviewSheet({
  visible,
  meals,
  locationId,
  storeId,
  storeName,
  onClose,
  onMealUpdated,
}: KrogerCartReviewSheetProps) {
  const storeColor = STORES.find((s) => s.id === storeId)?.color ?? '#003087';

  const [step, setStep] = useState<Step>('qty');
  const [error, setError] = useState('');

  // Step qty
  const [items, setItems] = useState<ConsolidatedIngredient[]>([]);
  const [checkedItems, setCheckedItems] = useState<boolean[]>([]);

  // Step review
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [pickedItems, setPickedItems] = useState<{ upc: string; quantity: number; description: string }[]>([]);
  const [reviewMealQtys, setReviewMealQtys] = useState<Record<number, Record<string, number>>>({});

  // Per-review selection
  const [selectedSuggIdx, setSelectedSuggIdx] = useState<number | 'custom'>(0);
  const [customText, setCustomText] = useState('');
  const [customSearching, setCustomSearching] = useState(false);
  // Suggestions produced by a custom search (replaces currentReview.suggestions in-place)
  const [customSuggestions, setCustomSuggestions] = useState<SearchResult['suggestions']>([]);
  const [customSearchTerm, setCustomSearchTerm] = useState('');
  const shouldShowSuggestionsRef = useRef(false);

  // Step done
  const [totalAdded, setTotalAdded] = useState(0);
  const [cartError, setCartError] = useState('');
  const [addedItems, setAddedItems] = useState<{ description: string; quantity: number }[]>([]);

  // Re-initialize when sheet opens
  useEffect(() => {
    if (visible) {
      const consolidated = consolidateIngredients(meals);
      setItems(consolidated);
      setCheckedItems(consolidated.map(() => true));
      setStep('qty');
      setError('');
      setSearchResults([]);
      setReviewIdx(0);
      setPickedItems([]);
      setReviewMealQtys({});
      setSelectedSuggIdx(0);
      setCustomText('');
      setTotalAdded(0);
      setCartError('');
      setAddedItems([]);
    }
  }, [visible]);

  // Reset selection when review item changes
  useEffect(() => {
    setSelectedSuggIdx(0);
    setCustomText('');
    setCustomSuggestions([]);
    setCustomSearchTerm('');
  }, [reviewIdx]);

  const reviewQueue = searchResults.filter((r) => !r.exact);
  const currentReview = reviewQueue[reviewIdx];

  // ── Per-recipe qty helpers ────────────────────────────────────────────────

  const getReviewMealQtys = (idx: number): Record<string, number> => {
    if (reviewMealQtys[idx]) return reviewMealQtys[idx];
    const r = reviewQueue[idx];
    if (!r) return {};
    const map: Record<string, number> = {};
    for (const m of r.mealIngredients) map[m.mealId] = m.qty;
    return map;
  };

  const getReviewTotalQty = (idx: number): number => {
    const qtys = getReviewMealQtys(idx);
    const total = Object.values(qtys).reduce((a, b) => a + b, 0);
    return total || 1;
  };

  const adjustReviewMealQty = (idx: number, mealId: string, delta: number) => {
    setReviewMealQtys((prev) => {
      const current = prev[idx] ?? getReviewMealQtys(idx);
      const newQty = Math.max(1, (current[mealId] ?? 1) + delta);
      return { ...prev, [idx]: { ...current, [mealId]: newQty } };
    });
  };

  // ── Step handlers ────────────────────────────────────────────────────────

  const handleStartSearch = async () => {
    const active = items.filter((it, i) => (checkedItems[i] ?? true) && it.productQty > 0);
    if (active.length === 0) return;
    setStep('searching');
    setError('');
    try {
      const data = await krogerApi.searchProducts(
        active.map((i) => ({
          productName: i.ingredientName,
          searchTerm: i.searchTerm,
          unit: i.unit,
          measure: i.measure,
          quantity: i.productQty,
        })),
        locationId,
        storeId,
        [...new Set(active.flatMap((i) => i.mealNames))],
      );
      const results: SearchResult[] = data.results.map((r: any) => {
        const src = active.find(
          (c) => c.ingredientName.toLowerCase().trim() === r.term.toLowerCase().trim(),
        );
        return {
          ...r,
          suggestions: r.suggestions ?? [],
          mealIds: src?.mealIds ?? [],
          mealNames: src?.mealNames ?? [],
          mealIngredients: src?.mealIngredients ?? [],
          searchTerm: src?.searchTerm ?? null,
          unit: src?.unit ?? 'qty',
          measure: src?.measure ?? null,
        };
      });
      setSearchResults(results);

      const needsReview = results.filter((r) => !r.exact);
      if (needsReview.length === 0) {
        await doAddToCart(
          results.filter((r) => r.upc).map((r) => ({ upc: r.upc!, quantity: r.quantity })),
        );
      } else {
        setReviewIdx(0);
        setPickedItems([]);
        setStep('searchResult');
      }
    } catch (err: any) {
      setError(err.message || 'Search failed');
      setStep('qty');
    }
  };

  const resolveCurrentSelection = async (): Promise<{ upc: string | null; name: string } | null> => {
    shouldShowSuggestionsRef.current = false;
    if (selectedSuggIdx === 'custom') {
      const term = customText.trim();
      if (!term) return null;
      setCustomSearching(true);
      try {
        const data = await krogerApi.searchProducts(
          [{ productName: term, quantity: 1 }],
          locationId,
        );
        const result = data.results?.[0];
        // Always show suggestions for custom searches — the user typed this term
        // to review options, so never silently add even if the score is exact.
        setCustomSuggestions(result?.suggestions ?? []);
        setCustomSearchTerm(term);
        setSelectedSuggIdx(0);
        setCustomText('');
        shouldShowSuggestionsRef.current = true;
        return null;
      } finally {
        setCustomSearching(false);
      }
    }
    const displaySuggestions = customSuggestions.length > 0 ? customSuggestions : currentReview.suggestions;
    const s = displaySuggestions[selectedSuggIdx as number];
    return s ? { upc: s.upc, name: s.description } : null;
  };

  const handleReviewDecision = async (action: 'skip' | 'add' | 'update') => {
    const newPicked = [...pickedItems];

    if (action !== 'skip') {
      const resolved = await resolveCurrentSelection();
      if (shouldShowSuggestionsRef.current) return; // custom search showed new suggestions — stay on this item
      const mealQtys = getReviewMealQtys(reviewIdx);
      const totalQty = getReviewTotalQty(reviewIdx);
      if (resolved?.upc) {
        newPicked.push({ upc: resolved.upc, quantity: totalQty, description: resolved.name });
      }
      if (action === 'update' && resolved?.name) {
        for (const mealId of currentReview.mealIds) {
          const meal = meals.find((m) => m.id === mealId);
          if (!meal) continue;
          const mealQty = mealQtys[mealId] ?? currentReview.mealIngredients.find((mi) => mi.mealId === mealId)?.qty ?? 1;
          const updatedIngredients: Ingredient[] = meal.ingredients.map((ing) => {
            const iName = normIngName(ing);
            return iName.toLowerCase().trim() === currentReview.term.toLowerCase().trim()
              ? { ...ing, searchTerm: resolved.name, productQty: mealQty }
              : ing;
          });
          mealsApi
            .update(mealId, { ingredients: updatedIngredients })
            .then((updated) => onMealUpdated?.(updated))
            .catch(() => {});
        }
      }
    }

    if (reviewIdx < reviewQueue.length - 1) {
      setPickedItems(newPicked);
      setReviewIdx(reviewIdx + 1);
    } else {
      const exactItems = searchResults
        .filter((r) => r.exact && r.upc)
        .map((r) => ({ upc: r.upc!, quantity: r.quantity, description: r.description ?? '' }));
      await doAddToCart([...exactItems, ...newPicked]);
    }
  };

  const doAddToCart = async (cartItems: { upc: string; quantity: number; description?: string }[]) => {
    setStep('adding');
    if (cartItems.length === 0) {
      setTotalAdded(0);
      setAddedItems([]);
      setCartError('');
      setStep('done');
      return;
    }
    try {
      await krogerApi.addToCartDirect(cartItems, locationId);
      setTotalAdded(cartItems.length);
      setAddedItems(cartItems.map((i) => ({ description: i.description ?? '', quantity: i.quantity })));
      setCartError('');
    } catch (err: any) {
      setTotalAdded(0);
      setAddedItems([]);
      setCartError(err.message || 'Failed to add to cart');
    }
    setStep('done');
  };

  const updateQty = (i: number, delta: number) =>
    setItems((prev) =>
      prev.map((it, idx) => (idx === i ? { ...it, productQty: Math.max(0, it.productQty + delta) } : it)),
    );

  const toggleRemove = (i: number) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i ? { ...it, productQty: it.productQty === 0 ? 1 : 0 } : it,
      ),
    );

  const storeUrl = STORE_URLS[storeId] ?? 'kroger.com';
  const appScheme = STORE_APP_SCHEMES[storeId];

  const handleOpenStore = async () => {
    if (appScheme) {
      const canOpen = await Linking.canOpenURL(appScheme).catch(() => false);
      if (canOpen) {
        await Linking.openURL(appScheme);
        return;
      }
    }
    await Linking.openURL(`https://www.${storeUrl}/cart`);
  };

  // ── Title ────────────────────────────────────────────────────────────────

  const titleMap: Record<Step, string> = {
    qty: 'Review Ingredients',
    searching: 'Finding Products…',
    searchResult: 'Items Not Added',
    review: `Review Unmatched Ingredients (${reviewIdx + 1} of ${reviewQueue.length})`,
    adding: 'Adding to Cart…',
    done: 'Done!',
  };

  const activeCount = items.filter((it, i) => (checkedItems[i] ?? true) && it.productQty > 0).length;
  const allChecked = checkedItems.length === 0 || checkedItems.every((c) => c);
  const toggleAll = () => setCheckedItems((prev) => prev.map(() => !allChecked));
  const toggleChecked = (i: number) => setCheckedItems((prev) => prev.map((c, idx) => idx === i ? !c : c));

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>

        {/* Header */}
        <View style={styles.header}>
          <View style={{ width: 28 }} />
          <Text style={styles.title}>{titleMap[step]}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* ── Step: qty ─────────────────────────────────────────────────── */}
        {step === 'qty' && (
          <>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.listContent}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <TouchableOpacity onPress={toggleAll}>
                  <Text style={{ fontSize: 12, color: Colors.text3 }}>{allChecked ? 'Uncheck all' : 'Check all'}</Text>
                </TouchableOpacity>
                <Text style={styles.subheading}>
                  {meals.length} meal{meals.length !== 1 ? 's' : ''} · {items.length} ingredient{items.length !== 1 ? 's' : ''}
                </Text>
              </View>
              {items.map((it, i) => {
                const checked = checkedItems[i] ?? true;
                const excluded = !checked;
                return (
                  <View
                    key={i}
                    style={[styles.qtyRow, excluded && styles.qtyRowZeroed]}
                  >
                    <TouchableOpacity onPress={() => toggleChecked(i)} style={styles.checkbox}>
                      {checked && <View style={[styles.checkboxInner, { backgroundColor: storeColor }]} />}
                    </TouchableOpacity>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.ingName, excluded && styles.ingNameZeroed]}>
                        {it.searchTerm ?? it.ingredientName}
                      </Text>
                      {it.mealIngredients.map((mi, mIdx) => {
                        const isQty = it.unit.toLowerCase() === 'qty';
                        const measurement = isQty ? `${mi.qty} qty` : `${it.measure} ${it.unit}`;
                        return (
                          <Text key={mIdx} style={styles.mealNames}>
                            {mi.mealName} • {measurement}
                          </Text>
                        );
                      })}
                    </View>
                    <TouchableOpacity
                      onPress={() => updateQty(i, -1)}
                      disabled={it.productQty === 0 || excluded}
                      style={[styles.qtyBtn, (it.productQty === 0 || excluded) && { opacity: 0.3 }]}
                    >
                      <Text style={styles.qtyBtnText}>−</Text>
                    </TouchableOpacity>
                    <Text style={styles.qtyNum}>{it.productQty}</Text>
                    <TouchableOpacity
                      onPress={() => updateQty(i, 1)}
                      disabled={excluded}
                      style={[styles.qtyBtn, excluded && { opacity: 0.3 }]}
                    >
                      <Text style={styles.qtyBtnText}>+</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </ScrollView>
            <View style={styles.footer}>
              <TouchableOpacity
                onPress={handleStartSearch}
                disabled={activeCount === 0}
                style={[styles.primaryBtn, { backgroundColor: storeColor }, activeCount === 0 && { opacity: 0.4 }]}
              >
                <Text style={styles.primaryBtnText}>Add Ingredients to {storeName} Cart →</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onClose} style={styles.ghostBtn}>
                <Text style={styles.ghostBtnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* ── Step: searching ───────────────────────────────────────────── */}
        {step === 'searching' && (
          <View style={styles.centered}>
            <StoreSpinner color={storeColor} />
            <Text style={styles.spinnerLabel}>
              Searching for {activeCount} ingredient{activeCount !== 1 ? 's' : ''}…
            </Text>
          </View>
        )}

        {/* ── Step: searchResult ────────────────────────────────────────── */}
        {step === 'searchResult' && (() => {
          const needsReview = searchResults.filter((r) => !r.exact);
          const autoAdded = searchResults.filter((r) => r.exact && r.upc);
          return (
            <>
              <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.listContent, { alignItems: 'center' }]}>
                <Text style={{ fontSize: 44, marginBottom: 16 }}>⚠️</Text>
                <Text style={[styles.doneTitle, { marginBottom: 8 }]}>
                  {needsReview.length} item{needsReview.length !== 1 ? 's' : ''} could not be added to cart
                </Text>
                <Text style={[styles.doneSub, { marginBottom: 20 }]}>
                  This may be because the item is out of stock or the store no longer carries it.
                </Text>
                {autoAdded.length > 0 && (
                  <Text style={[styles.doneSub, { marginBottom: 20 }]}>
                    {autoAdded.length} item{autoAdded.length !== 1 ? 's' : ''} matched and will be added automatically.
                  </Text>
                )}
                <View style={{ width: '100%', borderRadius: 12, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden' }}>
                  {needsReview.map((r, i) => (
                    <View
                      key={i}
                      style={{
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderBottomWidth: i < needsReview.length - 1 ? 1 : 0,
                        borderBottomColor: Colors.border,
                      }}
                    >
                      <Text style={{ fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text1 }}>
                        {r.searchTerm ?? r.term}
                      </Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
              <View style={styles.footer}>
                <TouchableOpacity
                  onPress={() => setStep('review')}
                  style={[styles.primaryBtn, { backgroundColor: storeColor }]}
                >
                  <Text style={styles.primaryBtnText}>
                    Review {needsReview.length} Item{needsReview.length !== 1 ? 's' : ''} →
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          );
        })()}

        {/* ── Step: review ──────────────────────────────────────────────── */}
        {step === 'review' && currentReview && (() => {
          const displaySuggestions = customSuggestions.length > 0 ? customSuggestions : currentReview.suggestions;
          const hasSuggestions = displaySuggestions.length > 0;
          const canAdd = hasSuggestions
            ? selectedSuggIdx !== 'custom' || customText.trim().length > 0
            : selectedSuggIdx === 'custom' && customText.trim().length > 0;
          const mealQtys = getReviewMealQtys(reviewIdx);
          const totalQty = getReviewTotalQty(reviewIdx);

          const selectedImageUrl = typeof selectedSuggIdx === 'number'
            ? (displaySuggestions[selectedSuggIdx]?.imageUrl ?? null)
            : null;

          return (
            <>
              {selectedImageUrl ? (
                <View style={styles.floatingImageWrap} pointerEvents="none">
                  <Image source={{ uri: selectedImageUrl }} style={styles.floatingImage} contentFit="contain" />
                </View>
              ) : null}
              <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.listContent}>
                {/* What was searched */}
                {currentReview.reason === 'out_of_stock' && (
                  <Text style={{ fontSize: 12, fontFamily: 'Inter_500Medium', color: '#b45309', marginBottom: 6 }}>⚠ Out of stock at this store</Text>
                )}
                {currentReview.reason === 'no_results' && (
                  <Text style={{ fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.text3, marginBottom: 6 }}>No products found for this search</Text>
                )}
                {(!currentReview.reason || currentReview.reason === 'low_confidence') && (
                  <Text style={{ fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.text3, marginBottom: 6 }}>No exact match found</Text>
                )}
                <View style={styles.searchedBox}>
                  <Text style={styles.searchedLabel}>You searched for</Text>
                  <Text style={styles.searchedTerm}>{currentReview.searchTerm ?? currentReview.term}</Text>
                  {currentReview.mealIngredients.map((mi, mIdx) => {
                    const isQty = (currentReview.unit ?? 'qty') === 'qty';
                    const measurement = isQty ? `${mi.qty} qty` : `${currentReview.measure} ${currentReview.unit}`;
                    return (
                      <Text key={mIdx} style={styles.searchedMeals}>{mi.mealName} • {measurement}</Text>
                    );
                  })}
                  {customSearchTerm ? (
                    <Text style={[styles.searchedMeals, { color: storeColor, marginTop: 4 }]}>
                      Showing results for: "{customSearchTerm}"
                    </Text>
                  ) : null}
                </View>

                {/* Suggestions header */}
                <Text style={styles.suggHeader}>
                  {hasSuggestions ? 'Kroger suggests' : 'No exact match found'}
                </Text>

                {/* Suggestion list */}
                {displaySuggestions.map((s, i) => {
                  const selected = selectedSuggIdx === i;
                  const label = formatSuggestionLabel(s);
                  const isWeight = s.soldBy === 'WEIGHT';
                  const priceLabel = s.price != null
                    ? (isWeight && s.size
                        ? `$${s.price.toFixed(2)} / ${s.size.replace(/(\d)([a-zA-Z])/, '$1 $2').toLowerCase()}`
                        : `$${s.price.toFixed(2)}`)
                    : null;
                  return (
                    <TouchableOpacity
                      key={i}
                      onPress={() => setSelectedSuggIdx(i)}
                      style={[
                        styles.suggRow,
                        {
                          borderColor: selected ? storeColor : Colors.border,
                          backgroundColor: selected ? '#e8f4fb' : Colors.surface,
                        },
                      ]}
                      activeOpacity={0.7}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                        <Text style={[styles.suggText, { flex: 1 }]}>{label}</Text>
                        {priceLabel != null && (
                          <Text style={styles.suggPrice}>{priceLabel}</Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  );
                })}

                {/* Custom option */}
                <TouchableOpacity
                  onPress={() => setSelectedSuggIdx('custom')}
                  style={[
                    styles.suggRow,
                    {
                      borderColor: selectedSuggIdx === 'custom' ? storeColor : Colors.border,
                      backgroundColor: selectedSuggIdx === 'custom' ? '#e8f4fb' : Colors.surface,
                    },
                  ]}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.suggText,
                      { color: selectedSuggIdx === 'custom' ? Colors.text1 : Colors.text3 },
                    ]}
                  >
                    {customSuggestions.length > 0 ? 'Try a different search…' : 'Other — type a product name…'}
                  </Text>
                </TouchableOpacity>
                {selectedSuggIdx === 'custom' && (
                  <TextInput
                    autoFocus
                    value={customText}
                    onChangeText={setCustomText}
                    placeholder="e.g. Ground Beef 80/20"
                    placeholderTextColor={Colors.text3}
                    style={[styles.customInput, { borderColor: storeColor }]}
                    onSubmitEditing={() => { if (customText.trim()) handleReviewDecision('add'); }}
                    returnKeyType="search"
                  />
                )}
              </ScrollView>

              <View style={[styles.footer, { gap: 8 }]}>
                {/* Per-meal qty selectors */}
                {currentReview.mealIngredients.map((mi) => {
                  const mealQtys = getReviewMealQtys(reviewIdx);
                  const qty = mealQtys[mi.mealId] ?? mi.qty;
                  const isQtyUnit = !currentReview.unit || currentReview.unit === 'qty';
                  const measurement = isQtyUnit ? null : `${currentReview.measure ?? ''} ${currentReview.unit}`.trim();
                  const label = measurement ? `${mi.mealName} • ${measurement}` : mi.mealName;
                  return (
                    <View key={mi.mealId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text2, flex: 1 }}>{label}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <TouchableOpacity onPress={() => adjustReviewMealQty(reviewIdx, mi.mealId, -1)} style={styles.qtyBtn}>
                          <Text style={styles.qtyBtnText}>−</Text>
                        </TouchableOpacity>
                        <Text style={{ fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1, minWidth: 20, textAlign: 'center' }}>{qty}</Text>
                        <TouchableOpacity onPress={() => adjustReviewMealQty(reviewIdx, mi.mealId, 1)} style={styles.qtyBtn}>
                          <Text style={styles.qtyBtnText}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
                <TouchableOpacity
                  onPress={() => handleReviewDecision('update')}
                  disabled={!canAdd || customSearching}
                  style={[
                    styles.primaryBtn,
                    { backgroundColor: storeColor },
                    (!canAdd || customSearching) && { opacity: 0.4 },
                  ]}
                >
                  <Text style={styles.primaryBtnText}>
                    {customSearching ? 'Searching…' : 'Add & Update Meal Ingredient'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleReviewDecision('add')}
                  disabled={!canAdd || customSearching}
                  style={[styles.secondaryBtn, { borderColor: storeColor }, (!canAdd || customSearching) && { opacity: 0.4 }]}
                >
                  <Text style={[styles.secondaryBtnText, { color: storeColor }]}>Add to Cart Only</Text>
                </TouchableOpacity>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {reviewIdx > 0 && (
                    <TouchableOpacity
                      onPress={() => { setReviewIdx(reviewIdx - 1); setPickedItems(prev => prev.slice(0, -1)); }}
                      disabled={customSearching}
                      style={[styles.skipBtn, { flex: 1, borderWidth: 1, borderColor: Colors.border, borderRadius: 12 }, customSearching && { opacity: 0.4 }]}
                    >
                      <Text style={styles.skipBtnText}>← Back</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    onPress={() => handleReviewDecision('skip')}
                    disabled={customSearching}
                    style={[styles.skipBtn, { flex: 1 }, customSearching && { opacity: 0.4 }]}
                  >
                    <Text style={styles.skipBtnText}>Skip this ingredient</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </>
          );
        })()}

        {/* ── Step: adding ──────────────────────────────────────────────── */}
        {step === 'adding' && (
          <View style={styles.centered}>
            <StoreSpinner color={storeColor} />
            <Text style={styles.spinnerLabel}>Adding items to your {storeName} cart…</Text>
          </View>
        )}

        {/* ── Step: done ────────────────────────────────────────────────── */}
        {step === 'done' && (
          <>
            <View style={{ alignItems: 'center', paddingHorizontal: 24, paddingTop: 24, paddingBottom: 12 }}>
              {cartError ? (
                <>
                  <Text style={styles.doneEmoji}>⚠️</Text>
                  <Text style={[styles.doneTitle, { color: Colors.error }]}>
                    Failed to add items to cart.
                  </Text>
                  <Text style={styles.doneSub}>
                    Kroger returned an error. Please try again or add items manually.
                  </Text>
                </>
              ) : totalAdded > 0 ? (
                <>
                  <Text style={styles.doneEmoji}>🛒</Text>
                  <Text style={styles.doneTitle}>
                    {totalAdded} item{totalAdded !== 1 ? 's' : ''} added to your {storeName} cart!
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.doneEmoji}>😔</Text>
                  <Text style={styles.doneTitle}>No items were added.</Text>
                  <Text style={styles.doneSub}>
                    No matching products were found or all were skipped.
                  </Text>
                </>
              )}
            </View>
            {addedItems.length > 0 && (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8 }}>
                {addedItems.map((item, i) => (
                  <View
                    key={i}
                    style={{
                      paddingVertical: 10,
                      borderBottomWidth: i < addedItems.length - 1 ? 1 : 0,
                      borderBottomColor: Colors.border,
                    }}
                  >
                    <Text style={{ fontSize: 14, color: Colors.text1, fontFamily: 'Inter_400Regular' }}>
                      {item.description}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            )}
            {addedItems.length === 0 && <View style={{ flex: 1 }} />}
            <View style={[styles.footer, { gap: 8 }]}>
              {!cartError && totalAdded > 0 && (
                <TouchableOpacity
                  onPress={handleOpenStore}
                  style={[styles.primaryBtn, { backgroundColor: storeColor }]}
                >
                  <Text style={styles.primaryBtnText}>Open {storeName} to Checkout</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={onClose}
                style={[styles.secondaryBtn, { borderColor: storeColor }]}
              >
                <Text style={[styles.secondaryBtnText, { color: storeColor }]}>Done</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

      </SafeAreaView>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: { fontSize: 16, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  close: { fontSize: 18, color: Colors.text3 },

  listContent: { paddingHorizontal: 20, paddingVertical: 16 },

  subheading: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
  },

  // Qty step
  qtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 6,
  },
  qtyRowZeroed: { opacity: 0.45 },
  ingName: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: Colors.text1,
    marginBottom: 2,
  },
  ingNameZeroed: { textDecorationLine: 'line-through' },
  mealNames: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  qtyBtn: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  qtyBtnText: { fontSize: 14, color: Colors.text2, lineHeight: 18 },
  qtyNum: {
    width: 20,
    textAlign: 'center',
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    flexShrink: 0,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  checkboxInner: {
    width: 12,
    height: 12,
    borderRadius: 2,
  },

  // Qty by recipe (review step)
  qtyByRecipeBox: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 16,
  },
  qtyByRecipeLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  qtyByRecipeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  qtyByRecipeMeal: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
  },
  qtyByRecipeCaution: {
    fontSize: 13,
    color: '#b45309',
  },
  qtyByRecipeTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  qtyByRecipeTotalLabel: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text2,
  },
  qtyByRecipeTotalValue: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text1,
  },

  // Review step
  searchedBox: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 16,
  },
  searchedLabel: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    marginBottom: 2,
  },
  searchedTerm: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  searchedMeals: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    marginTop: 2,
  },
  measurementHint: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: '#b91c1c',
    marginTop: 6,
    opacity: 0.85,
  },
  suggHeader: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text3,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  suggRow: {
    borderRadius: 10,
    borderWidth: 1.5,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  suggText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text1 },
  suggPrice: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text2, flexShrink: 0 },
  outOfStock: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: '#b45309',
    marginTop: 2,
  },
  customInput: {
    borderWidth: 1.5,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    backgroundColor: Colors.surface,
    marginTop: 6,
    marginBottom: 6,
  },

  // Shared footer / buttons
  footer: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  primaryBtn: {
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 0,
  },
  primaryBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: '#fff',
  },
  secondaryBtn: {
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: Colors.text1,
  },
  ghostBtn: {
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  ghostBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
  },
  skipBtn: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  skipBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
  },

  // Floating image (review step)
  floatingImageWrap: {
    position: 'absolute',
    top: 70,
    right: 16,
    width: 80,
    height: 80,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 6,
    zIndex: 10,
    overflow: 'hidden',
  },
  floatingImage: { width: '100%', height: '100%' },

  // Centered (spinners / done)
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 16,
  },
  spinnerLabel: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    textAlign: 'center',
  },

  // Done step
  doneEmoji: { fontSize: 44, marginBottom: 8 },
  doneTitle: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    color: Colors.text1,
    textAlign: 'center',
  },
  doneSub: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    textAlign: 'center',
    lineHeight: 20,
  },
  errorText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: Colors.error,
    textAlign: 'center',
    marginTop: 8,
  },
});
