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
import FollowingListSheet from '../../components/FollowingListSheet';
import StoreSelectorSheet from '../../components/StoreSelectorSheet';
import FilterSheet, { FilterValues, EMPTY_FILTERS } from '../../components/FilterSheet';
import WelcomeSheet from '../../components/WelcomeSheet';
import { hasSeen, markSeen, FIRST_RUN_WELCOME } from '../../lib/firstRun';
import { POPULAR_TAGS, DISCOVER_TAG_CHIPS } from '../../constants/tags';
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

  /**
   * Which fetch is still allowed to write.
   *
   * Tapping a segment starts a request and does not cancel the one before it,
   * so switching fast enough lets the OLDER answer land last and overwrite the
   * newer one. Stephen, 2026-09-09: "if I click following then back to trending
   * very quick, it will show the following filter, and not switch back to
   * trending." The header said Trending because the header is state; the list
   * said Following because the list was whatever resolved last.
   *
   * Every call takes a number, and only the newest number may touch state.
   *
   * What this deliberately does NOT do: the stale request is not cancelled (the
   * API client has no abort), and its `finally` does not clear the loading
   * flags. Clearing them from a discarded response is how the website's version
   * of this guard ended up spinning forever -- the newest request clears them in
   * its own `finally`, which is the only one that means anything.
   */
  const fetchGenRef = React.useRef(0);
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

  // Who you follow, shown at the top of the Following feed.
  //
  // It used to live only on the Account screen, three taps away from the feed
  // that is made of these people's meals. Stephen, 2026-09-09: "easier way to
  // see who you're following on discover tab instead of having followers in
  // account page."
  const [followedCreators, setFollowedCreators] = useState<Creator[]>([]);
  const [followingListVisible, setFollowingListVisible] = useState(false);

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

  /**
   * The tags the chip row offers.
   *
   * Curated order, cut to what the catalogue has meals for: a chip whose tag
   * nobody has used can only ever answer "No meals found", and the row is meant
   * to be the fast way in. Until the facets land -- or if that read fails -- it
   * shows the first of the curated list rather than an empty row, because a row
   * that appears a second later moves everything under it.
   */
  const chipTags = React.useMemo(() => {
    if (facets.tags.length === 0) return POPULAR_TAGS.slice(0, DISCOVER_TAG_CHIPS);
    const inUse = new Set(facets.tags.map((t) => t.toLowerCase()));
    return POPULAR_TAGS.filter((t) => inUse.has(t.toLowerCase())).slice(0, DISCOVER_TAG_CHIPS);
  }, [facets.tags]);

  /**
   * ANY-OF, and it has to be. A meal carries at most MAX_MEAL_TAGS tags, so an
   * all-of row would ask for two of a meal's three on the second tap and for
   * the impossible on the third. It is also what `?tags=` already means on the
   * server, so the chips and the filter sheet cannot mean different things by
   * the same request.
   *
   * The chips write into `filters.tags` rather than keeping a selection of
   * their own: the filter sheet reads that too, so a tag chosen in either place
   * shows as chosen in both, and the request is built once.
   */
  function toggleTag(tag: string) {
    setFilters((prev) => ({
      ...prev,
      tags: prev.tags.includes(tag) ? prev.tags.filter((t) => t !== tag) : [...prev.tags, tag],
    }));
  }

  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    setLoading(true);
    loadData(0, true);
  }, [segment, filters, debouncedSearch]);

  // Read on every entry into Following rather than once, because following is
  // the one list on this screen the user changes from inside the app: follow
  // someone from a creator sheet, come back, and the strip has to have them.
  // Keyed on the user's id and the segment name -- both plain strings, never a
  // fresh object -- because the website's version of this effect span forever
  // once a new Set() reached its dependency array.
  useEffect(() => {
    if (segment !== 'Following' || !user) {
      if (!user) setFollowedCreators([]);
      return;
    }
    loadFollowing();
  }, [segment, user?.id]);

  async function loadFollowing() {
    try {
      setFollowedCreators(await creatorsApi.following());
    } catch {
      // The strip is a convenience over the feed below it; a failed read leaves
      // it out rather than putting an error where the creators should be.
    }
  }

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
    const gen = ++fetchGenRef.current;
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

      // A newer segment, filter or search started while this was in flight, so
      // this answer is about a question nobody is asking any more.
      // A newer segment, filter or search started while this was in flight, so
      // this answer is about a question nobody is asking any more.
      if (fetchGenRef.current !== gen) return;

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
      // Same rule for the failure: a stale request's error is not this screen's
      // problem, and an alert about the feed you already left is noise.
      if (fetchGenRef.current !== gen) return;
      Alert.alert('Error', err.message || 'Could not load meals');
    } finally {
      if (fetchGenRef.current === gen) {
        loadingMoreRef.current = false;
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
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

  /**
   * A creator named somewhere on this screen, tapped: the byline on an open
   * meal, the face on a card, or the strip at the top of the Following feed.
   *
   * The meal carries the creator's id and name and nothing else, and the profile
   * sheet shows a bio and a follower count, so this fetches the creator rather
   * than opening the sheet on the three fields a meal happens to hold. The meal
   * sheet closes first: two page-sheet modals stacked is the website's order too
   * (its card closes the detail modal before opening the creator popup).
   */
  async function openCreatorById(creatorId: string) {
    setDetailVisible(false);
    try {
      const { creator } = await creatorsApi.getById(creatorId);
      // `GET /api/creators/[id]` does not say whether YOU follow them, so the
      // sheet opens on "Follow" for someone you already follow. Where this
      // screen knows the answer -- it is holding the followed list for the
      // strip -- it says so, which is every open from the strip itself.
      openCreatorProfile(
        followedCreators.some((c) => c.id === creatorId)
          ? { ...creator, isFollowing: true }
          : creator,
      );
    } catch {
      Alert.alert('Not available', 'That creator profile could not be loaded.');
    }
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
      // Creator first, author second, which is the order the website's card has
      // always used. It matters now that the card also shows the creator's face:
      // the name under it has to be the person the face belongs to.
      subtitle={item.creatorName ?? item.author ?? undefined}
      creatorPhotoUrl={item.creatorPhotoUrl}
      creatorName={item.creatorName}
      onCreatorPress={item.creatorId ? () => openCreatorById(item.creatorId!) : undefined}
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
          // NO `clearButtonMode`. It is iOS-only and renders a NATIVE clear
          // button inside the field -- so on a phone it sat next to the one
          // below and the search box had two ✕ icons, while Android showed one.
          // Stephen, 2026-09-09, on the app: "there are two x icons to the
          // right." Measured: one on the Pixel, because `clearButtonMode` does
          // nothing there.
          //
          // The custom button is the one that stays, because it is the only one
          // that exists on both platforms. Losing it to keep the native one
          // would leave Android with no way to clear the field at all.
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity
            testID="search-clear"
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            onPress={() => setSearchQuery('')}
            style={styles.searchClear}
          >
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
            {/* Tag chips. Inside the list header, NOT above it with the search
                box: the search box is how you get back to everything and stays
                put, while these are a starting point and scroll away with the
                meals they filtered. */}
            {chipTags.length > 0 && (
              <View style={styles.tagChipRow} testID="tag-chip-row">
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.tagChipRowContent}
                >
                  {chipTags.map((tag) => {
                    const on = filters.tags.includes(tag);
                    return (
                      <TouchableOpacity
                        key={tag}
                        style={[styles.tagChip, on && styles.tagChipOn]}
                        onPress={() => toggleTag(tag)}
                        testID={`tag-chip-${tag}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                      >
                        <Text style={[styles.tagChipText, on && styles.tagChipTextOn]}>{tag}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            )}

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

            {/* Creators you follow — the Following feed is made of their meals,
                so this is where "who am I following?" is actually asked. It
                stands in for the featured strip rather than sitting beside it:
                two rows of round faces one above the other read as one list. */}
            {segment === 'Following' && followedCreators.length > 0 && (
              <View style={styles.creatorsSection}>
                <View style={styles.followHeaderRow}>
                  <Text style={[styles.sectionTitle, styles.followHeaderTitle]}>Creators You Follow</Text>
                  <TouchableOpacity
                    onPress={() => setFollowingListVisible(true)}
                    testID="see-all-following"
                    accessibilityRole="button"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.seeAll}>See all {followedCreators.length}</Text>
                  </TouchableOpacity>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {followedCreators.map((creator) => (
                    <TouchableOpacity
                      key={creator.id}
                      style={styles.creatorChip}
                      testID={`following-creator-${creator.id}`}
                      accessibilityRole="button"
                      accessibilityLabel={`View ${creator.displayName}'s profile`}
                      onPress={() => openCreatorById(creator.id)}
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

            {/* Featured Creators */}
            {segment !== 'Following' && featuredCreators.length > 0 && (
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
              <Text style={styles.emptyText}>
                {segment === 'Following' && followedCreators.length === 0
                  ? 'You are not following anyone yet. Open a creator and tap Follow to see their meals here.'
                  : 'No meals found'}
              </Text>
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
        onCreatorPress={openCreatorById}
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

      <FollowingListSheet
        visible={followingListVisible}
        creators={followedCreators}
        onClose={() => setFollowingListVisible(false)}
        onOpenCreator={(creatorId) => { setFollowingListVisible(false); openCreatorById(creatorId); }}
        // The sheet holds no list of its own: an unfollow re-reads here and the
        // shorter list goes back down, so the sheet, the strip and the feed
        // cannot disagree about who you follow.
        onUnfollowed={() => { loadFollowing(); loadData(0, true); }}
      />

      <CreatorProfileSheet
        visible={creatorSheetVisible}
        creator={selectedCreator}
        onClose={() => setCreatorSheetVisible(false)}
        onFollowChange={() => { loadData(0, true); loadFollowing(); }}
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
  // The selected feed is brand red rather than a raised white pill: on this
  // screen the white pill sat on a near-white track and read as no selection at
  // all on a bright phone.
  segmentActive: { backgroundColor: Colors.brand, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
  segmentText: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text3 },
  segmentTextActive: { color: '#fff', fontFamily: 'Inter_600SemiBold' },
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
  // Negative margins cancel the list's own 12pt padding so the row runs to both
  // edges: a chip half off the screen is what says "this scrolls" without a
  // scrollbar. The content padding puts the first chip back where the search
  // box above it starts.
  tagChipRow: { marginHorizontal: -12, marginBottom: 16 },
  tagChipRowContent: { paddingHorizontal: 16, gap: 8 },
  tagChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tagChipOn: { backgroundColor: Colors.brand, borderColor: Colors.brand },
  tagChipText: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text2 },
  tagChipTextOn: { color: '#fff', fontFamily: 'Inter_600SemiBold' },
  creatorsSection: { marginBottom: 20 },
  followHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // The section title carries its own bottom margin, which the row would
  // otherwise stretch the link to match.
  followHeaderTitle: { marginBottom: 0 },
  seeAll: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: Colors.brand },
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
