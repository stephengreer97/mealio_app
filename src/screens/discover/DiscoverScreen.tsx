import React, { useState, useEffect, useCallback } from 'react';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
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

} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../../constants/colors';
import { PresetMeal, Creator, Meal } from '../../types';
import { presetMeals as presetMealsApi, creators as creatorsApi, meals as mealsApi } from '../../lib/api';
import { getOffering, purchasePackage } from '../../lib/purchases';
import { useAuth } from '../../context/AuthContext';
import { STORES } from '../../constants/stores';
import MealCard from '../../components/MealCard';
import MealDetailSheet from '../../components/MealDetailSheet';
import CreatorProfileSheet from '../../components/CreatorProfileSheet';
import StoreSelectorSheet from '../../components/StoreSelectorSheet';
import FilterSheet, { FilterValues, EMPTY_FILTERS } from '../../components/FilterSheet';
import WelcomeSheet from '../../components/WelcomeSheet';
import { hasSeen, markSeen, FIRST_RUN_WELCOME } from '../../lib/firstRun';

const LIMIT = 20;

const ALL_SEGMENTS = ['Trending', 'New', 'Following'] as const;
type Segment = typeof ALL_SEGMENTS[number];

const SEGMENT_SORT: Record<Segment, string> = {
  Trending: 'trending',
  New: 'newest',
  Following: 'following',
};

const FREE_LIMIT = 3;

export default function DiscoverScreen() {
  const { user, refreshUser } = useAuth();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const onSignIn: (() => void) | undefined = route.params?.onSignIn;
  const onReady: (() => void) | undefined = route.params?.onReady;
  const readyCalled = React.useRef(false);
  const SEGMENTS = user ? ALL_SEGMENTS : (['Trending', 'New'] as const);
  const [segment, setSegment] = useState<Segment>('Trending');
  const [meals, setMeals] = useState<PresetMeal[]>([]);
  const [featuredCreators, setFeaturedCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = React.useRef(false);
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

  // First run: the pitch (MEAL-84). Discover is the front door for signed-in and
  // signed-out users alike, and a grid of recipe photos never says that Mealio
  // fills a grocery cart. Held until the first load finishes so it does not
  // animate in over the splash screen, and shown once per device.
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const welcomeChecked = React.useRef(false);

  useEffect(() => {
    setLoading(true);
    loadData(0, true);
  }, [segment, filters]);

  useEffect(() => {
    if (loading || welcomeChecked.current) return;
    welcomeChecked.current = true;
    let cancelled = false;
    (async () => {
      if (!(await hasSeen(FIRST_RUN_WELCOME)) && !cancelled) setWelcomeVisible(true);
    })();
    return () => { cancelled = true; };
  }, [loading]);

  // Every exit from the sheet is this one: the ✕, the backdrop, the button, the
  // Android back gesture. Marked seen on the way out rather than on the way in,
  // so an app killed mid-pitch still gets to show it.
  function dismissWelcome() {
    setWelcomeVisible(false);
    markSeen(FIRST_RUN_WELCOME);
  }

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
      const pkg = await getOffering();
      if (!pkg) {
        Alert.alert('Unavailable', 'No subscription plans found. Please try again later.');
        return;
      }
      const active = await purchasePackage(pkg);
      if (active) {
        await refreshUser();
        Alert.alert('Welcome to Full Access!', 'Your subscription is now active.');
      } else {
        // Purchase succeeded but the entitlement hasn't propagated yet.
        Alert.alert('Purchase received', 'Activating your subscription… this can take a moment.');
        await refreshUser();
      }
    } catch (err: any) {
      if (!err.userCancelled) {
        Alert.alert('Purchase Failed', err.message || 'Something went wrong. Please try again.');
      }
    }
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
      loadingMoreRef.current = false;
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
      if (onReady && !readyCalled.current) {
        readyCalled.current = true;
        onReady();
      }
    }
  }

  async function loadMore() {
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
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

  // Client-side filters
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
      const names = m.ingredients.map((i) => i.ingredientName.toLowerCase());
      if (!filters.ingredients.every((ing) => names.some((n) => n.includes(ing)))) return false;
    }
    if (filters.excludeIngredients.length > 0) {
      const names = m.ingredients.map((i) => i.ingredientName.toLowerCase());
      if (filters.excludeIngredients.some((ex) => names.some((n) => n.includes(ex)))) return false;
    }
    return true;
  });

  // Saved meals are held back until all pages are loaded so they always appear at the very end
  const unsavedMeals = filteredMeals.filter((m) => !savedMap[m.id]);
  const savedMeals = filteredMeals.filter((m) => !!savedMap[m.id]);
  const displayMeals = hasMore ? unsavedMeals : [...unsavedMeals, ...savedMeals];

  const authorSuggestions = [...new Set(
    meals.flatMap((m) => [m.author, m.creatorName]).filter((a): a is string => Boolean(a))
  )];

  // One card per item + numColumns={2} so FlatList can virtualize rows, instead
  // of manual index%2 pairing (which forced every item through renderItem).
  const renderMeal = useCallback(({ item, index }: { item: PresetMeal; index: number }) => (
    <MealCard
      meal={item}
      onPress={() => openMealDetail(item)}
      subtitle={item.author ?? item.creatorName ?? undefined}
      savedAt={savedMap[item.id]}
      testID={`meal-card-${index}`}
    />
  ), [savedMap]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.titleRow}>
        <Text style={styles.logo}>Mealio</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {onSignIn && (
            <TouchableOpacity onPress={onSignIn} style={styles.signInBtn}>
              <Text style={styles.signInBtnText}>Sign In</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.filterBtn} onPress={() => setFilterVisible(true)} testID="filter-btn">
            <Ionicons name="options-outline" size={22} color={Colors.text1} />
            {activeFilterCount > 0 && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
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
        data={displayMeals}
        keyExtractor={(item) => item.id}
        renderItem={renderMeal}
        numColumns={2}
        columnWrapperStyle={styles.mealRow}
        contentContainerStyle={styles.list}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.brand} />}
        ListHeaderComponent={
          <>
            {/* Upgrade nudge for free tier */}
            {user && user?.tier !== 'paid' && totalMealCount >= FREE_LIMIT && (
              <TouchableOpacity style={styles.upgradeBanner} onPress={handleUpgrade} activeOpacity={0.8}>
                <Ionicons
                  name={totalMealCount >= FREE_LIMIT ? 'lock-closed' : 'sparkles'}
                  size={13}
                  color={Colors.brand}
                  style={{ marginRight: 4 }}
                />
                <Text style={styles.upgradeBannerText}>
                  {totalMealCount >= FREE_LIMIT
                    ? 'Meal limit reached. Upgrade for unlimited saves'
                    : `${totalMealCount} of ${FREE_LIMIT} free meals saved. Upgrade for unlimited`}
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
                      <Text style={styles.creatorName} numberOfLines={2}>{creator.displayName}</Text>
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

      <WelcomeSheet visible={welcomeVisible} onDismiss={dismissWelcome} />

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
          if (!user) {
            setDetailVisible(false);
            Alert.alert('Sign In Required', 'Create an account or sign in to save meals.', [
              { text: 'Not now', style: 'cancel' },
              { text: 'Sign In', onPress: () => onSignIn?.() },
            ]);
            return;
          }
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
        isLoggedIn={!!user}
        onSignIn={() => { const parent = navigation.getParent?.(); if (parent?.navigate) parent.navigate('Auth'); else onSignIn?.(); }}
        onPressSaveMeal={(meal) => {
          setCreatorSheetVisible(false);
          if (!user) {
            Alert.alert('Sign In Required', 'Create an account or sign in to save meals.', [
              { text: 'Not now', style: 'cancel' },
              {
                text: 'Sign In',
                onPress: () => {
                  const parent = navigation.getParent?.();
                  if (parent?.navigate) parent.navigate('Auth');
                },
              },
            ]);
            return;
          }
          setSelectedMeal(meal);
          setStoreSelectorVisible(true);
        }}
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
  signInBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: Colors.brand },
  signInBtnText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: '#fff' },
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
