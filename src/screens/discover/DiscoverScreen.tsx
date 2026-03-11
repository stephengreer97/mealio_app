import React, { useState, useEffect, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  Alert,
  TextInput,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../../constants/colors';
import { PresetMeal, Creator, Meal } from '../../types';
import { presetMeals as presetMealsApi, creators as creatorsApi, meals as mealsApi, payments as paymentsApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { STORES } from '../../constants/stores';
import MealCard from '../../components/MealCard';
import MealDetailSheet from '../../components/MealDetailSheet';
import CreatorProfileSheet from '../../components/CreatorProfileSheet';
import StoreSelectorSheet from '../../components/StoreSelectorSheet';
import FilterSheet, { FilterValues, EMPTY_FILTERS } from '../../components/FilterSheet';

const LIMIT = 20;

const SEGMENTS = ['Trending', 'New', 'Following'] as const;
type Segment = typeof SEGMENTS[number];

const SEGMENT_SORT: Record<Segment, string> = {
  Trending: 'trending',
  New: 'newest',
  Following: 'following',
};

const FREE_LIMIT = 3;

export default function DiscoverScreen() {
  const { user } = useAuth();
  const [segment, setSegment] = useState<Segment>('Trending');
  const [meals, setMeals] = useState<PresetMeal[]>([]);
  const [featuredCreators, setFeaturedCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Map of presetMealId → store names where user has already saved it
  const [savedMap, setSavedMap] = useState<Record<string, string[]>>({});
  const [totalMealCount, setTotalMealCount] = useState(0);

  const [filters, setFilters] = useState<FilterValues>(EMPTY_FILTERS);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterVisible, setFilterVisible] = useState(false);
  const [selectedMeal, setSelectedMeal] = useState<PresetMeal | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [storeSelectorVisible, setStoreSelectorVisible] = useState(false);
  const [selectedCreator, setSelectedCreator] = useState<Creator | null>(null);
  const [creatorSheetVisible, setCreatorSheetVisible] = useState(false);

  useEffect(() => {
    setLoading(true);
    loadData(0, true);
  }, [segment, filters]);

  useFocusEffect(
    useCallback(() => {
      loadSavedMap();
    }, [])
  );

  async function loadSavedMap() {
    try {
      const userMeals = await mealsApi.list();
      const active = userMeals.filter((m) => !m.deletedAt);
      setTotalMealCount(active.length);
      const map: Record<string, string[]> = {};
      for (const m of active) {
        if (!m.presetMealId) continue;
        const storeName = STORES.find((s) => s.id === m.storeId)?.name ?? m.storeId;
        if (!map[m.presetMealId]) map[m.presetMealId] = [];
        if (!map[m.presetMealId].includes(storeName)) map[m.presetMealId].push(storeName);
      }
      setSavedMap(map);
    } catch {
      // non-critical — silently ignore (e.g. not logged in)
    }
  }

  async function handleUpgrade() {
    try {
      const { portalUrl } = await paymentsApi.portal();
      if (portalUrl) await Linking.openURL(portalUrl);
    } catch {}
  }

  async function loadData(offset: number, reset: boolean) {
    try {
      const [result, creatorsData] = await Promise.all([
        presetMealsApi.list({
          limit: LIMIT,
          offset,
          tags: filters.tags,
          sort: SEGMENT_SORT[segment],
        }),
        featuredCreators.length === 0 ? creatorsApi.featured() : Promise.resolve(null),
      ]);

      if (creatorsData) setFeaturedCreators(creatorsData);

      if (reset) {
        setMeals(result.meals);
      } else {
        setMeals((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...result.meals.filter((m) => !seen.has(m.id))];
        });
      }
      setHasMore(result.hasMore);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not load meals');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    await loadData(meals.length, false);
  }

  function handleRefresh() {
    setRefreshing(true);
    loadData(0, true);
  }

  function handleApplyFilters(f: FilterValues) {
    setFilters(f);
  }

  function openMealDetail(meal: PresetMeal) {
    setSelectedMeal(meal);
    setDetailVisible(true);
  }

  function openCreatorProfile(creator: Creator) {
    setSelectedCreator(creator);
    setCreatorSheetVisible(true);
  }

  const activeFilterCount = [
    filters.tags.length > 0,
    filters.difficulty.length > 0,
    filters.authors.length > 0,
    filters.ingredients.length > 0,
    filters.excludeIngredients.length > 0,
  ].filter(Boolean).length;

  // Client-side filters then sort: unsaved first, saved last
  const filteredMeals = meals.filter((m) => {
    const q = searchQuery.trim().toLowerCase();
    if (q && !(m.name.toLowerCase().includes(q) || (m.creatorName ?? m.author ?? '').toLowerCase().includes(q))) return false;
    if (filters.tags.length > 0 && !filters.tags.some((t) => m.tags?.includes(t))) return false;
    if (filters.difficulty.length > 0 && !filters.difficulty.includes(m.difficulty ?? -1)) return false;
    if (filters.authors.length > 0) {
      const mAuthor = (m.creatorName ?? m.author ?? '').toLowerCase();
      if (!filters.authors.some((a) => mAuthor.includes(a.toLowerCase()))) return false;
    }
    if (filters.ingredients.length > 0) {
      const names = m.ingredients.map((i) => i.productName.toLowerCase());
      if (!filters.ingredients.every((ing) => names.some((n) => n.includes(ing)))) return false;
    }
    if (filters.excludeIngredients.length > 0) {
      const names = m.ingredients.map((i) => i.productName.toLowerCase());
      if (filters.excludeIngredients.some((ex) => names.some((n) => n.includes(ex)))) return false;
    }
    return true;
  }).sort((a, b) => {
    const aSaved = savedMap[a.id] ? 1 : 0;
    const bSaved = savedMap[b.id] ? 1 : 0;
    return aSaved - bSaved;
  });

  const authorSuggestions = [...new Set(
    meals.flatMap((m) => [m.author, m.creatorName]).filter((a): a is string => Boolean(a))
  )];

  const renderMeal = useCallback(({ item, index }: { item: PresetMeal; index: number }) => {
    if (index % 2 !== 0) return null; // render pairs
    const next = filteredMeals[index + 1] ?? null;
    return (
      <View style={styles.mealRow}>
        <MealCard
          meal={item}
          onPress={() => openMealDetail(item)}
          subtitle={item.author ?? item.creatorName ?? undefined}
          savedAt={savedMap[item.id]}
        />
        {next ? (
          <MealCard
            meal={next}
            onPress={() => openMealDetail(next)}
            subtitle={next.author ?? next.creatorName ?? undefined}
            savedAt={savedMap[next.id]}
          />
        ) : (
          <View style={{ flex: 1, marginHorizontal: 4 }} />
        )}
      </View>
    );
  }, [filteredMeals, savedMap]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.titleRow}>
        <Text style={styles.logo}>Mealio</Text>
        <TouchableOpacity style={styles.filterBtn} onPress={() => setFilterVisible(true)}>
          <Ionicons name="options-outline" size={22} color={Colors.text1} />
          {activeFilterCount > 0 && (
            <View style={styles.filterBadge}>
              <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* Segment control */}
      <View style={styles.segmentRow}>
        {SEGMENTS.map((seg) => (
          <TouchableOpacity
            key={seg}
            style={[styles.segment, segment === seg && styles.segmentActive]}
            onPress={() => setSegment(seg)}
          >
            <Text style={[styles.segmentText, segment === seg && styles.segmentTextActive]}>
              {seg}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Search bar */}
      <View style={styles.searchRow}>
        <Ionicons name="search-outline" size={18} color={Colors.text3} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search meals or creators…"
          placeholderTextColor={Colors.text3}
          value={searchQuery}
          onChangeText={setSearchQuery}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.searchClear}>
            <Ionicons name="close-circle" size={16} color={Colors.text3} />
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={filteredMeals}
        keyExtractor={(item) => item.id}
        renderItem={renderMeal}
        contentContainerStyle={styles.list}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.brand} />}
        ListHeaderComponent={
          <>
            {/* Upgrade nudge for free tier */}
            {user?.tier !== 'paid' && (
              <TouchableOpacity style={styles.upgradeBanner} onPress={handleUpgrade} activeOpacity={0.8}>
                <Text style={styles.upgradeBannerText}>
                  {totalMealCount >= FREE_LIMIT
                    ? '🔒 Meal limit reached — upgrade for unlimited saves'
                    : `✨ ${totalMealCount} of ${FREE_LIMIT} free meals saved — upgrade for unlimited`}
                </Text>
                <Ionicons name="arrow-forward" size={13} color={Colors.brand} />
              </TouchableOpacity>
            )}

            {/* Featured Creators */}
            {featuredCreators.length > 0 && (
              <View style={styles.creatorsSection}>
                <Text style={styles.sectionTitle}>Featured Creators</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {featuredCreators.map((creator) => (
                    <TouchableOpacity
                      key={creator.id}
                      style={styles.creatorChip}
                      onPress={() => openCreatorProfile(creator)}
                    >
                      {creator.photoUrl ? (
                        <Image source={{ uri: creator.photoUrl }} style={styles.creatorAvatar} contentFit="cover" />
                      ) : (
                        <View style={[styles.creatorAvatar, styles.creatorAvatarPlaceholder]}>
                          <Text style={styles.creatorInitial}>{creator.displayName?.[0]?.toUpperCase() ?? '?'}</Text>
                        </View>
                      )}
                      <Text style={styles.creatorName} numberOfLines={1}>{creator.displayName}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}
            <Text style={styles.sectionTitle}>{segment} Meals</Text>
          </>
        }
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No meals found</Text>
            </View>
          ) : null
        }
      />

      <FilterSheet
        visible={filterVisible}
        initial={filters}
        authorSuggestions={authorSuggestions}
        onClose={() => setFilterVisible(false)}
        onApply={handleApplyFilters}
      />

      <MealDetailSheet
        visible={detailVisible}
        meal={selectedMeal}
        mode="view"
        onClose={() => setDetailVisible(false)}
        onPressSave={() => {
          setDetailVisible(false);
          setStoreSelectorVisible(true);
        }}
      />

      <StoreSelectorSheet
        visible={storeSelectorVisible}
        meal={selectedMeal}
        onClose={() => setStoreSelectorVisible(false)}
        onSaved={() => { setStoreSelectorVisible(false); loadSavedMap(); }}
      />

      <CreatorProfileSheet
        visible={creatorSheetVisible}
        creator={selectedCreator}
        onClose={() => setCreatorSheetVisible(false)}
        onFollowChange={() => loadData(0, true)}
        onPressSaveMeal={(meal) => { setSelectedMeal(meal); setCreatorSheetVisible(false); setStoreSelectorVisible(true); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  logo: { fontSize: 28, fontFamily: 'Pacifico_400Regular', color: Colors.brand },
  filterBtn: { padding: 8, position: 'relative' },
  filterBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: Colors.brand,
    borderRadius: 8,
    width: 16,
    height: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterBadgeText: { fontSize: 10, color: '#fff', fontFamily: 'Inter_700Bold' },
  segmentRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: Colors.surface,
    borderRadius: Radius.button,
    padding: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: Radius.button - 2,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: Colors.surfaceRaised, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
  segmentText: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text3 },
  segmentTextActive: { color: Colors.text1, fontFamily: 'Inter_600SemiBold' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: Colors.surface,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    height: 40,
  },
  searchIcon: { marginRight: 6 },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    paddingVertical: 0,
    letterSpacing: 0,
  },
  searchClear: { padding: 2 },
  list: { paddingHorizontal: 12, paddingBottom: 20 },
  mealRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 0 },
  creatorsSection: { marginBottom: 20 },
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    color: Colors.text1,
    marginBottom: 12,
    marginTop: 4,
  },
  creatorChip: { alignItems: 'center', marginRight: 16, width: 72 },
  creatorAvatar: { width: 56, height: 56, borderRadius: 28, marginBottom: 6, backgroundColor: Colors.surface },
  creatorAvatarPlaceholder: { backgroundColor: Colors.brand, justifyContent: 'center', alignItems: 'center' },
  creatorInitial: { fontSize: 22, fontFamily: 'Inter_700Bold', color: '#fff' },
  creatorName: { fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.text2, textAlign: 'center' },
  empty: { flex: 1, alignItems: 'center', paddingTop: 60 },
  emptyText: { fontSize: 16, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  upgradeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.brandLight,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#fccdd4',
    gap: 6,
  },
  upgradeBannerText: {
    flex: 1,
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: Colors.brand,
  },
});
