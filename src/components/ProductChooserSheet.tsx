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
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../constants/colors';
import { Meal } from '../types';
import { kroger as krogerApi, meals as mealsApi } from '../lib/api';

type Step = 'searching' | 'picking' | 'saving' | 'done';
type Suggestion = { upc: string; description: string; size?: string | null; soldBy?: string | null; averageWeightPerUnit?: string | null; price: number | null; stockLevel?: string; imageUrl?: string | null };

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
  const [productQty, setProductQty] = useState(0);
  const [selectedDescription, setSelectedDescription] = useState<string | null>(null);
  const [customText, setCustomText] = useState('');
  const [customSearching, setCustomSearching] = useState(false);
  const [savedCount, setSavedCount] = useState(0);

  const unchosenIngredients = meal.ingredients.filter((i) => !i.searchTerm);
  const current = results[pickIdx];
  const isLast = pickIdx === results.length - 1;

  const selectedImageUrl: string | null = (selectedDescription && current)
    ? current.suggestions.find((s) => {
        const isWeight = s.soldBy === 'WEIGHT';
        const name = isWeight ? formatWeightName(s.description, s.averageWeightPerUnit, s.size) : (s.size && !s.description.includes(s.size) ? `${s.description}, ${s.size}` : s.description);
        return name === selectedDescription;
      })?.imageUrl ?? null
    : null;

  useEffect(() => {
    if (visible) {
      setStep('searching');
      setError('');
      setResults([]);
      setPickIdx(0);
      setSelections(new Map());
      setProductQty(0);
      setSelectedDescription(null);
      setCustomText('');
      setSavedCount(0);
      doSearch();
    }
  }, [visible]);

  useEffect(() => {
    setCustomText('');
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

  function handleSelectProduct(displayName: string) {
    setSelectedDescription((prev) => (prev === displayName ? null : displayName));
  }

  function handleBack() {
    const newSelections = new Map(selections);
    if (selectedDescription && current) {
      newSelections.set(current.ingredientName, { description: selectedDescription, qty: productQty });
    } else if (current) {
      newSelections.delete(current.ingredientName);
    }
    setSelections(newSelections);
    const prevIdx = pickIdx - 1;
    const prevSel = results[prevIdx] ? newSelections.get(results[prevIdx].ingredientName) : undefined;
    setSelectedDescription(prevSel?.description ?? null);
    setProductQty(prevSel?.qty ?? unchosenIngredients[prevIdx]?.productQty ?? unchosenIngredients[prevIdx]?.qty ?? 1);
    setPickIdx(prevIdx);
  }

  function handleNextBtn() {
    const newSelections = new Map(selections);
    if (selectedDescription && current) {
      newSelections.set(current.ingredientName, { description: selectedDescription, qty: productQty });
    }
    setSelections(newSelections);
    if (!isLast) {
      const nextIdx = pickIdx + 1;
      const nextSel = results[nextIdx] ? newSelections.get(results[nextIdx].ingredientName) : undefined;
      setSelectedDescription(nextSel?.description ?? null);
      setProductQty(nextSel?.qty ?? 0);
      setPickIdx(nextIdx);
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
          <View style={{ flex: 1 }}>
          {selectedImageUrl ? (
            <View style={styles.floatingImageWrap} pointerEvents="none">
              <Image source={{ uri: selectedImageUrl }} style={styles.floatingImage} contentFit="contain" />
            </View>
          ) : null}
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
                const displayName = isWeight ? formatWeightName(s.description, s.averageWeightPerUnit, s.size) : (s.size && !s.description.includes(s.size) ? `${s.description}, ${s.size}` : s.description);
                const priceLabel = s.price != null
                  ? (isWeight && s.size
                      ? `$${s.price.toFixed(2)} / ${s.size.replace(/(\d)([a-zA-Z])/, '$1 $2').toLowerCase()}`
                      : `$${s.price.toFixed(2)}`)
                  : null;
                const isSelected = selectedDescription === displayName;
                return (
                  <TouchableOpacity
                    key={i}
                    style={[styles.suggRow, isSelected && { borderColor: storeColor, backgroundColor: `${storeColor}18` }]}
                    onPress={() => handleSelectProduct(displayName)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.suggLeft}>
                      <Text style={[styles.suggName, isSelected && { fontFamily: 'Inter_600SemiBold' }]}>{displayName}</Text>
                      {s.stockLevel === 'TEMPORARILY_OUT_OF_STOCK' && (
                        <Text style={styles.outOfStock}>⚠ Temporarily out of stock</Text>
                      )}
                    </View>
                    {priceLabel != null && (
                      <Text style={styles.suggPrice}>{priceLabel}</Text>
                    )}
                    {isSelected && <Ionicons name="checkmark-circle" size={20} color={storeColor} />}
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
            <View style={styles.footer}>
              <View style={styles.qtySection}>
                <View style={styles.qtyRow}>
                  <Text style={styles.qtyLabel}>Qty to add to cart</Text>
                  <View style={styles.qtyControls}>
                    <TouchableOpacity
                      style={styles.qtyBtn}
                      onPress={() => setProductQty((q) => Math.max(0, q - 1))}
                      disabled={productQty <= 0}
                    >
                      <Text style={[styles.qtyBtnText, productQty <= 0 && { opacity: 0.3 }]}>−</Text>
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
              <TouchableOpacity
                style={[styles.navBtn, styles.navBtnSecondary, pickIdx === 0 && { opacity: 0.3 }]}
                onPress={handleBack}
                disabled={pickIdx === 0}
              >
                <Text style={styles.navBtnSecondaryText}>← Back</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.navBtn, { backgroundColor: storeColor }]}
                onPress={handleNextBtn}
              >
                <Text style={styles.navBtnText}>{isLast ? 'Save' : 'Next →'}</Text>
              </TouchableOpacity>
            </View>
          </>
          </View>
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
  qtyWarning: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: '#92400e', backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fbbf24', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginTop: 6 },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: 12,
  },
  navBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: Radius.button,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBtnSecondary: {
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
  },
  navBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: '#fff' },
  navBtnSecondaryText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.text2 },
  floatingImageWrap: {
    position: 'absolute',
    top: 12,
    right: 16,
    width: 88,
    height: 88,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 8,
    zIndex: 10,
    overflow: 'hidden',
  },
  floatingImage: { width: '100%', height: '100%' },
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
