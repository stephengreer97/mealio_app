import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TextInput,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { Colors, Radius } from '../../constants/colors';
import { Meal, Ingredient } from '../../types';
import { meals as mealsApi, kroger as krogerApi } from '../../lib/api';
import { getOffering, purchasePackage } from '../../lib/purchases';
import { mergeChosenProduct, createMealSaveQueue } from '../../lib/saveChosenIngredient';
import { useAuth } from '../../context/AuthContext';
import { useSessionEnd } from '../../context/useSessionEnd';
import { isKrogerBrand, isWebViewStore } from '../../constants/stores';
import { getStores } from '../../lib/store-catalog';
import { useStores } from '../../lib/store-catalog/useStores';
import MealCard from '../../components/MealCard';
import MealDetailSheet from '../../components/MealDetailSheet';
import KrogerCartReviewSheet from '../../components/KrogerCartReviewSheet';
import WebViewCartSheet from '../../components/WebViewCartSheet';
import ProductChooserSheet from '../../components/ProductChooserSheet';
import ChooseProductsIntroSheet from '../../components/ChooseProductsIntroSheet';
import { hasSeen, markSeen, FIRST_RUN_CHOOSE_PRODUCTS } from '../../lib/firstRun';
import { isChooseRun } from '../../lib/chooseRun';
import { useCartJob } from '../../context/CartJobContext';
import { useLoginPrewarm } from '../../context/LoginPrewarmContext';
import { FEATURE_BACKGROUND_CART } from '../../constants/features';
import IngredientEditor from '../../components/IngredientEditor';
import PhotoPicker from '../../components/PhotoPicker';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import TagPicker from '../../components/TagPicker';

const FREE_LIMIT = 3;

function unchosenIngredients(meal: Meal): any[] {
  return (meal.ingredients ?? []).filter((i: any) => {
    const term = i.searchTerm ?? i.search_term ?? null;
    return term === null || term === undefined;
  });
}

function hasUnchosenProducts(meal: Meal): boolean {
  return unchosenIngredients(meal).length > 0;
}

/**
 * Will the WebView sheet treat this selection as a Choose Products run?
 *
 * Asks the sheet's own question, from `lib/chooseRun.ts`, so the button that
 * starts a run and the title of the screen it opens cannot disagree. See that
 * module for why "every item" and not "any meal", and why Kroger keeps the
 * other question.
 */
function isWebViewChooseRun(meals: Meal[]): boolean {
  return isChooseRun(
    meals.flatMap((m) => ((m.ingredients ?? []) as any[]).map(
      (i) => ({ searchTerm: i.searchTerm ?? i.search_term ?? null }),
    )),
  );
}

export default function MyMealsScreen() {
  const { user, isCreator, refreshUser } = useAuth();
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [allMeals, setAllMeals] = useState<Meal[]>([]);
  // Mirror of allMeals read by handleIngredientChosen. The handler must build
  // its PATCH from the FRESHEST ingredient array (including saves still settling
  // from a prior choice on the same meal), not the render-time snapshot — see
  // the per-meal serialization in handleIngredientChosen.
  const allMealsRef = useRef<Meal[]>([]);
  useEffect(() => { allMealsRef.current = allMeals; }, [allMeals]);
  // Per-meal promise chain so concurrent choices on the same meal serialize
  // instead of racing (each PATCH rewrites the meal's whole ingredient array;
  // overlapping writes from a stale base would clobber each other).
  const enqueueMealSave = useRef(createMealSaveQueue()).current;
  // The end of a session abandons whatever is still on that chain (MEAL-142).
  // Because the saves for one meal are serialised, a run that chose several
  // products for the same meal leaves several of them queued; once the session
  // is over every one is doomed, and the failure path below logs the product
  // name, the ingredient name and the meal id into the console ring buffer —
  // arbitrarily late, after the buffer was emptied, possibly after the next
  // person has signed in. That is the same leak CartJobContext's teardown exists
  // to close, from a second writer: on a shared phone the next person's bug
  // report would carry the previous person's product names under their own
  // verified userId.
  //
  // Which of the two guards below fires depends on how the session ends, and
  // MEAL-146 is why both are needed:
  //
  //   • SIGN-OUT unmounts this screen. RootNavigator renders MainTabs only
  //     `if (user)`, so `user` going null REMOVES the screen rather than
  //     re-rendering it signed-out, and the cleanup is the half that runs
  //     (probed under MEAL-142 — only the cleanup ran).
  //   • ANOTHER ACCOUNT TAKING OVER did not, when MEAL-146 was written. B
  //     arriving through the verification deep link keeps `user` truthy, so
  //     MainTabs was reconciled rather than swapped and this screen was never
  //     unmounted; the cleanup never ran and the queue survived into B's
  //     session, where every save is a 401 or a 404 for a meal that is not B's,
  //     and each failure names one of A's products in B's buffer.
  //     `useSessionEnd` is the half that catches that — and, being keyed on the
  //     user id rather than on the object, it does NOT fire for a token renewal
  //     or a profile refresh, which would silently drop a live user's own saves.
  //
  // MEAL-154 has since keyed MainTabs on the account id, so a hand-over does
  // remount this screen. That does not make the hook redundant and the epoch is
  // still the thing a save is compared against: a PATCH already in flight comes
  // back to a closure that outlives the unmount, and one navigator option is all
  // it takes for a future hand-over to reach a still-mounted instance again.
  //
  // A COUNTER, NOT A FLAG, and that distinction is the whole of MEAL-146's
  // second review. A boolean "saves are abandoned" was safe only while the
  // premise above was "the screen is unmounted either way": every session got a
  // fresh instance, so nothing had to un-set it. Resting on that premise is what
  // turns the same flag into a one-way latch the moment a session outlives the
  // instance that set it — B chooses a product, the latch A left behind drops
  // the PATCH before it is sent, and the guard in the catch swallows the line
  // that would have said so. Silent, total data loss on Choose Products for the
  // whole of B's session. Measured on the first version of this fix:
  // `meals.update` called 0 times for B, expected 1. The remount would mask that
  // today, which is exactly why the guard must not depend on it.
  //
  // So the question a queued save asks is not "have saves been abandoned?" but
  // "is the session that queued me still the one running?". Each choice captures
  // the counter as it is made; each save compares before it is sent and again
  // before it logs a failure. Ending a session bumps it, which invalidates
  // exactly the work that session queued and nothing else — so the next account
  // starts able to save on the very same mounted instance, and a hand-over back
  // again is no different. Same shape as the run generation in WebViewCartSheet,
  // for the same reason.
  const saveEpochRef = useRef(0);
  useSessionEnd(() => { saveEpochRef.current += 1; });
  useEffect(() => () => { saveEpochRef.current += 1; }, []);
  const stores = useStores();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStore, setSelectedStore] = useState<string>(stores[0].id);
  const [selectedMeal, setSelectedMeal] = useState<Meal | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [krogerConnected, setKrogerConnected] = useState(false);
  const [krogerLocations, setKrogerLocations] = useState<Record<string, { locationId: string; locationName: string | null }>>({});

  // Background add-to-cart job owner (root-level WebView engine).
  const cartJob = useCartJob();
  // Silent login pre-warm: check the store login ahead of add-to-cart so the
  // flow already knows whether to surface the login prompt.
  const loginPrewarm = useLoginPrewarm();

  // Multi-select / Kroger cart
  const [selectedMealIds, setSelectedMealIds] = useState<Set<string>>(new Set());
  const [reviewVisible, setReviewVisible] = useState(false);
  const [webViewCartVisible, setWebViewCartVisible] = useState(false);
  // Store the cart was opened for. Frozen at open so the auto-select-store
  // effect (loadMeals picks the store with the most meals) can't switch the
  // store out from under an in-flight cart — that desynced the sheet (logs
  // showed e.g. storeId=acme while running an H-E-B cart).
  const [cartStoreId, setCartStoreId] = useState<string>('');

  // Choose products flow
  const [choosingMeal, setChoosingMeal] = useState<Meal | null>(null);
  const chooseQueueRef = useRef<string[]>([]);
  const pendingChooseMealRef = useRef<Meal | null>(null);

  // First-run explainer for Choose Products (MEAL-84). Holds the run the user
  // asked for until they have been told what it is; both stores' flows start
  // from the same floating button, so both go through here.
  const [introVisible, setIntroVisible] = useState(false);
  const pendingRunRef = useRef<(() => void) | null>(null);
  // Was the WebView run that is currently open a Choose Products run? Decides
  // whether closing it clears the selection — see `endWebViewRun`.
  const webViewChooseRunRef = useRef(false);

  // Kroger store picker
  const [krogerPickerVisible, setKrogerPickerVisible] = useState(false);
  const [krogerZip, setKrogerZip] = useState('');
  const [krogerLocationsList, setKrogerLocationsList] = useState<Array<{ locationId: string; name: string; storeId: string; address: string }>>([]);
  const [krogerSearching, setKrogerSearching] = useState(false);
  const [krogerSaving, setKrogerSaving] = useState(false);

  // Create meal form
  const [formVisible, setFormVisible] = useState(false);
  const [mealName, setMealName] = useState('');
  const [formStore, setFormStore] = useState('');
  const [ingredients, setIngredients] = useState<Ingredient[]>([{ ingredientName: '', searchTerm: null, qty: 1, productQty: 1, unit: 'qty', measure: null }]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [mealAuthor, setMealAuthor] = useState('');
  const [mealStory, setMealStory] = useState('');
  const [mealRecipe, setMealRecipe] = useState('');
  const [mealSource, setMealSource] = useState('');
  const [tagSearch, setTagSearch] = useState('');
  const [storePickerVisible, setStorePickerVisible] = useState(false);
  const [storeSearch, setStoreSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [photoPreview, setPhotoPreview] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [pendingPhotoBase64, setPendingPhotoBase64] = useState<string | null>(null);
  const [photoIsUrl, setPhotoIsUrl] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadMeals();
      krogerApi.status().then(d => {
        setKrogerConnected(d.connected);
        if (d.connected) {
          setKrogerLocations(d.locations ?? {});
        } else {
          setKrogerLocations({});
        }
      }).catch(() => {});
    }, [])
  );

  // Refresh Kroger status when returning from OAuth in browser
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url === 'mealio://kroger/connected') {
        krogerApi.status().then(d => {
          setKrogerConnected(d.connected);
          if (d.connected) {
            setKrogerLocations(d.locations ?? {});
            if (!d.locations?.[selectedStore]) {
              setKrogerZip('');
              setKrogerLocationsList([]);
              setKrogerPickerVisible(true);
            }
          }
        }).catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  async function handleKrogerConnect() {
    try {
      const { redirectUrl } = await krogerApi.connect(selectedStore);
      // In-app OAuth round-trip; the server bounces the final hop back to
      // mealio://kroger/connected, which the auth session returns here.
      const result = await WebBrowser.openAuthSessionAsync(redirectUrl, 'mealio://kroger/connected');
      if (result.type === 'success' && result.url.includes('/connected')) {
        const d = await krogerApi.status();
        setKrogerConnected(d.connected);
        if (d.connected) {
          setKrogerLocations(d.locations ?? {});
          if (!d.locations?.[selectedStore]) {
            setKrogerZip('');
            setKrogerLocationsList([]);
            setKrogerPickerVisible(true);
          }
        }
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not connect to Kroger');
    }
  }

  async function handleCartButtonPress() {
    if (isOverFreeLimit()) { showOverLimitNotice(); return; }
    let connected = krogerConnected;
    let locations = krogerLocations;

    // If state says not connected, do a live check first — the async status
    // fetch from useFocusEffect or the OAuth deep link handler may not have
    // resolved yet (e.g. user taps quickly after returning from browser).
    if (!connected) {
      try {
        const d = await krogerApi.status();
        connected = d.connected;
        locations = d.locations ?? {};
        if (connected) {
          setKrogerConnected(true);
          setKrogerLocations(locations);
        }
      } catch {}
    }

    if (!connected) {
      const storeName = selectedStore_?.name ?? 'This store';
      Alert.alert(
        `Connect ${storeName}`,
        `${storeName} is part of the Kroger family of stores. To add meals to your cart, you'll need to connect your Kroger account.\n\nYou'll be taken to Kroger's sign-in page in your browser and returned to Mealio once connected.`,
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Connect Account', onPress: handleKrogerConnect },
        ]
      );
      return;
    }
    const currentLocationId = locations[selectedStore]?.locationId ?? null;
    if (!currentLocationId) {
      setKrogerZip('');
      setKrogerLocationsList([]);
      setKrogerPickerVisible(true);
      return;
    }
    setReviewVisible(true);
  }

  function advanceChooseQueue(currentMeals?: Meal[]) {
    const meals = currentMeals ?? allMeals;
    while (chooseQueueRef.current.length > 0) {
      const nextId = chooseQueueRef.current.shift()!;
      const nextMeal = meals.find((m) => m.id === nextId);
      if (nextMeal && hasUnchosenProducts(nextMeal)) {
        setChoosingMeal(nextMeal);
        return;
      }
    }
    setChoosingMeal(null);
  }

  async function handleChooseProducts(meal: Meal) {
    if (isOverFreeLimit()) { showOverLimitNotice(); return; }
    let connected = krogerConnected;
    let locations = krogerLocations;
    if (!connected) {
      try {
        const d = await krogerApi.status();
        connected = d.connected;
        locations = d.locations ?? {};
        if (connected) {
          setKrogerConnected(true);
          setKrogerLocations(locations);
        }
      } catch {}
    }
    if (!connected) {
      const storeName = selectedStore_?.name ?? 'This store';
      Alert.alert(
        `Connect ${storeName}`,
        `${storeName} is part of the Kroger family of stores. Connect your Kroger account to choose products.\n\nYou'll be taken to Kroger's sign-in page in your browser and returned to Mealio once connected.`,
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Connect Account', onPress: handleKrogerConnect },
        ]
      );
      return;
    }
    const currentLocationId = locations[selectedStore]?.locationId ?? null;
    if (!currentLocationId) {
      pendingChooseMealRef.current = meal;
      setKrogerZip('');
      setKrogerLocationsList([]);
      setKrogerPickerVisible(true);
      return;
    }
    // Past both prerequisites — the chooser is opening, so the explainer that
    // preceded it has now been spent on a real run.
    noteChooseRunStarted();
    setChoosingMeal(meal);
  }

  function handleFloatingChooseProducts() {
    const mealsNeedingChoose = selectedMeals.filter(hasUnchosenProducts);
    if (mealsNeedingChoose.length === 0) return;
    chooseQueueRef.current = mealsNeedingChoose.slice(1).map((m) => m.id);
    handleChooseProducts(mealsNeedingChoose[0]);
  }

  // Run a choose-products flow, explaining it first the one time (MEAL-84).
  // The explainer never blocks: its primary button runs `start` unchanged, and
  // it is a detour exactly once per device and a straight-through call forever
  // after.
  async function withChooseIntro(start: () => void) {
    if (await hasSeen(FIRST_RUN_CHOOSE_PRODUCTS)) { start(); return; }
    pendingRunRef.current = start;
    setIntroVisible(true);
  }

  /**
   * Spend the one showing of the explainer, at the moment a choose run actually
   * begins.
   *
   * Deliberately not called from `handleIntroStart`. Kroger's flow can still
   * bounce after the explainer and before anything opens — a first-time Kroger
   * user is by definition not connected yet, so "Choose products" hits the
   * "Connect Kroger" alert and returns having opened nothing (same shape for the
   * no-location path). Marking seen at the button spent the explainer on a run
   * that never happened, and the person who came back connected, ready for the
   * twelve screens this sheet exists to warn them about, got no warning.
   */
  function noteChooseRunStarted() {
    markSeen(FIRST_RUN_CHOOSE_PRODUCTS);
  }

  /**
   * A WebView run has closed. Clear the selection — unless it was a Choose
   * Products run, which keeps it.
   *
   * Choosing is setup, not shopping: it saves matches and puts nothing in a
   * cart, so the meals the user picked are still the meals they want. The
   * explainer promises exactly this ("at the end … you are back at your meals,
   * with the button now offering to add them all to your cart") and it was only
   * true on Kroger, where the chooser never touches the selection. On the
   * WebView path — every store except the Kroger family, i.e. most of the people
   * who see the sheet — the selection was dropped, the floating button renders
   * only when something is selected, and twelve screens of work ended on a
   * screen with no button on it at all. Someone reasonably reads that as failure.
   *
   * An add-to-cart run still clears, unchanged: those meals are in the cart now
   * and leaving them selected invites adding them twice.
   */
  function endWebViewRun() {
    const wasChooseRun = webViewChooseRunRef.current;
    webViewChooseRunRef.current = false;
    if (!wasChooseRun) setSelectedMealIds(new Set());
  }

  function handleIntroStart() {
    setIntroVisible(false);
    const start = pendingRunRef.current;
    pendingRunRef.current = null;
    start?.();
  }

  // Dismissing is an answer, not a deferral — it is marked seen here, because
  // there is no later run to mark it at.
  function handleIntroCancel() {
    setIntroVisible(false);
    markSeen(FIRST_RUN_CHOOSE_PRODUCTS);
    pendingRunRef.current = null;
  }

  // Free accounts keep their saved meals but lose cart automation / choose
  // products while over the limit — this nudges them to trim to FREE_LIMIT or
  // upgrade, without touching their data.
  function isOverFreeLimit() {
    return user?.tier !== 'paid' && allMeals.length > FREE_LIMIT;
  }

  function showOverLimitNotice() {
    Alert.alert(
      'Free plan limit reached',
      `Free accounts can use cart automation with up to ${FREE_LIMIT} saved meals. You have ${allMeals.length}. Remove meals until you have ${FREE_LIMIT} or fewer, or upgrade to Full Access to use it with all of them.`,
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Upgrade', onPress: handleUpgrade },
      ]
    );
  }

  async function handleKrogerSearchStores() {
    if (!krogerZip.trim()) return;
    setKrogerSearching(true);
    setKrogerLocationsList([]);
    try {
      const { locations } = await krogerApi.searchLocations(krogerZip.trim());
      setKrogerLocationsList(locations);
      if (locations.length === 0) Alert.alert('No stores found', 'No Kroger-family stores found near that ZIP code.');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not search stores');
    } finally {
      setKrogerSearching(false);
    }
  }

  async function handleKrogerSaveLocation(loc: { locationId: string; name: string; storeId: string; address: string }) {
    setKrogerSaving(true);
    try {
      await krogerApi.setLocation(loc.locationId, loc.name, loc.storeId);
      setKrogerLocations(prev => ({ ...prev, [loc.storeId]: { locationId: loc.locationId, locationName: loc.name } }));
      setKrogerPickerVisible(false);
      if (pendingChooseMealRef.current) {
        // The run the explainer was shown for is resuming here, having been
        // parked on "pick a store" — this is where it really starts.
        noteChooseRunStarted();
        setChoosingMeal(pendingChooseMealRef.current);
        pendingChooseMealRef.current = null;
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not save store');
    } finally {
      setKrogerSaving(false);
    }
  }

  async function handleIngredientChosen(ingredientName: string, mealIds: string[], productName: string, mealQtys?: Record<string, number>, dropdown?: { type: string; selectedText: string; selectedValue: string } | null, purchaseWeight?: number | null, weightStep?: number | null, storeProduct?: { upc: string; name: string; sku?: string } | null) {
    // Whose choice this is. Captured HERE, when the product is picked, rather
    // than read inside the queued work: the point of the guard is to compare the
    // session that queued a save against the one running when it comes up.
    const epoch = saveEpochRef.current;
    await Promise.all(
      mealIds.map((mealId) =>
        // Serialize all saves for this meal: each PATCH runs after (and reads the
        // result of) the previous one. Choices arrive faster than the server
        // round-trip, so without this they'd each rebuild the whole ingredient
        // array from a stale snapshot and overwrite earlier saves
        // (last-write-wins). Keyed per meal, so different meals save in parallel.
        enqueueMealSave(mealId, async () => {
          // Read the freshest copy (updated by any prior chained save below),
          // never the render snapshot.
          // Whoever chose this product is gone, so this PATCH is doomed. Bail
          // before it is sent, not just before it is logged: guarding only the
          // catch would still fire a 401 and a renew attempt per queued save.
          // Whoever is here NOW is unaffected — their own choices carry the
          // current epoch and go out normally.
          if (saveEpochRef.current !== epoch) return;
          const meal = allMealsRef.current.find((m) => m.id === mealId);
          if (!meal) return;
          const updatedIngredients = mergeChosenProduct(
            meal.ingredients as any[],
            ingredientName,
            productName,
            // storeProduct is the store's own id for what was picked. Saved
            // beside the name so the NEXT run writes it straight to the cart
            // instead of searching the name again — Choose Product once, add
            // forever, made literal. Keyed to the meal's own store.
            { qty: mealQtys?.[mealId], dropdown, purchaseWeight, weightStep,
              storeProduct, storeId: meal.storeId },
          );
          try {
            const updated = await mealsApi.update(mealId, { ingredients: updatedIngredients } as any);
            // Update the ref synchronously so the next chained save for this meal
            // builds on this result, not the pre-save state.
            allMealsRef.current = allMealsRef.current.map((m) => (m.id === updated.id ? updated : m));
            setAllMeals((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
          } catch (err) {
            // A save already in flight when the session ended cannot be
            // recalled, but its failure must not name their products in a buffer
            // that now belongs to whoever came next. Within the session that
            // chose the product, this line is exactly what a "my chosen product
            // did not stick" report needs.
            if (saveEpochRef.current !== epoch) return;
            console.warn(`[MyMeals] failed to save chosen product "${productName}" for ingredient "${ingredientName}" (meal ${mealId})`, err);
          }
        }),
      ),
    );
  }

  async function loadMeals() {
    try {
      const data = await mealsApi.list();
      const seen = new Set<string>();
      const active = data
        .filter((m) => !m.deletedAt && !seen.has(m.id) && seen.add(m.id))
        .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
      setAllMeals(active);
      // Store with the most saved meals — used both to auto-select a landing
      // store and to silently pre-warm its login (idea: check the store the user
      // is most likely to add to before they ever tap add-to-cart).
      const counts: Record<string, number> = {};
      for (const m of active) if (m.storeId) counts[m.storeId] = (counts[m.storeId] ?? 0) + 1;
      const topStore = getStores().reduce<{ id: string; count: number } | null>((best, s) => {
        const c = counts[s.id] ?? 0;
        return c > 0 && (!best || c > best.count) ? { id: s.id, count: c } : best;
      }, null);
      console.log('[Prewarm] MyMeals loaded — top store by meal count:', topStore?.id ?? '(none)');
      if (topStore) loginPrewarm.checkStore(topStore.id);
      // Auto-select the store with the most meals (if current selection has none)
      setSelectedStore((prev) => {
        const hasMealsAtCurrent = active.some((m) => m.storeId === prev);
        if (hasMealsAtCurrent) return prev;
        return topStore ? topStore.id : prev;
      });
    } catch (err: any) {
      if (err.status !== 401) {
        Alert.alert('Error', err.message || 'Could not load meals');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  function handleRefresh() {
    setRefreshing(true);
    loadMeals();
  }

  async function handleUpgrade() {
    setUpgradeLoading(true);
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
        // Purchase went through but the entitlement hasn't propagated yet.
        Alert.alert('Purchase received', 'Activating your subscription… this can take a moment.');
        await refreshUser();
      }
    } catch (err: any) {
      if (!err.userCancelled) {
        Alert.alert('Purchase Failed', err.message || 'Something went wrong. Please try again.');
      }
    } finally {
      setUpgradeLoading(false);
    }
  }

  function openCreate() {
    setMealName('');
    setFormStore('');
    setIngredients([{ ingredientName: '', searchTerm: null, qty: 1, productQty: 1, unit: 'qty', measure: null }]);
    setSelectedTags([]);
    setDifficulty(null);
    setMealAuthor('');
    setMealStory('');
    setMealRecipe('');
    setMealSource('');
    setTagSearch('');
    setStoreSearch('');
    setPhotoPreview('');
    setPhotoUrl('');
    setPendingPhotoBase64(null);
    setPhotoIsUrl(false);
    setFormVisible(true);
  }

  async function handleCreate() {
    if (!mealName.trim()) {
      Alert.alert('Error', 'Meal name is required.');
      return;
    }
    if (!formStore) {
      Alert.alert('Error', 'Please select a store.');
      return;
    }
    const validIngredients = ingredients.filter((i) => i.ingredientName.trim());
    if (validIngredients.length === 0) {
      Alert.alert('Error', 'Add at least one ingredient.');
      return;
    }
    setSaving(true);
    try {
      let finalPhotoUrl: string | null = null;
      if (photoIsUrl && photoUrl) {
        finalPhotoUrl = photoUrl;
      } else if (pendingPhotoBase64) {
        const { images: imagesApi } = await import('../../lib/api');
        const { url } = await imagesApi.upload(pendingPhotoBase64);
        finalPhotoUrl = url;
      }
      await mealsApi.create({
        name: mealName.trim(),
        storeId: formStore,
        ingredients: validIngredients,
        photoUrl: finalPhotoUrl,
        ...(selectedTags.length ? { tags: selectedTags } : {}),
        ...(difficulty != null ? { difficulty } : {}),
        ...(mealAuthor.trim() ? { author: mealAuthor.trim() } : {}),
        ...(mealStory.trim() ? { story: mealStory.trim() } : {}),
        ...(mealRecipe.trim() ? { recipe: mealRecipe.trim() } : {}),
        ...(mealSource.trim() ? { website: mealSource.trim() } : {}),
      } as any);
      setFormVisible(false);
      setSelectedStore(formStore);
      await loadMeals();
    } catch (err: any) {
      if (err.status === 403) {
        Alert.alert('Limit Reached', "You've reached the free tier meal limit. Upgrade to save more meals.");
      } else {
        Alert.alert('Error', err.message || 'Could not create meal');
      }
    } finally {
      setSaving(false);
    }
  }

  const storeMeals = allMeals.filter((m) => m.storeId === selectedStore);
  const storesWithMeals = stores
    .filter((s) => allMeals.some((m) => m.storeId === s.id))
    .sort((a, b) => allMeals.filter((m) => m.storeId === b.id).length - allMeals.filter((m) => m.storeId === a.id).length);
  const displayStores = loading ? [] : storesWithMeals;
  const isKroger = isKrogerBrand(selectedStore);
  const isWebView = isWebViewStore(selectedStore);
  const isCartEnabled = isKroger || isWebView;
  const selectedMeals = storeMeals.filter((m) => selectedMealIds.has(m.id));
  const selectedStore_ = stores.find((s) => s.id === selectedStore);

  function openMeal(meal: Meal) {
    setSelectedMeal(meal);
    setDetailVisible(true);
  }

  function toggleMealSelect(id: string) {
    setSelectedMealIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // NOTE: manual index%2 pairing defeats FlatList virtualization (every item is
  // rendered). Left as-is for now — unlike DiscoverScreen this list carries
  // multi-select + per-card warning state, so a numColumns={2} conversion is a
  // higher-risk change; convert when that state is refactored.
  const renderMeal = useCallback(({ item, index }: { item: Meal; index: number }) => {
    if (index % 2 !== 0) return null;
    const next = storeMeals[index + 1] ?? null;
    return (
      <View style={styles.mealRow}>
        <MealCard
          meal={item}
          testID={`meal-card-${item.name}`}
          onPress={isCartEnabled ? () => toggleMealSelect(item.id) : () => openMeal(item)}
          subtitle={item.author ?? undefined}
          selected={isCartEnabled ? selectedMealIds.has(item.id) : undefined}
          onView={isCartEnabled ? () => openMeal(item) : undefined}
          warning={(isKroger || isWebView) && hasUnchosenProducts(item) ? 'Choose products once to add this to your cart' : undefined}
        />
        {next ? (
          <MealCard
            meal={next}
            testID={`meal-card-${next.name}`}
            onPress={isCartEnabled ? () => toggleMealSelect(next.id) : () => openMeal(next)}
            subtitle={next.author ?? undefined}
            selected={isCartEnabled ? selectedMealIds.has(next.id) : undefined}
            onView={isCartEnabled ? () => openMeal(next) : undefined}
            warning={(isKroger || isWebView) && hasUnchosenProducts(next) ? 'Choose products once to add this to your cart' : undefined}
          />
        ) : (
          <View style={{ flex: 1, marginHorizontal: 4 }} />
        )}
      </View>
    );
  }, [storeMeals, isCartEnabled, isKroger, selectedMealIds]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>My Meals</Text>
        <TouchableOpacity style={styles.addBtn} onPress={openCreate} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="add" size={24} color={Colors.brand} />
        </TouchableOpacity>
      </View>

      {/* Store tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.storeTabsScroll}
        contentContainerStyle={styles.storeTabs}
      >
        {displayStores.map((store) => (
          <TouchableOpacity
            key={store.id}
            style={[styles.storeTab, selectedStore === store.id && styles.storeTabActive]}
            onPress={() => { console.log('[Prewarm] store tab tapped:', store.id); setSelectedStore(store.id); setSelectedMealIds(new Set()); loginPrewarm.checkStore(store.id); }}
          >
            <View style={[styles.storeDot, { backgroundColor: store.color }]} />
            <Text style={[styles.storeTabText, selectedStore === store.id && styles.storeTabTextActive]}>
              {store.name}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {!loading && !isCartEnabled && allMeals.length > 0 && (
        <View style={styles.krogerNotice}>
          <Text style={styles.krogerNoticeText}>
            <Text style={styles.krogerNoticeBold}>{selectedStore_?.name ?? 'This store'}</Text>
            {' '}does not currently support one-click add to cart. Try the Mealio desktop browser extension for one-click add to cart. Stay tuned for updates!
          </Text>
        </View>
      )}

      {user?.tier !== 'paid' && allMeals.length >= FREE_LIMIT && (
        <View style={styles.tierBanner}>
          <View style={styles.tierBarRow}>
            <View style={styles.tierBarOuter}>
              <View style={[styles.tierBarFill, { width: `${Math.min(allMeals.length / FREE_LIMIT, 1) * 100}%` as any }]} />
            </View>
            <Text style={styles.tierCountText}>{allMeals.length}/{FREE_LIMIT}</Text>
          </View>
          <View style={styles.tierTextRow}>
            <Text style={styles.tierLabel}>
              {allMeals.length >= FREE_LIMIT
                ? 'Meal limit reached'
                : `${allMeals.length} of ${FREE_LIMIT} free meals saved`}
            </Text>
            <TouchableOpacity onPress={handleUpgrade} disabled={upgradeLoading}>
              <Text style={styles.upgradeLink}>{upgradeLoading ? 'Loading…' : 'Upgrade for unlimited →'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <FlatList
        data={storeMeals}
        keyExtractor={(item) => item.id}
        renderItem={renderMeal}
        extraData={selectedMealIds}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.brand} />}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <View style={{ marginBottom: 12 }}>
                <Ionicons name="restaurant-outline" size={56} color="#9ca3af" />
              </View>
              <Text style={styles.emptyTitle}>No meals yet</Text>
              {/* The empty state used to describe filing, not shopping — it
                  never mentioned the cart, which is the only reason to save a
                  meal here at all (MEAL-84). */}
              <Text style={styles.emptyBody}>
                Save meals from Discover or tap + to create your own. Pick the store you shop at,
                and Mealio can put every ingredient into your cart there.
              </Text>
            </View>
          ) : null
        }
      />

      {isCartEnabled && selectedMealIds.size > 0 && (() => {
        if (isOverFreeLimit()) {
          return (
            <TouchableOpacity
              testID="floating-over-limit"
              style={[styles.floatingCart, styles.floatingCartDisabled]}
              onPress={showOverLimitNotice}
              activeOpacity={0.9}
            >
              <Ionicons name="lock-closed" size={18} color="#fff" />
              <Text style={styles.floatingCartText}>Reduce to {FREE_LIMIT} meals to add to cart</Text>
            </TouchableOpacity>
          );
        }
        if (isKroger) {
          const needsChoose = selectedMeals.some(hasUnchosenProducts);
          const unchosenCount = selectedMeals.filter(hasUnchosenProducts).length;
          return (
            <TouchableOpacity
              style={[styles.floatingCart, { backgroundColor: selectedStore_?.color ?? Colors.brand }]}
              onPress={needsChoose ? () => withChooseIntro(handleFloatingChooseProducts) : handleCartButtonPress}
              activeOpacity={0.88}
            >
              <Ionicons name={needsChoose ? 'search' : 'cart'} size={18} color="#fff" />
              <Text style={styles.floatingCartText}>
                {needsChoose
                  ? `Choose Products for ${unchosenCount} meal${unchosenCount !== 1 ? 's' : ''}`
                  : `Add ${selectedMealIds.size} meal${selectedMealIds.size !== 1 ? 's' : ''} to ${selectedStore_?.name ? `${selectedStore_.name} cart` : 'cart'}`}
              </Text>
            </TouchableOpacity>
          );
        }
        // WebView store (e.g. H-E-B) — WebViewCartSheet handles both choose + add.
        // `isWebViewChooseRun` is the sheet's own test, asked here so the button
        // and the screen it opens cannot disagree about which run this is.
        const webViewNeedsChoose = isWebViewChooseRun(selectedMeals);
        const webViewUnchosenCount = selectedMeals.filter(hasUnchosenProducts).length;
        return (
          <TouchableOpacity
            testID="floating-add-to-cart"
            style={[styles.floatingCart, { backgroundColor: selectedStore_?.color ?? Colors.brand }]}
            onPress={() => {
              const start = () => {
                if (FEATURE_BACKGROUND_CART) {
                  cartJob.startJob({
                    meals: selectedMeals,
                    storeId: selectedStore,
                    storeName: stores.find((s) => s.id === selectedStore)?.name ?? 'Store',
                    onIngredientChosen: handleIngredientChosen,
                    onClose: endWebViewRun,
                  });
                } else {
                  setCartStoreId(selectedStore);
                  setWebViewCartVisible(true);
                }
              };
              // Same sheet opens either way; only a run that has choosing to do
              // gets the explainer, since an add-to-cart run explains itself.
              webViewChooseRunRef.current = webViewNeedsChoose;
              if (webViewNeedsChoose) {
                withChooseIntro(() => {
                  // Nothing can bounce a WebView run between here and the sheet
                  // opening, so this is where the explainer is spent.
                  noteChooseRunStarted();
                  start();
                });
              } else {
                start();
              }
            }}
            activeOpacity={0.88}
          >
            <Ionicons name={webViewNeedsChoose ? 'search' : 'cart'} size={18} color="#fff" />
            <Text style={styles.floatingCartText}>
              {webViewNeedsChoose
                ? `Choose Products for ${webViewUnchosenCount} meal${webViewUnchosenCount !== 1 ? 's' : ''}`
                : `Add ${selectedMealIds.size} meal${selectedMealIds.size !== 1 ? 's' : ''} to ${selectedStore_?.name ? `${selectedStore_.name} cart` : 'cart'}`}
            </Text>
          </TouchableOpacity>
        );
      })()}

      <MealDetailSheet
        visible={detailVisible}
        meal={selectedMeal}
        mode="edit"
        onClose={() => setDetailVisible(false)}
        onSave={(updated) => { loadMeals(); if (updated) { setSelectedMeal(updated); if (updated.storeId) setSelectedStore(updated.storeId); } }}
        krogerLocationId={krogerLocations[selectedMeal?.storeId ?? '']?.locationId ?? null}
        onNeedKrogerStore={() => { setKrogerZip(''); setKrogerLocationsList([]); setKrogerPickerVisible(true); }}
        hideShare={isCreator}
      />

      <KrogerCartReviewSheet
        visible={reviewVisible}
        meals={selectedMeals}
        locationId={krogerLocations[selectedStore]?.locationId ?? ''}
        storeId={selectedStore}
        storeName={selectedStore_?.name ?? 'Kroger'}
        onClose={() => { setReviewVisible(false); setSelectedMealIds(new Set()); }}
        onMealUpdated={(updated) => {
          setAllMeals((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
        }}
      />

      {/* Inline cart mount — only when the background-cart engine is OFF.
          When ON, the root-level CartJobProvider owns the WebView instead. */}
      {!FEATURE_BACKGROUND_CART && (
        <WebViewCartSheet
          visible={webViewCartVisible}
          meals={selectedMeals}
          storeId={cartStoreId || selectedStore}
          storeName={stores.find((s) => s.id === (cartStoreId || selectedStore))?.name ?? 'Store'}
          onClose={() => { setWebViewCartVisible(false); endWebViewRun(); }}
          onIngredientChosen={handleIngredientChosen}
        />
      )}

      <ChooseProductsIntroSheet
        visible={introVisible}
        storeName={selectedStore_?.name ?? 'your store'}
        ingredientCount={selectedMeals.reduce((n, m) => n + unchosenIngredients(m).length, 0)}
        mealCount={selectedMeals.filter(hasUnchosenProducts).length}
        onStart={handleIntroStart}
        onCancel={handleIntroCancel}
      />

      {choosingMeal && (
        <ProductChooserSheet
          key={choosingMeal.id}
          visible={!!choosingMeal}
          meal={choosingMeal}
          locationId={krogerLocations[selectedStore]?.locationId ?? ''}
          storeName={selectedStore_?.name ?? 'Kroger'}
          storeColor={selectedStore_?.color ?? Colors.brand}
          onClose={() => advanceChooseQueue()}
          onMealUpdated={(updated) => {
            setAllMeals((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
          }}
        />
      )}

      {/* Kroger store picker */}
      <Modal visible={krogerPickerVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setKrogerPickerVisible(false)}>
        <SafeAreaView style={styles.safe}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select Your Store</Text>
            <TouchableOpacity onPress={() => setKrogerPickerVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.sectionLabel}>Find a nearby {selectedStore_?.name ?? 'Kroger'} store</Text>
            <View style={styles.krogerZipRow}>
              <TextInput
                style={styles.krogerZipInput}
                placeholder="ZIP code"
                placeholderTextColor={Colors.text3}
                value={krogerZip}
                onChangeText={setKrogerZip}
                keyboardType="numeric"
                maxLength={10}
                returnKeyType="search"
                onSubmitEditing={handleKrogerSearchStores}
              />
              <TouchableOpacity
                style={[styles.krogerSearchBtn, (!krogerZip.trim() || krogerSearching) && { opacity: 0.5 }]}
                onPress={handleKrogerSearchStores}
                disabled={!krogerZip.trim() || krogerSearching}
              >
                <Text style={styles.krogerSearchBtnText}>{krogerSearching ? '…' : 'Search'}</Text>
              </TouchableOpacity>
            </View>
            {krogerLocationsList.map((loc) => (
              <TouchableOpacity
                key={loc.locationId}
                style={[styles.krogerLocRow, krogerLocations[loc.storeId]?.locationId === loc.locationId && styles.krogerLocRowActive]}
                onPress={() => handleKrogerSaveLocation(loc)}
                disabled={krogerSaving}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.krogerLocName}>{loc.name}</Text>
                  <Text style={styles.krogerLocAddr} numberOfLines={1}>{loc.address}</Text>
                </View>
                {krogerLocations[loc.storeId]?.locationId === loc.locationId
                  ? <Ionicons name="checkmark" size={18} color={Colors.brand} />
                  : <Ionicons name="chevron-forward" size={16} color={Colors.text3} />
                }
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Create meal modal */}
      <Modal visible={formVisible} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={styles.safe}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New Meal</Text>
              <TouchableOpacity onPress={() => setFormVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {/* Store selector */}
              <Text style={styles.sectionLabel}>Store *</Text>
              <TouchableOpacity
                style={styles.dropdown}
                onPress={() => { setStoreSearch(''); setStorePickerVisible(true); }}
              >
                {formStore ? (
                  <View style={styles.dropdownSelected}>
                    <View style={[styles.storeDot, { backgroundColor: stores.find(s => s.id === formStore)?.color ?? Colors.border }]} />
                    <Text style={styles.dropdownSelectedText}>{stores.find(s => s.id === formStore)?.name}</Text>
                  </View>
                ) : (
                  <Text style={styles.dropdownPlaceholder}>Select a store…</Text>
                )}
                <Ionicons name="chevron-down" size={18} color={Colors.text3} />
              </TouchableOpacity>

              <Input
                label="Meal Name"
                placeholder="e.g. Lemon Herb Chicken"
                value={mealName}
                onChangeText={setMealName}
              />

              <Input
                label="Author (optional)"
                placeholder="e.g. Gordon Ramsay"
                value={mealAuthor}
                onChangeText={setMealAuthor}
              />

              <Input
                label="Recipe URL (optional)"
                placeholder="https://example.com/recipe"
                value={mealSource}
                onChangeText={setMealSource}
                keyboardType="url"
                autoCapitalize="none"
              />

              <Text style={styles.sectionLabel}>Photo (optional)</Text>
              <PhotoPicker
                mealName={mealName}
                previewUri={photoPreview}
                onPhotoReady={(uri, isUrl, base64) => {
                  setPhotoPreview(uri);
                  setPhotoIsUrl(isUrl);
                  if (isUrl) { setPhotoUrl(uri); setPendingPhotoBase64(null); }
                  else { setPendingPhotoBase64(base64 ?? null); setPhotoUrl(''); }
                }}
                onClear={() => { setPhotoPreview(''); setPhotoUrl(''); setPendingPhotoBase64(null); setPhotoIsUrl(false); }}
              />

              {/* Difficulty */}
              <Text style={styles.sectionLabel}>Difficulty</Text>
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

              <Text style={styles.sectionLabel}>Story (optional)</Text>
              <TextInput
                style={styles.textArea}
                value={mealStory}
                onChangeText={setMealStory}
                placeholder={"The story behind the meal or a simple one liner. e.g.\nPerfect for a summer BBQ\nGreat budget-friendly weeknight dinner\nHigh protein, low carb – great for meal prep"}
                placeholderTextColor={Colors.text3}
                multiline
              />

              <IngredientEditor ingredients={ingredients} onChange={setIngredients} />

              <Text style={styles.sectionLabel}>Recipe Instructions (optional)</Text>
              <TextInput
                style={[styles.textArea, { minHeight: 120 }]}
                value={mealRecipe}
                onChangeText={setMealRecipe}
                placeholder={'1. Boil 4 cups of water…\n2. Add pasta…'}
                placeholderTextColor={Colors.text3}
                multiline
              />

              {/* Tags. The shared picker rather than a fourth hand-rolled copy:
                  this one had no cap at all, so nine tags could be selected and
                  `POST /api/meals` — which counts them now — would turn Create
                  Meal into an error about a rule the form never mentioned. */}
              <Text style={styles.sectionLabel}>Tags</Text>
              <TagPicker
                selected={selectedTags}
                onChange={setSelectedTags}
                search={tagSearch}
                onSearchChange={setTagSearch}
              />
            </ScrollView>

            <View style={styles.modalFooter}>
              <Button
                label="Cancel"
                variant="secondary"
                onPress={() => setFormVisible(false)}
                style={{ flex: 1, marginRight: 8 }}
              />
              <Button label="Create Meal" onPress={handleCreate} loading={saving} style={{ flex: 2 }} />
            </View>

            {/* Store picker overlay — rendered inside the modal to avoid nested Modal issues */}
            {storePickerVisible && (
              <View style={styles.pickerOverlay}>
                <TouchableOpacity style={styles.pickerBackdrop} onPress={() => setStorePickerVisible(false)} />
                <View style={styles.pickerSheet}>
                  <View style={styles.pickerHeader}>
                    <Text style={styles.pickerTitle}>Select Store</Text>
                    <TouchableOpacity onPress={() => setStorePickerVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Ionicons name="close" size={22} color={Colors.text2} />
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    style={styles.pickerSearch}
                    placeholder="Search stores…"
                    placeholderTextColor={Colors.text3}
                    value={storeSearch}
                    onChangeText={setStoreSearch}
                  />
                  <FlatList
                    data={stores.filter((s) =>
                      !storeSearch.trim() || s.name.toLowerCase().includes(storeSearch.toLowerCase())
                    )}
                    keyExtractor={(s) => s.id}
                    renderItem={({ item }) => (
                      <TouchableOpacity
                        style={[styles.pickerRow, formStore === item.id && styles.pickerRowActive]}
                        onPress={() => { setFormStore(item.id); setStorePickerVisible(false); }}
                      >
                        <View style={[styles.storeDot, { backgroundColor: item.color }]} />
                        <Text style={[styles.pickerRowText, formStore === item.id && styles.pickerRowTextActive]}>
                          {item.name}
                        </Text>
                        {formStore === item.id && <Ionicons name="checkmark" size={18} color={Colors.brand} />}
                      </TouchableOpacity>
                    )}
                    keyboardShouldPersistTaps="handled"
                  />
                </View>
              </View>
            )}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  title: { fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.text1 },
  addBtn: { padding: 4 },
  storeTabsScroll: { flexGrow: 0, flexShrink: 0 },
  storeTabs: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  storeTab: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
    gap: 6,
  },
  storeTabActive: {
    borderColor: Colors.brand,
    backgroundColor: Colors.brandLight,
  },
  storeDot: { width: 8, height: 8, borderRadius: 4 },
  storeTabText: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text2 },
  storeTabTextActive: { color: Colors.brand },
  krogerNotice: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    backgroundColor: '#fff8e1',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#ffe082',
  },
  krogerNoticeText: {
    fontSize: 13,
    color: '#7a5c00',
    lineHeight: 19,
  },
  krogerNoticeBold: {
    fontWeight: '600',
  },
  tierBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: Colors.brandLight,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#fccdd4',
  },
  tierBarRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  tierBarOuter: {
    flex: 1,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#fccdd4',
    overflow: 'hidden',
  },
  tierBarFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: Colors.brand,
  },
  tierCountText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.brand },
  tierTextRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tierLabel: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text2 },
  upgradeLink: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.brand },
  floatingCartDisabled: {
    backgroundColor: Colors.text3,
  },
  floatingCart: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    backgroundColor: Colors.brand,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  floatingCartText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: '#fff',
  },
  list: { paddingHorizontal: 12, paddingBottom: 20 },
  mealRow: { flexDirection: 'row', justifyContent: 'space-between' },
  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 40 },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 8 },
  emptyBody: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    textAlign: 'center',
    lineHeight: 22,
  },
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
  modalFooter: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  sectionLabel: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text2,
    marginBottom: 10,
    marginTop: 4,
  },
  dropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
  },
  dropdownSelected: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dropdownSelectedText: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text1 },
  dropdownPlaceholder: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  pickerOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'flex-end',
    zIndex: 100,
  },
  pickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  pickerSheet: {
    backgroundColor: Colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
    paddingBottom: 32,
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  pickerTitle: { fontSize: 17, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  pickerSearch: {
    margin: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    letterSpacing: 0,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  pickerRowActive: { backgroundColor: Colors.brandLight },
  pickerRowText: { flex: 1, fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.text1 },
  pickerRowTextActive: { fontFamily: 'Inter_600SemiBold', color: Colors.brand },
  krogerZipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  krogerZipInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
  },
  krogerSearchBtn: {
    backgroundColor: Colors.brand,
    borderRadius: Radius.input,
    paddingHorizontal: 16,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  krogerSearchBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: '#fff' },
  krogerLocRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
    backgroundColor: Colors.surfaceRaised,
    gap: 10,
  },
  krogerLocRowActive: { borderColor: Colors.brand, backgroundColor: Colors.brandLight },
  krogerLocName: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1, marginBottom: 2 },
  krogerLocAddr: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  diffRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
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
});
