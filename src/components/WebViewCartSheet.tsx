import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import WebView, { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import FloatingPreviewImage from './FloatingPreviewImage';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/colors';
import { Meal } from '../types';
import { STORES } from '../constants/stores';
import { getStoreScripts, StoreScripts } from '../lib/webview-scripts';
import { getStoreWebViewUA } from '../lib/webview-user-agent';
import { buildBeforeContentScript } from '../lib/webview-appbanner-suppressor';
import { usage } from '../lib/api';
import {
  ConsolidatedIngredient,
  consolidateIngredients,
} from '../lib/consolidateIngredients';
import { ingredientWeight, weightLabelLb } from '../lib/weightDisplay';
import { useParallelSearchPool } from '../lib/useParallelSearchPool';
import { useDraggablePreview } from '../lib/useDraggablePreview';
import { buildSearchAndAddWorker } from '../lib/webview-scripts/worker-search';
import { FEATURE_PARALLEL_ADD, PARALLEL_ADD_WORKERS } from '../constants/features';
import { buildCartCountScript, getCartPageUrl, buildCartPageCountScript, buildOpenCartScript, buildInlineCartScript, diffCartItems, findUnaddedItems, findShortAddedItems, cartNameMatches, CartItem, CartRow } from '../lib/webview-scripts/cart-count';
import { scoreMatch } from '../lib/webview-scripts/_scoring';

// ── Types ────────────────────────────────────────────────────────────────────

interface MealIngredientQty {
  mealId: string;
  mealName: string;
  qty: number;
}

interface Candidate {
  productName: string;
  imageUrl: string | null;
  outOfStock: boolean;
  preferences: Array<{ text: string; value: string }> | null;
  price: string | null;
  isWeightItem?: boolean;
  /** For sold-by-weight items: the buyable weights (lb) from the addByWeight
   *  dropdown, in order. Increments differ per product, so this drives the
   *  weight chooser + add (qty = the Nth option). */
  weightOptions?: number[];
}

interface SearchResult {
  term: string;
  candidates: Candidate[];
  mealIngredients: MealIngredientQty[];
  unit: string;
  measure: string | null;
  reason: 'out_of_stock' | 'no_results' | 'low_confidence' | 'needs_weight';
  isChoose: boolean; // true = choose-product flow (no searchTerm yet); false = review unmatched (searchTerm set but no match)
}

// Result a parallel-add worker reports for one ingredient.
interface AddResult {
  success: boolean;
  productName: string | null;
  reason: string | null;
  candidates: Candidate[];
}

interface PickedItem {
  searchTerm: string;
  productName: string;
  preference: { text: string } | null;
  qty: number;
  /** Sold-by-weight: the chosen weight (lb) to select at add time. */
  purchaseWeight?: number | null;
  /** The review-queue index this pick was made for (manual-review picks only).
   *  Lets the "Back" button remove the pick that belongs to the item being left
   *  rather than blindly popping the last one — "Skip" advances WITHOUT pushing,
   *  so the last pick can belong to a much earlier item. */
  reviewIndex?: number;
}

export type Step = 'qty' | 'login_check' | 'login' | 'searching' | 'searchResult' | 'review' | 'adding' | 'done' | 'robot_challenge';

// Coarse state the floating bubble renders from. `kind` drives the icon and the
// provider's collapse/expand decisions; `phase` is the raw step; `label` is a
// short human string.
export type CartJobKind = 'setup' | 'running' | 'attention' | 'warning' | 'done';
export interface CartJobStatus {
  phase: Step;
  kind: CartJobKind;
  label: string;
  /** 0..1 determinate progress for the bubble ring, or null = indeterminate. */
  progress: number | null;
}

export interface WebViewCartSheetProps {
  visible: boolean;
  meals: Array<Pick<Meal, 'id' | 'name' | 'ingredients'>>;
  storeId: string;
  storeName: string;
  onClose: () => void;
  onIngredientChosen?: (ingredientName: string, mealIds: string[], productName: string, mealQtys?: Record<string, number>, dropdown?: { type: string; selectedText: string; selectedValue: string } | null, purchaseWeight?: number | null, weightStep?: number | null) => void;
  /** 'modal' (default) renders the original native pageSheet — unchanged
   *  behavior. 'layer' renders a provider-controlled root overlay that can be
   *  slid offscreen (collapsed) while keeping the WebView mounted, so the cart
   *  job can run in the background behind the floating status bubble. */
  presentation?: 'modal' | 'layer';
  /** Layer mode only: when true the sheet is slid offscreen (background). */
  collapsed?: boolean;
  /** Fires whenever the job's coarse status changes, so the provider can drive
   *  the floating bubble and collapse/expand. */
  onStatusChange?: (status: CartJobStatus) => void;
  /** Layer mode only: user tapped the minimize control (collapse to bubble). */
  onMinimize?: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(): string {
  const d = new Date();
  return `${d.toLocaleTimeString('en-US', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// Product-name match scoring reuses the diacritic-aware scorer in _scoring.ts
// (the same contract the injected store scripts copy), so accented items like
// "Jalapeño" auto-pick against a "Jalapeno" candidate instead of always falling
// to manual review. The previous local scorer stripped diacritics to spaces.

// HEB Deli / Fish Market items are sold by weight: 1 qty = 0.25 lb.
// HTTP statuses anti-bot systems (Akamai, DataDome, PerimeterX) use to block.
const ANTI_BOT_STATUSES = [403, 429, 503];

// onHttpError fires for subresources too (images, XHR, assets). Only a top-level
// page load on the store domain should be treated as a block — filter the rest.
function isLikelyPageUrl(url: string, domain: string): boolean {
  return (
    !!url &&
    url.includes(domain) &&
    !/\.(js|css|png|jpe?g|gif|webp|svg|woff2?|ttf|ico|json|mp4|map)(\?|$)/i.test(url) &&
    !/\/api\//.test(url)
  );
}

function fmtWeight(qty: number): string {
  return `${(qty * 0.25).toFixed(2)} lb`;
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function WebViewCartSheet({
  visible,
  meals,
  storeId,
  storeName,
  onClose,
  onIngredientChosen,
  presentation = 'modal',
  collapsed = false,
  onStatusChange,
  onMinimize,
}: WebViewCartSheetProps) {
  // Lock the store to whatever it was when the sheet opened. The parent
  // (MyMealsScreen) can change `storeId` mid-flow — its loadMeals() auto-selects
  // the store with the most meals — which previously made the parallel workers
  // build URLs for the WRONG store (e.g. acmemarkets.com while the user was on
  // H-E-B → 0 results). lockedStoreId only updates when the sheet (re)opens.
  const [lockedStoreId, setLockedStoreId] = useState(storeId);
  // Same locked id as a ref, set synchronously at open. The parallel pool's
  // getUrl is captured in callbacks that can go stale (referencing the store
  // from an earlier render); reading this ref makes the worker URL resolve to
  // the CURRENT locked store at call time, immune to closure staleness.
  const lockedStoreIdRef = useRef(storeId);
  const storeColor = STORES.find((s) => s.id === lockedStoreId)?.color ?? '#dd0031';
  // May be null if a meal ever carries a non-WebView store id (e.g. a
  // Kroger-family store handled by the web integration, or mockstore in prod).
  // Consumers guard against null and the sheet closes gracefully on open rather
  // than crashing on a non-null-asserted `.storeUrl`.
  const scripts = useMemo(() => getStoreScripts(lockedStoreId), [lockedStoreId]);
  // Fingerprint shim + app-install-nudge suppressor, injected before store JS.
  const beforeContent = useMemo(() => buildBeforeContentScript(lockedStoreId), [lockedStoreId]);

  const [step, _setStep] = useState<Step>('qty');
  const stepRef = useRef<Step>('qty');
  const setStep = useCallback((s: Step) => { stepRef.current = s; _setStep(s); }, []);

  // Usage analytics for the WebView automation run (best-effort). Covers both the
  // background (startJob) and direct (setWebViewCartVisible) entry paths since it
  // lives in the sheet. One run per visible open: started -> completed on 'done'.
  const automationRunIdRef = useRef<string | null>(null);
  const automationStartedRef = useRef(false);
  const automationCompletedRef = useRef(false);
  useEffect(() => {
    if (visible) {
      if (!automationStartedRef.current) {
        automationStartedRef.current = true;
        usage
          .logAutomationStart({ storeId, source: 'app', mealCount: meals.length })
          .then((id) => { automationRunIdRef.current = id; });
      }
    } else {
      automationStartedRef.current = false;
      automationCompletedRef.current = false;
      automationRunIdRef.current = null;
    }
  }, [visible, storeId, meals.length]);

  // Step: qty
  const [items, setItems] = useState<ConsolidatedIngredient[]>([]);
  const [checkedItems, setCheckedItems] = useState<boolean[]>([]);

  // Step: searching / adding
  const [searchingLabel, setSearchingLabel] = useState('');
  const [webviewUri, setWebviewUri] = useState('');
  // Mirror of webviewUri for navTo (a []-dep callback). Lets it tell "navigate
  // to a new URL" from "reload the same URL" without the cache-buster query.
  const webviewUriRef = useRef('');
  const [browserShown, setBrowserShown] = useState(false);
  // Set to the HTTP status (e.g. 'http-403') when the store blocks us with an
  // anti-bot response. Reuses the robot_challenge step UI but swaps the banner
  // and shows a manual "Try again" button. Null = not blocked.
  const [blockReason, setBlockReason] = useState<string | null>(null);
  // Synchronous mirror of blockReason for onLoadEnd (a []-dep callback that
  // reads refs). Set the instant a block is detected so the very next onLoadEnd
  // for the 403 page does NOT auto-resume — that resume re-navigated and
  // re-blocked, which was the tight 403 loop.
  const blockReasonRef = useRef<string | null>(null);

  // Step: review
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [selectedSuggIdx, setSelectedSuggIdx] = useState<number | 'custom'>(0);
  const [selectedPreference, setSelectedPreference] = useState<string | null>(null);
  const [reviewMealQtys, setReviewMealQtys] = useState<Record<number, Record<string, number>>>({});
  const [pickedItems, setPickedItems] = useState<PickedItem[]>([]);
  // Draggable floating product-preview thumbnail (88x88, rests 12px from the right).
  const preview = useDraggablePreview(88, 88, 12);
  // Re-center the thumbnail on each new ingredient being reviewed.
  useEffect(() => { preview.reset(); }, [reviewIdx, preview.reset]);
  // Ingredients the user explicitly skipped during review, keyed by reviewIndex
  // so re-deciding after Back clears the earlier skip. Reported on the done
  // snapshot — distinct from items the automation failed to add.
  const [skippedByIdx, setSkippedByIdx] = useState<Record<number, string>>({});
  // Choose-product flow: single qty per ingredient (default 0, red until set)
  const [chooseQty, setChooseQty] = useState(0);
  // Custom search state (used when user selects "Other — type a product name…")
  const [customText, setCustomText] = useState('');
  const [customSearching, setCustomSearching] = useState(false);
  const [customSuggestions, setCustomSuggestions] = useState<Candidate[]>([]);
  const [customSearchTerm, setCustomSearchTerm] = useState('');

  // Step: done
  const [totalAdded, setTotalAdded] = useState(0);
  // Items processed so far (re-render-driving mirror of searchIdxRef), used to
  // drive the bubble's determinate progress ring. searchIdxRef alone is a ref
  // and never triggers a render, so it can't feed progress directly.
  const [processedCount, setProcessedCount] = useState(0);
  const [totalFailed, setTotalFailed] = useState(0);
  // Cart snapshot validation (silent-miss detection): badge count captured
  // right after login confirms, compared against the badge after the run.
  // null anywhere means "couldn't read the badge" → validation is skipped.
  const cartCountBeforeRef = useRef<number | null>(null);
  const cartCountPendingRef = useRef<'before' | 'after' | 'reconcile' | null>(null);
  // Cart-PAGE counting (HEB): the before-probe navigates to /cart, counts, then
  // resumes the search flow. This flag tells the CART_COUNT handler to kick off
  // the search once the before-count lands; the timer is a safety net so a /cart
  // that never loads/counts can't wedge the run.
  const cartProbeBeginSearchRef = useRef<boolean>(false);
  const cartProbeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const CART_PROBE_TIMEOUT_MS = 10_000;
  // Safety net for the after/reconcile probe: if CART_COUNT never posts (a cart
  // page that loops or never hydrates), retry once then finalize so reconcile
  // can't wait forever.
  const cartProbeResultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cartProbeRetriedRef = useRef(false);
  const CART_PROBE_RESULT_TIMEOUT_MS = 14_000;
  // The done-screen breakdown spinner falls back to the plain list after this,
  // so a cart page that never loads/counts (e.g. Amazon's multi-hop cart) can't
  // hang on "Updating your … cart" forever.
  const CART_ROWS_TIMEOUT_MS = 8_000;
  // Per-line cart contents captured by the before-probe, diffed against the
  // after-probe to render the done screen (added in green vs already-in-cart in
  // grey). Only populated for cart-page stores (HEB).
  const cartItemsBeforeRef = useRef<CartItem[]>([]);
  // For click-path cart stores (Amazon: cart icon → cart-of-carts → expand the
  // Fresh cart), the before-probe reports the final cart URL it counted on. We
  // cache it here and navigate straight there for the after-snapshot, skipping
  // the multi-hop click chain (saves a couple seconds). Null when no URL was
  // captured — the after-probe then falls back to the open-cart click path.
  const capturedCartUrlRef = useRef<string | null>(null);
  const [cartResultRows, setCartResultRows] = useState<CartRow[] | null>(null);
  // While the after-probe loads /cart on the done screen, show a loading state
  // (not the old added-names list) so the breakdown doesn't flash in. Flips true
  // if the after-probe never returns, so we fall back instead of spinning forever.
  const [cartRowsTimedOut, setCartRowsTimedOut] = useState(false);
  const cartRowsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cartDeltaWarning, setCartDeltaWarning] = useState<string | null>(null);
  const [addedNames, setAddedNames] = useState<string[]>([]);

  // WebView refs
  const webviewRef = useRef<WebView>(null);
  // Queue of scripts to inject sequentially on each onLoadEnd.
  // Each page load pops one script. Scripts that trigger navigation (e.g. buildSearchScript)
  // cause the next onLoadEnd to pop the following script automatically.
  const loadQueueRef = useRef<string[]>([]);
  // Tracks the last URL processed by onLoadEnd to deduplicate extra fires per page load.
  const lastLoadEndUrlRef = useRef('');
  // True once the WebView has landed on a store search page — lets subsequent items
  // skip the homepage round-trip and inject buildSearchScript directly.
  const onSearchPageRef = useRef(false);
  // When a store's buildSearchScript is about to navigate (window.location.href = …),
  // it posts NAV_INTENT with the target URL. onLoadEnd events whose URL doesn't
  // match this target are stale duplicates from the prior page and must NOT pop
  // the queue, otherwise the new search's extract would run on the old DOM
  // (the "chicken breast for every search" bug).
  const expectedNavUrlRef = useRef<string>('');
  // Bound how long we'll wait for an ADD_RESULT for the current item before
  // marking it failed and advancing. Without this, a stuck store script (e.g.
  // selectors broke, page never loaded, the search returned nothing addable)
  // leaves the user staring at the spinner forever.
  const addTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ADD_TIMEOUT_MS = 10_000;
  // Same safety net for navigateToSearchItem — the search+add (combined) and
  // choose-product flows both go through it, and if buildSearchScript hangs
  // (bad selectors, SPA submit fails AND fallback nav fails, …) we'd otherwise
  // never advance. Cleared when SEARCH_RESULT or SEARCH_AND_ADD_RESULT arrives.
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SEARCH_TIMEOUT_MS = 15_000;
  // Safety net for the Review/Choose custom search. If the user-typed search
  // never posts a SEARCH_RESULT (page reload-loops, WAF re-challenge, SPA submit
  // swallowed), customSearching would stay true forever and every review button
  // is disabled — wedging the user with no way out but closing the sheet.
  const customSearchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const CUSTOM_SEARCH_TIMEOUT_MS = 15_000;
  // Same safety net for the login check. If CHECK_LOGIN never posts a
  // LOGIN_STATUS (page hung, WAF interstitial swallowed the script, store
  // changed its DOM), fall back to showing the login WebView — the same
  // behavior as an explicit "not logged in" — instead of spinning forever.
  const loginCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LOGIN_CHECK_TIMEOUT_MS = 20_000;
  // Tracks which search idx to resume from after a robot/captcha challenge
  // (Walmart redirects to /blocked when it suspects automation; user has to
  // press-and-hold to verify). -1 when no challenge in progress.
  const robotChallengeResumeIdxRef = useRef<number>(-1);
  // Tracks which step we were in before a login redirect, so we can resume after login.
  const stepBeforeLoginRef = useRef<Step>('searching');
  const loginCheckActiveRef = useRef(false);
  const searchIdxRef = useRef(0);
  const addingIdxRef = useRef(0);
  const addingItemsRef = useRef<PickedItem[]>([]);
  const addResultsRef = useRef<{ name: string; success: boolean }[]>([]);
  const activeItemsRef = useRef<ConsolidatedIngredient[]>([]);
  // Parallel-add reconciliation: results from the concurrent pass (by item idx)
  // and a one-shot arm so the after-snapshot re-adds the genuinely-missing items
  // (false positives from the shared cart counter) sequentially, exactly once.
  const parallelResultByIdxRef = useRef<Map<number, AddResult>>(new Map());
  const parallelReconcileArmedRef = useRef(false);
  // Set when the reconcile probe finalized using its own cart read, so the
  // 'done' effect doesn't fire a redundant second after-probe.
  const reconcileFinalizedRef = useRef(false);
  // Forward-only progress across the parallel pass → sequential reconcile: keep
  // ONE denominator (the original item count) and a baseline of how many are
  // already done, so the ring continues instead of restarting at 0 for the
  // (smaller) reconcile subset. 0 = not a parallel run → normal per-item progress.
  const parallelOriginalTotalRef = useRef(0);
  const reconcileBaseRef = useRef(0);
  // Items that were auto-picked during search (had searchTerm set, match found — skip review).
  const autoPickedItemsRef = useRef<PickedItem[]>([]);
  // Sync mirror of searchResults for use inside callbacks (avoids stale closure on state).
  const searchResultsRef = useRef<SearchResult[]>([]);
  // True when SEARCH_RESULT should be treated as a custom-search response (not advancing queue).
  const isCustomSearchRef = useRef(false);
  // When >= 0: SEARCH_RESULT following a SEARCH_AND_ADD_RESULT failure should enrich candidates
  // at this index rather than starting a new review item. pendingNavIdxRef holds the next index
  // to navigate to once the enrichment SEARCH_RESULT arrives.
  const prefFetchResultIdxRef = useRef<number>(-1);
  const pendingNavIdxRef = useRef<number>(-1);

  // Last script popped from the queue and injected. Re-injected if onLoadEnd
  // fires AGAIN for the same URL during the `searching` step before a result
  // arrives — this handles SSO/MSAL bootstrap reloads (e.g. Wegmans's first
  // navigation) that kill the just-injected script. Cleared on SEARCH_RESULT
  // or SEARCH_AND_ADD_RESULT, and when the next script is popped from queue.
  const inflightScriptRef = useRef<string | null>(null);

  // ── Wegmans parallel search pool (storeId === 'wegmans' choose-flow only) ──
  // Worker WebViews are mounted only AFTER login completes and parallel search
  // starts — to avoid spawning 5 hidden WebViews during login_check, which can
  // overwhelm iOS WebView init and cause a silent crash. The queue/dispatch/
  // timeout state machine lives in useParallelSearchPool; this component owns
  // only the start trigger, the per-worker WebView render, and the "all done →
  // build SearchResult list → go to review" finalization.
  // Worker count + initial-dispatch stagger are per-store (anti-bot tuning):
  // ALDI uses 3 staggered workers; everyone else defaults to 5 at once.
  const PARALLEL_WORKER_COUNT = scripts?.workerCount ?? 5;
  const PARALLEL_WORKER_STAGGER_MS = scripts?.workerStaggerMs ?? 0;
  const PARALLEL_WORKER_TIMEOUT_MS = 20_000;
  // Parallel-ADD worker count: honor the per-store workerCount (a heavy store
  // like Albertsons crashed the iOS WKWebView content process with 5 concurrent
  // add WebViews), falling back to the global pilot default.
  const PARALLEL_ADD_WORKER_COUNT = scripts?.workerCount ?? PARALLEL_ADD_WORKERS;
  // A store opts into the worker-pool choose-product path by exposing BOTH
  // getSearchUrl and buildWorkerScript on its StoreScripts. Null otherwise →
  // sequential single-WebView flow. (WAF note: HEB/Walmart/Albertsons run 5
  // concurrent WebViews here; live-tested in dev before shipping.)
  const parallelCfg = (scripts?.getSearchUrl && scripts.buildWorkerScript && !scripts.forceSerialSearch)
    ? { getSearchUrl: scripts.getSearchUrl, buildWorkerScript: scripts.buildWorkerScript }
    : null;

  const parallelPool = useParallelSearchPool<ConsolidatedIngredient, Candidate[]>({
    workerCount: PARALLEL_WORKER_COUNT,
    workerTimeoutMs: PARALLEL_WORKER_TIMEOUT_MS,
    dispatchStaggerMs: PARALLEL_WORKER_STAGGER_MS,
    // Resolve the store from the live ref (not the captured parallelCfg) so a
    // stale dispatch closure can't build URLs for a previously-selected store.
    getUrl: (item) => {
      const s = getStoreScripts(lockedStoreIdRef.current);
      return s?.getSearchUrl ? s.getSearchUrl(item.ingredientName) : '';
    },
    emptyResult: () => [],
  });

  // Parallel ADD pool (FEATURE_PARALLEL_ADD): the regular add flow's workers
  // search AND add one product each, concurrently. Bounded lower than search
  // (PARALLEL_ADD_WORKERS) since concurrent cart writes are riskier than reads.
  // Per-item term/qty/preference ride in the URL hash; the worker's add script
  // reads them and confirms via the store cart badge (> prev).
  const addPool = useParallelSearchPool<ConsolidatedIngredient, AddResult>({
    workerCount: PARALLEL_ADD_WORKER_COUNT,
    // Longer than search: an add worker also runs the cart-badge confirmation
    // poll (up to ~10s on a slow network) on top of search + click.
    workerTimeoutMs: 35_000,
    // Stagger the initial burst so 5 workers don't all cold-start their search
    // pages at the same instant — that simultaneous load left some grids unpainted
    // when the add script ran (no_results / product=null). Spreads them out.
    dispatchStaggerMs: PARALLEL_WORKER_STAGGER_MS || 500,
    getUrl: (item) => {
      const s = getStoreScripts(lockedStoreIdRef.current);
      if (!s?.getSearchUrl || !item.searchTerm) return '';
      const payload = encodeURIComponent(JSON.stringify({
        term: item.searchTerm, qty: item.productQty, dropdown: item.dropdown ?? null,
      }));
      return s.getSearchUrl(item.searchTerm) + '#mealio=' + payload;
    },
    emptyResult: () => ({ success: false, productName: null, reason: 'timeout', candidates: [] }),
  });

  // Emit coarse status (incl. a determinate progress fraction) upward so the
  // provider can drive the floating bubble. No-op in modal mode.
  useEffect(() => {
    if (!onStatusChange) return;
    const kindMap: Record<Step, CartJobKind> = {
      qty: 'setup',
      login_check: 'running',
      login: 'attention',
      robot_challenge: 'attention',
      searching: 'running',
      adding: 'running',
      searchResult: 'warning',
      review: 'warning',
      done: 'done',
    };
    const labelMap: Record<Step, string> = {
      qty: 'Set quantities',
      login_check: 'Checking login…',
      login: `Log in to ${storeName}`,
      robot_challenge: 'Verification needed',
      searching: searchingLabel || 'Adding to cart…',
      adding: searchingLabel || 'Adding to cart…',
      searchResult: 'Choose a product',
      review: 'Review needed',
      done: 'Done',
    };
    // Progress: per-item position through the search/add funnel. processedCount
    // advances once per ingredient and DOES trigger renders (unlike searchIdxRef,
    // and unlike totalAdded which the sequential search-and-add path never
    // updates — that left the ring frozen). The parallel search phase has no
    // per-item signal, so show the indeterminate spinner there.
    const total = activeItemsRef.current.length;
    let progress: number | null = null;
    if (step === 'done') {
      progress = 1;
    } else if (addPool.isActive) {
      // Parallel add: determinate, one tick per ingredient processed.
      progress = addPool.total > 0 ? Math.min(1, addPool.completed / addPool.total) : null;
    } else if (parallelPool.isActive) {
      progress = null;
    } else if (parallelOriginalTotalRef.current > 0 && (step === 'searching' || step === 'adding')) {
      // Forward-only across the parallel pass → cart-check → sequential top-up:
      // one denominator (original total) plus the already-done baseline, so the
      // ring continues rather than restarting at 0 for the smaller reconcile set.
      progress = Math.min(1, (reconcileBaseRef.current + processedCount) / parallelOriginalTotalRef.current);
    } else if (total > 0 && (step === 'searching' || step === 'adding')) {
      progress = Math.min(1, processedCount / total);
    }
    onStatusChange({ phase: step, kind: kindMap[step], label: labelMap[step], progress });
  }, [step, searchingLabel, storeName, onStatusChange, processedCount, parallelPool.isActive, addPool.isActive, addPool.completed, addPool.total]);

  const workerScripts = useMemo(
    () => parallelCfg
      ? new Array(PARALLEL_WORKER_COUNT).fill(0).map((_, i) => parallelCfg.buildWorkerScript(i))
      : [],
    [parallelCfg, PARALLEL_WORKER_COUNT],
  );
  const workerSources = useMemo(
    () => parallelPool.workerUris.map((uri) => ({ uri: uri || 'about:blank' })),
    [parallelPool.workerUris],
  );

  // Add-worker scripts: one fixed search-and-add script per worker (placeholder
  // params; real ones come from the URL hash at runtime). Only stores whose
  // buildSearchAndAddScript reads the #mealio hash support parallel add today
  // (HEB pilot); others fall back to sequential via beginSearchFlow's gate.
  const addWorkerScripts = useMemo(
    () => parallelCfg && scripts
      ? new Array(PARALLEL_ADD_WORKER_COUNT).fill(0).map((_, i) =>
          buildSearchAndAddWorker(i, scripts.buildSearchAndAddScript('', 1, null)))
      : [],
    [parallelCfg, scripts],
  );
  const addWorkerSources = useMemo(
    () => addPool.workerUris.map((uri) => ({ uri: uri || 'about:blank' })),
    [addPool.workerUris],
  );

  const finishParallelSearch = useCallback((resultsByIdx: Map<number, Candidate[]>) => {
    const active = activeItemsRef.current;
    const results: SearchResult[] = [];
    for (let idx = 0; idx < active.length; idx++) {
      const item = active[idx];
      const candidates = resultsByIdx.get(idx) ?? [];
      results.push({
        term: item.ingredientName,
        candidates,
        mealIngredients: item.mealIngredients,
        unit: item.unit,
        measure: item.measure,
        reason: candidates.length === 0 ? 'no_results' : 'low_confidence',
        isChoose: true,
      });
    }
    const summary = results.map((r) => ({ term: r.term, count: r.candidates.length, first: r.candidates[0]?.productName }));
    console.log(`[Cart ${ts()}]`, 'parallel search: finishing → review', JSON.stringify(summary));
    searchResultsRef.current = results;
    setSearchResults(results);
    setStep('review');
    setReviewIdx(0);
  }, []);

  const startParallelSearch = useCallback(() => {
    const active = activeItemsRef.current;
    if (active.length === 0) {
      console.log(`[Cart ${ts()}]`, 'parallel search: no active items, skipping');
      return;
    }
    console.log(`[Cart ${ts()}]`, 'parallel search: dispatching', active.length, 'across', PARALLEL_WORKER_COUNT, 'workers');
    setSearchingLabel(`Searching ${active.length} ingredients…`);
    parallelPool.start(active, finishParallelSearch);
  }, [parallelPool, finishParallelSearch]);

  // ── Parallel ADD (FEATURE_PARALLEL_ADD) ─────────────────────────────────────

  // Probe the cart for its current contents → CART_COUNT (phase-tagged). Shared
  // by the done-screen after-snapshot and the parallel-add reconcile. Arms a
  // result-timeout so a cart page that never posts can't strand the flow.
  const triggerCartProbe = useCallback((phase: 'after' | 'reconcile') => {
    const sid = lockedStoreIdRef.current;
    const cartPageScript = buildCartPageCountScript(sid);
    const cartPageUrl = getCartPageUrl(sid) ?? capturedCartUrlRef.current;
    const openCartScript = buildOpenCartScript(sid);
    const inlineCartScript = buildInlineCartScript(sid);
    if (cartPageScript || inlineCartScript) {
      if (cartRowsTimeoutRef.current) clearTimeout(cartRowsTimeoutRef.current);
      cartRowsTimeoutRef.current = setTimeout(() => { cartRowsTimeoutRef.current = null; setCartRowsTimedOut(true); }, CART_ROWS_TIMEOUT_MS);
    }
    if (cartProbeResultTimeoutRef.current) clearTimeout(cartProbeResultTimeoutRef.current);
    cartProbeResultTimeoutRef.current = setTimeout(() => {
      cartProbeResultTimeoutRef.current = null;
      console.log(`[Cart ${ts()}]`, 'cart probe timeout — no CART_COUNT for', phase);
      cartCountPendingRef.current = null;
      if (phase === 'reconcile') {
        parallelReconcileArmedRef.current = false;
        setCartDeltaWarning(`Couldn't verify your ${storeName} cart — please double-check it.`);
        setStep('done');
      }
    }, CART_PROBE_RESULT_TIMEOUT_MS);
    if (inlineCartScript) {
      cartCountPendingRef.current = phase;
      webviewRef.current?.injectJavaScript(inlineCartScript);
      return;
    }
    if (cartPageScript && (cartPageUrl || openCartScript)) {
      cartCountPendingRef.current = phase;
      cartProbeBeginSearchRef.current = false;
      loadQueueRef.current = [cartPageScript];
      lastLoadEndUrlRef.current = '';
      expectedNavUrlRef.current = '';
      if (cartPageUrl) {
        setWebviewUri(cartPageUrl + (cartPageUrl.includes('?') ? '&' : '?') + '_t=' + Date.now());
      } else {
        webviewRef.current?.injectJavaScript(openCartScript!);
      }
      return;
    }
    const countScript = buildCartCountScript(sid);
    if (!countScript) {
      if (cartProbeResultTimeoutRef.current) { clearTimeout(cartProbeResultTimeoutRef.current); cartProbeResultTimeoutRef.current = null; }
      if (phase === 'reconcile') { parallelReconcileArmedRef.current = false; setStep('done'); }
      return;
    }
    cartCountPendingRef.current = phase;
    webviewRef.current?.injectJavaScript(countScript);
  }, [setStep, storeName, setWebviewUri]);

  const finishParallelAdd = useCallback((resultsByIdx: Map<number, AddResult>) => {
    const active = activeItemsRef.current;
    // The concurrent pass is best-effort — its per-worker confirmation reads a
    // SHARED cart counter, so under concurrency a worker can falsely confirm.
    // Don't trust it: record the reported successes, keep the bubble RUNNING
    // (no premature check), and probe the REAL cart to reconcile.
    parallelResultByIdxRef.current = resultsByIdx;
    addResultsRef.current = [];
    let successCount = 0;
    for (let idx = 0; idx < active.length; idx++) {
      const r = resultsByIdx.get(idx);
      if (r && r.success) {
        addResultsRef.current.push({ name: r.productName || active[idx].searchTerm || active[idx].ingredientName, success: true });
        successCount++;
      }
    }
    console.log(`[Cart ${ts()}]`, 'parallel add: pass done. reported success=', successCount, 'of', active.length, '— reconciling against cart');
    parallelReconcileArmedRef.current = true;
    cartProbeRetriedRef.current = false;
    // Hold the ring at the parallel peak through the cart-check, then the
    // reconcile branch corrects the baseline to the CONFIRMED count.
    reconcileBaseRef.current = successCount;
    setProcessedCount(0);
    setSearchingLabel('Checking your cart…');
    triggerCartProbe('reconcile');
  }, [triggerCartProbe]);

  const startParallelAdd = useCallback(() => {
    const active = activeItemsRef.current;
    if (active.length === 0) return;
    console.log(`[Cart ${ts()}]`, 'parallel ADD: dispatching', active.length, 'across', PARALLEL_ADD_WORKER_COUNT, 'workers');
    parallelOriginalTotalRef.current = active.length; // forward-only progress denominator
    setStep('adding');
    setSearchingLabel(`Adding ${active.length} ingredients…`);
    addPool.start(active, finishParallelAdd);
  }, [addPool, finishParallelAdd, setStep]);

  const onAddWorkerMessage = useCallback((workerId: number, event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'WORKER_DEBUG') {
        console.log(`[Cart ${ts()}]`, 'ADD WORKER_DEBUG w', workerId, JSON.stringify(msg).slice(0, 200));
        return;
      }
      if (msg.type === 'WORKER_RESULT') {
        console.log(`[Cart ${ts()}]`, 'ADD WORKER_RESULT w', workerId, 'success=', msg.success, 'product=', msg.productName, 'reason=', msg.reason ?? null);
        addPool.reportResult(workerId, {
          success: !!msg.success, productName: msg.productName ?? null,
          reason: msg.reason ?? null, candidates: msg.candidates ?? [],
        });
        return;
      }
    } catch (e) {
      console.log(`[Cart ${ts()}]`, 'onAddWorkerMessage parse error w', workerId, e);
    }
  }, [addPool]);

  // Navigate the store WebView. Default: append a `?_t=<ts>` cache-buster so the
  // load is unique (forces a real reload + dodges the onLoadEnd same-URL dedup).
  // For stores that opt out (cacheBustNav:false — ALDI, whose anti-bot 403s on
  // that synthetic query), use the CLEAN URL instead: if it's already the
  // current source, force a reload(); otherwise set it. Either way clear the
  // dedup so the next onLoadEnd re-injects.
  const navTo = useCallback((baseUrl: string) => {
    const s = getStoreScripts(lockedStoreIdRef.current);
    if (s?.cacheBustNav !== false) {
      setWebviewUri(baseUrl + (baseUrl.includes('?') ? '&' : '?') + '_t=' + Date.now());
      return;
    }
    lastLoadEndUrlRef.current = '';
    if (webviewUriRef.current === baseUrl && webviewRef.current) {
      webviewRef.current.reload();
    } else {
      setWebviewUri(baseUrl);
    }
  }, []);

  useEffect(() => { webviewUriRef.current = webviewUri; }, [webviewUri]);

  const onWorkerMessage = useCallback((workerId: number, event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'WORKER_DEBUG') {
        console.log(`[Cart ${ts()}]`, 'WORKER_DEBUG w', workerId, JSON.stringify(msg));
        return;
      }
      if (msg.type === 'WORKER_RESULT') {
        console.log(`[Cart ${ts()}]`, 'WORKER_RESULT w', workerId, 'candidates=', (msg.candidates || []).length);
        parallelPool.reportResult(workerId, msg.candidates || []);
        return;
      }
    } catch (e) {
      console.log(`[Cart ${ts()}]`, 'onWorkerMessage parse error w', workerId, e);
    }
  }, [parallelPool]);

  // ── Reset on open ────────────────────────────────────────────────────────

  useEffect(() => {
    if (visible) {
      // Snapshot the store at open and lock it. Use it synchronously for the
      // immediate setup below (state update lags a render, but onMessage and
      // the parallel pool must see the right store from the first tick).
      const openStoreId = storeId;
      const openScripts = getStoreScripts(openStoreId);
      // A non-WebView store id (Kroger-family web integration, or mockstore in
      // prod) has no scripts. There's nothing this sheet can automate, so close
      // gracefully instead of crashing on openScripts.storeUrl below.
      if (!openScripts) {
        console.warn(`[Cart ${ts()}]`, 'no WebView scripts for store=', openStoreId, '— closing sheet');
        onClose();
        return;
      }
      lockedStoreIdRef.current = openStoreId;
      setLockedStoreId(openStoreId);
      scriptsRef.current = openScripts;
      console.log(`[Cart ${ts()}]`, 'cart opened: locking store=', openStoreId);
      const consolidated = consolidateIngredients(meals);
      setItems(consolidated);
      setCheckedItems(consolidated.map(() => true));
      setSearchResults([]);
      setReviewIdx(0);
      setSelectedSuggIdx(0);
      setSelectedPreference(null);
      setReviewMealQtys({});
      setPickedItems([]);
      preview.reset();
      setSkippedByIdx({});
      setCustomText('');
      setCustomSearching(false);
      setCustomSuggestions([]);
      setCustomSearchTerm('');
      setTotalAdded(0);
      setProcessedCount(0);
      setTotalFailed(0);
      setAddedNames([]);
      setBrowserShown(false);
      setBlockReason(null);
      blockReasonRef.current = null;
      console.log(`[Cart ${ts()}]`, 'initial webviewUri=', scriptsRef.current!.storeUrl);
      setWebviewUri(scriptsRef.current!.storeUrl);
      loadQueueRef.current = [];
      lastLoadEndUrlRef.current = '';
      expectedNavUrlRef.current = '';
      inflightScriptRef.current = null;
      if (addTimeoutRef.current) { clearTimeout(addTimeoutRef.current); addTimeoutRef.current = null; }
      if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }
      if (customSearchTimeoutRef.current) { clearTimeout(customSearchTimeoutRef.current); customSearchTimeoutRef.current = null; }
      if (cartProbeTimeoutRef.current) { clearTimeout(cartProbeTimeoutRef.current); cartProbeTimeoutRef.current = null; }
      if (loginCheckTimeoutRef.current) { clearTimeout(loginCheckTimeoutRef.current); loginCheckTimeoutRef.current = null; }
      isCustomSearchRef.current = false;
      cartProbeBeginSearchRef.current = false;
      cartCountBeforeRef.current = null;
      robotChallengeResumeIdxRef.current = -1;
      onSearchPageRef.current = false;
      loginCheckActiveRef.current = false;
      searchIdxRef.current = 0;
      addingIdxRef.current = 0;
      addResultsRef.current = [];
      autoPickedItemsRef.current = [];
      searchResultsRef.current = [];
      isCustomSearchRef.current = false;
      cartCountBeforeRef.current = null;
      cartCountPendingRef.current = null;
      cartItemsBeforeRef.current = [];
      capturedCartUrlRef.current = null;
      parallelReconcileArmedRef.current = false;
      reconcileFinalizedRef.current = false;
      cartProbeRetriedRef.current = false;
      parallelOriginalTotalRef.current = 0;
      reconcileBaseRef.current = 0;
      if (cartProbeResultTimeoutRef.current) { clearTimeout(cartProbeResultTimeoutRef.current); cartProbeResultTimeoutRef.current = null; }
      parallelResultByIdxRef.current = new Map();
      setCartResultRows(null);
      setCartRowsTimedOut(false);
      if (cartRowsTimeoutRef.current) { clearTimeout(cartRowsTimeoutRef.current); cartRowsTimeoutRef.current = null; }
      setCartDeltaWarning(null);

      // Reset Wegmans parallel worker state. The hook clears its queue,
      // active flag, timers, and worker URIs in one call — workers unmount
      // because isActive flips to false.
      parallelPool.reset(); addPool.reset();

      // If any ingredient has no chosen product yet, skip the qty step and
      // auto-start the search/choose flow immediately.
      const hasUnchosen = consolidated.some((it) => !it.searchTerm);
      console.log(`[Cart ${ts()}]`, 'open: meals=', meals.length, 'consolidated=', consolidated.length, 'hasUnchosen=', hasUnchosen);
      if (hasUnchosen && consolidated.length > 0) {
        // Only search for ingredients that don't have a product chosen yet.
        const unchosen = consolidated.filter((it) => !it.searchTerm);
        const active = unchosen.filter((it) => it.productQty > 0);
        activeItemsRef.current = active.length > 0 ? active : unchosen;
        console.log(`[Cart ${ts()}]`, 'auto-start: active=', activeItemsRef.current.length, activeItemsRef.current.map(i => i.ingredientName));
        searchIdxRef.current = 0;
        setStep('login_check');
        setSearchingLabel('Checking login…');
        loadQueueRef.current = [scriptsRef.current!.checkLoginScript];
        navTo(scriptsRef.current!.storeUrl);
        armLoginCheckTimeout();
      } else {
        setStep('qty');
      }
    }
  }, [visible]);

  // Reset selection when review item changes
  useEffect(() => {
    setSelectedSuggIdx(0);
    setSelectedPreference(null);
    setCustomText('');
    setCustomSuggestions([]);
    setCustomSearchTerm('');
    setChooseQty(0);
  }, [reviewIdx]);

  // ── Qty step helpers ─────────────────────────────────────────────────────

  const updateQty = (i: number, delta: number) =>
    setItems((prev) =>
      prev.map((it, idx) => {
        if (idx !== i) return it;
        const w = ingredientWeight(it);
        // Dropdown-weight item: step the absolute weight by its increment.
        if (w?.mode === 'dropdown') {
          return { ...it, purchaseWeight: Math.max(w.step, +((it.purchaseWeight ?? w.step) + delta * w.step).toFixed(2)) };
        }
        // Stepper-weight (Deli) AND normal items both step productQty by 1; the
        // weight display derives from productQty × step.
        return { ...it, productQty: Math.max(0, it.productQty + delta) };
      }),
    );

  const toggleChecked = (i: number) =>
    setCheckedItems((prev) => prev.map((c, idx) => (idx === i ? !c : c)));

  const allChecked = checkedItems.length === 0 || checkedItems.every((c) => c);
  const toggleAll = () => setCheckedItems((prev) => prev.map(() => !allChecked));
  // A dropdown-weight item is active whenever it has a chosen weight; stepper
  // and normal items need productQty > 0.
  const activeCount = items.filter((it, i) => (checkedItems[i] ?? true) && (it.purchaseWeight != null || it.productQty > 0)).length;

  // Cart snapshot AFTER the run. Only fires when the before-snapshot succeeded
  // and something was reported added. For cart-page stores (HEB) navigate the
  // now-idle webview to /cart and count there; otherwise read the header badge
  // off the last search page (still mounted through 'done').
  useEffect(() => {
    if (step !== 'done' || cartCountBeforeRef.current == null) return;
    // The reconcile pass already read the cart with its own probe and set the
    // final state — don't fire a redundant second after-probe.
    if (reconcileFinalizedRef.current) { reconcileFinalizedRef.current = false; return; }
    if (totalAdded === 0) return;
    triggerCartProbe('after');
  }, [step, totalAdded, lockedStoreId, triggerCartProbe]);

  // Usage analytics: log the automation run's completion once it reaches 'done'.
  // Fires for every finished run (unlike the gated after-probe above).
  useEffect(() => {
    if (step !== 'done' || automationCompletedRef.current) return;
    automationCompletedRef.current = true;
    const outcome: 'success' | 'partial' | 'failed' =
      totalAdded === 0 ? 'failed' : cartDeltaWarning ? 'partial' : 'success';
    const runId = automationRunIdRef.current;
    if (runId) usage.logAutomationComplete({ runId, itemsAdded: totalAdded, outcome });
  }, [step, totalAdded, cartDeltaWarning]);

  // Clear all safety timers on unmount. Without this, closing the sheet mid
  // login-check / search / add leaves a real setTimeout running that later
  // fires setState on an unmounted component (and, in tests, logs after the
  // test finishes — "Cannot log after tests are done").
  useEffect(() => {
    return () => {
      if (loginCheckTimeoutRef.current) clearTimeout(loginCheckTimeoutRef.current);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      if (addTimeoutRef.current) clearTimeout(addTimeoutRef.current);
      if (customSearchTimeoutRef.current) clearTimeout(customSearchTimeoutRef.current);
      if (cartProbeTimeoutRef.current) clearTimeout(cartProbeTimeoutRef.current);
      if (cartRowsTimeoutRef.current) clearTimeout(cartRowsTimeoutRef.current);
      if (cartProbeResultTimeoutRef.current) clearTimeout(cartProbeResultTimeoutRef.current);
    };
  }, []);

  // ── Start flow ──────────────────────────────────────────────────────────

  const armLoginCheckTimeout = useCallback(() => {
    if (loginCheckTimeoutRef.current) clearTimeout(loginCheckTimeoutRef.current);
    loginCheckTimeoutRef.current = setTimeout(() => {
      loginCheckTimeoutRef.current = null;
      if (stepRef.current !== 'login_check') return;
      console.log(`[Cart ${ts()}]`, 'LOGIN CHECK timeout — no LOGIN_STATUS, falling back to login webview');
      loginCheckActiveRef.current = false;
      // Mirror the LOGIN_STATUS:false branch: show the webview so the user
      // can log in (or see whatever the store is actually displaying).
      const alreadyOnStore = lastLoadEndUrlRef.current &&
        lastLoadEndUrlRef.current.includes(scriptsRef.current!.domain);
      setStep('login');
      lastLoadEndUrlRef.current = '';
      if (!alreadyOnStore) {
        setWebviewUri(scriptsRef.current!.loginUrl);
      }
    }, LOGIN_CHECK_TIMEOUT_MS);
  }, []);

  const handleStartSearch = () => {
    const active = items.filter((it, i) => (checkedItems[i] ?? true) && (it.purchaseWeight != null || it.productQty > 0));
    if (active.length === 0) return;
    activeItemsRef.current = active;
    searchIdxRef.current = 0;
    setStep('login_check');
    setSearchingLabel('Checking login…');
    loadQueueRef.current = [scriptsRef.current!.checkLoginScript];
    navTo(scriptsRef.current!.storeUrl);
    armLoginCheckTimeout();
  };

  // ── Navigation to next search item ──────────────────────────────────────

  const navigateToSearchItem = useCallback((idx: number) => {
    // Drive the progress ring: idx is the per-item position (0..N), advancing
    // once per ingredient through the sequential search/add funnel.
    setProcessedCount(idx);
    // Clear any prior search timer — even on the all-done branch — so a late
    // firing can't synthesize a phantom failure on the next session.
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    const active = activeItemsRef.current;
    if (idx >= active.length) {
      if (searchResultsRef.current.length === 0) {
        console.log(`[Cart ${ts()}]`, 'navigateToSearchItem: all done, no review needed');
        const autoPicked = autoPickedItemsRef.current;
        if (autoPicked.length > 0) {
          // Legacy path: unchosen items that happened to score 100 — add them now.
          addingItemsRef.current = autoPicked;
          addingIdxRef.current = 0;
          addResultsRef.current = [];
          setStep('adding');
          navigateToAddItem(0, autoPicked);
        } else {
          // Combined path: all items were search+added inline; results are in addResultsRef.
          const added = addResultsRef.current.filter((r) => r.success).length;
          const failed = addResultsRef.current.filter((r) => !r.success).length;
          const names = addResultsRef.current.filter((r) => r.success).map((r) => r.name);
          setTotalAdded(added);
          setTotalFailed(failed);
          setAddedNames(names);
          setStep('done');
        }
      } else {
        // Skip the "items could not be added" summary for choose-product flow — go straight to review.
        const allChoose = searchResultsRef.current.every(r => r.isChoose);
        const resultSummary = searchResultsRef.current.map(r => ({ term: r.term, isChoose: r.isChoose, candidateCount: r.candidates.length, firstCandidatePrefs: r.candidates[0]?.preferences }));
        console.log(`[Cart ${ts()}]`, 'navigateToSearchItem: all done → ', allChoose ? 'review (choose flow)' : 'searchResult', JSON.stringify(resultSummary));
        if (allChoose) {
          setStep('review');
        } else {
          setStep('searchResult');
        }
        setReviewIdx(0);
      }
      return;
    }
    const item = active[idx];
    const term = item.searchTerm ?? item.ingredientName;
    console.log(`[Cart ${ts()}]`, 'navigateToSearchItem idx=', idx, 'term=', term, 'hasSearchTerm=', !!item.searchTerm, 'onSearchPage=', onSearchPageRef.current);

    if (item.searchTerm) {
      // Combined path: search + add to cart in one step (no separate add phase).
      setSearchingLabel(`Adding ${term}…`);
      // Sold-by-weight item with a remembered weight: pass it as a 'weight'
      // dropdown so the add selects the option closest to the saved lb amount
      // (the store's increments can differ / change). Falls back to the normal
      // preference dropdown for everything else.
      const addDropdown = item.purchaseWeight != null
        ? { type: 'weight', selectedText: `${item.purchaseWeight} lb`, selectedValue: String(item.purchaseWeight) }
        : (item.dropdown ?? null);
      const script = scriptsRef.current!.buildSearchAndAddScript(term, item.productQty, addDropdown);
      if (onSearchPageRef.current) {
        loadQueueRef.current = [script];
        // Clear dedup so onLoadEnd fires even if the search URL is identical (same ingredient across meals).
        lastLoadEndUrlRef.current = '';
        webviewRef.current?.injectJavaScript(scriptsRef.current!.buildSearchScript(term));
      } else {
        loadQueueRef.current = [scriptsRef.current!.buildSearchScript(term), script];
        navTo(scriptsRef.current!.storeUrl);
      }
    } else {
      // Choose-product path: extract candidates for user to pick from.
      setSearchingLabel(`Searching for ${term}…`);
      if (onSearchPageRef.current) {
        loadQueueRef.current = [scriptsRef.current!.extractProductsScript];
        // Clear dedup so onLoadEnd fires even if the search URL is identical (same ingredient across meals).
        lastLoadEndUrlRef.current = '';
        webviewRef.current?.injectJavaScript(scriptsRef.current!.buildSearchScript(term));
      } else {
        loadQueueRef.current = [scriptsRef.current!.buildSearchScript(term), scriptsRef.current!.extractProductsScript];
        navTo(scriptsRef.current!.storeUrl);
      }
    }
    // Arm a safety timeout. If neither SEARCH_RESULT nor SEARCH_AND_ADD_RESULT
    // arrives within the window, mark this item as failed (where applicable)
    // and advance. Without this a hung buildSearchScript spins forever.
    searchTimeoutRef.current = setTimeout(() => {
      searchTimeoutRef.current = null;
      inflightScriptRef.current = null;
      console.log(`[Cart ${ts()}]`, 'SEARCH timeout for', term, '— treating as failed and advancing');
      if (item.searchTerm) {
        // Auto-add flow: also push a SearchResult with empty candidates so
        // the failed item appears in the review/searchResult screen — same
        // shape as the SEARCH_AND_ADD_RESULT failure path.
        const newResult: SearchResult = {
          term: item.searchTerm,
          candidates: [],
          mealIngredients: item.mealIngredients,
          unit: item.unit,
          measure: item.measure,
          reason: 'no_results',
          isChoose: false,
        };
        searchResultsRef.current = [...searchResultsRef.current, newResult];
        setSearchResults(searchResultsRef.current);
        addResultsRef.current.push({ name: item.searchTerm, success: false });
      } else {
        // Choose-product flow: push an empty-candidates SearchResult so the
        // review screen still renders an entry for this ingredient.
        const newResult: SearchResult = {
          term: item.ingredientName,
          candidates: [],
          mealIngredients: item.mealIngredients,
          unit: item.unit,
          measure: item.measure,
          reason: 'no_results',
          isChoose: true,
        };
        searchResultsRef.current = [...searchResultsRef.current, newResult];
        setSearchResults(searchResultsRef.current);
      }
      // Clear any in-flight load state so the next nav can run cleanly.
      loadQueueRef.current = [];
      expectedNavUrlRef.current = '';
      const nextIdx = idx + 1;
      searchIdxRef.current = nextIdx;
      navigateToSearchItem(nextIdx);
    }, SEARCH_TIMEOUT_MS);
  }, []);

  const navigateToAddItem = useCallback((idx: number, itemsToAdd: PickedItem[]) => {
    // Always clear any timer from the previous item — even on the "all done"
    // branch, otherwise a late firing could synthesize a phantom result.
    if (addTimeoutRef.current) {
      clearTimeout(addTimeoutRef.current);
      addTimeoutRef.current = null;
    }
    if (idx >= itemsToAdd.length) {
      // All done — navigate to cart
      const added = addResultsRef.current.filter((r) => r.success).length;
      const failed = addResultsRef.current.filter((r) => !r.success).length;
      const names = addResultsRef.current.filter((r) => r.success).map((r) => r.name);
      setTotalAdded(added);
      setTotalFailed(failed);
      setAddedNames(names);
      setStep('done');
      return;
    }
    const item = itemsToAdd[idx];
    console.log(`[Cart ${ts()}]`, 'navigateToAddItem idx=', idx, 'searchTerm=', item.searchTerm, 'product=', item.productName, 'qty=', item.qty, 'pref=', item.preference?.text ?? null, 'onSearchPage=', onSearchPageRef.current);
    setSearchingLabel(`Adding ${item.productName}…`);
    if (onSearchPageRef.current) {
      loadQueueRef.current = [scriptsRef.current!.buildAddToCartScript(item.productName, item.preference, item.qty, item.purchaseWeight ?? null)];
      lastLoadEndUrlRef.current = '';
      webviewRef.current?.injectJavaScript(scriptsRef.current!.buildSearchScript(item.searchTerm));
    } else {
      loadQueueRef.current = [scriptsRef.current!.buildSearchScript(item.searchTerm), scriptsRef.current!.buildAddToCartScript(item.productName, item.preference, item.qty, item.purchaseWeight ?? null)];
      navTo(scriptsRef.current!.storeUrl);
    }
    // Arm the per-item timeout. On fire: synthesize a failure ADD_RESULT,
    // wipe any pending queue/nav-intent, and advance.
    addTimeoutRef.current = setTimeout(() => {
      addTimeoutRef.current = null;
      console.log(`[Cart ${ts()}]`, 'ADD timeout for', item.productName, '— treating as failed and advancing');
      addResultsRef.current.push({ name: item.productName, success: false });
      loadQueueRef.current = [];
      expectedNavUrlRef.current = '';
      const nextIdx = idx + 1;
      addingIdxRef.current = nextIdx;
      navigateToAddItem(nextIdx, itemsToAdd);
    }, ADD_TIMEOUT_MS);
  }, []);

  // Kick off the search phase (parallel pool when every active item is a
  // choose-flow ingredient and the store opts in, else the sequential WebView
  // flow). Extracted so the HEB cart-page before-probe can defer it until the
  // before-count lands.
  const beginSearchFlow = useCallback(() => {
    setStep('searching');
    const active = activeItemsRef.current;
    const allChoose = active.length > 0 && active.every((it) => !it.searchTerm);
    // Resolve parallel-vs-serial from the LIVE locked store, NOT the captured
    // `parallelCfg`. onMessage has []-deps and reaches here via a closure chain
    // that froze `parallelCfg` at an early render (before this store was locked),
    // so a serial store (forceSerialSearch) could wrongly run parallel. The ref
    // is always current (same source the worker pool's getUrl uses).
    const s = getStoreScripts(lockedStoreIdRef.current);
    const canParallel = !!(s && s.getSearchUrl && s.buildWorkerScript && !s.forceSerialSearch);
    console.log(`[Cart ${ts()}]`, 'beginSearchFlow: parallel=', canParallel, 'allChoose=', allChoose, 'activeLen=', active.length, 'store=', lockedStoreIdRef.current);
    if (canParallel && allChoose) {
      startParallelSearch();
    } else if (canParallel && !allChoose && FEATURE_PARALLEL_ADD) {
      // Regular add flow through the parallel pool: each worker searches AND
      // adds one product concurrently. Unconfirmed items fall to review.
      startParallelAdd();
    } else {
      navigateToSearchItem(0);
    }
  }, [startParallelSearch, startParallelAdd, navigateToSearchItem]);

  // Snapshot the cart BEFORE any adds, then start the search. For cart-page
  // stores (HEB, Albertsons family) navigate to the cart URL, count there, and
  // gate the search start on the before-count (with a timeout safety net). For
  // others read the header badge and start immediately. Called from both login
  // paths (LOGIN_STATUS for already-logged-in, LOGIN_COMPLETE for popup login).
  const snapshotBeforeAndBeginSearch = useCallback(() => {
    // Move off the (visible) login step into searching FIRST, so the webview is
    // hidden while the before-probe loads the cart page. Otherwise a fresh-login
    // store (Albertsons) would briefly show /erums/cart on screen mid-probe.
    setStep('searching');
    // Resolve the store from the ref: onMessage is created once (deps []) so the
    // lockedStoreId STATE it closes over is the pre-open value; the ref is current.
    const probeStoreId = lockedStoreIdRef.current;
    const cartPageScript = buildCartPageCountScript(probeStoreId);
    const cartPageUrl = getCartPageUrl(probeStoreId);     // HEB / Albertsons: direct URL
    const openCartScript = buildOpenCartScript(probeStoreId); // Amazon: click the cart icon
    const inlineCartScript = buildInlineCartScript(probeStoreId); // ALDI: in-page side panel
    console.log(`[Cart ${ts()}]`, 'snapshotBefore: storeId=', probeStoreId, 'cartUrl=', !!cartPageUrl, 'cartClick=', !!openCartScript, 'inlineCart=', !!inlineCartScript, 'activeLen=', activeItemsRef.current.length);
    if (inlineCartScript) {
      // Side-panel cart (ALDI): no navigation — inject the self-contained
      // open+count+close script directly, and gate the search start on the
      // before-count (the panel is closed before CART_COUNT posts, so the search
      // bar is clear). Reuse the cart-probe timeout as the safety net.
      cartCountPendingRef.current = 'before';
      cartProbeBeginSearchRef.current = true;
      if (cartProbeTimeoutRef.current) clearTimeout(cartProbeTimeoutRef.current);
      cartProbeTimeoutRef.current = setTimeout(() => {
        cartProbeTimeoutRef.current = null;
        if (!cartProbeBeginSearchRef.current) return;
        console.log(`[Cart ${ts()}]`, 'inline cart before-probe timed out — starting search without a baseline');
        cartProbeBeginSearchRef.current = false;
        cartCountPendingRef.current = null;
        beginSearchFlow();
      }, CART_PROBE_TIMEOUT_MS);
      webviewRef.current?.injectJavaScript(inlineCartScript);
      return;
    }
    if (cartPageScript && (cartPageUrl || openCartScript)) {
      cartCountPendingRef.current = 'before';
      cartProbeBeginSearchRef.current = true;
      loadQueueRef.current = [cartPageScript];
      lastLoadEndUrlRef.current = '';
      expectedNavUrlRef.current = '';
      if (cartProbeTimeoutRef.current) clearTimeout(cartProbeTimeoutRef.current);
      cartProbeTimeoutRef.current = setTimeout(() => {
        cartProbeTimeoutRef.current = null;
        if (!cartProbeBeginSearchRef.current) return; // before-count already resumed it
        console.log(`[Cart ${ts()}]`, 'cart before-probe timed out — starting search without a baseline');
        cartProbeBeginSearchRef.current = false;
        cartCountPendingRef.current = null;
        loadQueueRef.current = [];
        beginSearchFlow();
      }, CART_PROBE_TIMEOUT_MS);
      // URL stores navigate directly; click stores (Amazon) click the cart icon
      // on the current page, which navigates — onLoadEnd then pops the count script.
      if (cartPageUrl) setWebviewUri(cartPageUrl + '?_t=' + Date.now());
      else webviewRef.current?.injectJavaScript(openCartScript!);
    } else {
      const countScript = buildCartCountScript(probeStoreId);
      if (countScript) {
        cartCountPendingRef.current = 'before';
        webviewRef.current?.injectJavaScript(countScript);
      }
      beginSearchFlow();
    }
  }, [beginSearchFlow]);

  // ── WebView events ───────────────────────────────────────────────────────

  // Store scripts in a ref so callbacks always see the latest value without needing deps.
  const scriptsRef = useRef(scripts);
  scriptsRef.current = scripts;

  const onLoadEnd = useCallback((e: any) => {
    const url = e?.nativeEvent?.url ?? '';
    const s = scriptsRef.current;
    // Only process pages for this store — ignore about:blank and other internal loads.
    if (!s || !url.includes(s.domain)) {
      console.log(`[Cart ${ts()}]`, 'onLoadEnd url=', url, 'skipped: not store domain');
      return;
    }
    // Walmart anti-bot redirect: /blocked?url=<encoded original>. We surface
    // this to the user as a 'robot_challenge' step so they can complete the
    // press-and-hold verification. Once they're past it the page navigates
    // back away from /blocked, and we resume the current search idx.
    const onBlockedPage = /\/blocked(\?|$)/.test(url);
    console.log(`[Cart ${ts()}]`, 'onLoadEnd url=', url,
      'queue=', loadQueueRef.current.length,
      'step=', stepRef.current,
      'onBlockedPage=', onBlockedPage);
    if (onBlockedPage && stepRef.current !== 'robot_challenge') {
      console.log(`[Cart ${ts()}]`, 'onLoadEnd detected anti-bot block — showing webview for user');
      if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }
      if (addTimeoutRef.current) { clearTimeout(addTimeoutRef.current); addTimeoutRef.current = null; }
      if (loginCheckTimeoutRef.current) { clearTimeout(loginCheckTimeoutRef.current); loginCheckTimeoutRef.current = null; }
      loadQueueRef.current = [];
      expectedNavUrlRef.current = '';
      lastLoadEndUrlRef.current = url;
      robotChallengeResumeIdxRef.current = searchIdxRef.current;
      setStep('robot_challenge');
      return;
    }
    // Already in the challenge: if URL is back to a normal walmart page,
    // resume from the saved idx.
    if (stepRef.current === 'robot_challenge') {
      // HTTP-block (403/429/503) has no URL marker and nothing to solve —
      // re-navigating just re-blocks (the tight 403 loop). Stay put until the
      // user taps "Try again".
      if (blockReasonRef.current) return;
      if (!onBlockedPage) {
        const resumeIdx = robotChallengeResumeIdxRef.current >= 0 ? robotChallengeResumeIdxRef.current : 0;
        robotChallengeResumeIdxRef.current = -1;
        console.log(`[Cart ${ts()}]`, 'onLoadEnd robot challenge cleared — resuming at idx', resumeIdx);
        setStep('searching');
        lastLoadEndUrlRef.current = '';
        navigateToSearchItem(resumeIdx);
      }
      return;
    }
    // Immediate logged-out detection. During the login check, a logged-in
    // profile click stays on the store; navigating to the store's login/auth
    // page instead means the user is signed out. Show the login webview now
    // rather than waiting out the login-check timeout. Must run BEFORE the
    // auth-redirect skip below, since some stores' login form lives behind an
    // /authorize URL (HEB → accounts.heb.com) that the skip would swallow.
    if (stepRef.current === 'login_check') {
      const onLoginPage = s.isLoginPageUrl
        ? s.isLoginPageUrl(url)
        : /\/login|\/sign-in|\/signin/i.test(url);
      if (onLoginPage) {
        console.log(`[Cart ${ts()}]`, 'onLoadEnd login page during login_check — showing login immediately');
        if (loginCheckTimeoutRef.current) { clearTimeout(loginCheckTimeoutRef.current); loginCheckTimeoutRef.current = null; }
        loginCheckActiveRef.current = false;
        loadQueueRef.current = [];
        expectedNavUrlRef.current = '';
        setStep('login');
        lastLoadEndUrlRef.current = '';
        return;
      }
    }
    // Skip intermediate auth/SSO redirect pages — scripts injected here get killed
    // when the page redirects to the final destination.
    if (/\/sso\/|\/authorize[?/]|\/oidc\/|\/oauth[?/]|\/callback[?/]|\/authcallback\/|\/secur\/|\/frontdoor|\/RemoteAccessAuth|\/CIAM_/.test(url)) {
      console.log(`[Cart ${ts()}]`, 'onLoadEnd skipping auth redirect page');
      // Clear dedup so the next page load (post-login destination) triggers re-injection.
      lastLoadEndUrlRef.current = '';
      return;
    }
    // If a store's buildSearchScript declared a NAV_INTENT, only the matching
    // URL is allowed to consume the queue. Late onLoadEnd events for the
    // PREVIOUS page (which react-native-webview sometimes fires after we've
    // already triggered window.location.href = …) get dropped.
    //
    // Compare URLs after decoding because the WebView may percent-encode
    // characters that encodeURIComponent leaves alone (apostrophe → %27,
    // parens, *, !, ~). Without this, search terms like "Ben's Original"
    // never match and the spinner hangs forever.
    if (expectedNavUrlRef.current) {
      const norm = (u: string) => { try { return decodeURIComponent(u); } catch { return u; } };
      if (norm(url) !== norm(expectedNavUrlRef.current)) {
        console.log(`[Cart ${ts()}]`, 'onLoadEnd ignored — does not match NAV_INTENT', expectedNavUrlRef.current);
        return;
      }
      expectedNavUrlRef.current = '';
      lastLoadEndUrlRef.current = url;
    } else {
      // Deduplicate: react-native-webview fires onLoadEnd multiple times per navigation.
      // Skip dedup during login + login_check — pages with SSO/MSAL bootstraps
      // (e.g. Wegmans) bounce the URL multiple times during init, and we need
      // every onLoadEnd to be a chance to re-inject the check script even if
      // the URL matches a recently-seen one. Per-store check scripts use a
      // gate (sessionStorage / window.__loginPosted) to avoid double-posting.
      //
      // Also: during `searching` if we have an inflight script (a script we
      // just injected but haven't received its result for yet), a same-URL
      // onLoadEnd means the page reloaded mid-script (e.g. SSO bootstrap on
      // first navigation). Re-inject so the work can complete on the freshly-
      // loaded page. The store's script uses a window-level guard to no-op
      // duplicate runs within the same JS context.
      const sameUrl = url === lastLoadEndUrlRef.current;
      // SPA-search stores (ALDI/Instacart) fire onLoadEnd multiple times for ONE
      // pushState route change WITHOUT reloading — the injected script is still
      // running. Re-injecting there would spawn a second concurrent run of
      // buildSearchAndAddScript, posting a duplicate result that over-advances
      // searchIdxRef and skips items. Only re-inject for stores whose same-URL
      // onLoadEnd really is a script-killing reload (e.g. Wegmans SSO bootstrap).
      const reinjectInflight = !s.spaSearch;
      const allowRecheck =
        stepRef.current === 'login' ||
        stepRef.current === 'login_check' ||
        // A cart-count probe is in flight: HEB re-renders the cart page (same
        // URL) a beat after load, which kills the injected count script before
        // it polls/posts. Let same-URL reloads through so the re-inject branch
        // below can re-run it until CART_COUNT actually comes back.
        !!cartCountPendingRef.current ||
        (stepRef.current === 'searching' && !!inflightScriptRef.current && reinjectInflight);
      if (sameUrl && !allowRecheck) {
        if (sameUrl && stepRef.current === 'searching' && inflightScriptRef.current && !reinjectInflight) {
          console.log(`[Cart ${ts()}]`, 'onLoadEnd same-URL during searching — SPA store, NOT re-injecting (script still running)');
        }
        return;
      }
      lastLoadEndUrlRef.current = url;
      if (sameUrl && stepRef.current === 'searching' && inflightScriptRef.current && reinjectInflight) {
        console.log(`[Cart ${ts()}]`, 'onLoadEnd same-URL during searching — re-injecting inflight script');
        webviewRef.current?.injectJavaScript(inflightScriptRef.current);
        return;
      }
    }
    // Track whether we're on a search results page so subsequent items skip homepage reload.
    onSearchPageRef.current = s.isSearchUrl(url);
    if (loadQueueRef.current.length > 0) {
      const script = loadQueueRef.current.shift()!;
      const label = script.slice(0, 60).replace(/\n/g, ' ');
      console.log(`[Cart ${ts()}]`, 'onLoadEnd injecting script:', label);
      inflightScriptRef.current = script;
      webviewRef.current?.injectJavaScript(script);
    } else if (stepRef.current === 'login_check' && s.checkLoginScript) {
      // Queue was consumed by a redirect (e.g. /fresh → /alm/storefront).
      // Re-inject the login check on the final page.
      console.log(`[Cart ${ts()}]`, 'onLoadEnd login_check step — re-injecting after redirect');
      webviewRef.current?.injectJavaScript(s.checkLoginScript);
    } else if ((stepRef.current === 'login_check' || stepRef.current === 'login') &&
               /\/login|\/sign-in|\/signin/i.test(url)) {
      // Login check clicked a profile icon and HEB navigated to a login page,
      // or we landed on a login page during the login step. Show the webview
      // so the user can log in.
      console.log(`[Cart ${ts()}]`, 'onLoadEnd detected login page — showing webview');
      if (stepRef.current !== 'login') {
        setStep('login');
        lastLoadEndUrlRef.current = '';
      }
    } else if (stepRef.current === 'login' && s.checkLoginScript) {
      // Re-inject login check after login completes and the user lands back on
      // the store. By here, /login & /sign-in URLs were already handled above, so
      // this fires on the post-login store page. During multi-step logins (Amazon
      // email → password → MFA), re-injection could disrupt the flow, so it's
      // gated to isLoginSuccessUrl or stores that opt in via reinjectLoginCheckOnNav
      // (poll-based logins whose detection dies on the post-sign-in reload).
      if ((s.isLoginSuccessUrl && s.isLoginSuccessUrl(url)) || s.reinjectLoginCheckOnNav) {
        console.log(`[Cart ${ts()}]`, 'onLoadEnd login step — back on store, re-injecting login check');
        webviewRef.current?.injectJavaScript(s.checkLoginScript);
      } else {
        console.log(`[Cart ${ts()}]`, 'onLoadEnd login step — not on store yet, skipping re-inject');
      }
    } else if (cartCountPendingRef.current) {
      // A cart probe is mid-flight and the queue is already drained — this load
      // is a navigation the count script itself triggered (Amazon: cart icon →
      // cart-of-carts → Fresh expand link). Re-inject the count script so it
      // runs on the freshly-loaded page (the expanded Fresh cart).
      const cartPageScript = buildCartPageCountScript(lockedStoreIdRef.current);
      if (cartPageScript) {
        console.log(`[Cart ${ts()}]`, 'onLoadEnd cart probe navigated — re-injecting count script');
        webviewRef.current?.injectJavaScript(cartPageScript);
      } else {
        console.log(`[Cart ${ts()}]`, 'onLoadEnd queue empty, no inject');
      }
    } else {
      console.log(`[Cart ${ts()}]`, 'onLoadEnd queue empty, no inject');
    }
  }, []);

  const onNavigationStateChange = useCallback(
    (_navState: WebViewNavigation) => {
      // Login success is detected exclusively via LOGIN_STATUS messages from the
      // injected check script — never from URL changes. Multi-step logins (e.g.
      // Amazon email → password → MFA) bounce through intermediate URLs that
      // can look like "success" but aren't.
    },
    [],
  );

  // Anti-bot block (HTTP 403/429/503): tear down the in-flight run and surface
  // the store page so the user can complete any challenge, then retry. Reuses
  // the robot_challenge step (webview visible + banner), with blockReason set so
  // the banner/title swap to the "blocked" copy and a manual retry is offered.
  const handleHttpBlock = useCallback((statusCode: number, url: string) => {
    if (!ANTI_BOT_STATUSES.includes(statusCode)) return;
    const s = scriptsRef.current;
    if (!s || !isLikelyPageUrl(url, s.domain)) return;
    const st = stepRef.current;
    // Only meaningful while we're driving the store; ignore once the user is in
    // the review/done UI or already looking at a challenge.
    if (st === 'qty' || st === 'review' || st === 'searchResult' || st === 'done' || st === 'robot_challenge') return;
    console.log(`[Cart ${ts()}]`, `HTTP ${statusCode} block on`, url, '— surfacing challenge');
    if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }
    if (addTimeoutRef.current) { clearTimeout(addTimeoutRef.current); addTimeoutRef.current = null; }
    if (loginCheckTimeoutRef.current) { clearTimeout(loginCheckTimeoutRef.current); loginCheckTimeoutRef.current = null; }
    loadQueueRef.current = [];
    expectedNavUrlRef.current = '';
    parallelPool.reset(); addPool.reset();
    robotChallengeResumeIdxRef.current = searchIdxRef.current;
    blockReasonRef.current = 'http-' + statusCode;
    setBlockReason('http-' + statusCode);
    setStep('robot_challenge');
  }, [parallelPool, setStep]);

  const onHttpError = useCallback((e: any) => {
    const code = e?.nativeEvent?.statusCode;
    const url = e?.nativeEvent?.url ?? '';
    if (typeof code === 'number') handleHttpBlock(code, url);
  }, [handleHttpBlock]);

  // Manual retry from the blocked state: re-run the login check from a fresh
  // store load. If the block cleared (or the user solved a challenge) it
  // proceeds; if not, the 403 fires again and we land back here.
  const retryAfterBlock = useCallback(() => {
    setBlockReason(null);
    blockReasonRef.current = null;
    robotChallengeResumeIdxRef.current = -1;
    parallelPool.reset(); addPool.reset();
    searchIdxRef.current = 0;
    onSearchPageRef.current = false;
    loadQueueRef.current = [scriptsRef.current!.checkLoginScript];
    lastLoadEndUrlRef.current = '';
    expectedNavUrlRef.current = '';
    setStep('login_check');
    setSearchingLabel('Checking login…');
    navTo(scriptsRef.current!.storeUrl);
    armLoginCheckTimeout();
  }, [parallelPool, setStep, armLoginCheckTimeout]);

  // Manual "I'm already logged in" recovery from the login step. If detection
  // timed out or posted logged-out on a slow load but the user is in fact
  // signed in, one tap re-runs the check from a fresh store load and, if logged
  // in, proceeds without the user re-entering anything. Universal safety net so
  // a genuinely-logged-in user is never stranded on the login prompt.
  const recheckLogin = useCallback(() => {
    searchIdxRef.current = 0;
    onSearchPageRef.current = false;
    loadQueueRef.current = [scriptsRef.current!.checkLoginScript];
    lastLoadEndUrlRef.current = '';
    expectedNavUrlRef.current = '';
    setStep('login_check');
    setSearchingLabel('Checking login…');
    navTo(scriptsRef.current!.storeUrl);
    armLoginCheckTimeout();
  }, [setStep, armLoginCheckTimeout]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data);
        console.log(`[Cart ${ts()}]`, 'onMessage type=', msg.type, msg);

        // A store's buildSearchScript is about to do window.location.href = target.
        // Record the target so onLoadEnd can ignore late/stale events for the
        // previous URL.
        if (msg.type === 'NAV_INTENT') {
          expectedNavUrlRef.current = msg.target || '';
          return;
        }

        // For SPA-style search (no full reload → no onLoadEnd), buildSearchScript
        // signals when the new search results are rendered. We pop the next
        // queued script (extract / search+add) and inject it directly. If
        // onLoadEnd ALSO fires later, the queue is already empty so nothing
        // is injected twice.
        if (msg.type === 'EXTRACT_NOW') {
          if (loadQueueRef.current.length > 0) {
            const next = loadQueueRef.current.shift()!;
            expectedNavUrlRef.current = '';
            console.log(`[Cart ${ts()}]`, 'EXTRACT_NOW — injecting queued script');
            webviewRef.current?.injectJavaScript(next);
          } else {
            console.log(`[Cart ${ts()}]`, 'EXTRACT_NOW — queue empty (onLoadEnd already consumed it)');
          }
          return;
        }

        if (msg.type === 'LOGIN_STATUS') {
          loginCheckActiveRef.current = false;
          if (loginCheckTimeoutRef.current) { clearTimeout(loginCheckTimeoutRef.current); loginCheckTimeoutRef.current = null; }
          if (msg.isLoggedIn) {
            setBrowserShown(false);
            console.log(`[Cart ${ts()}]`, 'LOGIN_STATUS true: storeId=', lockedStoreIdRef.current, 'parallel=', !!parallelCfg, 'activeLen=', activeItemsRef.current.length);
            snapshotBeforeAndBeginSearch();
          } else if (stepRef.current !== 'login') {
            // First transition to login — show the webview for the user to log in.
            // Only navigate if the webview isn't already on the store's domain.
            // For stores where the check script already opened a sign-in UI
            // (e.g. hamburger menu), navigating away would lose that state.
            const alreadyOnStore = lastLoadEndUrlRef.current &&
              lastLoadEndUrlRef.current.includes(scriptsRef.current!.domain);
            setStep('login');
            lastLoadEndUrlRef.current = '';
            if (!alreadyOnStore) {
              setWebviewUri(scriptsRef.current!.loginUrl);
            }
          }
          // If already on login step and got false again (e.g. re-injection on
          // login page), do nothing — user is still logging in.
          return;
        }

        if (msg.type === 'CART_COUNT') {
          const phase = cartCountPendingRef.current;
          cartCountPendingRef.current = null;
          if (cartProbeResultTimeoutRef.current) { clearTimeout(cartProbeResultTimeoutRef.current); cartProbeResultTimeoutRef.current = null; }
          const count = typeof msg.count === 'number' ? msg.count : null;
          console.log(`[Cart ${ts()}]`, 'CART_COUNT phase=', phase, 'count=', count);
          if (phase === 'before') {
            cartCountBeforeRef.current = count;
            cartItemsBeforeRef.current = Array.isArray(msg.items) ? msg.items : [];
            // Cache the cart URL the before-probe counted on (click-path stores
            // only — URL stores already have a direct getCartPageUrl). The
            // after-probe hits it directly instead of re-walking the click chain.
            if (typeof msg.url === 'string' && msg.url && !getCartPageUrl(lockedStoreIdRef.current)) {
              capturedCartUrlRef.current = msg.url;
            }
            // Cart-page probe: the before-count was gated in front of the search,
            // so kick off the search now (once).
            if (cartProbeBeginSearchRef.current) {
              cartProbeBeginSearchRef.current = false;
              if (cartProbeTimeoutRef.current) { clearTimeout(cartProbeTimeoutRef.current); cartProbeTimeoutRef.current = null; }
              beginSearchFlow();
            }
          } else if (phase === 'reconcile') {
            // Parallel-add reconciliation: trust the CART, not the workers. Any
            // item reported-added that isn't actually in the cart (shared-counter
            // false positive), plus any that failed, gets re-added SEQUENTIALLY
            // (single-threaded → no race).
            parallelReconcileArmedRef.current = false;
            let rows: CartRow[] | null = null;
            if (Array.isArray(msg.items)) {
              if (cartRowsTimeoutRef.current) { clearTimeout(cartRowsTimeoutRef.current); cartRowsTimeoutRef.current = null; }
              rows = diffCartItems(cartItemsBeforeRef.current, msg.items);
            }
            const reconResults = parallelResultByIdxRef.current;
            const active = activeItemsRef.current;
            if (!rows) {
              // Can't diff per-item (header-badge store) → trust the worker
              // results. Parallel add is HEB-only today (a per-item cart store),
              // so this is just a safety fallback.
              const wins = active
                .map((item, idx) => { const r = reconResults.get(idx); return r && r.success ? { name: r.productName || item.searchTerm || item.ingredientName, success: true } : null; })
                .filter((x): x is { name: string; success: boolean } => x !== null);
              addResultsRef.current = wins;
              setTotalAdded(wins.length);
              setTotalFailed(active.length - wins.length);
              setAddedNames(wins.map((x) => x.name));
              reconcileFinalizedRef.current = true;
              setStep('done');
              return;
            }
            // Qty-aware reconcile: compare each item's EXPECTED quantity against
            // the quantity that actually landed in the cart (sum of matching added
            // rows). A product present but short (added ×1 when ×2 was wanted)
            // gets topped up by the shortfall — not just fully-missing items.
            const addedRows = rows.filter((r) => r.added);
            const retryItems: ConsolidatedIngredient[] = [];
            const confirmed: { name: string; success: boolean }[] = [];
            const reviewFailures: SearchResult[] = [];

            // Attribute each added cart unit to a SINGLE item. Summing every
            // name-matching row per item double-counts when two distinct products
            // have near-identical names (e.g. "…Dried Chile Ancho Peppers, 4 oz"
            // vs "…Guajillo Peppers, 4 oz"): each pepper's name matches both rows,
            // so a 1-of-2 shortfall looks fully stocked. Instead, consume from a
            // shared pool — reserve exact-name matches first, then let a loose
            // match take only what's genuinely left over.
            const pool = addedRows.map((row) => ({ name: row.name, qty: row.qty }));
            const norm = (s: string) => (s || '').trim().toLowerCase();
            const claimQty = (reportedName: string, need: number, exactOnly: boolean): number => {
              let got = 0;
              for (const row of pool) {
                if (got >= need) break;
                if (row.qty <= 0) continue;
                const match = exactOnly ? norm(row.name) === norm(reportedName) : cartNameMatches(row.name, reportedName);
                if (match) { const take = Math.min(row.qty, need - got); row.qty -= take; got += take; }
              }
              return got;
            };

            // Resolve each item's identity up front, routing definitive failures
            // out so they don't consume pool units. An out-of-stock / no-results
            // item is genuinely not in the cart, so it must NOT be qty-matched
            // (productName is null; the search term loosely collides with a
            // sibling's row) nor blindly retried — route it to review so the user
            // can pick an alternative or skip, like the serial add path.
            const toMatch: { item: ConsolidatedIngredient; reportedName: string; expectedQty: number; claimed: number; confirmedWeight?: boolean }[] = [];
            active.forEach((item, idx) => {
              const r = reconResults.get(idx);
              if (r && !r.success && (r.reason === 'out_of_stock' || r.reason === 'no_results')) {
                reviewFailures.push({
                  term: item.searchTerm || item.ingredientName,
                  candidates: r.candidates ?? [],
                  mealIngredients: item.mealIngredients,
                  unit: item.unit,
                  measure: item.measure,
                  reason: r.reason,
                  isChoose: false,
                });
                return;
              }
              toMatch.push({
                item,
                reportedName: (r && r.productName) || item.searchTerm || item.ingredientName,
                expectedQty: Math.max(1, item.productQty || 1),
                claimed: 0,
              });
            });
            // Weight items first, confirmed by PRESENCE. A sold-by-weight line is
            // a single cart row at N lb regardless of the chosen poundage, so it
            // can't be count-compared (qty 3 lb ≠ 3 units). If a weight row matches
            // by name, it's confirmed; consume it from the pool so a sibling can't
            // claim it. (rows already tag weight lines via the cart snapshot.)
            const weightPool = addedRows.filter((r) => r.isWeight).map((r) => ({ name: r.name, used: false }));
            toMatch.forEach((m) => {
              if (m.confirmedWeight) return;
              const w = weightPool.find((p) => !p.used && cartNameMatches(p.name, m.reportedName));
              if (w) { w.used = true; m.confirmedWeight = true; }
            });
            // Pass 1: every item reserves its exact-name units. Pass 2: items still
            // short take loose matches from whatever remains unclaimed.
            toMatch.forEach((m) => { if (!m.confirmedWeight) m.claimed = claimQty(m.reportedName, m.expectedQty, true); });
            toMatch.forEach((m) => { if (!m.confirmedWeight && m.claimed < m.expectedQty) m.claimed += claimQty(m.reportedName, m.expectedQty - m.claimed, false); });
            toMatch.forEach((m) => {
              if (m.confirmedWeight) { confirmed.push({ name: m.reportedName, success: true }); return; }
              const shortfall = m.expectedQty - m.claimed;
              if (shortfall <= 0) {
                confirmed.push({ name: m.reportedName, success: true });
              } else {
                // Re-add only the missing units; re-adding the full qty would
                // over-add the units that already landed.
                retryItems.push({ ...m.item, productQty: shortfall });
              }
            });
            console.log(`[Cart ${ts()}]`, 'reconcile: confirmed=', confirmed.length, 'retry=', retryItems.length, retryItems.map((i) => i.searchTerm), 'review=', reviewFailures.length, reviewFailures.map((r) => `${r.term}:${r.reason}`));
            // Surface definitive failures (out of stock / no results) in the
            // review queue. When there are also qty top-ups, the sequential retry
            // below finishes into the review step because searchResults is now
            // non-empty; otherwise we route there directly after this block.
            if (reviewFailures.length > 0) {
              searchResultsRef.current = [...searchResultsRef.current, ...reviewFailures];
              setSearchResults(searchResultsRef.current);
            }
            if (retryItems.length > 0) {
              addResultsRef.current = confirmed;
              activeItemsRef.current = retryItems;
              searchIdxRef.current = 0;
              onSearchPageRef.current = false;
              // Forward-only progress: continue from the CONFIRMED count over the
              // original total, so the ring resumes instead of restarting at 0.
              reconcileBaseRef.current = confirmed.length;
              setProcessedCount(0);
              setSearchingLabel(`Topping up ${retryItems.length} item${retryItems.length === 1 ? '' : 's'} we couldn't confirm…`);
              setStep('searching');
              navigateToSearchItem(0);
              return;
            }
            // No qty top-ups. If workers flagged definitive failures (OOS / no
            // results), show the "Items Not Added" review summary so the user can
            // resolve them, rather than silently finishing.
            addResultsRef.current = confirmed;
            setCartResultRows(rows);
            setTotalAdded(confirmed.length);
            setAddedNames(confirmed.map((x) => x.name));
            setCartDeltaWarning(null);
            if (reviewFailures.length > 0) {
              setTotalFailed(reviewFailures.length);
              reconcileFinalizedRef.current = true;
              setReviewIdx(0);
              setStep('searchResult');
              return;
            }
            // Everything confirmed — finalize using THIS probe's data, no second
            // snapshot (reconcileFinalizedRef makes the 'done' effect skip its probe).
            setTotalFailed(0);
            reconcileFinalizedRef.current = true;
            setStep('done');
            return;
          } else if (phase === 'after') {
            const before = cartCountBeforeRef.current;
            const expected = addResultsRef.current.filter((r) => r.success).length;
            // Name the warning after the LOCKED store (source of truth), so the
            // text can't drift from the brand the cart actually ran on.
            const lockedName = STORES.find((s) => s.id === lockedStoreIdRef.current)?.name ?? storeName;
            // Per-line breakdown for the done screen (cart-page stores only):
            // added qty in green, pre-existing qty in grey.
            let rows: CartRow[] | null = null;
            if (Array.isArray(msg.items)) {
              if (cartRowsTimeoutRef.current) { clearTimeout(cartRowsTimeoutRef.current); cartRowsTimeoutRef.current = null; }
              rows = diffCartItems(cartItemsBeforeRef.current, msg.items);
              setCartResultRows(rows);
            }
            // When we have per-item cart data, audit each product Mealio reported
            // as added against what actually landed in the cart:
            //   • absent entirely   → silent miss (name present in report, no cart row)
            //   • present but short  → fewer units than requested (e.g. a store
            //                          per-item cap accepted 2 of 3). The serial
            //                          path used to only check presence, so a short
            //                          add slipped through silently — this is the
            //                          qty check the parallel reconcile branch has.
            let missing: string[] = [];
            let shortAdds: string[] = [];
            if (rows) {
              const active = activeItemsRef.current;
              const reportedAdded = addResultsRef.current.filter((r) => r.success).map((r) => r.name);
              const addedRows = rows.filter((r) => r.added);
              missing = findUnaddedItems(reportedAdded, addedRows.map((r) => r.name));
              // Only audit items we reported as added (failures already route to
              // review), skip sold-by-weight lines (one row at N lb, not count-
              // comparable), and skip fully-missing items (covered by `missing`).
              const auditItems = active
                .map((item) => ({
                  name: item.searchTerm || item.ingredientName,
                  expectedQty: Math.max(1, item.productQty || 1),
                  isWeight: item.purchaseWeight != null,
                }))
                .filter((a) =>
                  !a.isWeight
                  && reportedAdded.some((n) => cartNameMatches(a.name, n))
                  && !missing.some((n) => cartNameMatches(a.name, n)),
                );
              shortAdds = findShortAddedItems(addedRows, auditItems).map((s) => `${s.name} (${s.got} of ${s.expected})`);
            }
            if (missing.length > 0 || shortAdds.length > 0) {
              const parts: string[] = [];
              if (missing.length > 0) {
                parts.push(`${missing.length} item${missing.length === 1 ? '' : 's'} may not have been added (${missing.join(', ')})`);
              }
              if (shortAdds.length > 0) {
                parts.push(`${shortAdds.length} item${shortAdds.length === 1 ? '' : 's'} added below the requested quantity, which a store limit can cause (${shortAdds.join(', ')})`);
              }
              setCartDeltaWarning(`Cart check on your ${lockedName} cart: ${parts.join('; ')}. Please double-check your cart.`);
            } else if (before != null && count != null && expected > 0 && count - before < expected) {
              // No per-item data (header-badge stores) or names didn't resolve —
              // fall back to the count-shortfall message.
              const delta = Math.max(count - before, 0);
              setCartDeltaWarning(
                `Cart check: ${lockedName} shows ${delta} new item${delta === 1 ? '' : 's'} in the cart, but ${expected} ${expected === 1 ? 'was' : 'were'} reported added. Please double-check your cart.`
              );
            }
          }
          return;
        }

        // Popup-based login (e.g. Albertsons): background poll detected login success.
        if (msg.type === 'LOGIN_COMPLETE') {
          loginCheckActiveRef.current = false;
          if (loginCheckTimeoutRef.current) { clearTimeout(loginCheckTimeoutRef.current); loginCheckTimeoutRef.current = null; }
          setBrowserShown(false);
          // Same before-snapshot + search start as the LOGIN_STATUS path, so the
          // cart-page probe runs for popup-login stores (Albertsons) too.
          snapshotBeforeAndBeginSearch();
          return;
        }

        if (msg.type === 'PRICE_DEBUG') {
          console.log(`[Cart ${ts()}]`, 'PRICE_DEBUG priceElFound=', msg.dbg?.priceElFound);
          console.log(`[Cart ${ts()}]`, 'PRICE_DEBUG priceElHtml=', msg.dbg?.priceElHtml);
          console.log(`[Cart ${ts()}]`, 'PRICE_DEBUG cardHtml=', msg.dbg?.cardHtml);
          console.log(`[Cart ${ts()}]`, 'PRICE_DEBUG addBtnFound=', msg.dbg?.addBtnFound, 'ariaHasPopup=', msg.dbg?.ariaHasPopup, 'hasPopup=', msg.dbg?.hasPopup, 'outOfStock=', msg.dbg?.outOfStock);
          console.log(`[Cart ${ts()}]`, 'PRICE_DEBUG addBtnHtml=', msg.dbg?.addBtnHtml);
          return;
        }

        if (msg.type === 'PREF_DEBUG') {
          console.log(`[Cart ${ts()}]`, 'PREF_DEBUG', JSON.stringify(msg));
          return;
        }

        if (msg.type === 'ADD_DEBUG') {
          console.log(`[Cart ${ts()}]`, 'ADD_DEBUG', JSON.stringify(msg));
          return;
        }

        if (msg.type === 'SEARCH_AND_ADD_RESULT') {
          if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
            searchTimeoutRef.current = null;
          }
          inflightScriptRef.current = null;
          const idx = searchIdxRef.current;
          const active = activeItemsRef.current;
          const item = active[idx];
          console.log(`[Cart ${ts()}]`, 'SEARCH_AND_ADD_RESULT idx=', idx, 'success=', msg.success, 'productName=', msg.productName);
          const nextIdx = idx + 1;
          searchIdxRef.current = nextIdx;
          if (item) {
            if (msg.success) {
              addResultsRef.current.push({ name: msg.productName || item.searchTerm!, success: true });
            } else if (msg.reason === 'needs_weight') {
              // Sold-by-weight item, no remembered weight: the combined add bailed
              // with the weight options. Route it straight to the review picker
              // (the candidate already carries weightOptions, so no extract enrich)
              // — the weight stepper lets the user choose, then it's remembered.
              const newResult: SearchResult = {
                term: item.searchTerm!,
                candidates: msg.candidates ?? [],
                mealIngredients: item.mealIngredients,
                unit: item.unit,
                measure: item.measure,
                reason: 'needs_weight',
                isChoose: false,
              };
              searchResultsRef.current = [...searchResultsRef.current, newResult];
              setSearchResults(searchResultsRef.current);
              setTimeout(() => navigateToSearchItem(nextIdx), 400);
              return;
            } else {
              const newResult: SearchResult = {
                term: item.searchTerm!,
                candidates: msg.candidates ?? [],
                mealIngredients: item.mealIngredients,
                unit: item.unit,
                measure: item.measure,
                reason: msg.reason ?? 'no_results',
                isChoose: false,
              };
              searchResultsRef.current = [...searchResultsRef.current, newResult];
              setSearchResults(searchResultsRef.current);
              // Inject EXTRACT_PRODUCTS_SCRIPT to enrich candidates with preference data.
              // Navigation resumes when the resulting SEARCH_RESULT is received.
              prefFetchResultIdxRef.current = searchResultsRef.current.length - 1;
              pendingNavIdxRef.current = nextIdx;
              webviewRef.current?.injectJavaScript(scriptsRef.current!.extractProductsScript);
              return;
            }
          }
          // Buffer before navigating to the next ingredient — gives Wegmans's
          // cart API enough time to fully commit this item before the page
          // reloads. Without this, the page navigation can race-cancel the
          // in-flight POST cart request, visually reverting qty to 0.
          setTimeout(() => navigateToSearchItem(nextIdx), 400);
          return;
        }

        if (msg.type === 'SEARCH_RESULT') {
          if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
            searchTimeoutRef.current = null;
          }
          inflightScriptRef.current = null;
          // Preference-fetch pass: enrich a failed SEARCH_AND_ADD_RESULT's candidates with
          // preference data from extractProductsScript, then resume navigation.
          if (prefFetchResultIdxRef.current >= 0) {
            const targetIdx = prefFetchResultIdxRef.current;
            const nextNavIdx = pendingNavIdxRef.current;
            prefFetchResultIdxRef.current = -1;
            pendingNavIdxRef.current = -1;
            const newCandidates: Candidate[] = msg.candidates ?? [];
            if (newCandidates.length > 0) {
              const updated = searchResultsRef.current.map((r, i) =>
                i === targetIdx ? { ...r, candidates: newCandidates } : r,
              );
              searchResultsRef.current = updated;
              setSearchResults(updated);
            }
            navigateToSearchItem(nextNavIdx);
            return;
          }

          // Custom search during review — update suggestions without advancing the queue.
          if (isCustomSearchRef.current) {
            isCustomSearchRef.current = false;
            if (customSearchTimeoutRef.current) { clearTimeout(customSearchTimeoutRef.current); customSearchTimeoutRef.current = null; }
            setCustomSuggestions(msg.candidates ?? []);
            setCustomSearching(false);
            setSelectedSuggIdx(0);
            setCustomText('');
            return;
          }

          console.log(`[Cart ${ts()}]`, 'SEARCH_RESULT candidates:', (msg.candidates ?? []).map((c: any) => ({ name: c.productName, price: c.price })));
          const active = activeItemsRef.current;
          const idx = searchIdxRef.current;
          const item = active[idx];
          if (item) {
            const candidates: Candidate[] = msg.candidates ?? [];
            const isChooseFlow = !item.searchTerm; // no searchTerm set yet = choose-product flow
            const scoreTarget = item.searchTerm ?? item.ingredientName;

            if (!isChooseFlow) {
              // Add-to-cart flow: auto-pick if exact in-stock match, else queue for review.
              const scored = candidates.map(c => ({ c, score: scoreMatch(scoreTarget, c.productName) }));
              const bestInStock = scored.filter(({ score, c }) => score === 100 && !c.outOfStock)[0];
              const bestExactOos = !bestInStock && scored.find(({ score, c }) => score === 100 && c.outOfStock);

              if (bestInStock) {
                console.log(`[Cart ${ts()}]`, 'SEARCH_RESULT auto-pick:', scoreTarget, '→', bestInStock.c.productName);
                autoPickedItemsRef.current.push({
                  searchTerm: scoreTarget,
                  productName: bestInStock.c.productName,
                  preference: null,
                  qty: item.productQty,
                });
              } else {
                const reason: SearchResult['reason'] = bestExactOos
                  ? 'out_of_stock'
                  : candidates.length === 0
                  ? 'no_results'
                  : 'low_confidence';
                const newResult: SearchResult = {
                  term: scoreTarget,
                  candidates,
                  mealIngredients: item.mealIngredients,
                  unit: item.unit,
                  measure: item.measure,
                  reason,
                  isChoose: false,
                };
                searchResultsRef.current = [...searchResultsRef.current, newResult];
                setSearchResults(searchResultsRef.current);
              }
            } else {
              // Choose-product flow: always show candidates to user, never auto-pick.
              const newResult: SearchResult = {
                term: scoreTarget,
                candidates,
                mealIngredients: item.mealIngredients,
                unit: item.unit,
                measure: item.measure,
                reason: candidates.length === 0 ? 'no_results' : 'low_confidence',
                isChoose: true,
              };
              searchResultsRef.current = [...searchResultsRef.current, newResult];
              setSearchResults(searchResultsRef.current);
            }
          }
          const nextIdx = idx + 1;
          searchIdxRef.current = nextIdx;
          navigateToSearchItem(nextIdx);
          return;
        }

        if (msg.type === 'ADD_RESULT') {
          if (addTimeoutRef.current) {
            clearTimeout(addTimeoutRef.current);
            addTimeoutRef.current = null;
          }
          const idx = addingIdxRef.current;
          const itemsToAdd = addingItemsRef.current;
          const item = itemsToAdd[idx];
          console.log(`[Cart ${ts()}]`, 'ADD_RESULT idx=', idx, 'success=', msg.success, 'product=', item?.productName, 'reason=', msg.reason ?? null);
          if (item) {
            addResultsRef.current.push({ name: item.productName, success: msg.success });
          }
          const nextIdx = idx + 1;
          addingIdxRef.current = nextIdx;
          // Buffer before advancing — same as the SEARCH_AND_ADD_RESULT path —
          // so the add's in-flight cart POST commits before the next navigation
          // (for the last item, the jump to the cart page for the snapshot)
          // race-cancels it. Without this, the review-flow click fired but the
          // request never reached HEB, so the item reported success yet never
          // landed in the cart.
          setTimeout(() => navigateToAddItem(nextIdx, itemsToAdd), 400);
        }
      } catch {
        // ignore
      }
    },
    [navigateToSearchItem, navigateToAddItem],
  );

  // ── Review step helpers ──────────────────────────────────────────────────

  const currentReview = searchResults[reviewIdx] ?? null;

  const getReviewMealQtys = (idx: number): Record<string, number> => {
    if (reviewMealQtys[idx]) return reviewMealQtys[idx];
    const r = searchResults[idx];
    if (!r) return {};
    const map: Record<string, number> = {};
    for (const m of r.mealIngredients) map[m.mealId] = 0;
    return map;
  };

  const getReviewTotalQty = (idx: number): number => {
    const qtys = getReviewMealQtys(idx);
    return Object.values(qtys).reduce((a, b) => a + b, 0);
  };

  const adjustReviewMealQty = (idx: number, mealId: string, delta: number) => {
    setReviewMealQtys((prev) => {
      const current = prev[idx] ?? getReviewMealQtys(idx);
      const newQty = Math.max(0, (current[mealId] ?? 0) + delta);
      return { ...prev, [idx]: { ...current, [mealId]: newQty } };
    });
  };

  const handleCustomSearch = useCallback((term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    isCustomSearchRef.current = true;
    setCustomSearching(true);
    setCustomSearchTerm(trimmed);
    loadQueueRef.current = [scriptsRef.current!.extractProductsScript];
    // Recovery timer: if no SEARCH_RESULT lands, surface "no results" (which
    // re-enables the buttons via !customSearching) instead of hanging.
    if (customSearchTimeoutRef.current) clearTimeout(customSearchTimeoutRef.current);
    customSearchTimeoutRef.current = setTimeout(() => {
      customSearchTimeoutRef.current = null;
      if (!isCustomSearchRef.current) return; // result already arrived
      console.log(`[Cart ${ts()}]`, 'CUSTOM SEARCH timeout for', trimmed, '— re-enabling review buttons');
      isCustomSearchRef.current = false;
      loadQueueRef.current = []; // drop the stale queued extract so a later reload can't fire it
      setCustomSuggestions([]);
      setCustomSearching(false);
    }, CUSTOM_SEARCH_TIMEOUT_MS);
    webviewRef.current?.injectJavaScript(scriptsRef.current!.buildSearchScript(trimmed));
  }, []);

  const handleReviewDecision = (action: 'add' | 'update' | 'skip' | 'choose') => {
    // If the user typed a custom search term, trigger the search instead of advancing.
    if (action !== 'skip' && action !== 'choose' && selectedSuggIdx === 'custom') {
      const term = customText.trim();
      if (term) {
        handleCustomSearch(term);
      }
      return;
    }

    const newPicked = [...pickedItems];

    if (action === 'skip') {
      // Remember this ingredient as skipped so the done snapshot can report it.
      const skippedName = currentReview?.term ?? '';
      if (skippedName) setSkippedByIdx((prev) => ({ ...prev, [reviewIdx]: skippedName }));
    }

    if (action !== 'skip' && currentReview) {
      const displayCandidates = customSuggestions.length > 0 ? customSuggestions : currentReview.candidates;
      const candidate = typeof selectedSuggIdx === 'number' ? displayCandidates[selectedSuggIdx] : null;
      if (candidate && !candidate.outOfStock) {
        // Re-deciding this ingredient after a Back: drop any earlier skip for it.
        setSkippedByIdx((prev) => {
          if (!(reviewIdx in prev)) return prev;
          const next = { ...prev };
          delete next[reviewIdx];
          return next;
        });
        const needsPref = candidate.preferences && candidate.preferences.length > 0;
        const prefText = selectedPreference ?? null;

        // Sold-by-weight: the stepper value is an option index; remember the
        // chosen ABSOLUTE weight (lb) so a future run re-selects it even if the
        // store's increments change. Distinct from the recipe measure/unit.
        const wopts = candidate.weightOptions;
        const weightFromIdx = (idx: number): number | null =>
          candidate.isWeightItem && wopts && wopts.length
            ? wopts[Math.min(Math.max(1, idx), wopts.length) - 1]
            : null;
        // The increment: a dropdown item's smallest option, else 0.25 lb for a
        // stepper-weight item (HEB Deli — no dropdown, increments by weight).
        const weightStep = candidate.isWeightItem ? ((wopts && wopts.length) ? wopts[0] : 0.25) : null;

        if (action === 'choose') {
          // Choose-product flow: save the selection as the ingredient's searchTerm + qty. No cart.
          const qtyMap = Object.fromEntries(currentReview.mealIngredients.map((mi) => [mi.mealId, chooseQty]));
          // Build dropdown object if a preference was selected
          let dropdown: { type: string; selectedText: string; selectedValue: string } | null = null;
          if (needsPref && prefText) {
            const prefOpt = candidate.preferences!.find((p) => p.text === prefText);
            dropdown = { type: 'preference', selectedText: prefText, selectedValue: prefOpt?.value ?? prefText };
          }
          onIngredientChosen?.(
            currentReview.term,
            currentReview.mealIngredients.map((mi) => mi.mealId),
            candidate.productName,
            qtyMap,
            dropdown,
            weightFromIdx(chooseQty),
            weightStep,
          );
        } else {
          // Add-to-cart / review-unmatched flow: queue item for cart, optionally save searchTerm.
          const totalQty = getReviewTotalQty(reviewIdx);
          // Tag the pick with its review index so "Back" removes the correct
          // one. Replace any prior pick for this same index (re-deciding after
          // going Back and forward) to avoid a duplicate cart line.
          const existingIdx = newPicked.findIndex((p) => p.reviewIndex === reviewIdx);
          const pick: PickedItem = {
            searchTerm: currentReview.term,
            productName: candidate.productName,
            preference: needsPref && prefText ? { text: prefText } : null,
            qty: totalQty,
            purchaseWeight: weightFromIdx(totalQty),
            reviewIndex: reviewIdx,
          };
          if (existingIdx >= 0) newPicked[existingIdx] = pick;
          else newPicked.push(pick);
          // Persist on "Add & Update", AND always for a sold-by-weight item even
          // via "Add to Cart Only" — otherwise the chosen weight isn't saved and
          // the item would re-prompt on every run instead of being remembered.
          const chosenWeight = weightFromIdx(totalQty);
          if (action === 'update' || (candidate.isWeightItem && chosenWeight != null)) {
            const qtyMap = getReviewMealQtys(reviewIdx);
            let reviewDropdown: { type: string; selectedText: string; selectedValue: string } | null = null;
            if (needsPref && prefText) {
              const prefOpt = candidate.preferences!.find((p: any) => p.text === prefText);
              reviewDropdown = { type: 'preference', selectedText: prefText, selectedValue: prefOpt?.value ?? prefText };
            }
            onIngredientChosen?.(
              currentReview.term,
              currentReview.mealIngredients.map((mi) => mi.mealId),
              candidate.productName,
              qtyMap,
              reviewDropdown,
              chosenWeight,
              weightStep,
            );
          }
        }
      }
    }

    if (reviewIdx < searchResults.length - 1) {
      setPickedItems(newPicked);
      setReviewIdx(reviewIdx + 1);
    } else {
      // All reviewed — combine auto-picked + manually reviewed items, then start adding.
      setPickedItems(newPicked);
      startAdding([...autoPickedItemsRef.current, ...newPicked]);
    }
  };

  const startAdding = (itemsToAdd: PickedItem[]) => {
    if (itemsToAdd.length === 0) {
      // No review items to add — compile done stats from combined-phase results.
      const added = addResultsRef.current.filter((r) => r.success).length;
      const failed = addResultsRef.current.filter((r) => !r.success).length;
      const names = addResultsRef.current.filter((r) => r.success).map((r) => r.name);
      setTotalAdded(added);
      setTotalFailed(failed);
      setAddedNames(names);
      setStep('done');
      return;
    }
    // Don't reset addResultsRef — may already contain results from the combined search+add phase.
    addingItemsRef.current = itemsToAdd;
    addingIdxRef.current = 0;
    setStep('adding');
    navigateToAddItem(0, itemsToAdd);
  };

  // ── Open store cart (native app if installed, browser fallback) ─────────

  const handleOpenCart = async () => {
    if (scriptsRef.current!.appScheme) {
      try {
        await Linking.openURL(scriptsRef.current!.appScheme);
        return;
      } catch {
        // App not installed or scheme not handled — fall through to browser
      }
    }
    Linking.openURL(scriptsRef.current!.cartUrl).catch(() => {});
  };

  // ── Title ────────────────────────────────────────────────────────────────

  const titleMap: Record<Step, string> = {
    qty: 'Add to Cart',
    login_check: 'Connecting…',
    login: `Log in to ${storeName}`,
    searching: currentReview?.isChoose ? 'Choosing Products…' : 'Finding Products…',
    searchResult: 'Items Not Added',
    review: currentReview?.isChoose
      ? `Choose Product (${reviewIdx + 1} of ${searchResults.length})`
      : `Review Ingredients (${reviewIdx + 1} of ${searchResults.length})`,
    adding: 'Adding to Cart…',
    done: 'Done!',
    robot_challenge: blockReason ? `${storeName} blocked us` : `${storeName} verification`,
  };

  // ── Derived ──────────────────────────────────────────────────────────────

  const webviewVisible = step === 'login' || step === 'robot_challenge' || browserShown;

  // ── Render ───────────────────────────────────────────────────────────────

  const content = (
      <SafeAreaView style={styles.safe}>

        {/* Header */}
        <View style={styles.header}>
          {step !== 'login' && step !== 'qty' ? (
            <TouchableOpacity onPress={() => setBrowserShown(b => !b)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={{ fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.brand }}>
                {browserShown ? 'Hide Browser' : 'Show Browser'}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={{ width: 28 }} />
          )}
          <Text style={styles.title}>{titleMap[step]}</Text>
          <View style={styles.headerRight}>
            {presentation === 'layer' && onMinimize && (
              <TouchableOpacity onPress={onMinimize} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ marginRight: 16 }}>
                <Ionicons name="chevron-down" size={20} color={Colors.brand} />
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Hidden / Visible WebView — not mounted during qty step so the qty UI
            stays responsive (heavy ecommerce sites otherwise block the JS thread). */}
        {step !== 'qty' && (
        <View style={[
          webviewVisible ? styles.webviewVisible : styles.webviewHidden,
          webviewVisible && step !== 'login' && step !== 'robot_challenge' && { borderWidth: 2, borderColor: '#ef4444' },
        ]} pointerEvents={webviewVisible ? 'auto' : 'none'}>
          {step === 'login' && (
            <View>
              <Text style={styles.loginBanner}>
                Log in to your {storeName} account, then Mealio will add your ingredients automatically.
              </Text>
              <TouchableOpacity style={styles.retryBtn} onPress={recheckLogin}>
                <Text style={styles.retryBtnText}>I'm already logged in</Text>
              </TouchableOpacity>
            </View>
          )}
          {step === 'robot_challenge' && !blockReason && (
            <Text style={styles.loginBanner}>
              {storeName} asked us to verify you're a human — complete the press-and-hold below and Mealio will pick up where it left off.
            </Text>
          )}
          {step === 'robot_challenge' && blockReason && (
            <View>
              <Text style={styles.loginBanner}>
                {storeName} temporarily blocked automated access. Complete any challenge shown below, or wait a few minutes — then tap Try again.
              </Text>
              <TouchableOpacity style={styles.retryBtn} onPress={retryAfterBlock}>
                <Text style={styles.retryBtnText}>Try again</Text>
              </TouchableOpacity>
            </View>
          )}
          <WebView
            ref={webviewRef}
            source={{ uri: webviewUri }}
            // incognito  // TODO: uncomment to force fresh session (no stored cookies)
            style={{ flex: 1 }}
            onLoadEnd={onLoadEnd}
            onMessage={onMessage}
            onHttpError={onHttpError}
            onNavigationStateChange={onNavigationStateChange}
            onShouldStartLoadWithRequest={(request) => {
              // Block custom URL schemes that would open the native app.
              // Allow http/https and about: (used internally by the WebView for blank pages).
              return (
                request.url.startsWith('http://') ||
                request.url.startsWith('https://') ||
                request.url.startsWith('about:')
              );
            }}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            userAgent={getStoreWebViewUA()}
            injectedJavaScriptBeforeContentLoaded={beforeContent}
          />
        </View>
        )}

        {/* ── Hidden parallel worker pool (PARALLEL_SEARCH_STORES) ─────────
            5 WebViews mounted offscreen ONLY while parallel search is running.
            Mounted by startParallelSearch() with their initial dispatch URIs,
            unmounted by finishParallelSearch() to free resources before the
            review/ATC phase. Avoids overwhelming iOS WebView init during the
            (single-WebView) login_check phase. */}
        {parallelCfg && parallelPool.isActive && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              // Real phone-sized viewport, parked far offscreen and invisible.
              // A WebView's internal browser viewport equals its OWN style size,
              // independent of where it sits in the RN tree — and viewport-lazy
              // storefronts (HEB renders its product grid by visible area) need
              // a real size or the grid never paints and the worker extracts 0.
              width: 414,
              height: 896,
              opacity: 0,
              left: -100000,
              top: -100000,
            }}
          >
            {parallelPool.workerUris.map((uri, i) => uri ? (
              <WebView
                key={'parallel-worker-' + i}
                source={workerSources[i]}
                style={{ width: 414, height: 896 }}
                onMessage={(e) => onWorkerMessage(i, e)}
                onHttpError={onHttpError}
                onShouldStartLoadWithRequest={(request) => (
                  request.url.startsWith('http://') ||
                  request.url.startsWith('https://') ||
                  request.url.startsWith('about:')
                )}
                javaScriptEnabled
                domStorageEnabled
                sharedCookiesEnabled
                thirdPartyCookiesEnabled
                userAgent={getStoreWebViewUA()}
                injectedJavaScriptBeforeContentLoaded={beforeContent}
                injectedJavaScript={workerScripts[i]}
              />
            ) : null)}
          </View>
        )}

        {/* ── Hidden parallel ADD pool (FEATURE_PARALLEL_ADD) ──────────────
            Mounted offscreen only while parallel add is running. Each worker
            loads getSearchUrl(term)#mealio=<json> and runs the search-and-add
            script, reporting WORKER_RESULT. */}
        {parallelCfg && addPool.isActive && (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', width: 414, height: 896, opacity: 0, left: -100000, top: -100000 }}
          >
            {addPool.workerUris.map((uri, i) => uri ? (
              <WebView
                key={'parallel-add-worker-' + i}
                source={addWorkerSources[i]}
                style={{ width: 414, height: 896 }}
                onMessage={(e) => onAddWorkerMessage(i, e)}
                onHttpError={onHttpError}
                onShouldStartLoadWithRequest={(request) => (
                  request.url.startsWith('http://') ||
                  request.url.startsWith('https://') ||
                  request.url.startsWith('about:')
                )}
                javaScriptEnabled
                domStorageEnabled
                sharedCookiesEnabled
                thirdPartyCookiesEnabled
                userAgent={getStoreWebViewUA()}
                injectedJavaScriptBeforeContentLoaded={beforeContent}
                injectedJavaScript={addWorkerScripts[i]}
              />
            ) : null)}
          </View>
        )}


        {/* ── Step: qty ──────────────────────────────────────────────────── */}
        {step === 'qty' && (
          <>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.listContent}>
              <View style={{ backgroundColor: '#f0f6ff', borderRadius: 8, borderWidth: 1, borderColor: '#c8dcf8', padding: 10, marginBottom: 12 }}>
                <Text style={{ fontSize: 12, color: Colors.text2, lineHeight: 17 }}>
                  All items are checked by default. Uncheck any ingredients you already have at home.
                </Text>
              </View>
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
                return (
                  <View key={i} style={[styles.qtyRow, !checked && styles.qtyRowZeroed]}>
                    <TouchableOpacity onPress={() => toggleChecked(i)} style={styles.checkbox} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      {checked && <View style={[styles.checkboxInner, { backgroundColor: storeColor }]} />}
                    </TouchableOpacity>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.ingName, !checked && styles.ingNameZeroed]}>
                        {it.searchTerm ?? it.ingredientName}
                      </Text>
                      {it.dropdown?.selectedText ? (
                        <Text style={{ fontSize: 11, fontFamily: 'Inter_400Regular', color: Colors.text3 }}>
                          {it.dropdown.selectedText}
                        </Text>
                      ) : null}
                      {it.mealIngredients.map((mi, mIdx) => {
                        const w = ingredientWeight(it);
                        const isQty = it.unit.toLowerCase() === 'qty';
                        const measurement = w
                          ? weightLabelLb(w.lb)
                          : (isQty ? `${mi.qty} qty` : `${it.measure} ${it.unit}`);
                        return (
                          <Text key={mIdx} style={styles.mealNames}>{mi.mealName} • {measurement}</Text>
                        );
                      })}
                    </View>
                    {(() => {
                      const w = ingredientWeight(it);
                      const atMin = w?.mode === 'dropdown'
                        ? (it.purchaseWeight ?? 0) <= w.step
                        : it.productQty === 0;
                      return (
                    <TouchableOpacity
                      onPress={() => updateQty(i, -1)}
                      disabled={atMin || !checked}
                      style={[styles.qtyBtn, (atMin || !checked) && { opacity: 0.3 }]}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.qtyBtnText}>−</Text>
                    </TouchableOpacity>
                      );
                    })()}
                    <Text style={styles.qtyNum}>
                      {(() => { const w = ingredientWeight(it); return w ? weightLabelLb(w.lb) : it.productQty; })()}
                    </Text>
                    <TouchableOpacity
                      onPress={() => updateQty(i, 1)}
                      disabled={!checked}
                      style={[styles.qtyBtn, !checked && { opacity: 0.3 }]}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.qtyBtnText}>+</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
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

        {/* ── Step: login_check / searching / adding (spinner) ────────────── */}
        {(step === 'login_check' || step === 'searching' || step === 'adding') && (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={storeColor} />
            <Text style={styles.spinnerLabel}>{searchingLabel}</Text>
            {(step === 'searching' || step === 'adding') && (() => {
              // Parallel choose-product search dispatches all items at once, so
              // the index refs never advance — drive the bar from the pool's
              // reactive completed/total instead. The sequential flow still
              // reads the index refs (re-rendered via setSearchingLabel).
              let total: number;
              let idx: number;
              if (step === 'searching' && parallelPool.isActive) {
                total = parallelPool.total;
                idx = parallelPool.completed;
              } else {
                total = step === 'searching'
                  ? activeItemsRef.current.length
                  : addingItemsRef.current.length;
                idx = step === 'searching' ? searchIdxRef.current : addingIdxRef.current;
              }
              const pct = total > 0 ? Math.min(idx / total, 1) * 100 : 0;
              return (
                <View style={styles.progressTrack} testID="cart-progress-track">
                  <View
                    style={[styles.progressFill, { width: `${pct}%`, backgroundColor: storeColor }]}
                    testID="cart-progress-fill"
                  />
                </View>
              );
            })()}
          </View>
        )}

        {/* ── Step: searchResult ──────────────────────────────────────────── */}
        {step === 'searchResult' && (() => {
          const autoAdded = autoPickedItemsRef.current;
          return (
            <>
              <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.listContent, { alignItems: 'center' }]}>
                <View style={{ marginBottom: 16 }}>
                  <Ionicons name="alert-circle" size={48} color="#f59e0b" />
                </View>
                <Text style={[styles.doneTitle, { marginBottom: 8 }]}>
                  {searchResults.length} item{searchResults.length !== 1 ? 's' : ''} could not be added to cart
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
                  {searchResults.map((r, i) => (
                    <View
                      key={i}
                      style={{
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderBottomWidth: i < searchResults.length - 1 ? 1 : 0,
                        borderBottomColor: Colors.border,
                      }}
                    >
                      <Text style={{ fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text1 }}>{r.term}</Text>
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
                    Review {searchResults.length} Item{searchResults.length !== 1 ? 's' : ''} →
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          );
        })()}

        {/* ── Step: review ────────────────────────────────────────────────── */}
        {step === 'review' && currentReview && (() => {
          const isChoose = currentReview.isChoose;
          const displayCandidates = customSuggestions.length > 0 ? customSuggestions : currentReview.candidates;
          const candidate = typeof selectedSuggIdx === 'number' ? (displayCandidates[selectedSuggIdx] ?? null) : null;
          const selectedImageUrl = candidate?.imageUrl ?? null;
          const hasCandidates = displayCandidates.length > 0;
          const mealQtys = getReviewMealQtys(reviewIdx);
          const totalQty = getReviewTotalQty(reviewIdx);
          const isWeightCandidate = !!(candidate?.isWeightItem);
          // Use the product's OWN detected weight increments (from the dropdown)
          // instead of the legacy fixed qty*0.25. qty is the option index, so the
          // picker shows the real buyable weight (e.g. "1 lb", "2 lb") and matches
          // exactly what add-to-cart will select.
          const weightOpts = (candidate?.weightOptions && candidate.weightOptions.length) ? candidate.weightOptions : null;
          // idx is the option index (1-based). 0 = nothing chosen yet → show
          // "0 lb", mirroring how the qty stepper starts at 0.
          const weightLabel = (idx: number) =>
            weightOpts ? (idx <= 0 ? '0 lb' : `${weightOpts[Math.min(idx, weightOpts.length) - 1]} lb`) : fmtWeight(idx);
          const maxWeightSteps = weightOpts ? weightOpts.length : Infinity;
          const needsPref = candidate && !candidate.outOfStock && candidate.preferences && candidate.preferences.length > 0;
          console.log(`[Cart ${ts()}]`, 'review render', { isChoose, reviewIdx, candidateName: candidate?.productName, prefs: candidate?.preferences, needsPref, selectedSuggIdx });
          const canAdd = !customSearching && (
            selectedSuggIdx === 'custom'
              ? customText.trim().length > 0
              : candidate != null && !candidate.outOfStock &&
                (isChoose ? chooseQty > 0 : totalQty > 0) &&
                (!needsPref || selectedPreference != null)
          );

          return (
            <View style={{ flex: 1 }} onLayout={preview.onContainerLayout}>
              <KeyboardAwareScrollView style={{ flex: 1 }} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled" enableOnAndroid extraScrollHeight={24} scrollEnabled={preview.scrollEnabled}>
                {/* Reason context — only shown for review-unmatched, not choose-product */}
                {!isChoose && currentReview.reason === 'out_of_stock' && (
                  <Text style={{ fontSize: 12, fontFamily: 'Inter_500Medium', color: '#b45309', marginBottom: 6 }}>⚠ Out of stock at this store</Text>
                )}
                {!isChoose && currentReview.reason === 'no_results' && (
                  <Text style={{ fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.text3, marginBottom: 6 }}>No products found for this search</Text>
                )}
                {!isChoose && currentReview.reason === 'low_confidence' && (
                  <Text style={{ fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.text3, marginBottom: 6 }}>No exact match found</Text>
                )}
                {!isChoose && currentReview.reason === 'needs_weight' && (
                  <Text style={{ fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.brand, marginBottom: 6 }}>⚖ Sold by weight — choose how much to add</Text>
                )}
                {/* Searched for */}
                <View style={styles.searchedBox} onLayout={preview.onAnchorLayout}>
                  {isChoose ? (
                    <>
                      <Text style={styles.searchedLabel}>
                        <Text style={{ fontFamily: 'Inter_600SemiBold', color: Colors.text1 }}>
                          {currentReview.mealIngredients.map((mi) => mi.mealName).join(', ')}
                        </Text>
                        {currentReview.mealIngredients.length === 1 ? ' calls for' : ' call for'}
                      </Text>
                      <Text style={styles.searchedTerm}>
                        {(() => {
                          const isQtyUnit = !currentReview.unit || currentReview.unit === 'qty';
                          if (isQtyUnit) {
                            const totalQtyNeeded = currentReview.mealIngredients.reduce((s, mi) => s + mi.qty, 0);
                            return `${currentReview.term}, ${totalQtyNeeded}`;
                          }
                          return `${currentReview.term}, ${currentReview.measure ?? ''} ${currentReview.unit}`.replace(/\s+/g, ' ').trim();
                        })()}
                      </Text>
                    </>
                  ) : (
                    <>
                      <Text style={styles.searchedLabel}>You searched for</Text>
                      <Text style={styles.searchedTerm}>{currentReview.term}</Text>
                      {currentReview.mealIngredients.map((mi, mIdx) => {
                        const isQty = (currentReview.unit ?? 'qty') === 'qty';
                        const measurement = isQty ? `${mi.qty} qty` : `${currentReview.measure} ${currentReview.unit}`;
                        return (
                          <Text key={mIdx} style={styles.searchedMeals}>{mi.mealName} • {measurement}</Text>
                        );
                      })}
                    </>
                  )}
                </View>

                {/* Candidates */}
                <Text style={styles.suggHeader}>
                  {hasCandidates
                    ? (customSuggestions.length > 0 ? `Results for "${customSearchTerm}"` : `${storeName} suggests`)
                    : 'No products found'}
                </Text>
                {customSearchTerm && customSuggestions.length === 0 && !customSearching && (
                  <Text style={{ fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, marginBottom: 8 }}>
                    No results for "{customSearchTerm}". Try a different search.
                  </Text>
                )}

                {displayCandidates.map((c, i) => {
                  const selected = selectedSuggIdx === i;
                  return (
                    <TouchableOpacity
                      key={i}
                      testID={`candidate-${i}`}
                      onPress={() => { setSelectedSuggIdx(i); setSelectedPreference(null); }}
                      style={[
                        styles.suggRow,
                        {
                          borderColor: selected ? storeColor : Colors.border,
                          backgroundColor: selected ? '#fff0f0' : Colors.surface,
                          opacity: c.outOfStock ? 0.5 : 1,
                        },
                      ]}
                      activeOpacity={0.7}
                    >
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <Text style={[styles.suggText, { flex: 1, marginRight: 8 }]}>{c.productName}</Text>
                        {c.price && !c.outOfStock && (
                          <Text style={{ fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1 }}>{c.price}</Text>
                        )}
                      </View>
                      {c.outOfStock && <Text style={styles.outOfStockText}>Out of stock</Text>}
                      {c.preferences && c.preferences.length > 0 && !c.outOfStock && (
                        <Text style={styles.prefHint}>Requires preference selection</Text>
                      )}
                    </TouchableOpacity>
                  );
                })}

                {/* Custom search option */}
                <TouchableOpacity
                  onPress={() => setSelectedSuggIdx('custom')}
                  style={[
                    styles.suggRow,
                    {
                      borderColor: selectedSuggIdx === 'custom' ? storeColor : Colors.border,
                      backgroundColor: selectedSuggIdx === 'custom' ? '#fff0f0' : Colors.surface,
                    },
                  ]}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.suggText, { color: selectedSuggIdx === 'custom' ? Colors.text1 : Colors.text3 }]}>
                    {customSuggestions.length > 0 ? 'Try a different search…' : 'Other — type a product name…'}
                  </Text>
                </TouchableOpacity>
                {selectedSuggIdx === 'custom' && (
                  <TextInput
                    autoFocus
                    value={customText}
                    onChangeText={setCustomText}
                    placeholder="e.g. Chicken Breast Boneless"
                    placeholderTextColor={Colors.text3}
                    style={[styles.customInput, { borderColor: storeColor }]}
                    onSubmitEditing={() => { if (customText.trim()) handleCustomSearch(customText); }}
                    returnKeyType="search"
                  />
                )}

              </KeyboardAwareScrollView>

              {/* Preference picker — sticky between scroll and footer */}
              {needsPref && candidate?.preferences && (
                <View style={[styles.prefBox, { marginHorizontal: 16, marginBottom: 0 }]}>
                  <Text style={styles.prefLabel}>
                    Select your preference:{' '}
                    {!selectedPreference && <Text style={{ color: '#ef4444' }}>required</Text>}
                  </Text>
                  <View style={styles.prefRow}>
                    {candidate.preferences.map((pref, pi) => {
                      const active = selectedPreference === pref.text;
                      return (
                        <TouchableOpacity
                          key={pi}
                          onPress={() => setSelectedPreference(pref.text)}
                          style={[styles.prefBtn, active && { backgroundColor: storeColor, borderColor: storeColor }]}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.prefBtnText, active && { color: '#fff' }]}>{pref.text}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}

              <View style={[styles.footer, { gap: 8 }]}>
                {/* Per-meal qty — only for review-unmatched flow; choose-product uses single chooseQty below */}
                {!isChoose && currentReview.mealIngredients.map((mi) => {
                  const qty = mealQtys[mi.mealId] ?? 0;
                  const showMealName = currentReview.mealIngredients.length > 1;
                  return (
                    <View key={mi.mealId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ fontSize: 14, fontFamily: 'Inter_500Medium', color: qty === 0 ? '#ef4444' : Colors.text2, flex: 1 }} numberOfLines={1}>
                        {showMealName ? mi.mealName : 'Qty to add to cart'}
                      </Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <TouchableOpacity
                          onPress={() => adjustReviewMealQty(reviewIdx, mi.mealId, -1)}
                          disabled={qty === 0}
                          style={[styles.qtyBtn, qty === 0 && { opacity: 0.3 }]}
                        >
                          <Text style={styles.qtyBtnText}>−</Text>
                        </TouchableOpacity>
                        <Text style={{ fontSize: 14, fontFamily: 'Inter_600SemiBold', color: qty === 0 ? '#ef4444' : Colors.text1, minWidth: 36, textAlign: 'center' }}>
                          {isWeightCandidate ? weightLabel(qty) : qty}
                        </Text>
                        <TouchableOpacity onPress={() => { if (!isWeightCandidate || qty < maxWeightSteps) adjustReviewMealQty(reviewIdx, mi.mealId, 1); }} style={styles.qtyBtn}>
                          <Text style={styles.qtyBtnText}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}

                {isChoose ? (
                  // Choose-product flow: "Qty to add to cart" + Back / Next→ / Save
                  <>
                    <View style={{ borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 12, gap: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 13, fontFamily: 'Inter_500Medium', color: chooseQty === 0 ? '#ef4444' : Colors.text2 }}>
                          Qty to add to cart
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <TouchableOpacity
                            onPress={() => setChooseQty((q) => Math.max(0, q - 1))}
                            disabled={chooseQty <= 0}
                            style={[styles.qtyBtn, chooseQty <= 0 && { opacity: 0.3 }]}
                          >
                            <Text style={styles.qtyBtnText}>−</Text>
                          </TouchableOpacity>
                          <Text style={{ fontSize: 14, fontFamily: 'Inter_600SemiBold', color: chooseQty === 0 ? '#ef4444' : Colors.text1, minWidth: 20, textAlign: 'center' }}>
                            {isWeightCandidate ? weightLabel(chooseQty) : chooseQty}
                          </Text>
                          <TouchableOpacity onPress={() => setChooseQty((q) => Math.min(q + 1, maxWeightSteps))} style={styles.qtyBtn}>
                            <Text style={styles.qtyBtnText}>+</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                      {chooseQty > 2 && !isWeightCandidate && (
                        <Text style={{ fontSize: 13, fontFamily: 'Inter_600SemiBold', color: '#92400e', backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fbbf24', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
                          ⚠ {chooseQty} is a lot — does this come in a multipack or bulk size?
                        </Text>
                      )}
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TouchableOpacity
                        onPress={() => { setReviewIdx(reviewIdx - 1); }}
                        disabled={reviewIdx === 0 || customSearching}
                        style={[styles.skipBtn, { flex: 1, borderWidth: 1, borderColor: Colors.border, borderRadius: 12 }, (reviewIdx === 0 || customSearching) && { opacity: 0.3 }]}
                      >
                        <Text style={styles.skipBtnText}>← Back</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => handleReviewDecision('choose')}
                        disabled={!canAdd || customSearching}
                        style={[styles.primaryBtn, { flex: 1, backgroundColor: storeColor }, (!canAdd || customSearching) && { opacity: 0.4 }]}
                      >
                        <Text style={styles.primaryBtnText}>
                          {customSearching ? 'Searching…' : reviewIdx === searchResults.length - 1 ? 'Save' : 'Next →'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    {/* Skip — lets the user move past an ingredient with no match
                        instead of being stuck on a disabled Next. */}
                    <TouchableOpacity
                      onPress={() => handleReviewDecision('skip')}
                      disabled={customSearching}
                      style={[styles.skipBtn, customSearching && { opacity: 0.4 }]}
                    >
                      <Text style={styles.skipBtnText}>Skip this ingredient</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  // Review-unmatched flow: add to cart (with or without saving searchTerm).
                  <>
                    <TouchableOpacity
                      onPress={() => handleReviewDecision('update')}
                      disabled={!canAdd || customSearching}
                      style={[styles.primaryBtn, { backgroundColor: storeColor }, (!canAdd || customSearching) && { opacity: 0.4 }]}
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
                          onPress={() => { const target = reviewIdx - 1; setReviewIdx(target); setPickedItems((prev) => prev.filter((p) => p.reviewIndex !== target)); }}
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
                  </>
                )}
              </View>

              {/* Draggable product preview — rendered last so it paints above the list
                  and its PanResponder wins the touch. Vanishes when the product has
                  no image (or it fails to load) instead of a blank/stale frame. */}
              <FloatingPreviewImage
                uri={selectedImageUrl}
                transform={preview.transform}
                panHandlers={preview.panHandlers}
                wrapStyle={styles.floatingImageWrap}
                imageStyle={styles.floatingImage}
              />
            </View>
          );
        })()}

        {/* ── Step: done ─────────────────────────────────────────────────── */}
        {step === 'done' && (() => {
          const wasChooseFlow = searchResults.length > 0 && searchResults.every(r => r.isChoose);
          const skippedNames = Object.values(skippedByIdx).filter(Boolean);
          return (
            <>
              <View style={{ alignItems: 'center', paddingHorizontal: 24, paddingTop: 32, paddingBottom: 16 }}>
                {wasChooseFlow ? (
                  <>
                    <View style={styles.doneIconWrap}>
                      <Ionicons name="checkmark-circle" size={56} color="#22c55e" />
                    </View>
                    <Text style={styles.doneTitle}>Products chosen!</Text>
                    <Text style={styles.doneSub}>
                      Your selections have been saved. Next time you add to cart, they'll be added automatically.
                    </Text>
                  </>
                ) : totalAdded > 0 ? (
                  <>
                    {/* TODO: drop a Lottie celebration animation here (e.g. confetti
                        or a checkmark draw-in). The cart icon is the static
                        placeholder until a designer-approved animation lands. */}
                    <View style={styles.doneIconWrap}>
                      <Ionicons name="cart" size={56} color={storeColor} />
                    </View>
                    <Text style={styles.doneTitle}>
                      {totalAdded} item{totalAdded !== 1 ? 's' : ''} added to your {storeName} cart!
                    </Text>
                    {totalFailed > 0 && (
                      <Text style={[styles.doneSub, { color: '#b45309' }]}>
                        {totalFailed} item{totalFailed !== 1 ? 's' : ''} could not be added.
                      </Text>
                    )}
                    {cartDeltaWarning && (
                      <View style={styles.cartCheckBanner} testID="cart-check-warning">
                        <Ionicons name="alert-circle" size={18} color="#b45309" />
                        <Text style={styles.cartCheckBannerText}>{cartDeltaWarning}</Text>
                      </View>
                    )}
                  </>
                ) : (
                  <>
                    <View style={styles.doneIconWrap}>
                      <Ionicons name="information-circle-outline" size={56} color="#6b7280" />
                    </View>
                    <Text style={styles.doneTitle}>No items were added.</Text>
                    <Text style={styles.doneSub}>
                      No products were selected or all were skipped.
                    </Text>
                  </>
                )}
              </View>

              {/* Ingredients the user chose to skip during review. Distinct from
                  the automation-failure count above — these were passed over on
                  purpose, so we surface them plainly rather than as a warning. */}
              {skippedNames.length > 0 && (
                <View style={styles.skippedBanner} testID="snapshot-skipped">
                  <Text style={styles.skippedBannerTitle}>
                    {skippedNames.length} item{skippedNames.length !== 1 ? 's' : ''} skipped during review
                  </Text>
                  <Text style={styles.skippedBannerBody} numberOfLines={3}>
                    {skippedNames.join(', ')}
                  </Text>
                </View>
              )}

              {!cartResultRows && !cartRowsTimedOut && (buildCartPageCountScript(lockedStoreId) || buildInlineCartScript(lockedStoreId)) && totalAdded > 0 && cartCountBeforeRef.current != null ? (
                // Cart-page store (or inline side-panel store like ALDI) with a
                // baseline: the after-probe is reading the cart. Show a loading
                // state instead of the plain list so the breakdown doesn't flash
                // in. (No baseline → the after-probe won't run, so we skip the
                // spinner and fall through to the plain list below.)
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                  <ActivityIndicator size="small" color={storeColor} />
                  <Text style={{ fontSize: 13, color: Colors.text3, fontFamily: 'Inter_400Regular' }}>
                    Updating your {storeName} cart…
                  </Text>
                </View>
              ) : cartResultRows ? (
                // Cart-page stores: full cart breakdown — added qty in green with
                // a +, pre-existing qty in grey. Qty shown on each row.
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 }}>
                    <Text style={{ fontSize: 13, fontFamily: 'Inter_600SemiBold', color: Colors.text2 }}>
                      Your {storeName} cart
                    </Text>
                    <Text style={{ fontSize: 13, fontFamily: 'Inter_600SemiBold', color: Colors.text2 }}>
                      {(() => { const n = cartResultRows.reduce((s, r) => s + r.qty, 0); return `${n} item${n !== 1 ? 's' : ''}`; })()}
                    </Text>
                  </View>
                  {cartResultRows.length === 0 ? (
                    <Text style={{ fontSize: 14, color: Colors.text3, paddingVertical: 10, fontFamily: 'Inter_400Regular' }}>
                      Your cart is empty.
                    </Text>
                  ) : (
                    cartResultRows.map((row, i) => (
                      <View
                        key={i}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingVertical: 10,
                          borderBottomWidth: i < cartResultRows.length - 1 ? 1 : 0,
                          borderBottomColor: Colors.border,
                        }}
                        testID={row.added ? 'cart-row-added' : 'cart-row-existing'}
                      >
                        <View style={{ width: 22, alignItems: 'center' }}>
                          {row.added && <Ionicons name="add" size={18} color="#22c55e" />}
                        </View>
                        <Text
                          style={{ flex: 1, fontSize: 14, fontFamily: 'Inter_400Regular', color: row.added ? '#15803d' : Colors.text3 }}
                          numberOfLines={2}
                        >
                          {row.name}
                        </Text>
                        <Text style={{ fontSize: 14, fontFamily: 'Inter_500Medium', color: row.added ? '#15803d' : Colors.text3, marginLeft: 8 }}>
                          {row.isWeight && row.weight ? `${row.weight} lb` : `x${row.qty}`}
                        </Text>
                      </View>
                    ))
                  )}
                </ScrollView>
              ) : addedNames.length > 0 ? (
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8 }}>
                  {addedNames.map((name, i) => (
                    <View
                      key={i}
                      style={{
                        paddingVertical: 10,
                        borderBottomWidth: i < addedNames.length - 1 ? 1 : 0,
                        borderBottomColor: Colors.border,
                      }}
                    >
                      <Text style={{ fontSize: 14, color: Colors.text1, fontFamily: 'Inter_400Regular' }}>{name}</Text>
                    </View>
                  ))}
                </ScrollView>
              ) : (
                <View style={{ flex: 1 }} />
              )}

              <View style={[styles.footer, { gap: 8 }]}>
                {!wasChooseFlow && totalAdded > 0 && (
                  <TouchableOpacity
                    onPress={handleOpenCart}
                    style={[styles.primaryBtn, { backgroundColor: storeColor }]}
                  >
                    <Text style={styles.primaryBtnText}>Open {storeName} Cart to Checkout</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={onClose} style={[styles.secondaryBtn, { borderColor: storeColor }]}>
                  <Text style={[styles.secondaryBtnText, { color: storeColor }]}>Done</Text>
                </TouchableOpacity>
              </View>
            </>
          );
        })()}

      </SafeAreaView>
  );

  // Layer mode: a provider-controlled root overlay that slides offscreen when
  // collapsed (WebView stays mounted, background job keeps running). Used for
  // the floating-bubble background-cart flow.
  if (presentation === 'layer') {
    return (
      <View
        style={[styles.layerRoot, collapsed && styles.layerCollapsed]}
        pointerEvents={collapsed ? 'none' : 'auto'}
      >
        {content}
      </View>
    );
  }

  // Modal mode (default): unchanged native pageSheet.
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {content}
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },

  // Layer-mode root: full-screen overlay above the app. When collapsed it is
  // pushed far offscreen so the WebView stays mounted (job keeps running) while
  // the app underneath is fully interactive.
  layerRoot: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: Colors.bg, zIndex: 100, elevation: 100 },
  layerCollapsed: { transform: [{ translateX: 100000 }] },
  headerRight: { flexDirection: 'row', alignItems: 'center' },

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

  webviewHidden: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0, pointerEvents: 'none' as const },
  webviewVisible: {
    flex: 1,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  loginBanner: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fff7ed',
    color: '#92400e',
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    lineHeight: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#fde68a',
  },
  retryBtn: {
    alignSelf: 'flex-start',
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: Colors.brand,
  },
  retryBtnText: {
    color: '#fff',
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },

  listContent: { paddingHorizontal: 20, paddingVertical: 16 },

  subheading: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3 },

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
  ingName: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text1, marginBottom: 2 },
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
  qtyNum: { width: 20, textAlign: 'center', fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text2, flexShrink: 0 },
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
  checkboxInner: { width: 12, height: 12, borderRadius: 2 },

  // Spinner
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  spinnerLabel: { fontSize: 15, fontFamily: 'Inter_500Medium', color: Colors.text2, textAlign: 'center' },
  progressTrack: {
    width: '60%',
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.border,
    marginTop: 14,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 3 },
  cartCheckBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#fef3c7',
    borderWidth: 1,
    borderColor: '#fcd34d',
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
  },
  cartCheckBannerText: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: '#92400e',
    lineHeight: 18,
  },
  // Neutral (not a warning) note listing ingredients the user skipped on purpose.
  skippedBanner: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginHorizontal: 20,
    marginBottom: 8,
  },
  skippedBannerTitle: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text2,
  },
  skippedBannerBody: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: Colors.text3,
    lineHeight: 18,
    marginTop: 2,
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
  searchedLabel: { fontSize: 11, fontFamily: 'Inter_400Regular', color: Colors.text3, marginBottom: 2 },
  searchedTerm: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  searchedMeals: { fontSize: 11, fontFamily: 'Inter_400Regular', color: Colors.text3, marginTop: 2 },

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
  outOfStockText: { fontSize: 12, fontFamily: 'Inter_500Medium', color: '#b45309', marginTop: 2 },
  prefHint: { fontSize: 11, fontFamily: 'Inter_400Regular', color: Colors.text3, marginTop: 2 },

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

  // Preference picker
  prefBox: {
    marginTop: 8,
    marginBottom: 8,
    padding: 12,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  prefLabel: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.text2, marginBottom: 8 },
  prefRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  prefBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  prefBtnText: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text2 },

  // Floating product image
  floatingImageWrap: {
    position: 'absolute',
    top: 0,
    right: 12,
    zIndex: 10,
    width: 88,
    height: 88,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  floatingImage: { width: '100%', height: '100%' },

  // Footer
  footer: { paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: 1, borderTopColor: Colors.border },
  primaryBtn: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryBtnText: { fontSize: 15, fontFamily: 'Inter_700Bold', color: '#fff' },
  secondaryBtn: {
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1.5,
  },
  secondaryBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  ghostBtn: { paddingVertical: 12, alignItems: 'center' },
  ghostBtnText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text3 },
  skipBtn: { paddingVertical: 12, alignItems: 'center' },
  skipBtnText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text3 },

  // Done step
  doneEmoji: { fontSize: 48, marginBottom: 16 },
  doneIconWrap: { marginBottom: 16 },
  doneTitle: { fontSize: 17, fontFamily: 'Inter_700Bold', color: Colors.text1, textAlign: 'center', marginBottom: 8 },
  doneSub: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text2, textAlign: 'center', lineHeight: 20 },
});
