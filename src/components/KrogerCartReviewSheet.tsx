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
import { Colors, Radius } from '../constants/colors';
import { Meal, Ingredient } from '../types';
import { kroger as krogerApi, meals as mealsApi } from '../lib/api';
import { STORES } from '../constants/stores';

// ── Types ────────────────────────────────────────────────────────────────────

interface ConsolidatedIngredient {
  productName: string;
  quantity: number;
  mealIds: string[];
  mealNames: string[];
}

interface SearchResult {
  term: string;
  quantity: number;
  upc: string | null;
  description: string | null;
  exact: boolean;
  suggestions: Array<{
    upc: string;
    description: string;
    size: string;
    price: number | null;
    stockLevel?: string;
    imageUrl?: string;
  }>;
  mealIds: string[];
  mealNames: string[];
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

type Step = 'qty' | 'searching' | 'review' | 'adding' | 'done';

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

function consolidateIngredients(meals: Array<Pick<Meal, 'id' | 'name' | 'ingredients'>>): ConsolidatedIngredient[] {
  const map = new Map<string, ConsolidatedIngredient>();
  for (const meal of meals) {
    for (const ing of meal.ingredients) {
      const key = (ing.productName ?? '').toLowerCase().trim();
      if (!key) continue;
      if (map.has(key)) {
        const e = map.get(key)!;
        e.quantity += ing.quantity ?? 1;
        if (!e.mealIds.includes(meal.id)) {
          e.mealIds.push(meal.id);
          e.mealNames.push(meal.name);
        }
      } else {
        map.set(key, {
          productName: ing.productName,
          quantity: ing.quantity ?? 1,
          mealIds: [meal.id],
          mealNames: [meal.name],
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

  // Step review
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [pickedItems, setPickedItems] = useState<{ upc: string; quantity: number; description: string }[]>([]);

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
      setItems(consolidateIngredients(meals));
      setStep('qty');
      setError('');
      setSearchResults([]);
      setReviewIdx(0);
      setPickedItems([]);
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

  // ── Step handlers ────────────────────────────────────────────────────────

  const handleStartSearch = async () => {
    const active = items.filter((i) => i.quantity > 0);
    if (active.length === 0) return;
    setStep('searching');
    setError('');
    try {
      const data = await krogerApi.searchProducts(
        active.map((i) => ({ productName: i.productName, quantity: i.quantity })),
        locationId,
      );
      const results: SearchResult[] = data.results.map((r: any) => {
        const src = active.find(
          (c) => c.productName.toLowerCase().trim() === r.term.toLowerCase().trim(),
        );
        return {
          ...r,
          suggestions: r.suggestions ?? [],
          mealIds: src?.mealIds ?? [],
          mealNames: src?.mealNames ?? [],
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
        setStep('review');
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
      if (resolved?.upc) {
        newPicked.push({ upc: resolved.upc, quantity: currentReview.quantity, description: resolved.name });
      }
      if (action === 'update' && resolved?.name) {
        for (const mealId of currentReview.mealIds) {
          const meal = meals.find((m) => m.id === mealId);
          if (!meal) continue;
          const updatedIngredients: Ingredient[] = meal.ingredients.map((ing) =>
            ing.productName.toLowerCase().trim() === currentReview.term.toLowerCase().trim()
              ? { ...ing, productName: resolved.name, searchTerm: resolved.name }
              : ing,
          );
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

  const doAddToCart = async (cartItems: { upc: string; quantity: number; description: string }[]) => {
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
      setAddedItems(cartItems.map((i) => ({ description: i.description, quantity: i.quantity })));
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
      prev.map((it, idx) => (idx === i ? { ...it, quantity: Math.max(0, it.quantity + delta) } : it)),
    );

  const toggleRemove = (i: number) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i ? { ...it, quantity: it.quantity === 0 ? 1 : 0 } : it,
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
    review: `Choose Product (${reviewIdx + 1} of ${reviewQueue.length})`,
    adding: 'Adding to Cart…',
    done: 'Done!',
  };

  const activeCount = items.filter((i) => i.quantity > 0).length;

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
              <Text style={styles.subheading}>
                {meals.length} meal{meals.length !== 1 ? 's' : ''} · {items.length} ingredient{items.length !== 1 ? 's' : ''}
              </Text>
              {items.map((it, i) => {
                const zeroed = it.quantity === 0;
                return (
                  <View
                    key={i}
                    style={[styles.qtyRow, zeroed && styles.qtyRowZeroed]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        style={[styles.ingName, zeroed && styles.ingNameZeroed]}
                        numberOfLines={1}
                      >
                        {it.productName}
                      </Text>
                      <Text style={styles.mealNames} numberOfLines={1}>
                        {it.mealNames.join(', ')}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => updateQty(i, -1)}
                      disabled={zeroed}
                      style={[styles.qtyBtn, zeroed && { opacity: 0.3 }]}
                    >
                      <Text style={styles.qtyBtnText}>−</Text>
                    </TouchableOpacity>
                    <Text style={styles.qtyNum}>{it.quantity}</Text>
                    <TouchableOpacity onPress={() => updateQty(i, 1)} style={styles.qtyBtn}>
                      <Text style={styles.qtyBtnText}>+</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => toggleRemove(i)} style={styles.removeBtn}>
                      <Text style={[styles.removeBtnText, zeroed && { color: storeColor }]}>
                        {zeroed ? '↩' : '✕'}
                      </Text>
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
                <Text style={styles.primaryBtnText}>Search {storeName} Products →</Text>
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

        {/* ── Step: review ──────────────────────────────────────────────── */}
        {step === 'review' && currentReview && (() => {
          const displaySuggestions = customSuggestions.length > 0 ? customSuggestions : currentReview.suggestions;
          const hasSuggestions = displaySuggestions.length > 0;
          const canAdd = hasSuggestions
            ? selectedSuggIdx !== 'custom' || customText.trim().length > 0
            : selectedSuggIdx === 'custom' && customText.trim().length > 0;

          return (
            <>
              <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.listContent}>
                {/* What was searched */}
                <View style={styles.searchedBox}>
                  <Text style={styles.searchedLabel}>You searched for</Text>
                  <Text style={styles.searchedTerm}>{currentReview.term}</Text>
                  {currentReview.mealNames.length > 0 && (
                    <Text style={styles.searchedMeals}>from: {currentReview.mealNames.join(', ')}</Text>
                  )}
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
                        <Text style={[styles.suggText, { flex: 1 }]}>{s.description}</Text>
                        {s.price != null && (
                          <Text style={styles.suggPrice}>${s.price.toFixed(2)}</Text>
                        )}
                      </View>
                      {s.stockLevel === 'TEMPORARILY_OUT_OF_STOCK' && (
                        <Text style={styles.outOfStock}>⚠ Temporarily out of stock</Text>
                      )}
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
                <TouchableOpacity
                  onPress={() => handleReviewDecision('skip')}
                  disabled={customSearching}
                  style={[styles.skipBtn, customSearching && { opacity: 0.4 }]}
                >
                  <Text style={styles.skipBtnText}>Skip this ingredient</Text>
                </TouchableOpacity>
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
    marginBottom: 12,
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
  removeBtn: { paddingHorizontal: 4, flexShrink: 0 },
  removeBtnText: { fontSize: 13, color: Colors.text3 },

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
