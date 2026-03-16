import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../constants/colors';
import { Meal } from '../types';
import { kroger as krogerApi, meals as mealsApi } from '../lib/api';

type Step = 'searching' | 'picking' | 'saving' | 'done';
type Suggestion = { upc: string; description: string; size?: string | null; soldBy?: string | null; price: number | null; stockLevel?: string };

interface Props {
  visible: boolean;
  meal: Meal;
  locationId: string;
  storeName: string;
  storeColor: string;
  onClose: () => void;
  onMealUpdated: (updated: Meal) => void;
}

export default function ProductChooserSheet({
  visible, meal, locationId, storeName, storeColor, onClose, onMealUpdated,
}: Props) {
  const [step, setStep] = useState<Step>('searching');
  const [error, setError] = useState('');
  const [results, setResults] = useState<Array<{ ingredientName: string; suggestions: Suggestion[] }>>([]);
  const [pickIdx, setPickIdx] = useState(0);
  const [selections, setSelections] = useState<Map<string, { description: string; qty: number }>>(new Map());
  const [productQty, setProductQty] = useState(1);
  const [customText, setCustomText] = useState('');
  const [customSearching, setCustomSearching] = useState(false);
  const [savedCount, setSavedCount] = useState(0);

  const unchosenIngredients = meal.ingredients.filter((i) => !i.searchTerm);
  const current = results[pickIdx];
  const isLast = pickIdx === results.length - 1;

  useEffect(() => {
    if (visible) {
      setStep('searching');
      setError('');
      setResults([]);
      setPickIdx(0);
      setSelections(new Map());
      setProductQty(meal.ingredients[0]?.productQty ?? meal.ingredients[0]?.qty ?? 1);
      setCustomText('');
      setSavedCount(0);
      doSearch();
    }
  }, [visible]);

  useEffect(() => {
    setCustomText('');
    setProductQty(meal.ingredients[pickIdx]?.productQty ?? meal.ingredients[pickIdx]?.qty ?? 1);
  }, [pickIdx]);

  async function doSearch() {
    try {
      const data = await krogerApi.searchProducts(
        unchosenIngredients.map((i) => ({
          productName: i.ingredientName,
          searchTerm: null as any,
          unit: i.unit,
          measure: i.measure,
          quantity: 1,
        })),
        locationId,
      );
      setResults(
        unchosenIngredients.map((ing, idx) => ({
          ingredientName: ing.ingredientName,
          suggestions: (data.results[idx]?.suggestions ?? []) as Suggestion[],
        })),
      );
      setPickIdx(0);
      setStep('picking');
    } catch (err: any) {
      setError(err.message || 'Search failed');
    }
  }

  async function handleCustomSearch() {
    if (!customText.trim()) return;
    setCustomSearching(true);
    try {
      const data = await krogerApi.searchProducts(
        [{ productName: customText.trim(), quantity: 1 }],
        locationId,
      );
      setResults((prev) =>
        prev.map((r, i) =>
          i === pickIdx ? { ...r, suggestions: (data.results[0]?.suggestions ?? []) as Suggestion[] } : r,
        ),
      );
      setCustomText('');
    } catch {}
    setCustomSearching(false);
  }

  function handleNext(description: string | null) {
    const newSelections = new Map(selections);
    if (description && current) newSelections.set(current.ingredientName, { description, qty: productQty });
    setSelections(newSelections);
    if (!isLast) {
      setPickIdx(pickIdx + 1);
    } else {
      doSave(newSelections);
    }
  }

  async function doSave(selMap: Map<string, { description: string; qty: number }>) {
    setStep('saving');
    const updatedIngredients = meal.ingredients.map((ing) => {
      const chosen = selMap.get(ing.ingredientName);
      return chosen !== undefined ? { ...ing, searchTerm: chosen.description, productQty: chosen.qty } : ing;
    });
    const count = selMap.size;
    try {
      const updated = await mealsApi.update(meal.id, { ingredients: updatedIngredients });
      if (updated) onMealUpdated(updated);
      setSavedCount(count);
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    }
    setStep('done');
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.title}>
              {step === 'searching' && 'Searching Products…'}
              {step === 'picking' && `Choose Product (${pickIdx + 1} of ${results.length})`}
              {step === 'saving' && 'Saving…'}
              {step === 'done' && 'Products Chosen!'}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>{meal.name}</Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={22} color={Colors.text2} />
          </TouchableOpacity>
        </View>

        {step === 'searching' && (
          <View style={styles.centered}>
            {error ? (
              <>
                <Text style={styles.errorText}>{error}</Text>
                <TouchableOpacity style={[styles.retryBtn, { backgroundColor: storeColor }]} onPress={doSearch}>
                  <Text style={styles.retryBtnText}>Retry</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <ActivityIndicator color={storeColor} size="large" />
                <Text style={styles.searchingText}>
                  Searching for {unchosenIngredients.length} ingredient{unchosenIngredients.length !== 1 ? 's' : ''}…
                </Text>
              </>
            )}
          </View>
        )}

        {step === 'picking' && current && (
          <>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
              <View style={styles.searchedBox}>
                <Text style={styles.searchedLabel}>{meal.name} calls for</Text>
                <Text style={styles.searchedName}>{(() => {
                  const ing = unchosenIngredients[pickIdx];
                  if (!ing) return current.ingredientName;
                  if (!ing.unit || ing.unit === 'qty') return `${ing.ingredientName}, ${ing.qty ?? 1}`;
                  return `${ing.ingredientName}, ${ing.measure ?? ''} ${ing.unit}`.replace(/\s+/g, ' ').trim();
                })()}</Text>
              </View>
              <Text style={styles.sectionLabel}>
                {current.suggestions.length > 0 ? `${storeName} products` : 'No products found'}
              </Text>
              {current.suggestions.map((s, i) => {
                const isWeight = s.soldBy === 'WEIGHT';
                const displayName = isWeight ? s.description : (s.size ? `${s.description}, ${s.size}` : s.description);
                const priceLabel = s.price != null
                  ? (isWeight && s.size
                      ? `$${s.price.toFixed(2)} / ${s.size.replace(/(\d)([a-zA-Z])/, '$1 $2').toLowerCase()}`
                      : `$${s.price.toFixed(2)}`)
                  : null;
                return (
                  <TouchableOpacity
                    key={i}
                    style={styles.suggRow}
                    onPress={() => handleNext(displayName)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.suggLeft}>
                      <Text style={styles.suggName}>{displayName}</Text>
                      {s.stockLevel === 'TEMPORARILY_OUT_OF_STOCK' && (
                        <Text style={styles.outOfStock}>⚠ Temporarily out of stock</Text>
                      )}
                    </View>
                    {priceLabel != null && (
                      <Text style={styles.suggPrice}>{priceLabel}</Text>
                    )}
                  </TouchableOpacity>
                );
              })}
              <View style={styles.customRow}>
                <TextInput
                  style={styles.customInput}
                  placeholder="Search different product…"
                  placeholderTextColor={Colors.text3}
                  value={customText}
                  onChangeText={setCustomText}
                  onSubmitEditing={handleCustomSearch}
                  returnKeyType="search"
                  editable={!customSearching}
                />
                <TouchableOpacity
                  style={[styles.customSearchBtn, { backgroundColor: storeColor }, (!customText.trim() || customSearching) && styles.btnDisabled]}
                  onPress={handleCustomSearch}
                  disabled={!customText.trim() || customSearching}
                >
                  {customSearching
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <Ionicons name="search" size={16} color="#fff" />}
                </TouchableOpacity>
              </View>
            </ScrollView>
            <View style={styles.qtySection}>
              <View style={styles.qtyRow}>
                <Text style={styles.qtyLabel}>Qty to add to cart</Text>
                <View style={styles.qtyControls}>
                  <TouchableOpacity
                    style={styles.qtyBtn}
                    onPress={() => setProductQty((q) => Math.max(1, q - 1))}
                    disabled={productQty <= 1}
                  >
                    <Text style={[styles.qtyBtnText, productQty <= 1 && { opacity: 0.3 }]}>−</Text>
                  </TouchableOpacity>
                  <Text style={styles.qtyNum}>{productQty}</Text>
                  <TouchableOpacity style={styles.qtyBtn} onPress={() => setProductQty((q) => q + 1)}>
                    <Text style={styles.qtyBtnText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>
              {productQty > 2 && (
                <Text style={styles.qtyWarning}>
                  ⚠ {productQty} is a lot for one item — does this come in a multipack or bulk size?
                </Text>
              )}
            </View>
            <View style={styles.footer}>
              {pickIdx > 0 && (
                <TouchableOpacity style={styles.skipBtn} onPress={() => setPickIdx(pickIdx - 1)}>
                  <Text style={styles.skipBtnText}>← Back</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.skipBtn} onPress={() => handleNext(null)}>
                <Text style={styles.skipBtnText}>{isLast ? 'Skip & Save' : 'Skip'}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {step === 'saving' && (
          <View style={styles.centered}>
            <ActivityIndicator color={storeColor} size="large" />
            <Text style={styles.searchingText}>Saving your product choices…</Text>
          </View>
        )}

        {step === 'done' && (
          <View style={styles.doneContainer}>
            <Text style={styles.doneIcon}>{error ? '⚠️' : savedCount > 0 ? '✅' : '👋'}</Text>
            <Text style={styles.doneTitle}>
              {error ? 'Failed to save' : savedCount > 0 ? 'Products chosen!' : 'No products chosen'}
            </Text>
            <Text style={styles.doneBody}>
              {error
                ? error
                : savedCount > 0
                  ? `${savedCount} of ${unchosenIngredients.length} ingredient${unchosenIngredients.length !== 1 ? 's' : ''} linked to a ${storeName} product.`
                  : 'You can choose products at any time from the meal card.'}
            </Text>
            <TouchableOpacity style={styles.doneBtn} onPress={onClose}>
              <Text style={styles.doneBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        )}
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
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerLeft: { flex: 1, marginRight: 12 },
  title: { fontSize: 16, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  subtitle: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, marginTop: 2 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  searchingText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text2 },
  errorText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.error, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: Radius.button },
  retryBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: '#fff' },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, gap: 12 },
  searchedBox: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.card,
    padding: 12,
  },
  searchedLabel: { fontSize: 11, fontFamily: 'Inter_400Regular', color: Colors.text3, marginBottom: 4 },
  searchedName: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  suggRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
    gap: 8,
  },
  suggLeft: { flex: 1 },
  suggName: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text1 },
  outOfStock: { fontSize: 11, fontFamily: 'Inter_500Medium', color: '#b45309', marginTop: 2 },
  suggPrice: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text2 },
  customRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  customInput: {
    flex: 1,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
  },
  customSearchBtn: {
    width: 40,
    height: 40,
    borderRadius: Radius.button,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.4 },
  qtySection: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: 6,
  },
  qtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  qtyLabel: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text2 },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  qtyBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyBtnText: { fontSize: 18, color: Colors.text2, lineHeight: 22 },
  qtyNum: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1, minWidth: 20, textAlign: 'center' },
  qtyWarning: { fontSize: 11, fontFamily: 'Inter_500Medium', color: '#b45309' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: 12,
  },
  skipBtn: { paddingHorizontal: 12, paddingVertical: 8 },
  skipBtnText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  doneContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  doneIcon: { fontSize: 48 },
  doneTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.text1, textAlign: 'center' },
  doneBody: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    textAlign: 'center',
    lineHeight: 20,
  },
  doneBtn: {
    marginTop: 8,
    width: '100%',
    paddingVertical: 12,
    borderRadius: Radius.button,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
  },
  doneBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
});
