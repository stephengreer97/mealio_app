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
import { getStores } from '../../lib/store-catalog';
import MealCard from '../../components/MealCard';
import MealDetailSheet from '../../components/MealDetailSheet';
import CreatorProfileSheet from '../../components/CreatorProfileSheet';
import StoreSelectorSheet from '../../components/StoreSelectorSheet';
import FilterSheet, { FilterValues, EMPTY_FILTERS } from '../../components/FilterSheet';
import WelcomeSheet from '../../components/WelcomeSheet';
import { hasSeen, markSeen, FIRST_RUN_WELCOME } from '../../lib/firstRun';
import { useDeepLinkBusy } from '../../context/DeepLinkContext';

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
  //
  // `welcomeDue` is "this device has not seen it"; `welcomeVisible` is "and now
  // is a moment to show it". They are separate because a deep link can be
  // occupying the screen with a Modal of its own that this one would stack on
  // top of — see src/context/DeepLinkContext.ts. Due survives the wait; the flag
  // is only spent by an actual dismissal, so a deep-linked first-run user gets
  // the pitch after the meal sheet closes rather than instead of it.
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const [welcomeDue, setWelcomeDue] = useState(false);
  const welcomeChecked = React.useRef(false);
  const deepLinkBusy = useDeepLinkBusy();

  // The search box reaches the server now, so it is debounced: typing
  // "chicken" is one request rather than seven, and 300ms still feels like the
  // list is following you.
  const [facets, setFacets] = useState<{ tags: string[]; authors: string[] }>({ tags: [], authors: [] });
  // Once. Facets come off the same 10-minute cached catalogue the feeds read
  // and change only when a creator publishes, so refetching per segment would
  // ask the same question again.
  useEffect(() => {
    let cancelled = false;
    presetMealsApi.facets()
      .then((f) => { if (!cancelled) setFacets(f); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    setLoading(true);
    loadData(0, true);
  }, [segment, filters, debouncedSearch]);

  useEffect(() => {
    if (loading || welcomeChecked.current) return;
    welcomeChecked.current = true;
    let cancelled = false;
    (async () => {
      if (!(await hasSeen(FIRST_RUN_WELCOME)) && !cancelled) setWelcomeDue(true);
    })();
    return () => { cancelled = true; };
  }, [loading]);

  useEffect(() => {
    setWelcomeVisible(welcomeDue && !deepLinkBusy);
  }, [welcomeDue, deepLinkBusy]);

  // Every exit from the sheet is this one: the ✕, the backdrop, the button, the
  // Android back gesture. Marked seen on the way out rather than on the way in,
  // so an app killed mid-pitch still gets to show it.
  function dismissWelcome() {
    setWelcomeDue(false);
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
        // getStores(), not useStores(): this runs inside an async loader, not in
        // render, so there is no subscription to hold — the map it builds is
        // written to state and repaints on its own.
        const storeName = getStores().find((s) => s.id === m.storeId)?.name ?? m.storeId;
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
          sort: SEGMENT_SORT[segment],
          // ALL of them, not just tags. These used to be applied below over the
          // meals already loaded, so a filter meant "among the ones we happen
          // to be holding" and scrolling revealed more matches.
          tags: filters.tags,
          difficulty: filters.difficulty,
          authors: filters.authors,
          ingredients: filters.ingredients,
          excludeIngredients: filters.excludeIngredients,
          q: debouncedSearch,
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

  // NO CLIENT-SIDE FILTERING. Every rule that narrows the catalogue runs on the
  // server now, before the rows are cut into pages, because that is the only
  // place all of them are visible at once. Re-applying them here would be
  // harmless today and a second definition to drift tomorrow, and the drift is
  // invisible: both sides look right on their own.
  //
  // Saved-vs-unsaved stays, and is not a filter. It is a reordering of what came
  // back, from this device's own state that the server has no reason to know.
  const filteredMeals = meals;

  const unsavedMeals = filteredMeals.filter((m) => !savedMap[m.id]);
  const savedMeals = filteredMeals.filter((m) => !!savedMap[m.id]);
  const displayMeals = hasMore ? unsavedMeals : [...unsavedMeals, ...savedMeals];

  // FROM THE SERVER, over the whole catalogue, not from the meals this screen
  // happens to be holding. Someone whose meals sit on page 4 was never
  // suggested; the filter is free text so typing the name still worked, which
  // is why nobody would report it.
  const authorSuggestions = facets.authors;

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
        extraTags={facets.tags}
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
