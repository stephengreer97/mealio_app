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
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import WebView, { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import FloatingPreviewImage from './FloatingPreviewImage';
import ProductImageViewer from './ProductImageViewer';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/colors';
import { Meal } from '../types';
import { STORES } from '../constants/stores';
import { getStoreScripts, StoreScripts } from '../lib/webview-scripts';
import { isAuthRedirectUrl } from '../lib/webview-scripts/auth-urls';
import { useLoginPrewarm } from '../context/LoginPrewarmContext';
import { getStoreWebViewUA } from '../lib/webview-user-agent';
import { WEBVIEW_FINGERPRINT_SHIM } from '../lib/webview-fingerprint-shim';
import { usage } from '../lib/api';
import {
  ConsolidatedIngredient,
  consolidateIngredients,
} from '../lib/consolidateIngredients';
import { ingredientAmount } from '../lib/formatMeasurement';
import { isChooseRun as isChooseRunItems } from '../lib/chooseRun';
import { ingredientWeight, weightLabelLb } from '../lib/weightDisplay';
import { useParallelSearchPool } from '../lib/useParallelSearchPool';
import { usePresearchAddPool, PresearchItem } from '../lib/usePresearchAddPool';
import { useDraggablePreview } from '../lib/useDraggablePreview';
import { buildSearchAndAddWorker, buildPresearchWorker } from '../lib/webview-scripts/worker-search';
import { FEATURE_PARALLEL_ADD, PARALLEL_ADD_WORKERS, FEATURE_PRESEARCH_ADD, ADD_COMMIT_JITTER_MS } from '../constants/features';
import Constants from 'expo-constants';
import { getAutomationConfig, getConfigVersion } from '../lib/automation-config';
import { setLastAutomationRun } from '../lib/lastAutomationRun';
import { AutomationTelemetry, createNoopTelemetry, addFailureCode, blockFailureCode } from '../lib/automation-telemetry';
import { buildCartCountScript, getCartPageUrl, buildCartPageCountScript, buildOpenCartScript, buildInlineCartScript, diffCartItems, CartItem, CartRow } from '../lib/webview-scripts/cart-count';
import { HebAddConfirmation } from '../lib/webview-scripts/heb-cart-query';
import { auditCartAfterRun, dropExplainedOverAdds, isWeightPriced, isZeroedOut, reconcileFromWorkerReports, reconcileParallelAdd, shouldProbeAfterRun, splitTopUpsForReview, summarizeConfirmations, toIntendedItem, AttemptedAdd, OverAdd } from '../lib/cart-reconcile';
import { ConfirmedSource, RequestedCount, RunKind, correctConfirmedFromCart, countRequested, isRunComplete } from '../lib/north-star';
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
  /** Store's own product id, when the extractor can see one. Present on HEB
   *  candidates read from __NEXT_DATA__ (MEAL-13); the DOM scrapers have no id in
   *  the card markup and leave both of these undefined. Needed by MEAL-14. */
  productId?: string | null;
  /** Store's SKU id, same availability caveat as productId. */
  skuId?: string | null;
}

/**
 * MEAL-119: a count-ordered item whose cart line came back sold-by-weight.
 *
 * Not "we could not add it" — the store may well have added it, as a single line
 * at some poundage we cannot compare to a ×3. Both machine answers are wrong
 * here: re-adding the shortfall unattended buys the deli meat a second time, and
 * confirming it off that line hands the user one slice and reports the order
 * complete. So the item is asked about instead. See splitTopUpsForReview.
 */
const IN_CART_BY_WEIGHT = 'in_cart_by_weight';

interface SearchResult {
  term: string;
  candidates: Candidate[];
  mealIngredients: MealIngredientQty[];
  unit: string;
  measure: string | null;
  reason: 'out_of_stock' | 'no_results' | 'low_confidence' | 'needs_weight' | typeof IN_CART_BY_WEIGHT;
  isChoose: boolean; // true = choose-product flow (no searchTerm yet); false = review unmatched (searchTerm set but no match)
}

/**
 * Build the review card for one in-cart-by-weight item.
 *
 * The card renders from `candidates`, and the worker that added this item has
 * none to give: H-E-B's success message carries no product list, so routing the
 * item to review with the worker's (empty) candidates would draw a card with
 * nothing named and nothing to press — trading a double purchase for a silent
 * non-delivery. So the cart row itself becomes the candidate. It is not a search
 * result and it is not pretending to be one: the name is the line the cart
 * actually holds, which is exactly what the user needs to recognise.
 *
 * `isWeightItem` stays FALSE deliberately. The item's intent is a unit count (a
 * stepper-weight deli item has no purchaseWeight — see isWeightPriced), so the
 * qty stepper must read in units and an intentional top-up must add units, the
 * same thing the automatic one would have added. Marking it weight would turn
 * the stepper into a poundage picker and persist a made-up purchaseWeight.
 */
export function inCartByWeightReview(
  item: Pick<ConsolidatedIngredient, 'searchTerm' | 'ingredientName' | 'unit' | 'measure'> & {
    mealIngredients: MealIngredientQty[];
  },
  cartName: string,
): SearchResult {
  return {
    term: item.searchTerm || item.ingredientName,
    candidates: [{
      productName: cartName,
      imageUrl: null,
      outOfStock: false,
      preferences: null,
      price: null,
      isWeightItem: false,
    }],
    mealIngredients: item.mealIngredients,
    unit: item.unit,
    measure: item.measure,
    reason: IN_CART_BY_WEIGHT,
    isChoose: false,
  };
}

// Result a parallel-add worker reports for one ingredient.
interface AddResult {
  success: boolean;
  productName: string | null;
  reason: string | null;
  candidates: Candidate[];
  /** MEAL-14: the cart's own verdict for this item, when the store has a cart
   *  query we can read. Null = no verdict, NOT a negative one. */
  confirm?: HebAddConfirmation | null;
}

/**
 * A cart verdict flattened into telemetry `detail` scalars (sanitizeDetail drops
 * nested objects, so a nested confirm would vanish silently). Empty when no rail
 * ran — an absent `confirmVia` in the funnel means the DOM decided, which is a
 * different row from a cart that answered.
 */
function confirmDetail(confirm: HebAddConfirmation | null | undefined): Record<string, unknown> {
  if (!confirm) return {};
  return {
    confirmVia: confirm.via,
    confirmState: confirm.state,
    confirmWhy: confirm.reason ?? undefined,
    confirmSku: confirm.skuId ?? confirm.productId ?? undefined,
  };
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

// Extra downward offset (px) for the floating preview's default rest in the Review
// Ingredients flow so it doesn't sit too high vs Choose Product. Tune on-device.
const REVIEW_PREVIEW_Y_OFFSET = 28;

// Cart-check copy for one over-added product: bare name, or "name ×N" when more
// than one unclaimed unit of it landed.
function overAddLabel(o: OverAdd): string {
  return o.qty > 1 ? `${o.name} ×${o.qty}` : o.name;
}

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

// ── In-cart-by-weight review card (MEAL-119) ──────────────────────────────────

/**
 * What happened, in the user's terms — the card's reason block.
 *
 * Says the three things only this state can say: the item IS in the cart, it is
 * there priced by weight, and *because* of that we cannot tell whether the amount
 * covers what the meal asked for. The last clause is the one that earns the
 * question: without it, "already in your cart" reads as done and the user has no
 * reason to look at the buttons.
 *
 * Exported so it can be rendered and read in a test — the copy is the feature
 * here, not decoration around it.
 */
export function InCartByWeightNote({ cartName }: { cartName: string | null }) {
  return (
    <View style={styles.noResultsBox} testID="in-cart-by-weight-note">
      <Text style={styles.noResultsTitle}>⚖ Already in your cart, priced by weight</Text>
      <Text style={styles.noResultsBody}>
        {cartName ? `Your cart has "${cartName}". ` : 'Your cart already has this item. '}
        It is charged by weight, so we cannot tell whether the amount there covers what your
        meal needs — and we did not add any more. Keep it as it is, or add more yourself.
      </Text>
    </View>
  );
}

/**
 * The card's buttons for this state, which is the whole point of MEAL-119.
 *
 * Neither of the two outcomes this ticket rejected is reachable from here:
 *
 *   • Nothing is confirmed silently. "Keep what's in my cart" is a press, on a
 *     card the user had to be shown to reach.
 *   • Nothing is re-added automatically, or at the full quantity by default. The
 *     top-up button is inert until the user raises the stepper above this footer
 *     off its 0. Guarded twice — `disabled` for the finger and a check inside
 *     onPress for everything else — because a re-add here spends the user's money
 *     a second time.
 *   • Skip stays exactly where it is on every other review card.
 *
 * The top-up deliberately does NOT promise a number of units, though the stepper
 * above it counts in whole numbers. This item's cart line came back sold by
 * weight, which is precisely the shape whose Add button opens H-E-B's weight
 * picker, and that picker resolves a bare qty to the qty-th weight option (see
 * handleWeightDropdown) — one line at that weight, never N pieces. "Add 3 more"
 * would therefore assert a count the store does not honour, and it would be wrong
 * in the direction that costs money. Instead the copy says what is actually true
 * of every branch: the store picks the amount from the weights it sells, and a
 * bigger number asks it for a bigger one.
 *
 * Every button goes inert while a custom product search is in flight. Advancing
 * mid-search is how the previous item's results end up offered on the next item's
 * card — the in-flight SEARCH_RESULT lands wherever the review has got to.
 *
 * There is deliberately no "Add & Update Meal Ingredient": the candidate on this
 * card is synthesized from a cart line (see inCartByWeightReview), not chosen
 * from search results, so saving it as the ingredient's product for all future
 * runs would persist a guess.
 */
export function InCartByWeightActions({
  addQty,
  storeColor,
  searching,
  customTermMissing,
  onKeep,
  onAddMore,
  onSkip,
  onBack,
}: {
  /** Units the stepper is currently set to add. 0 = nothing chosen yet. */
  addQty: number;
  storeColor: string;
  /** A custom product search is in flight. Nothing may be decided until it
   *  resolves — advancing sends its result to the wrong card. */
  searching: boolean;
  /** "Other — type a product name…" is selected with an empty box, so the add has
   *  no term to search and no product to add: it would return doing nothing. */
  customTermMissing: boolean;
  onKeep: () => void;
  onAddMore: () => void;
  onSkip: () => void;
  /** Omitted on the first review item, which has nothing to go back to. */
  onBack?: () => void;
}) {
  const canAddMore = addQty > 0 && !searching && !customTermMissing;
  return (
    <>
      <TouchableOpacity
        testID="keep-cart-weight-line"
        onPress={() => { if (!searching) onKeep(); }}
        disabled={searching}
        style={[styles.primaryBtn, { backgroundColor: storeColor }, searching && { opacity: 0.4 }]}
      >
        <Text style={styles.primaryBtnText}>
          {searching ? 'Searching…' : "That's enough — keep my cart as is"}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="add-more-anyway"
        onPress={() => { if (canAddMore) onAddMore(); }}
        disabled={!canAddMore}
        style={[styles.secondaryBtn, { borderColor: storeColor }, !canAddMore && { opacity: 0.4 }]}
      >
        <Text style={[styles.secondaryBtnText, { color: storeColor }]}>
          {searching
            ? 'Searching…'
            : customTermMissing
              ? 'Type a product name above to search'
              : addQty > 0
                ? 'Add more of this to my cart'
                : 'To add more, set an amount above'}
        </Text>
      </TouchableOpacity>
      {canAddMore && (
        <Text style={styles.qtyHint} testID="add-more-weight-caveat">
          This line is priced by weight, so the store picks the size — a bigger number
          above asks it for a bigger amount, up to the largest it sells. We can't
          promise an exact quantity.
        </Text>
      )}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {onBack && (
          <TouchableOpacity
            testID="in-cart-by-weight-back"
            onPress={() => { if (!searching) onBack(); }}
            disabled={searching}
            style={[styles.skipBtn, { flex: 1, borderWidth: 1, borderColor: Colors.border, borderRadius: 12 }, searching && { opacity: 0.4 }]}
          >
            <Text style={styles.skipBtnText}>← Back</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          testID="in-cart-by-weight-skip"
          onPress={() => { if (!searching) onSkip(); }}
          disabled={searching}
          style={[styles.skipBtn, { flex: 1 }, searching && { opacity: 0.4 }]}
        >
          <Text style={styles.skipBtnText}>Skip this ingredient</Text>
        </TouchableOpacity>
      </View>
    </>
  );
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
  // Android-only client-hint/fingerprint normalization, injected before store JS.
  // No-op on iOS (no navigator.userAgentData), and we deliberately inject NOTHING
  // before content on iOS — an injected before-content script is itself a signal to
  // aggressive bot defenses (e.g. Walmart/PerimeterX). No app-banner suppression:
  // that DOM/localStorage tampering tripped WAF blocks and was removed.
  const beforeContent = Platform.OS === 'android' ? WEBVIEW_FINGERPRINT_SHIM : undefined;

  // Silent login pre-warm result (session cache). When we already know the user
  // is logged OUT of this store, we skip the login_check round-trip and surface
  // the login prompt immediately at add-to-cart time.
  const loginPrewarm = useLoginPrewarm();

  const [step, _setStep] = useState<Step>('qty');
  const stepRef = useRef<Step>('qty');
  const setStep = useCallback((s: Step) => { stepRef.current = s; _setStep(s); }, []);

  // ── Remote automation config ───────────────────────────────────────────────
  // Timeouts, worker counts, and flags come from the remote config (bundled
  // defaults until a push lands), so we can retune the engine against a store
  // that has gotten slower — or throttle it against a WAF — without a release.
  // Snapshotted once per open rather than read per use: a config refresh landing
  // mid-run must not change a timeout the run already started measuring against.
  const cfgTimeouts = useMemo(() => getAutomationConfig().timeouts, [visible]);
  const cfgFlags = useMemo(() => getAutomationConfig().flags, [visible]);
  const cfgTelemetry = useMemo(() => getAutomationConfig().telemetry, [visible]);

  // Usage analytics for the WebView automation run (best-effort). Covers both the
  // background (startJob) and direct (setWebViewCartVisible) entry paths since it
  // lives in the sheet. One run per visible open: started -> completed on 'done'.
  const automationRunIdRef = useRef<string | null>(null);
  const automationStartedRef = useRef(false);
  const automationCompletedRef = useRef(false);
  // Which open of the sheet we are on. logAutomationStart is a round trip
  // (~100-500ms) and the close path below re-arms automationStartedRef, so a
  // close-then-reopen puts two starts in flight at once: open HEB, close before
  // the response lands, open Walmart. If HEB's response arrives second, its
  // `.then()` would install HEB's runId and — worse — a recorder keyed to HEB,
  // so Walmart's steps would upload under HEB's run. Closing bumps this, and a
  // `.then()` from a superseded open bails out instead of writing anything.
  //
  // Assumes no StrictMode — there is none in this app today. Under one, the dev
  // double-invoke would mount, unmount and remount, bumping the generation
  // between the capture below and the response landing, so a legitimate first run
  // would silently lose both its runId and its telemetry recorder in dev only.
  // Anyone adding StrictMode has to key this off something the remount preserves.
  const automationGenRef = useRef(0);

  // Per-step funnel telemetry (see lib/automation-telemetry.ts). A ref, not state,
  // because the message handler records steps synchronously and must never wait a
  // render to get a live recorder. Starts as a no-op so every call site can fire
  // unconditionally — no null checks scattered through the engine.
  const telemetryRef = useRef<AutomationTelemetry>(createNoopTelemetry());
  /** Stable accessor for the recorder. Cheap enough to call on every step. */
  const tel = useCallback(() => telemetryRef.current, []);

  useEffect(() => {
    if (visible) {
      if (!automationStartedRef.current) {
        automationStartedRef.current = true;
        const gen = automationGenRef.current;
        usage
          .logAutomationStart({
            storeId,
            source: 'app',
            mealCount: meals.length,
            // Attribute the run to the config + build that produced it, so a
            // confirm-rate regression is traceable to a specific config push.
            configVersion: getConfigVersion(),
            appVersion: Constants.expoConfig?.version ?? undefined,
            platform: Platform.OS === 'ios' ? 'ios' : 'android',
          })
          .then((id) => {
            // This open was abandoned while the request was in flight. Every
            // write below would name a run nobody is watching — and the recorder
            // would misfile the CURRENT open's steps under it.
            if (gen !== automationGenRef.current) return;
            automationRunIdRef.current = id;
            // Hand the id to the bug-report path too (MEAL-142). The console
            // buffer already captures what reproduces a failure; this is the key
            // that ties it to the rows this run is about to upload.
            if (id) setLastAutomationRun(id, storeId);
            // The recorder can only exist once the server has issued a runId —
            // steps are keyed to it. Steps emitted before this lands are dropped
            // by the no-op recorder, which is why login_check (the earliest step)
            // is recorded on its RESULT rather than at its start.
            if (id) {
              telemetryRef.current = new AutomationTelemetry({
                runId: id,
                upload: usage.logAutomationSteps,
                enabled: cfgTelemetry.enabled,
                sampleRate: cfgTelemetry.sampleRate,
                batchSize: cfgTelemetry.batchSize,
                flushIntervalMs: cfgTelemetry.flushIntervalMs,
                configVersion: getConfigVersion(),
                appVersion: Constants.expoConfig?.version ?? undefined,
                platform: Platform.OS === 'ios' ? 'ios' : 'android',
              });
            }
          });
      }
    } else {
      // Retire this open before re-arming the start below, so a response still
      // in flight for it can no longer write anything.
      automationGenRef.current += 1;
      automationStartedRef.current = false;
      automationCompletedRef.current = false;
      automationRunIdRef.current = null;
      // Flush on close. The sheet closing is the normal end of a run, and the
      // terminal steps are the most valuable rows in the funnel.
      const prev = telemetryRef.current;
      telemetryRef.current = createNoopTelemetry();
      void prev.dispose();
    }
  }, [visible, storeId, meals.length, cfgTelemetry]);

  // Being unmounted is an abandonment too, and it is the one that matters most:
  // the live mount site (CartJobContext, FEATURE_BACKGROUND_CART) renders this
  // with `visible` hardcoded true and ends a run by dropping the job, so the
  // close branch above never runs there. The refs it would have reset die with
  // the component anyway — but setLastAutomationRun writes module state that
  // outlives it, so a response landing after teardown could still name a run
  // nobody is watching. Its own effect, not a cleanup on the one above, which
  // would fire on every dependency change and cancel a legitimate start.
  useEffect(() => () => { automationGenRef.current += 1; }, []);

  // Step: qty
  const [items, setItems] = useState<ConsolidatedIngredient[]>([]);
  const [checkedItems, setCheckedItems] = useState<boolean[]>([]);

  // Step: searching / adding
  const [searchingLabel, setSearchingLabel] = useState('');
  const [webviewUri, setWebviewUri] = useState('');
  // Measured size of the live-browser region, used to size the tile grid so the
  // main WebView + active worker WebViews fit as a 2-up/2-down grid without the
  // page scrolling. 0 until the first onLayout.
  const [browserAreaSize, setBrowserAreaSize] = useState({ w: 0, h: 0 });
  // Mirror of webviewUri for navTo (a []-dep callback). Lets it tell "navigate
  // to a new URL" from "reload the same URL" without the cache-buster query.
  const webviewUriRef = useRef('');
  // Set to the HTTP status (e.g. 'http-403') when the store blocks us with an
  // anti-bot response. Reuses the robot_challenge step UI but swaps the banner
  // and shows a manual "Try again" button. Null = not blocked.
  const [blockReason, setBlockReason] = useState<string | null>(null);
  // Synchronous mirror of blockReason for onLoadEnd (a []-dep callback that
  // reads refs). Set the instant a block is detected so the very next onLoadEnd
  // for the 403 page does NOT auto-resume — that resume re-navigated and
  // re-blocked, which was the tight 403 loop.
  const blockReasonRef = useRef<string | null>(null);
  // Amazon Fresh only: set when a search reports the "no results … in Amazon Fresh"
  // empty-state (see FRESH_EMPTY_STATE_FN). Means the account has no Fresh store /
  // serviceable delivery address. Checked at the end-of-search gates so we surface
  // the "choose a store" prompt only when the WHOLE run came up empty (not a single
  // genuine miss). Reset on open + on retry.
  const freshStoreUnavailableRef = useRef(false);
  // Latest handleStoreUnavailable, called from the []-dep search-finish callbacks
  // (finishParallelSearch / navigateToSearchItem) without pulling it into their deps
  // — it's defined later in the component, so a direct dep would hit the TDZ.
  const handleStoreUnavailableRef = useRef<() => void>(() => {});

  // Step: review
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [selectedSuggIdx, setSelectedSuggIdx] = useState<number | 'custom'>(0);
  const [selectedPreference, setSelectedPreference] = useState<string | null>(null);
  const [reviewMealQtys, setReviewMealQtys] = useState<Record<number, Record<string, number>>>({});
  const [pickedItems, setPickedItems] = useState<PickedItem[]>([]);
  // Draggable floating product-preview thumbnail (88x88, rests 12px from the
  // right). Tapping it opens the full-screen viewer (MEAL-64).
  const [viewerOpen, setViewerOpen] = useState(false);
  const preview = useDraggablePreview(88, 88, 12, () => setViewerOpen(true));
  // Re-center the thumbnail on each new ingredient being reviewed. The Review
  // Ingredients flow rests slightly lower than Choose Product — its search box has
  // a reason line above it, so the centered default otherwise reads as too high.
  useEffect(() => {
    const rev = searchResultsRef.current[reviewIdx];
    preview.setDefaultOffset(rev && !rev.isChoose ? REVIEW_PREVIEW_Y_OFFSET : 0);
    // Close the viewer on the way to the next ingredient — it would otherwise
    // stay up showing the previous product's photo.
    setViewerOpen(false);
    preview.reset();
  }, [reviewIdx, preview.reset, preview.setDefaultOffset]);
  // Ingredients the user explicitly skipped during review, keyed by reviewIndex
  // so re-deciding after Back clears the earlier skip. Reported on the done
  // snapshot — distinct from items the automation failed to add.
  const [skippedByIdx, setSkippedByIdx] = useState<Record<number, string>>({});
  // MEAL-119: in-cart-by-weight items the user decided were already covered by
  // the cart line, keyed the same way. Held apart from both `addResults` and
  // `skippedByIdx` because it is neither: Mealio did not add this, so it cannot
  // be counted as added, and the user did not pass it over either — they looked
  // at the cart line and said it was enough. The value is the cart line's name.
  const [keptByIdx, setKeptByIdx] = useState<Record<number, string>>({});
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
  const CART_PROBE_TIMEOUT_MS = cfgTimeouts.cartProbeMs;
  // Safety net for the after/reconcile probe: if CART_COUNT never posts (a cart
  // page that loops or never hydrates), retry once then finalize so reconcile
  // can't wait forever.
  const cartProbeResultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cartProbeRetriedRef = useRef(false);
  const CART_PROBE_RESULT_TIMEOUT_MS = cfgTimeouts.cartProbeResultMs;
  // The done-screen breakdown spinner falls back to the plain list after this,
  // so a cart page that never loads/counts (e.g. Amazon's multi-hop cart) can't
  // hang on "Updating your … cart" forever.
  const CART_ROWS_TIMEOUT_MS = cfgTimeouts.cartRowsMs;
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
  // Names of items that could not be added, shown on the done screen so the
  // failure is specific ("Sour Cream could not be added") instead of a bare count.
  const [failedNames, setFailedNames] = useState<string[]>([]);

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
  const ADD_TIMEOUT_MS = cfgTimeouts.addMs;
  // Same safety net for navigateToSearchItem — the search+add (combined) and
  // choose-product flows both go through it, and if buildSearchScript hangs
  // (bad selectors, SPA submit fails AND fallback nav fails, …) we'd otherwise
  // never advance. Cleared when SEARCH_RESULT or SEARCH_AND_ADD_RESULT arrives.
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SEARCH_TIMEOUT_MS = cfgTimeouts.searchMs;
  // Safety net for the Review/Choose custom search. If the user-typed search
  // never posts a SEARCH_RESULT (page reload-loops, WAF re-challenge, SPA submit
  // swallowed), customSearching would stay true forever and every review button
  // is disabled — wedging the user with no way out but closing the sheet.
  const customSearchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const CUSTOM_SEARCH_TIMEOUT_MS = cfgTimeouts.customSearchMs;
  // Same safety net for the login check. If CHECK_LOGIN never posts a
  // LOGIN_STATUS (page hung, WAF interstitial swallowed the script, store
  // changed its DOM), fall back to showing the login WebView — the same
  // behavior as an explicit "not logged in" — instead of spinning forever.
  const loginCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LOGIN_CHECK_TIMEOUT_MS = cfgTimeouts.loginCheckMs;
  // Tracks which search idx to resume from after a robot/captcha challenge
  // (Walmart redirects to /blocked when it suspects automation; user has to
  // press-and-hold to verify). -1 when no challenge in progress.
  const robotChallengeResumeIdxRef = useRef<number>(-1);
  // Consecutive sequential search/add timeouts (no result posted at all). A
  // single stall advances that one item (it may genuinely hang once); but a run
  // of them means Mealio can't drive the store — a nudge/interstitial/captcha is
  // eating clicks, or the store is soft-blocking — so we surface the generic
  // blocker instead of silently failing every item. Reset by any real progress.
  const consecutiveTimeoutsRef = useRef(0);
  const CONSECUTIVE_TIMEOUT_BLOCK = cfgTimeouts.consecutiveTimeoutBlock;
  // Tracks which step we were in before a login redirect, so we can resume after login.
  const stepBeforeLoginRef = useRef<Step>('searching');
  const loginCheckActiveRef = useRef(false);
  const searchIdxRef = useRef(0);
  const addingIdxRef = useRef(0);
  const addingItemsRef = useRef<PickedItem[]>([]);
  const addResultsRef = useRef<{ name: string; success: boolean; reason?: string }[]>([]);
  // Adds ATTEMPTED this run — one per item that reached an add click, whatever
  // the store said back. Incremented wherever the funnel's `add_click` row is
  // emitted, so the two can never drift. This, not the reported-success count,
  // is what arms the after-snapshot: a run whose adds all reported failure is
  // the run most in need of a look at the real cart (MEAL-47).
  const addsAttemptedRef = useRef(0);
  // Compile the failed-item names (and log their reasons) for the done screen.
  // Called at each point the flow finalizes into 'done' with failures.
  const compileFailedNames = useCallback(() => {
    const failures = addResultsRef.current.filter((r) => !r.success);
    if (failures.length > 0) {
      console.log(`[Cart ${ts()}]`, 'failed adds:', JSON.stringify(failures.map((f) => ({ name: f.name, reason: f.reason ?? 'unknown' }))));
    }
    setFailedNames(failures.map((f) => f.name));
  }, []);
  const activeItemsRef = useRef<ConsolidatedIngredient[]>([]);
  // ── North-star metric (MEAL-3) ─────────────────────────────────────────────
  // The DENOMINATOR, counted once when the add phase commits its item set. It
  // cannot be read off activeItemsRef at run_summary time: the parallel
  // reconcile's top-up reassigns that ref to the retry subset, which would shrink
  // the denominator down to exactly the items that went wrong and report the
  // worst runs as perfect. See lib/north-star.ts for what counts as requested.
  const requestedRef = useRef<RequestedCount>({ requested: 0, weightRequested: 0 });
  // Does this run touch a cart at all? 'choose' runs save which product to buy
  // and add nothing, so they are excluded from both rates whole rather than
  // scored as a zero.
  //
  // NOT the same predicate as isChooseRun(items), and deliberately so. That one
  // asks about the user's whole selection and titles the screen (MEAL-84); this
  // one asks what THIS run does to a cart. They disagree on a mixed selection:
  // some items chosen, some not. There, isChooseRun is false (the screen says
  // "Add to Cart") while the run itself only ever searches the unchosen items and
  // adds nothing — so for the metric it is a choose run. Tying the metric to the
  // title instead would score that run 0-of-N against a cart it never touched.
  const runKindRef = useRef<RunKind>('add');
  // Set only when the run's final added-count came from a per-item CART diff.
  // False leaves the count as the store scripts' own success flags, which MEAL-47
  // showed are wrong in both directions — the run still reports its number, but
  // labelled `worker_reports` so the dashboard knows not to stand on it.
  const cartReconciledRef = useRef(false);
  // Parallel-add reconciliation: results from the concurrent pass (by item idx)
  // and a one-shot arm so the after-snapshot re-adds the genuinely-missing items
  // (false positives from the shared cart counter) sequentially, exactly once.
  const parallelResultByIdxRef = useRef<Map<number, AddResult>>(new Map());
  // The FULL intended add set (every item we tried to add, with expected qty),
  // captured before the retry top-up narrows activeItemsRef to the retry subset.
  // Used by the final cart check to flag over-adds / unintended additions.
  const reconcileIntendedRef = useRef<{ name: string; expectedQty: number; isWeight: boolean }[]>([]);
  // MEAL-119: the cart titles this run put to the user as in-cart-by-weight
  // questions. Held in a ref because the only readers are inside onMessage (deps
  // []), and both of the reconcile's exits need them: neither the reconcile's own
  // over-add warning nor the after-probe's may call one of these lines something
  // "Mealio didn't intend to add" — see dropExplainedOverAdds.
  const askedCartNamesRef = useRef<string[]>([]);
  const parallelReconcileArmedRef = useRef(false);
  // Set when the reconcile probe finalized using its own cart read, so the
  // 'done' effect doesn't fire a redundant second after-probe.
  const reconcileFinalizedRef = useRef(false);
  // Marks a parallel-add run for the progress effect: >0 means the parallel pass
  // ran, so post-parallel progress uses the 85/15 split (parallel 0–85%, cart-check
  // + top-up 85–100%). 0 = not a parallel run → normal per-item progress.
  const parallelOriginalTotalRef = useRef(0);
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

  // MEAL-13 rollout evidence. The extractor's chosen source ('next_data' | 'dom')
  // rides on SEARCH_RESULT, but WHY it chose it — 'ok', 'stale', 'no_next_data',
  // 'unverifiable', 'empty', 'threw' — travels separately, on the EXTRACT_DEBUG it
  // posts just before. Without the reason, every fallback collapses into
  // source: 'dom' and the funnel cannot tell "HEB removed the payload" from "the
  // freshness gate declined", which are the two outcomes the flag exists to
  // measure. Stash it per search surface and attach it to the candidates row.
  // Keyed by worker id; the main WebView uses MAIN_SURFACE.
  const MAIN_SURFACE = -1;
  const extractWhyRef = useRef<Record<number, string | null>>({});
  const takeExtractWhy = useCallback((surface: number): string | null => {
    const why = extractWhyRef.current[surface] ?? null;
    // Consume it: a stale reason attached to a LATER search would be worse than
    // none, since it would read as a measurement rather than a leftover.
    delete extractWhyRef.current[surface];
    return why;
  }, []);

  /**
   * Record the `candidates` funnel row for a search that ran in a WORKER WebView.
   *
   * The main WebView records its own row inline in onMessage; the two worker pools
   * recorded nothing, so the funnel only ever saw sequential searches — and the
   * parallel pools are where most searching happens. `source`/`why` in particular
   * are the MEAL-13 rollout comparison, which is the whole point of the flag.
   *
   * No itemIndex: the worker↔item mapping lives inside the pool's state machine,
   * and a guessed index would be worse than an absent one. `path` and `workerId`
   * identify the surface instead.
   */
  const recordWorkerCandidates = useCallback(
    (path: 'parallel' | 'presearch', workerId: number, msg: { candidates?: unknown; source?: string | null; storeUnavailable?: boolean }) => {
      const count = Array.isArray(msg.candidates) ? msg.candidates.length : 0;
      const detail = {
        count,
        storeUnavailable: !!msg.storeUnavailable,
        source: msg.source ?? null,
        why: takeExtractWhy(workerId),
        path,
        workerId,
      };
      if (count > 0) tel().record('candidates', 'ok', { detail });
      else tel().record('candidates', 'empty', { detail, code: 'no_candidates' });
    },
    [tel, takeExtractWhy],
  );

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
  // Worker count + initial-dispatch stagger are per-store, overridable, but the
  // GLOBAL defaults are kept low for anti-bot reasons: 3 workers (was 5), and a
  // 400ms staggered dispatch so they don't all fire in one simultaneous burst.
  // The stagger also activates the pool's per-worker jitter (i*base + random),
  // so the request pattern isn't a fixed metronome.
  const PARALLEL_WORKER_COUNT = scripts?.workerCount ?? 3;
  const PARALLEL_WORKER_STAGGER_MS = scripts?.workerStaggerMs ?? 400;
  const PARALLEL_WORKER_TIMEOUT_MS = cfgTimeouts.parallelWorkerMs;
  // Parallel-ADD worker count: honor the per-store workerCount (a heavy store
  // like Albertsons crashed the iOS WKWebView content process with 5 concurrent
  // add WebViews), falling back to the global pilot default.
  const PARALLEL_ADD_WORKER_COUNT = scripts?.workerCount ?? cfgFlags.parallelAddWorkers ?? PARALLEL_ADD_WORKERS;
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

  // ── Pre-search parking pool (FEATURE_PRESEARCH_ADD) ─────────────────────────
  // While the user is still on the qty screen and known-logged-in, workers park
  // on their loaded results pages. On the add-to-cart tap we inject the existing
  // buildSearchAndAddScript straight into each parked page (it operates on the
  // already-loaded results, so no re-search), jittered so N adds don't fire in
  // one burst. Deselected items are dropped; overflow rolls on as workers free.
  const presearchWorkerRefs = useRef<(WebView | null)[]>(new Array(PARALLEL_ADD_WORKER_COUNT).fill(null));
  const presearchStartedRef = useRef(false);
  // Armed at the add-to-cart tap when parked workers exist: the normal
  // login_check → before-snapshot flow still runs (so the cart baseline is
  // captured and the reconcile is correct), and beginSearchFlow then commits the
  // parked adds instead of spinning up the fused add pool. Entries carry each
  // selected item's original index so the pool matches its parked worker.
  const presearchCommitArmedRef = useRef(false);
  const presearchCommitEntriesRef = useRef<PresearchItem<ConsolidatedIngredient>[]>([]);
  // The cold slot (the main cart WebView, enlisted as a 4th add surface once it's
  // done snapshotting). Index sits just past the parked workers.
  const COLD_SLOT_IDX = PARALLEL_ADD_WORKER_COUNT;
  const mainColdActiveRef = useRef(false);   // main is running a cold search+add
  const mainColdSlotRef = useRef<number>(COLD_SLOT_IDX);
  const mainColdItemRef = useRef<ConsolidatedIngredient | null>(null);
  const mainColdInjectedRef = useRef(false);  // fused add injected for the current item
  const presearchOnInjectAdd = useCallback((workerId: number, item: ConsolidatedIngredient) => {
    const ref = presearchWorkerRefs.current[workerId];
    const s = scriptsRef.current;
    if (!ref || !s?.buildSearchAndAddScript) return;
    const term = item.searchTerm ?? item.ingredientName;
    const script = s.buildSearchAndAddScript(term, item.productQty, item.dropdown ?? null);
    const jitter = ADD_COMMIT_JITTER_MS + Math.floor(Math.random() * ADD_COMMIT_JITTER_MS);
    console.log(`[Cart ${ts()}]`, 'presearch commit: worker', workerId, 'term=', term, 'in', jitter, 'ms');
    setTimeout(() => { presearchWorkerRefs.current[workerId]?.injectJavaScript(script); }, jitter);
  }, []);
  // Cold slot dispatch: point the main WebView at the overflow item's results
  // page. The fused add is injected once it loads (see onLoadEnd's cold branch),
  // and its result is fed back via onMessage → reportAdded.
  const presearchOnColdDispatch = useCallback((slot: number, item: ConsolidatedIngredient) => {
    const s = scriptsRef.current;
    if (!s?.getSearchUrl) return; // no search URL → the pool's add timeout settles it
    const term = item.searchTerm ?? item.ingredientName;
    mainColdActiveRef.current = true;
    mainColdSlotRef.current = slot;
    mainColdItemRef.current = item;
    mainColdInjectedRef.current = false;
    const url = s.getSearchUrl(term);
    console.log(`[Cart ${ts()}]`, 'presearch COLD (main webview) → search', term);
    setWebviewUri(url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now());
  }, []);
  const presearchPool = usePresearchAddPool<ConsolidatedIngredient, AddResult>({
    workerCount: PARALLEL_ADD_WORKER_COUNT,
    coldWorkerCount: FEATURE_PRESEARCH_ADD ? 1 : 0,
    searchTimeoutMs: 25_000,
    addTimeoutMs: 35_000,
    getUrl: (item) => {
      const s = getStoreScripts(lockedStoreIdRef.current);
      const term = item.searchTerm ?? item.ingredientName;
      return s?.getSearchUrl ? s.getSearchUrl(term) : '';
    },
    emptyResult: () => ({ success: false, productName: null, reason: 'timeout', candidates: [] }),
    onInjectAdd: presearchOnInjectAdd,
    onColdDispatch: presearchOnColdDispatch,
  });

  // The cold slot is done (queue drained) → release the main WebView back to the
  // cart engine for the reconcile. Cleared synchronously enough that the reconcile
  // nav that follows finishParallelAdd isn't mistaken for a cold search page.
  useEffect(() => {
    if (mainColdActiveRef.current && !presearchPool.workerUris[COLD_SLOT_IDX]) {
      mainColdActiveRef.current = false;
    }
  }, [presearchPool.workerUris, COLD_SLOT_IDX]);

  const presearchScripts = useMemo(
    () => parallelCfg && scripts?.extractProductsScript
      ? new Array(PARALLEL_ADD_WORKER_COUNT).fill(0).map((_, i) => buildPresearchWorker(i, scripts.extractProductsScript))
      : [],
    [parallelCfg, scripts, PARALLEL_ADD_WORKER_COUNT],
  );
  const presearchSources = useMemo(
    () => presearchPool.workerUris.map((uri) => ({ uri: uri || 'about:blank' })),
    [presearchPool.workerUris],
  );

  const onPresearchWorkerMessage = useCallback((workerId: number, event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'WORKER_DEBUG') {
        // The wrappers re-tag the extractor's EXTRACT_DEBUG as WORKER_DEBUG, so
        // MEAL-13's ndReason arrives here — the ONLY place it can be read on this
        // path. A bare `return` used to drop it, which left the presearch flow
        // (a real navigation straight to the results URL, i.e. where the JSON path
        // fires most reliably) as the one flow with no evidence at all.
        if (msg.step === 'next_data') extractWhyRef.current[workerId] = msg.ndReason ?? null;
        return;
      }
      if (msg.type === 'WORKER_RESULT') {
        if (msg.phase === 'search') {
          console.log(`[Cart ${ts()}]`, 'presearch PARKED w', workerId, 'candidates=', (msg.candidates ?? []).length, 'source=', msg.source ?? null);
          recordWorkerCandidates('presearch', workerId, msg);
          presearchPool.reportSearched(workerId);
        } else if (msg.phase === 'add') {
          console.log(`[Cart ${ts()}]`, 'presearch ADD result w', workerId, 'success=', msg.success, 'product=', msg.productName, 'cart=', msg.confirm ? `${msg.confirm.state}/${msg.confirm.reason}` : null);
          if (msg.storeUnavailable) freshStoreUnavailableRef.current = true;
          presearchPool.reportAdded(workerId, {
            success: !!msg.success, productName: msg.productName ?? null,
            reason: msg.reason ?? null, candidates: msg.candidates ?? [],
            confirm: msg.confirm ?? null,
          });
        }
      }
    } catch (e) {
      console.log(`[Cart ${ts()}]`, 'onPresearchWorkerMessage parse error w', workerId, e);
    }
  }, [presearchPool, recordWorkerCandidates]);

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
    // Split the parallel-add run so the ring never runs backward: the concurrent
    // pass owns the first 85%, and the cart-check + sequential top-up own the last
    // 15%. Previously the parallel pass reached 100% (completed/total) and the
    // reconcile baseline (confirmed/original, always ≤ that) snapped the ring back.
    const PARALLEL_ADD_SHARE = 0.85;
    let progress: number | null = null;
    if (step === 'done') {
      progress = 1;
    } else if (addPool.isActive) {
      // Parallel add: determinate, one tick per ingredient — capped at 85%.
      progress = addPool.total > 0 ? PARALLEL_ADD_SHARE * Math.min(1, addPool.completed / addPool.total) : null;
    } else if (presearchPool.isCommitting) {
      // Parked pre-search commit: same 0→85% ramp as the fused add pass (the
      // reconcile top-up below then fills 85→100). Without this it would hit the
      // parallelOriginalTotal branch and jump straight to 85%.
      progress = presearchPool.total > 0 ? PARALLEL_ADD_SHARE * Math.min(1, presearchPool.completed / presearchPool.total) : null;
    } else if (parallelPool.isActive) {
      progress = null;
    } else if (parallelOriginalTotalRef.current > 0 && (step === 'searching' || step === 'adding')) {
      // Post-parallel: the cart-check holds at 85% (no subset yet), then the
      // sequential top-up fills 85% → 100% across the reconcile subset (the current
      // active items). If nothing needs a top-up, the step flips to 'done' (→ 1).
      const retryCount = activeItemsRef.current.length;
      const frac = retryCount > 0 ? Math.min(1, processedCount / retryCount) : 1;
      progress = PARALLEL_ADD_SHARE + (1 - PARALLEL_ADD_SHARE) * frac;
    } else if (total > 0 && (step === 'searching' || step === 'adding')) {
      progress = Math.min(1, processedCount / total);
    }
    onStatusChange({ phase: step, kind: kindMap[step], label: labelMap[step], progress });
  }, [step, searchingLabel, storeName, onStatusChange, processedCount, parallelPool.isActive, addPool.isActive, addPool.completed, addPool.total, presearchPool.isCommitting, presearchPool.completed, presearchPool.total]);

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
    // Amazon Fresh: every item came back empty AND a search reported the Fresh
    // empty-state → no store/address selected. Surface the picker instead of a
    // review screen full of "No products found".
    if (
      lockedStoreIdRef.current === 'amazon' &&
      freshStoreUnavailableRef.current &&
      results.every((r) => r.candidates.length === 0)
    ) {
      handleStoreUnavailableRef.current();
      return;
    }
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
    console.log(`[Cart ${ts()}]`, 'parallel add: pass done. reported success=', successCount, 'of', active.length, '— reconciling against cart', 'freshStoreUnavailable=', freshStoreUnavailableRef.current);
    // Amazon Fresh: nothing added AND a worker saw the Fresh "no results" empty-
    // state → no store/address selected. Surface the picker instead of routing the
    // whole run to the "could not add" review. (Parallel-ADD path, which reconciles
    // against the cart rather than going through finishParallelSearch.)
    if (lockedStoreIdRef.current === 'amazon' && freshStoreUnavailableRef.current && successCount === 0) {
      handleStoreUnavailableRef.current();
      return;
    }
    parallelReconcileArmedRef.current = true;
    cartProbeRetriedRef.current = false;
    // Reset the per-item counter so the cart-check holds the ring at 85% and the
    // top-up fills the last 15% (see the progress effect).
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
        // Diagnostic (saa_*) steps carry a full DOM snapshot — don't truncate
        // those; keep the 200-char cap only for the noisy per-tick messages.
        const isDiag = typeof msg.step === 'string' && msg.step.indexOf('saa_') === 0;
        console.log(`[Cart ${ts()}]`, 'ADD WORKER_DEBUG w', workerId, isDiag ? JSON.stringify(msg) : JSON.stringify(msg).slice(0, 200));
        return;
      }
      if (msg.type === 'WORKER_RESULT') {
        console.log(`[Cart ${ts()}]`, 'ADD WORKER_RESULT w', workerId, 'success=', msg.success, 'product=', msg.productName, 'reason=', msg.reason ?? null, 'storeUnavailable=', !!msg.storeUnavailable, 'cart=', msg.confirm ? `${msg.confirm.state}/${msg.confirm.reason}` : null);
        // reason:'blocked' (app-nudge overlay) is recorded as a failed add here;
        // the reconcile's serial retry re-detects the nudge and surfaces it (the
        // serial SEARCH_AND_ADD_RESULT handler calls surfaceBlocker). Handling it
        // here would forward-reference surfaceBlocker (defined later) → TDZ.
        if (msg.storeUnavailable) freshStoreUnavailableRef.current = true;
        addPool.reportResult(workerId, {
          success: !!msg.success, productName: msg.productName ?? null,
          reason: msg.reason ?? null, candidates: msg.candidates ?? [],
          confirm: msg.confirm ?? null,
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
        // MEAL-13's extractor reason (see extractWhyRef), re-tagged by the wrapper.
        if (msg.step === 'next_data') extractWhyRef.current[workerId] = msg.ndReason ?? null;
        return;
      }
      if (msg.type === 'WORKER_RESULT') {
        console.log(`[Cart ${ts()}]`, 'WORKER_RESULT w', workerId, 'candidates=', (msg.candidates || []).length, 'source=', msg.source ?? null);
        if (msg.storeUnavailable) freshStoreUnavailableRef.current = true;
        recordWorkerCandidates('parallel', workerId, msg);
        parallelPool.reportResult(workerId, msg.candidates || []);
        return;
      }
    } catch (e) {
      console.log(`[Cart ${ts()}]`, 'onWorkerMessage parse error w', workerId, e);
    }
  }, [parallelPool, recordWorkerCandidates]);

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
      setViewerOpen(false);
      preview.reset();
      setSkippedByIdx({});
      // MEAL-119: reset alongside the skips. Harmless while FEATURE_BACKGROUND_CART
      // keeps this sheet keyed and conditionally mounted, but under the
      // !FEATURE_BACKGROUND_CART mount (MyMealsScreen) the component survives
      // between runs — run 2 would show run 1's kept line on its done screen and
      // ship a stale keptInReview on the funnel.
      setKeptByIdx({});
      setCustomText('');
      setCustomSearching(false);
      setCustomSuggestions([]);
      setCustomSearchTerm('');
      setTotalAdded(0);
      setProcessedCount(0);
      setTotalFailed(0);
      setAddedNames([]);
      setFailedNames([]);
      setBlockReason(null);
      blockReasonRef.current = null;
      freshStoreUnavailableRef.current = false;
      extractWhyRef.current = {};
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
      consecutiveTimeoutsRef.current = 0;
      onSearchPageRef.current = false;
      loginCheckActiveRef.current = false;
      searchIdxRef.current = 0;
      addingIdxRef.current = 0;
      addResultsRef.current = [];
      addsAttemptedRef.current = 0;
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
      if (cartProbeResultTimeoutRef.current) { clearTimeout(cartProbeResultTimeoutRef.current); cartProbeResultTimeoutRef.current = null; }
      parallelResultByIdxRef.current = new Map();
      reconcileIntendedRef.current = [];
      askedCartNamesRef.current = [];
      // North-star counters. 'add' is the default because it is the reading that
      // cannot silently hide a run: a shopping run mislabelled 'choose' would
      // vanish from the metric, while a choose run mislabelled 'add' shows up as
      // an obvious 0-of-0 that the requested===0 guard drops anyway.
      requestedRef.current = { requested: 0, weightRequested: 0 };
      runKindRef.current = 'add';
      cartReconciledRef.current = false;
      setCartResultRows(null);
      setCartRowsTimedOut(false);
      if (cartRowsTimeoutRef.current) { clearTimeout(cartRowsTimeoutRef.current); cartRowsTimeoutRef.current = null; }
      setCartDeltaWarning(null);

      // Reset Wegmans parallel worker state. The hook clears its queue,
      // active flag, timers, and worker URIs in one call — workers unmount
      // because isActive flips to false.
      parallelPool.reset(); addPool.reset(); presearchPool.reset(); presearchStartedRef.current = false; presearchCommitArmedRef.current = false; mainColdActiveRef.current = false; mainColdInjectedRef.current = false;

      // If any ingredient has no chosen product yet, skip the qty step and
      // auto-start the search/choose flow immediately.
      const hasUnchosen = consolidated.some((it) => !it.searchTerm);
      console.log(`[Cart ${ts()}]`, 'open: meals=', meals.length, 'consolidated=', consolidated.length, 'hasUnchosen=', hasUnchosen);
      if (hasUnchosen && consolidated.length > 0) {
        // Only search for ingredients that don't have a product chosen yet.
        const unchosen = consolidated.filter((it) => !it.searchTerm);
        const active = unchosen.filter((it) => it.productQty > 0);
        activeItemsRef.current = active.length > 0 ? active : unchosen;
        // No north-star outcome: this branch only ever searches the UNCHOSEN
        // items and the review it ends in offers "choose", not "add", so the run
        // adds nothing to a cart. Excluded whole — scoring it against a cart
        // would report a permanent 0% for a flow that did exactly what it was
        // asked to. Covers the mixed selection too (see runKindRef).
        runKindRef.current = 'choose';
        console.log(`[Cart ${ts()}]`, 'auto-start: active=', activeItemsRef.current.length, activeItemsRef.current.map(i => i.ingredientName));
        searchIdxRef.current = 0;
        if (loginPrewarm.getStatus(openStoreId) === 'loggedOut') {
          console.log(`[Cart ${ts()}]`, 'prewarm: known logged out — surfacing login directly');
          surfaceLoginDirect();
        } else {
          setStep('login_check');
          setSearchingLabel('Checking login…');
          loadQueueRef.current = [scriptsRef.current!.checkLoginScript];
          navTo(scriptsRef.current!.storeUrl);
          armLoginCheckTimeout();
        }
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

  // The checkbox reports INCLUSION, and qty 0 excludes an item just as firmly as
  // an unchecked box (MEAL-65). So a tap on a row that already reads unchecked
  // has to clear whichever of the two is excluding it: restoring the box alone
  // would leave a zeroed row still struck through and the tap looking dead.
  const toggleChecked = (i: number) => {
    const it = items[i];
    if (!it) return;
    const zeroed = isZeroedOut(it);
    if ((checkedItems[i] ?? true) && !zeroed) {
      setCheckedItems((prev) => prev.map((c, idx) => (idx === i ? false : c)));
      return;
    }
    setCheckedItems((prev) => prev.map((c, idx) => (idx === i ? true : c)));
    // Back to one unit — a re-checked row has to be worth running.
    if (zeroed) updateQty(i, 1);
  };

  const allChecked = checkedItems.length === 0 || checkedItems.every((c) => c);
  const toggleAll = () => setCheckedItems((prev) => prev.map(() => !allChecked));
  // A dropdown-weight item is active whenever it has a chosen weight; stepper
  // and normal items need productQty > 0. Same predicate the row's checkbox and
  // strikethrough read, so what the screen says matches what runs.
  const activeCount = items.filter((it, i) => (checkedItems[i] ?? true) && !isZeroedOut(it)).length;

  // Cart snapshot AFTER the run. Fires when the before-snapshot succeeded and
  // the run ATTEMPTED at least one add — see shouldProbeAfterRun for why the
  // reported-success count is the wrong gate. For cart-page stores (HEB)
  // navigate the now-idle webview to /cart and count there; otherwise read the
  // header badge off the last search page (still mounted through 'done').
  useEffect(() => {
    if (step !== 'done') return;
    // The reconcile pass already read the cart with its own probe and set the
    // final state — don't fire a redundant second after-probe.
    if (reconcileFinalizedRef.current) { reconcileFinalizedRef.current = false; return; }
    if (!shouldProbeAfterRun({
      addsAttempted: addsAttemptedRef.current,
      hasBaseline: cartCountBeforeRef.current != null,
    })) return;
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
    // ── North-star metric (MEAL-3) ───────────────────────────────────────────
    // itemsAdded is the NUMERATOR and `requested` the DENOMINATOR of the item
    // success rate; runComplete is the run success rate's numerator. Both counts
    // ship on the run row as well as on the funnel row: storeId lives on the run
    // row, so the per-store daily rates are computable there without joining
    // step rows at all, and the step row carries the qualifiers that say whether
    // the rate is safe to draw. See lib/north-star.ts for every definition.
    const { requested, weightRequested } = requestedRef.current;
    const kind = runKindRef.current;
    // Where the numerator came from, decided by how the run finalized rather than
    // by which store it was: `confirm` step rows are absent on four of six stores
    // (MEAL-122), so a store-keyed guess would be wrong for exactly the stores
    // that matter most. `requested === 0` is the choose-run / nothing-requested
    // case, which has no cart outcome to source.
    const confirmedSource: ConfirmedSource =
      kind === 'choose' || requested === 0
        ? 'none'
        : cartReconciledRef.current
          ? 'cart_reconcile'
          : 'worker_reports';
    const skippedInReview = Object.values(skippedByIdx).filter(Boolean).length;
    // MEAL-119: how many in-cart-by-weight questions the user answered with "the
    // line I have is enough". Counted apart from skips (which pass over an item
    // nobody has) and from itemsAdded (Mealio added nothing for these) — it is the
    // read side's only way to see whether asking was the right call.
    const keptInReview = Object.values(keptByIdx).filter(Boolean).length;
    if (runId) {
      usage.logAutomationComplete({
        runId,
        itemsAdded: totalAdded,
        // Already in the client contract for this endpoint and never populated
        // until now — this is the field the dashboard's denominator reads.
        itemsRequested: requested,
        outcome,
      });
    }
    // Funnel: one terminal row per run, then flush. dispose() sends whatever is
    // still buffered — without it a short run's steps would sit in the buffer
    // until the flush interval and be lost if the app is backgrounded.
    //
    // itemsAdded is deliberately NOT corrected for MEAL-47 recoveries here: the
    // after-probe that finds them has not run yet and must not be waited on (a
    // hung probe would cost the whole run its terminal row). A `reconcile` row
    // with phase 'north_star' follows when the probe finds anything, and the read
    // side coalesces — see the emission site in the CART_COUNT 'after' branch.
    const summaryDetail = {
      outcome,
      itemsAdded: totalAdded,
      cartDeltaWarning: !!cartDeltaWarning,
      kind,
      requested,
      confirmedSource,
      weightRequested,
      skippedInReview,
      keptInReview,
      runComplete: isRunComplete(requested, totalAdded),
    };
    if (outcome === 'failed') {
      // The run has no failure of its own — it failed because its steps did, so
      // it reports whichever code dominated them. A run that added nothing while
      // recording no coded failure at all is the parallel add path, whose workers
      // report through the pool and emit no step rows: confirm_failed is the only
      // thing still true there (adds were dispatched, nothing evidenced landing).
      const dominant = tel().dominantFailureCode();
      tel().record('run_summary', 'error', {
        detail: { ...summaryDetail, codeSource: dominant ? 'dominant' : 'fallback' },
        code: dominant ?? 'confirm_failed',
      });
    } else {
      tel().record('run_summary', 'ok', { detail: summaryDetail });
    }
    void tel().flush();
    // skippedByIdx / keptByIdx are read above; automationCompletedRef keeps this to
    // one firing per run whatever re-renders the extra dependencies cause.
  }, [step, totalAdded, cartDeltaWarning, skippedByIdx, keptByIdx, tel]);

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
      // Funnel: the missing half of login_check, which otherwise only ever
      // records the answer it got. 'timeout' rather than 'auth_required' because
      // login state is exactly what we failed to determine — the fallback shows
      // the login webview, but that's a guess, not a finding.
      tel().record('login_check', 'timeout', {
        durationMs: LOGIN_CHECK_TIMEOUT_MS, code: 'timeout',
      });
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

  // Skip the login_check round-trip and jump straight to the login webview.
  // Used when the silent pre-warm already told us the user is logged OUT of this
  // store, so we surface the sign-in prompt immediately instead of loading the
  // store page just to discover they're logged out. If the pre-warm was stale
  // and they're actually signed in, the store redirects off the login URL and
  // the 'login'-step onLoadEnd re-injects the check, which resumes automatically.
  const surfaceLoginDirect = useCallback(() => {
    // Funnel: the run stops at the login gate without ever running a login_check,
    // so without this row it would disappear from the funnel between the tap and
    // the first search.
    //
    // `ok`, not a failure, and this is the model all three logged-out paths use:
    // the OUTCOME describes whether we determined the login state, and
    // `isLoggedIn` in the detail says what we determined. Recording this one as
    // `error`/`auth_required` while the mainline LOGIN_STATUS answer below
    // records `ok` would split one real-world condition — user is signed out,
    // login WebView shown — across two outcomes, and would leave
    // `auth_required` counting only the paths that lose the race.
    //
    // Known limit: this fires from two call sites and only one of them has a
    // recorder yet. The auto-start path inside the `[visible]` effect runs in
    // the same commit phase as mount, while the recorder is installed in the
    // `.then()` of `logAutomationStart` — so a prewarm row from there is
    // dropped by the no-op recorder. Fixing that means queueing pre-runId
    // steps, which is its own change; until then `source: 'prewarm'` undercounts
    // and must not be read as a total.
    tel().record('login_check', 'ok', {
      detail: { isLoggedIn: false, source: 'prewarm' },
    });
    setStep('login');
    setSearchingLabel('Sign in to continue');
    lastLoadEndUrlRef.current = '';
    setWebviewUri(scriptsRef.current!.loginUrl);
  }, [setStep]);

  // Kick off pre-search parking while the user is still on the qty screen: the
  // silent pre-warm says they're logged in, the store supports parallel workers,
  // and every ingredient already has a chosen product (the regular add flow). A
  // mixed/unchosen set goes through the choose flow instead, so we skip it there.
  useEffect(() => {
    if (!FEATURE_PRESEARCH_ADD) return;
    if (step !== 'qty' || presearchStartedRef.current) return;
    if (!parallelCfg) return;
    if (loginPrewarm.getStatus(lockedStoreIdRef.current) !== 'loggedIn') return;
    const chosen: PresearchItem<ConsolidatedIngredient>[] = items
      .map((item, idx) => ({ idx, item }))
      .filter((e) => !!e.item.searchTerm);
    if (chosen.length === 0 || chosen.length !== items.length) return;
    presearchStartedRef.current = true;
    console.log(`[Cart ${ts()}]`, 'presearch: parking first', PARALLEL_ADD_WORKER_COUNT, 'of', chosen.length, 'chosen items');
    presearchPool.start(chosen);
    // loginPrewarm.statusVersion is in the deps so this re-runs the moment a slow
    // store's login check resolves logged-in while the user is still on qty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, items, parallelCfg, loginPrewarm.statusVersion]);

  const handleStartSearch = () => {
    const active = items.filter((it, i) => (checkedItems[i] ?? true) && !isZeroedOut(it));
    if (active.length === 0) return;
    activeItemsRef.current = active;
    // The north-star denominator, fixed here and never recounted. This is the
    // only gate a shopping run passes through, and it is the last moment the
    // full requested set exists in one place: the reconcile top-up reassigns
    // activeItemsRef to the retry subset later in the same run. Unchecked and
    // zeroed lines were already filtered out above — they were never requested.
    runKindRef.current = 'add';
    requestedRef.current = countRequested(active);
    searchIdxRef.current = 0;
    // Arm the parked-worker commit (if any). We still run the normal login +
    // before-snapshot path below; only the add step changes (see beginSearchFlow).
    if (FEATURE_PRESEARCH_ADD && presearchStartedRef.current) {
      presearchCommitEntriesRef.current = items
        .map((item, idx) => ({ idx, item }))
        .filter((e) => (checkedItems[e.idx] ?? true) && !isZeroedOut(e.item));
      presearchCommitArmedRef.current = presearchCommitEntriesRef.current.length > 0;
    }
    const pre = loginPrewarm.getStatus(lockedStoreIdRef.current);
    if (pre === 'loggedOut') {
      console.log(`[Cart ${ts()}]`, 'prewarm: known logged out — surfacing login directly');
      surfaceLoginDirect();
      return;
    }
    if (pre === 'loggedIn') {
      // The silent pre-warm already confirmed login — skip the login_check
      // round-trip and go straight to the before-cart snapshot + search/add.
      console.log(`[Cart ${ts()}]`, 'prewarm: known logged in — skipping login check, going straight to snapshot');
      snapshotBeforeAndBeginSearch();
      return;
    }
    // Login state unknown (probe still running, errored, or not started) — fall
    // back to the live login check.
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
      // Amazon Fresh: the whole run came up empty with the Fresh empty-state and
      // nothing landed in the cart → no store/address selected. Prompt the user to
      // choose one instead of a misleading "nothing added" / review screen.
      const anyAdded = addResultsRef.current.some((r) => r.success);
      if (lockedStoreIdRef.current === 'amazon' && freshStoreUnavailableRef.current && !anyAdded) {
        handleStoreUnavailableRef.current();
        return;
      }
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
          compileFailedNames();
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
      const addDropdown = isWeightPriced(item)
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
      // A bare search timeout means this item's results never painted → treat it
      // as a failed/unfound item and advance. It does NOT indicate a block: a
      // real block shows an HTTP error, a /blocked page, or a blocking overlay,
      // all detected separately (BLOCKED_OVERLAY), so we no longer trip
      // surfaceBlocker on consecutive search timeouts.
      consecutiveTimeoutsRef.current += 1;
      // Funnel: 'timeout' is deliberately distinct from the 'empty' recorded on a
      // SEARCH_RESULT with zero candidates. Empty means the store answered and
      // had nothing; timeout means we never got an answer — different fixes.
      // 'timeout' and not 'nav_failed': the WebView can't tell a navigation that
      // never completed from a page that loaded and never answered, so the
      // budget is the only thing we can honestly say was exceeded.
      tel().record('search', 'timeout', {
        durationMs: SEARCH_TIMEOUT_MS, itemIndex: searchIdxRef.current, code: 'timeout',
      });
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
        addResultsRef.current.push({ name: item.searchTerm, success: false, reason: 'timeout' });
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
      compileFailedNames();
      setStep('done');
      return;
    }
    const item = itemsToAdd[idx];
    console.log(`[Cart ${ts()}]`, 'navigateToAddItem idx=', idx, 'searchTerm=', item.searchTerm, 'product=', item.productName, 'qty=', item.qty, 'pref=', item.preference?.text ?? null, 'onSearchPage=', onSearchPageRef.current);
    setSearchingLabel(`Adding ${item.productName}…`);
    // Funnel: this row is the DENOMINATOR of confirmRate. It must be emitted at
    // the moment the add is dispatched, not when it succeeds — otherwise a click
    // that never produced any signal would vanish from the funnel entirely, and
    // the confirm rate would flatter us by only counting adds we heard back about.
    tel().record('add_click', 'ok', {
      itemIndex: idx,
      detail: { path: 'sequential', qty: item.qty, onSearchPage: onSearchPageRef.current },
    });
    addsAttemptedRef.current += 1;
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
      // A bare add timeout → treat as a failed item and advance. Not a block
      // signal (blocks are surfaced via HTTP error / /blocked / BLOCKED_OVERLAY).
      consecutiveTimeoutsRef.current += 1;
      // Funnel: a click that produced no confirmation signal at all. This is the
      // failure the confirm-rate denominator is designed to expose.
      tel().record('confirm', 'timeout', {
        durationMs: ADD_TIMEOUT_MS, itemIndex: idx, detail: { attempt: 1, path: 'sequential' },
        code: 'timeout',
      });
      console.log(`[Cart ${ts()}]`, 'ADD timeout for', item.productName, '— treating as failed and advancing');
      addResultsRef.current.push({ name: item.productName, success: false, reason: 'timeout' });
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
  // Commit the parked pre-search workers: inject the add into each already-open
  // results page (jittered) instead of spinning up the fused add pool. Runs
  // AFTER the before-cart snapshot, so finishParallelAdd reconciles against a
  // real baseline. Results (keyed by original item index) are re-keyed to the
  // dense active-item order finishParallelAdd expects.
  const startPresearchCommit = useCallback(() => {
    const entries = presearchCommitEntriesRef.current;
    presearchCommitArmedRef.current = false;
    parallelOriginalTotalRef.current = entries.length;
    setStep('adding');
    setSearchingLabel(`Adding ${entries.length} ingredients…`);
    console.log(`[Cart ${ts()}]`, 'presearch: committing', entries.length, 'items into parked workers');
    presearchPool.commit(entries, (resultsByItemsIdx) => {
      const dense = new Map<number, AddResult>();
      entries.forEach((e, pos) =>
        dense.set(pos, resultsByItemsIdx.get(e.idx) ?? { success: false, productName: null, reason: 'timeout', candidates: [] }));
      finishParallelAdd(dense);
    });
  }, [presearchPool, finishParallelAdd, setStep]);

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
    if (canParallel && !allChoose && FEATURE_PRESEARCH_ADD && presearchCommitArmedRef.current) {
      // Parked pre-search workers are ready — commit their adds instead of the
      // fused pool. The before-snapshot already ran, so the reconcile is sound.
      startPresearchCommit();
    } else if (canParallel && allChoose) {
      startParallelSearch();
    } else if (canParallel && !allChoose && FEATURE_PARALLEL_ADD) {
      // Regular add flow through the parallel pool: each worker searches AND
      // adds one product concurrently. Unconfirmed items fall to review.
      startParallelAdd();
    } else {
      navigateToSearchItem(0);
    }
  }, [startParallelSearch, startParallelAdd, navigateToSearchItem, startPresearchCommit]);

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
    // Fast path: a fresh cart baseline was pre-captured during the silent login
    // check, so skip the cart round-trip entirely and go straight to the search.
    const prewarmed = loginPrewarm.takePrewarmedCart(probeStoreId);
    // A cached baseline with no COUNT is not a baseline (MEAL-152). The probe
    // caches its result either way, so before this a prewarm that could not read
    // the cart — now more likely, since the cart-page scripts refuse to answer
    // off the cart page — permanently forfeited the run's own before-snapshot:
    // the fast path consumed the empty result and returned, and the live probe
    // below never ran. Fall through instead, which is exactly what happens when
    // there is no prewarmed cart at all. Still one-shot: takePrewarmedCart has
    // already dropped the entry, so this cannot loop, and the cost is one cart
    // navigation bounded by CART_PROBE_TIMEOUT_MS.
    if (prewarmed && prewarmed.count != null) {
      console.log(`[Cart ${ts()}]`, 'snapshotBefore: using PREWARMED baseline count=', prewarmed.count, 'lines=', prewarmed.items.length);
      cartCountBeforeRef.current = prewarmed.count;
      cartItemsBeforeRef.current = prewarmed.items;
      if (prewarmed.url && !getCartPageUrl(probeStoreId)) capturedCartUrlRef.current = prewarmed.url;
      beginSearchFlow();
      return;
    }
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
  }, [beginSearchFlow, loginPrewarm]);

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
    // Cold-slot branch: the main WebView is acting as a 4th add surface — its
    // results page just loaded, so inject the fused search+add (once) and let
    // onMessage feed the result to the pool. Bypasses the normal cart-flow logic.
    if (mainColdActiveRef.current && !mainColdInjectedRef.current && s.buildSearchAndAddScript && mainColdItemRef.current) {
      mainColdInjectedRef.current = true;
      const item = mainColdItemRef.current;
      const term = item.searchTerm ?? item.ingredientName;
      console.log(`[Cart ${ts()}]`, 'presearch COLD (main) onLoadEnd — injecting fused add for', term);
      webviewRef.current?.injectJavaScript(s.buildSearchAndAddScript(term, item.productQty, item.dropdown ?? null));
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
        // Funnel: a redirect to the store's sign-in page IS the answer the check
        // script never got to post — so it is a successful determination, not a
        // failed check, and it records `ok` like the LOGIN_STATUS path. See the
        // note on `surfaceLoginDirect`: outcome says whether we found out,
        // `isLoggedIn` says what we found out.
        tel().record('login_check', 'ok', {
          detail: { isLoggedIn: false, source: 'login_redirect' },
        });
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
    // when the page redirects to the final destination. Shared with
    // SilentLoginProbe and the injected check scripts via auth-urls.ts.
    if (isAuthRedirectUrl(url)) {
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

  // Single entry point for every "Mealio can't drive the store" condition —
  // anti-bot HTTP block, /blocked redirect, Fresh no-store, and the no-progress
  // timeout all route here. Tears down the in-flight run and surfaces the live
  // store page (robot_challenge step) under one generic banner + manual retry,
  // so we no longer maintain per-cause UI. `reason` sets blockReason (drives the
  // Retry button) and is logged; the banner copy is intentionally the same for
  // all of them since the user just fixes whatever's on screen and taps Retry.
  const surfaceBlocker = useCallback((reason: string) => {
    console.log(`[Cart ${ts()}]`, 'surfaceBlocker reason=', reason, 'step=', stepRef.current);
    if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }
    if (addTimeoutRef.current) { clearTimeout(addTimeoutRef.current); addTimeoutRef.current = null; }
    if (loginCheckTimeoutRef.current) { clearTimeout(loginCheckTimeoutRef.current); loginCheckTimeoutRef.current = null; }
    loadQueueRef.current = [];
    expectedNavUrlRef.current = '';
    inflightScriptRef.current = null;
    parallelPool.reset(); addPool.reset(); presearchPool.reset(); presearchStartedRef.current = false; presearchCommitArmedRef.current = false; mainColdActiveRef.current = false; mainColdInjectedRef.current = false;
    robotChallengeResumeIdxRef.current = -1;
    consecutiveTimeoutsRef.current = 0;
    blockReasonRef.current = reason;
    // Funnel: blockedRate per store. This is the signal that tells us a WAF
    // posture changed before users start reporting it.
    tel().record('blocked', 'blocked', {
      detail: { reason: String(reason) }, code: blockFailureCode(String(reason)),
    });
    setBlockReason(reason);
    setStep('robot_challenge');
  }, [parallelPool, addPool, setStep]);

  // Anti-bot block (HTTP 403/429/503): surface the generic blocker so the user
  // can complete any challenge, then retry.
  const handleHttpBlock = useCallback((statusCode: number, url: string) => {
    if (!ANTI_BOT_STATUSES.includes(statusCode)) return;
    const s = scriptsRef.current;
    if (!s || !isLikelyPageUrl(url, s.domain)) return;
    const st = stepRef.current;
    // Only meaningful while we're driving the store; ignore once the user is in
    // the review/done UI or already looking at a challenge.
    if (st === 'qty' || st === 'review' || st === 'searchResult' || st === 'done' || st === 'robot_challenge') return;
    console.log(`[Cart ${ts()}]`, `HTTP ${statusCode} block on`, url, '— surfacing challenge');
    surfaceBlocker('http-' + statusCode);
  }, [surfaceBlocker]);

  const onHttpError = useCallback((e: any) => {
    const code = e?.nativeEvent?.statusCode;
    const url = e?.nativeEvent?.url ?? '';
    if (typeof code === 'number') handleHttpBlock(code, url);
  }, [handleHttpBlock]);

  // Amazon Fresh: the whole run came back empty with the Fresh "no results" empty-
  // state, meaning no store / delivery address is selected. Tear down the in-flight
  // run and surface the Fresh storefront (reusing the robot_challenge step + banner
  // + manual "Try again") so the user can pick a store, then retry. No polling.
  const handleStoreUnavailable = useCallback(() => {
    console.log(`[Cart ${ts()}]`, 'Amazon Fresh: no store/address selected — surfacing store picker');
    surfaceBlocker('fresh-no-store');
    // Land on the Fresh storefront so the store/address picker is available.
    navTo(scriptsRef.current!.storeUrl);
  }, [surfaceBlocker, navTo]);
  useEffect(() => { handleStoreUnavailableRef.current = handleStoreUnavailable; }, [handleStoreUnavailable]);

  // Manual retry from the blocked state: re-run the login check from a fresh
  // store load. If the block cleared (or the user solved a challenge) it
  // proceeds; if not, the 403 fires again and we land back here.
  const retryAfterBlock = useCallback(() => {
    setBlockReason(null);
    blockReasonRef.current = null;
    freshStoreUnavailableRef.current = false;
    robotChallengeResumeIdxRef.current = -1;
    consecutiveTimeoutsRef.current = 0;
    parallelPool.reset(); addPool.reset(); presearchPool.reset(); presearchStartedRef.current = false; presearchCommitArmedRef.current = false; mainColdActiveRef.current = false; mainColdInjectedRef.current = false;
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
          // Funnel: the login gate is the first place a run can silently stall.
          // Recorded on the RESULT (not at injection) because the recorder only
          // exists once the server has issued a runId.
          tel().record('login_check', 'ok', { detail: { isLoggedIn: !!msg.isLoggedIn, source: 'status' } });
          loginCheckActiveRef.current = false;
          if (loginCheckTimeoutRef.current) { clearTimeout(loginCheckTimeoutRef.current); loginCheckTimeoutRef.current = null; }
          if (msg.isLoggedIn) {
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
          // reason/url are what make a `count: null` diagnosable (MEAL-152): the
          // count alone says "unknown", while `reason=not_cart_page url=<href>`
          // says the cart URL landed somewhere that was never the cart. Nothing
          // downstream stores either field, so this line is the whole audit
          // trail — without it a redirect is indistinguishable from a selector
          // miss.
          console.log(`[Cart ${ts()}]`, 'CART_COUNT phase=', phase, 'count=', count, 'reason=', msg.reason ?? null, 'url=', msg.url);
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
            const attempts: AttemptedAdd[] = active.map((item, idx) => ({
              ...toIntendedItem(item),
              report: reconResults.get(idx) ?? null,
            }));
            // MEAL-14: name the items the CART said are missing, separately from
            // the ones we simply could not verify. This is the per-item evidence
            // MEAL-9's partial-success UI and MEAL-3's item-success metric read;
            // logging it here is also how the rollout is judged — a run where
            // everything is `unknown` means the rail never answered.
            const verdicts = summarizeConfirmations(attempts);
            if (verdicts.landed.length > 0 || verdicts.missing.length > 0) {
              console.log(`[Cart ${ts()}]`, 'cart verdicts: landed=', verdicts.landed.map((v) => v.skuId || v.productId || v.name),
                'missing=', verdicts.missing.map((v) => `${v.name}(${v.skuId || v.productId || '?'}:${v.reason})`),
                'unverified=', verdicts.unknown.length);
            }
            if (!rows) {
              // Can't diff per-item (header-badge store) → trust the worker
              // results. Parallel add is HEB-only today (a per-item cart store),
              // so this is just a safety fallback.
              const { confirmed: wins, failed: lost } = reconcileFromWorkerReports(attempts);
              addResultsRef.current = wins.map((w) => ({ name: w.name, success: true }));
              setTotalAdded(wins.length);
              setTotalFailed(lost.length);
              setAddedNames(wins.map((w) => w.name));
              setFailedNames(lost.map((l) => l.name));
              reconcileFinalizedRef.current = true;
              setStep('done');
              return;
            }
            const outcome = reconcileParallelAdd(attempts, rows.filter((r) => r.added));
            const confirmed = outcome.confirmed.map((c) => ({ name: c.name, success: true }));
            // Two destinations for a shortfall, and which one an item takes is not
            // this screen's judgement to make — see splitTopUpsForReview. `retry`
            // is re-added unattended; `ask` is the count-item-on-a-weight-row
            // disagreement, where the cart plausibly already holds the item and
            // both machine answers cost the user something real, so it goes to the
            // user instead. Nothing is in both, and nothing is dropped.
            const routing = splitTopUpsForReview(outcome);
            // Re-add only the missing units; re-adding the full qty would
            // over-add the units that already landed.
            const retryItems: ConsolidatedIngredient[] = routing.retry.map(
              (t) => ({ ...active[t.index], productQty: t.shortfall }),
            );
            const reviewFailures: SearchResult[] = outcome.definiteFailures.map((f) => {
              const item = active[f.index];
              return {
                term: item.searchTerm || item.ingredientName,
                candidates: reconResults.get(f.index)?.candidates ?? [],
                mealIngredients: item.mealIngredients,
                unit: item.unit,
                measure: item.measure,
                reason: f.reason,
                isChoose: false,
              };
            });
            // The disagreements, as review cards. Appended to the same queue the
            // definitive failures use, so they reach the user through the screen
            // that already exists — and appended AFTER them so the run's outright
            // failures are dealt with first.
            const askCards: SearchResult[] = routing.ask.map(
              (q) => inCartByWeightReview(active[q.index], q.cartName),
            );
            reviewFailures.push(...askCards);
            // The cart lines those cards name. Recorded before either exit below,
            // because BOTH announce over-adds and neither may call one of these
            // rows unintended — see dropExplainedOverAdds.
            askedCartNamesRef.current = routing.ask.map((q) => q.cartName).filter(Boolean);
            // Keep the full intended set: the retry branch below narrows
            // activeItemsRef to the top-up subset, and the final cart check needs
            // the whole set to spot units no item intended.
            reconcileIntendedRef.current = outcome.intended;
            console.log(`[Cart ${ts()}]`, 'reconcile: confirmed=', confirmed.length, 'retry=', retryItems.length, retryItems.map((i) => i.searchTerm), 'review=', reviewFailures.length, reviewFailures.map((r) => `${r.term}:${r.reason}`));
            if (routing.ask.length > 0) {
              console.log(`[Cart ${ts()}]`, 'reconcile: COUNT ITEM ON WEIGHT ROW — asking instead of re-adding',
                routing.ask.map((q) => `${active[q.index]?.searchTerm ?? q.index}→${q.cartName} (short ${q.shortfall})`));
            }
            // North-star: this is the ONE moment in the run where the added count
            // is backed by a per-item cart read, so it is the only place allowed
            // to claim `cart_reconcile` as the confirmed source. A top-up
            // downgrades it again below — the retry's results come back
            // worker-reported, so the finalized count is then only partly
            // cart-backed, and 'mostly trustworthy' is not a thing a metric can
            // say. The after-probe that follows a top-up re-upgrades the run with
            // a full cart audit (phase 'north_star'), so nothing is lost.
            //
            // Gated on the BASELINE, which this reconcile does not otherwise
            // require: with no before-snapshot cartItemsBeforeRef is still [], so
            // diffCartItems marks the user's whole existing cart as newly added
            // and every intended item finds a row to claim. The reconcile has
            // always behaved that way (it over-confirms rather than over-adds, so
            // it is safe for the cart) and changing it belongs with MEAL-47's
            // named baseline-retry follow-up, not here — but the METRIC must not
            // present that run as cart-backed. It reports `worker_reports`
            // instead, which is the honest description of what is left.
            cartReconciledRef.current = cartCountBeforeRef.current != null;
            // Funnel: the reconcile delta is the ground truth the workers' own
            // reports are checked against. A retry count that climbs over time is
            // the earliest signal that a store's confirm signal has drifted.
            const reconcileDetail = {
              // 'parallel' vs the after-probe's 'after'/'north_star' rows: all
              // three are `reconcile` steps and the read side has to tell them
              // apart to avoid counting one run twice.
              phase: 'parallel',
              confirmed: confirmed.length,
              retry: retryItems.length,
              review: reviewFailures.length,
              // How often the intent-vs-cart-row disagreement fires, and therefore
              // how often a user is asked. Replaces `weightRowRetry` from earlier on
              // this branch, which counted the same items while they were still
              // being re-added — a different event with the same number.
              weightRowAsked: routing.ask.length,
            };
            if (retryItems.length === 0 && reviewFailures.length === 0) {
              tel().record('reconcile', 'ok', { detail: reconcileDetail });
            } else {
              // A top-up means the cart is short of what the workers claimed —
              // that's the confirmation rail being wrong, and it outranks the
              // review pile because it's the part we got wrong ourselves. An asked
              // item is the same family: the add was dispatched and the cart cannot
              // corroborate what landed, which is confirm_failed however it is
              // routed. With neither, the row reflects the review failures, which
              // reconcile only ever routes here for out_of_stock / no_results.
              tel().record('reconcile', 'error', {
                detail: reconcileDetail,
                code: retryItems.length > 0 || routing.ask.length > 0
                  ? 'confirm_failed'
                  : reviewFailures.every((r) => r.reason === 'no_results')
                    ? 'no_candidates'
                    : 'match_rejected',
              });
            }
            // Surface definitive failures (out of stock / no results) in the
            // review queue. When there are also qty top-ups, the sequential retry
            // below finishes into the review step because searchResults is now
            // non-empty; otherwise we route there directly after this block.
            if (reviewFailures.length > 0) {
              searchResultsRef.current = [...searchResultsRef.current, ...reviewFailures];
              setSearchResults(searchResultsRef.current);
            }
            if (retryItems.length > 0) {
              // See cartReconciledRef above: from here the run's count is a mix
              // of cart-confirmed items and worker-reported top-ups, which is not
              // a claim the metric can make. The after-probe corrects it.
              cartReconciledRef.current = false;
              addResultsRef.current = confirmed;
              activeItemsRef.current = retryItems;
              searchIdxRef.current = 0;
              onSearchPageRef.current = false;
              // Top-up owns the last 15%: reset the counter so it fills 85% → 100%
              // across this reconcile subset (see the progress effect).
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
            // Safety net: flag any units in the cart that no intended item
            // accounts for (a double-add or an unintended product), even when
            // every intended item was confirmed. The lines the ask cards above
            // name are held out: they are unclaimed weight rows by construction,
            // so they land in overAdds every time, and this copy would tell the
            // user to delete the line the very next screen asks them about.
            const unexplainedOver = dropExplainedOverAdds(outcome.overAdds, askedCartNamesRef.current);
            if (unexplainedOver.length > 0) {
              const lockedName = STORES.find((s) => s.id === lockedStoreIdRef.current)?.name ?? storeName;
              const list = unexplainedOver.map(overAddLabel).join(', ');
              const units = unexplainedOver.reduce((n, o) => n + o.qty, 0);
              console.log(`[Cart ${ts()}]`, 'reconcile: OVER-ADD detected', unexplainedOver);
              setCartDeltaWarning(`Cart check: your ${lockedName} cart has ${units} item(s) Mealio didn't intend to add (${list}). Please review your cart.`);
            } else {
              setCartDeltaWarning(null);
            }
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
            const findings = auditCartAfterRun({
              rows,
              reportedAdded: addResultsRef.current.filter((r) => r.success).map((r) => r.name),
              active: activeItemsRef.current.map(toIntendedItem),
              reconcileIntended: reconcileIntendedRef.current,
              countBefore: cartCountBeforeRef.current,
              countAfter: count,
              // MEAL-119: this probe is the retry exit's finalizer, and it runs
              // AFTER the user has answered the ask cards. A kept line is an added
              // weight row no count item can claim, so without this it comes back
              // as `over: qty 1` and the done screen prints "1 item added that
              // Mealio didn't intend (…)" directly above "1 weight item kept as
              // already in your cart (…)" — the same product, in both banners,
              // with the warning telling the user to delete what they approved.
              explainedRows: askedCartNamesRef.current,
            });
            const { missing, short, over, recovered, countShortfall } = findings;
            // Read from the ref, NOT from the `totalAdded` state: onMessage is
            // created once (deps []) so the state it closes over is this run's
            // initial 0. This expression is the same one every finalize path
            // computes setTotalAdded from, so it is the number run_summary shipped.
            const reportedAddedCount = addResultsRef.current.filter((r) => r.success).length;
            // The workers under-reported: the cart holds items this run told the
            // user it could not add (MEAL-47). Say so — otherwise the user adds
            // them a second time by hand and pays twice. Recorded on the funnel
            // as a `reconcile` failure because that is what it is: the
            // confirmation rail was wrong, and the size of this row over time is
            // how the fix is told apart from a regression in itemsAdded (the
            // run_summary row above has already shipped its lower count).
            if (recovered.length > 0) {
              console.log(`[Cart ${ts()}]`, 'cart check: RECOVERED false-negative adds', JSON.stringify(recovered));
              tel().record('reconcile', 'error', {
                detail: { phase: 'after', recovered: recovered.length, reportedAdded: reportedAddedCount },
                code: 'confirm_failed',
              });
            }
            // ── North-star correction (MEAL-3 × MEAL-47) ─────────────────────
            //
            // The run's terminal run_summary row has already shipped with a
            // confirmed count that was NOT cart-backed (confirmedSource
            // 'worker_reports'): this probe is the first per-item cart read the
            // run has had, and it lands after the fact. It is deliberately not
            // waited on — see the run_summary emission — so the correction rides
            // on its own row and the read side coalesces the two.
            //
            // Emitted only when `rows` came back, because with no per-item cart
            // data there is nothing to correct WITH: countShortfall alone cannot
            // say which lines landed, and inventing a per-item number from a
            // header badge delta is the badge-count inference this whole metric
            // exists to replace.
            //
            // It corrects in BOTH directions, which matters more than the
            // recovery half: `missing` and `short` mean the workers claimed adds
            // the cart cannot corroborate, so the uncorrected number is too HIGH.
            // A north-star that can only be revised upward is a vanity metric.
            if (rows) {
              const correction = correctConfirmedFromCart({
                requested: requestedRef.current.requested,
                summaryConfirmed: reportedAddedCount,
                missing: missing.length,
                short: short.length,
                recovered,
              });
              tel().record('reconcile', 'ok', {
                detail: {
                  phase: 'north_star',
                  requested: requestedRef.current.requested,
                  // What run_summary shipped, so the two rows can be reconciled
                  // even if the runs table and the funnel disagree.
                  summaryConfirmed: reportedAddedCount,
                  confirmed: correction.confirmed,
                  runComplete: correction.runComplete,
                  overstated: correction.overstated,
                  recovered: correction.recovered,
                  // The noisy share of the recovery: a loose name match cannot
                  // tell "the failed item landed" from "an unintended product
                  // landed" (MEAL-47). Subtract it for a lower bound.
                  recoveredLoose: correction.recoveredLoose,
                  confirmedSource: 'cart_after_probe',
                },
              });
            }
            if (missing.length > 0 || short.length > 0 || over.length > 0 || recovered.length > 0) {
              const parts: string[] = [];
              if (recovered.length > 0) {
                const names = recovered.map((r) => r.cartName || r.name).join(', ');
                parts.push(`${recovered.length} item${recovered.length === 1 ? ' we reported as not added is' : 's we reported as not added are'} in your cart already (${names}) — don't add ${recovered.length === 1 ? 'it' : 'them'} again`);
              }
              if (missing.length > 0) {
                parts.push(`${missing.length} item${missing.length === 1 ? '' : 's'} may not have been added (${missing.join(', ')})`);
              }
              if (short.length > 0) {
                parts.push(`${short.length} item${short.length === 1 ? '' : 's'} added below the requested quantity, which a store limit can cause (${short.map((s) => `${s.name} (${s.got} of ${s.expected})`).join(', ')})`);
              }
              if (over.length > 0) {
                parts.push(`${over.length} item${over.length === 1 ? '' : 's'} added that Mealio didn't intend (${over.map(overAddLabel).join(', ')})`);
              }
              setCartDeltaWarning(`Cart check on your ${lockedName} cart: ${parts.join('; ')}. Please double-check your cart.`);
            } else if (countShortfall) {
              // No per-item data (header-badge stores) or names didn't resolve —
              // fall back to the count-shortfall message.
              const { delta, expected } = countShortfall;
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

        // Extractor diagnostics. The one field that has to outlive the log line is
        // MEAL-13's ndReason — see extractWhyRef. Everything else is dev-log only.
        if (msg.type === 'EXTRACT_DEBUG') {
          console.log(`[Cart ${ts()}]`, 'EXTRACT_DEBUG', JSON.stringify(msg));
          if (msg.step === 'next_data') {
            extractWhyRef.current[MAIN_SURFACE] = msg.ndReason ?? null;
          }
          return;
        }

        if (msg.type === 'SEARCH_AND_ADD_RESULT') {
          // Real block: the store served an app-download / interstitial nudge over
          // the page (no HTTP error). Surface it so the user can dismiss it.
          if (msg.reason === 'blocked') {
            console.log(`[Cart ${ts()}]`, 'BLOCKED_OVERLAY detected:', msg.blockedText);
            surfaceBlocker('nudge');
            return;
          }
          // Cold-slot result: the main WebView added an overflow item as a 4th
          // worker. Feed it to the pool (which pulls the next overflow item or
          // frees the main for the reconcile) — never the serial-add bookkeeping.
          if (mainColdActiveRef.current) {
            console.log(`[Cart ${ts()}]`, 'presearch COLD result: success=', msg.success, 'product=', msg.productName);
            if (msg.storeUnavailable) freshStoreUnavailableRef.current = true;
            presearchPool.reportAdded(mainColdSlotRef.current, {
              success: !!msg.success, productName: msg.productName ?? null,
              reason: msg.reason ?? null, candidates: msg.candidates ?? [],
              confirm: msg.confirm ?? null,
            });
            return;
          }
          if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
            searchTimeoutRef.current = null;
          }
          // Store responded → progress. Clear the no-progress block counter.
          consecutiveTimeoutsRef.current = 0;
          if (msg.storeUnavailable) freshStoreUnavailableRef.current = true;
          inflightScriptRef.current = null;
          const idx = searchIdxRef.current;
          const active = activeItemsRef.current;
          const item = active[idx];
          console.log(`[Cart ${ts()}]`, 'SEARCH_AND_ADD_RESULT idx=', idx, 'success=', msg.success, 'productName=', msg.productName, 'cart=', msg.confirm ? `${msg.confirm.state}/${msg.confirm.reason}` : null);
          // Funnel: the fused search+add path dispatches inside the injected
          // script, so there is no separate click moment to hook on the RN side.
          // Emit both halves here to keep the confirm-rate denominator complete —
          // a fused add that failed still counts as an attempt.
          tel().record('add_click', 'ok', { itemIndex: idx, detail: { path: 'fused' } });
          addsAttemptedRef.current += 1;
          // MEAL-14: which RAIL decided, and what it decided, flattened —
          // sanitizeDetail keeps scalars only. Without this the funnel cannot tell
          // a cart-verified confirm from a badge guess, which is the whole point.
          const cartDetail = confirmDetail(msg.confirm);
          if (msg.success) {
            tel().record('confirm', 'ok', { itemIndex: idx, detail: { attempt: 1, path: 'fused', ...cartDetail } });
          } else {
            const failReason = String(msg.reason ?? 'unknown');
            tel().record('confirm', 'error', {
              itemIndex: idx,
              detail: { attempt: 1, path: 'fused', reason: failReason, ...cartDetail },
              code: addFailureCode(failReason),
            });
          }
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
          // Funnel: a search that returns zero candidates is 'empty', not 'ok' —
          // that distinction is what separates "the store has no match" from
          // "our extractor's selectors broke", which look identical downstream.
          {
            const found = Array.isArray(msg.candidates) ? msg.candidates.length : 0;
            // `source` says which extractor produced these ('next_data' | 'dom' on
            // HEB, absent elsewhere) and `why` says what the JSON reader decided
            // ('ok' when it answered, or the reason it handed over to the DOM).
            // Recorded so the two can be compared in the funnel while MEAL-13's
            // flag is rolling out.
            const candidatesDetail = {
              count: found,
              storeUnavailable: !!msg.storeUnavailable,
              source: msg.source ?? null,
              why: takeExtractWhy(MAIN_SURFACE),
            };
            tel().record('search', 'ok', { itemIndex: searchIdxRef.current });
            if (found > 0) {
              tel().record('candidates', 'ok', { itemIndex: searchIdxRef.current, detail: candidatesDetail });
            } else {
              tel().record('candidates', 'empty', {
                itemIndex: searchIdxRef.current, detail: candidatesDetail, code: 'no_candidates',
              });
            }
          }
          // Store responded → progress. Clear the no-progress block counter.
          consecutiveTimeoutsRef.current = 0;
          if (msg.storeUnavailable) freshStoreUnavailableRef.current = true;
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
          // Funnel: the headline reliability number. `confirm` is what the store
          // actually evidenced, so a click that reported no success lands as
          // 'error' with its reason — that's the row the dashboard divides by.
          const addCartDetail = confirmDetail(msg.confirm);
          if (msg.success) {
            tel().record('confirm', 'ok', {
              itemIndex: addingIdxRef.current, detail: { attempt: 1, path: 'sequential', ...addCartDetail },
            });
          } else {
            const failReason = String(msg.reason ?? 'unknown');
            tel().record('confirm', 'error', {
              itemIndex: addingIdxRef.current,
              detail: { attempt: 1, reason: failReason, path: 'sequential', ...addCartDetail },
              code: addFailureCode(failReason),
            });
          }
          // Store responded → progress. Clear the no-progress block counter.
          consecutiveTimeoutsRef.current = 0;
          const idx = addingIdxRef.current;
          const itemsToAdd = addingItemsRef.current;
          const item = itemsToAdd[idx];
          console.log(`[Cart ${ts()}]`, 'ADD_RESULT idx=', idx, 'success=', msg.success, 'product=', item?.productName, 'reason=', msg.reason ?? null);
          if (item) {
            addResultsRef.current.push({ name: item.productName, success: msg.success, reason: msg.success ? undefined : (msg.reason ?? 'unknown') });
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

  const handleReviewDecision = (action: 'add' | 'update' | 'skip' | 'choose' | 'keep') => {
    // If the user typed a custom search term, trigger the search instead of advancing.
    if (action !== 'skip' && action !== 'choose' && action !== 'keep' && selectedSuggIdx === 'custom') {
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
      // Drop any earlier "keep the weight line" for this index, the mirror of what
      // 'keep' does to an earlier skip (MEAL-119). Without it, keep → Back → Skip
      // leaves the item in BOTH maps: the done screen lists it as kept and as
      // skipped, and keptInReview over-counts on the funnel. Neither decision
      // added anything, so this is contradictory reporting, not wrong groceries.
      setKeptByIdx((prev) => {
        if (!(reviewIdx in prev)) return prev;
        const next = { ...prev };
        delete next[reviewIdx];
        return next;
      });
    }

    // MEAL-119: "the weight line I already have is enough." Adds NOTHING — the
    // whole point of the card is that the automatic re-add was the danger — and
    // pushes no pick, so it advances exactly like a skip but is reported as the
    // deliberate acceptance it is. Clears any earlier skip for this index, the
    // same way a re-decided pick does.
    if (action === 'keep') {
      const keptName = currentReview?.candidates[0]?.productName || currentReview?.term || '';
      if (keptName) setKeptByIdx((prev) => ({ ...prev, [reviewIdx]: keptName }));
      setSkippedByIdx((prev) => {
        if (!(reviewIdx in prev)) return prev;
        const next = { ...prev };
        delete next[reviewIdx];
        return next;
      });
    }

    if (action !== 'skip' && action !== 'keep' && currentReview) {
      const displayCandidates = customSuggestions.length > 0 ? customSuggestions : currentReview.candidates;
      const candidate = typeof selectedSuggIdx === 'number' ? displayCandidates[selectedSuggIdx] : null;
      // 'choose' only saves the product for future runs (no cart add), so an
      // out-of-stock pick is allowed; 'add'/'update' hit the cart, so OOS stays blocked.
      if (candidate && (action === 'choose' || !candidate.outOfStock)) {
        // Re-deciding this ingredient after a Back: drop any earlier skip for it,
        // and any earlier "keep the weight line" — adding now supersedes both, and
        // a stale keep would report the item as covered on the done screen.
        setSkippedByIdx((prev) => {
          if (!(reviewIdx in prev)) return prev;
          const next = { ...prev };
          delete next[reviewIdx];
          return next;
        });
        setKeptByIdx((prev) => {
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
      compileFailedNames();
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

  // A run where nothing has a chosen product yet is a Choose Products run: it
  // saves matches and adds nothing. Titling its first screen "Add to Cart" is
  // the exact confusion MEAL-84 is about — the setup reading as the shopping.
  // Shared with the button that opens this sheet — see lib/chooseRun.ts.
  const isChooseRun = isChooseRunItems(items);

  const titleMap: Record<Step, string> = {
    qty: isChooseRun ? 'Choose Products' : 'Add to Cart',
    login_check: 'Connecting…',
    login: `Log in to ${storeName}`,
    searching: currentReview?.isChoose ? 'Choosing Products…' : 'Finding Products…',
    // "Items Not Added" is false for a queue made only of in-cart-by-weight items:
    // the store may well have added them, which is why they are being asked about
    // (MEAL-119). A mixed queue keeps the failure title — some of it did fail.
    searchResult: searchResults.length > 0 && searchResults.every((r) => r.reason === IN_CART_BY_WEIGHT)
      ? 'Check Your Cart'
      : 'Items Not Added',
    review: currentReview?.isChoose
      ? `Choose Product (${reviewIdx + 1} of ${searchResults.length})`
      : `Review Ingredients (${reviewIdx + 1} of ${searchResults.length})`,
    adding: 'Adding to Cart…',
    done: 'Done!',
    // One generic title for every "Mealio can't drive the store" state — the
    // banner tells the user what to do; the specific cause no longer matters.
    robot_challenge: `Action needed on ${storeName}`,
  };

  // ── Derived: live-browser layout ───────────────────────────────────────────

  // Which pool (if any) is actively working — drives the tile grid.
  const activeWorkerPool = parallelPool.isActive
    ? { pool: parallelPool, sources: workerSources, scripts: workerScripts, onMsg: onWorkerMessage, keyPrefix: 'search-worker-' }
    : addPool.isActive
    ? { pool: addPool, sources: addWorkerSources, scripts: addWorkerScripts, onMsg: onAddWorkerMessage, keyPrefix: 'add-worker-' }
    : null;

  // The browser region is on-screen for every automation phase now (no more
  // spinner). It's hidden — but the main WebView stays mounted — while the user
  // is in a panel step (qty is not mounted at all; review/searchResult/done keep
  // the WebView alive behind the panel for the cart snapshot).
  const browserVisible =
    step === 'login_check' || step === 'login' || step === 'searching' ||
    step === 'adding' || step === 'robot_challenge';
  // Pre-search: any parked/committing worker has a live URI. The browser region
  // stays mounted while these exist (even on the qty screen) so the parked pages
  // survive the login_check + snapshot window; the tiles themselves are kept
  // offscreen until the commit phase shows them live.
  const presearchGrid = FEATURE_PRESEARCH_ADD && presearchPool.workerUris.some((u) => !!u);
  const presearchCommitVisible = step === 'adding' && presearchPool.isCommitting;
  // Parked worker tiles currently live (the cold slot is the main cell, not a tile).
  const presearchParkedTilesLive = FEATURE_PRESEARCH_ADD
    && presearchPool.workerUris.slice(0, PARALLEL_ADD_WORKER_COUNT).some((u) => !!u);
  // Grid = the main WebView tiled alongside live worker WebViews. Only while a
  // worker pool is running (or parked adds are committing WITH tiles to show);
  // once only the cold slot (main) is left, the main fills the region full-size.
  const gridMode = browserVisible && (!!activeWorkerPool || (presearchCommitVisible && presearchParkedTilesLive));

  // Tile sizing: fixed 2×2 so tiles hold their size and simply drop out of the
  // grid as workers finish (4→3→2→1). Worker WebViews render at a real 414×896
  // viewport (viewport-lazy storefronts need it to paint) and are visually
  // scaled into the tile — the scale is cosmetic, so resizing never disturbs an
  // in-flight extraction.
  const TILE_GAP = 8;
  const tileW = browserAreaSize.w > 0 ? (browserAreaSize.w - TILE_GAP) / 2 : 0;
  const tileH = browserAreaSize.h > 0 ? (browserAreaSize.h - TILE_GAP) / 2 : 0;
  const tileScale = tileW > 0 && tileH > 0 ? Math.min(tileW / 414, tileH / 896) : 0;

  // Progress fraction for the caption bar (mirrors the bubble's ring logic:
  // parallel search/add drive it from the pool's completed/total; the sequential
  // flow from the index refs, re-rendered via setSearchingLabel).
  const captionPct = (() => {
    if (step !== 'searching' && step !== 'adding') return 0;
    let total: number; let idx: number;
    if (step === 'searching' && parallelPool.isActive) {
      total = parallelPool.total; idx = parallelPool.completed;
    } else if (step === 'adding' && addPool.isActive) {
      total = addPool.total; idx = addPool.completed;
    } else if (step === 'adding' && presearchPool.isCommitting) {
      total = presearchPool.total; idx = presearchPool.completed;
    } else {
      total = step === 'searching' ? activeItemsRef.current.length : addingItemsRef.current.length;
      idx = step === 'searching' ? searchIdxRef.current : addingIdxRef.current;
    }
    return total > 0 ? Math.min(idx / total, 1) * 100 : 0;
  })();

  // ── Render ───────────────────────────────────────────────────────────────

  const content = (
      <SafeAreaView style={styles.safe}>

        {/* Header */}
        <View style={styles.header}>
          <View style={{ width: 28 }} />
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

        {/* ── Live browser ───────────────────────────────────────────────────
            The main WebView stays mounted for the whole run (never during qty)
            so cookies/session and the cart snapshot survive. It is shown live
            during every automation phase — no spinner. During a parallel pass it
            tiles alongside the live worker WebViews (main + workers, 2×2); each
            worker's tile drops out the instant it finishes. Outside a pass the
            single main WebView fills the region. While the user is in a panel
            step (review / searchResult / done) the region is hidden but the
            WebView keeps running behind it for the after-snapshot. */}
        {(step !== 'qty' || presearchGrid) && (
        <View
          style={browserVisible ? styles.browserOuter : styles.webviewHidden}
          pointerEvents={browserVisible ? 'auto' : 'none'}
        >
          {/* Top bar: one slot — login banner, blocker banner, or the automation
              caption. Kept as a single stable child so the WebView below never
              remounts as it swaps. */}
          {step === 'login' ? (
            <View style={styles.topBar}>
              <Text style={styles.loginBanner}>
                Log in to your {storeName} account, then Mealio will add your ingredients automatically.
              </Text>
              <TouchableOpacity style={styles.retryBtn} onPress={recheckLogin}>
                <Text style={styles.retryBtnText}>I'm already logged in</Text>
              </TouchableOpacity>
            </View>
          ) : step === 'robot_challenge' ? (
            <View style={styles.topBar}>
              <Text style={styles.loginBanner}>
                Something is blocking Mealio from working on {storeName}. Take care of anything
                showing in the browser below (a prompt, a store or address to choose, or a
                "verify you're human" check), then tap Try again.
              </Text>
              <TouchableOpacity style={styles.retryBtn} onPress={retryAfterBlock}>
                <Text style={styles.retryBtnText}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : (step === 'searching' || step === 'adding' || step === 'login_check') ? (
            <View style={styles.captionBar}>
              <Text style={styles.captionLabel} numberOfLines={1}>{searchingLabel || titleMap[step]}</Text>
              {(step === 'searching' || step === 'adding') && (
                <View style={styles.progressTrack} testID="cart-progress-track">
                  <View
                    style={[styles.progressFill, { width: `${captionPct}%`, backgroundColor: storeColor }]}
                    testID="cart-progress-fill"
                  />
                </View>
              )}
            </View>
          ) : null}

          {/* Browser region: fullscreen single WebView, or the tile grid. */}
          <View
            style={styles.browserArea}
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              setBrowserAreaSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
            }}
          >
            <View style={gridMode ? styles.gridWrap : styles.fullWrap}>
              {/* Main WebView cell — always the first child so it never remounts.
                  Fills the region normally; becomes one tile in grid mode. Not
                  mounted during qty (the region only renders then to keep the
                  parked pre-search tiles alive). */}
              {step !== 'qty' && (
              <View style={gridMode ? [styles.tile, { width: tileW, height: tileH }] : styles.fullCell}>
                {/* Same wrapper structure in both modes so the WebView element
                    (and its session) never remounts when it moves between the
                    full-size interactive view and a scaled grid tile. In grid mode
                    it renders at a real 414×896 phone viewport and scales down —
                    without this the page paints into the small tile and looks
                    zoomed in. Full-size mode is interactive (login / robot). */}
                <View
                  style={gridMode ? styles.tileClip : styles.fullCell}
                  pointerEvents={gridMode ? 'none' : 'auto'}
                >
                  <View style={gridMode ? { width: 414, height: 896, transform: [{ scale: tileScale }] } : styles.fullCell}>
                    <WebView
                      ref={webviewRef}
                      source={{ uri: webviewUri }}
                      // incognito  // TODO: uncomment to force fresh session (no stored cookies)
                      style={gridMode ? { width: 414, height: 896 } : { flex: 1 }}
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
                </View>
                {gridMode && (
                  <View style={styles.tileLabel} pointerEvents="none">
                    <Text style={styles.tileLabelText} numberOfLines={1}>{storeName}</Text>
                  </View>
                )}
              </View>
              )}

              {/* Live worker tiles — each a real 414×896 WebView scaled into the
                  tile. Rendered only for workers with an active URI, so a worker
                  that finishes (URI cleared to '') drops straight out of the grid. */}
              {gridMode && activeWorkerPool && activeWorkerPool.pool.workerUris.map((uri, i) => {
                if (!uri) return null;
                const item = activeWorkerPool.pool.workerItems[i];
                const label = item ? (item.searchTerm ?? item.ingredientName) : '…';
                return (
                  <View key={activeWorkerPool.keyPrefix + i} style={[styles.tile, { width: tileW, height: tileH }]}>
                    <View style={styles.tileClip} pointerEvents="none">
                      <View style={{ width: 414, height: 896, transform: [{ scale: tileScale }] }}>
                        <WebView
                          source={activeWorkerPool.sources[i]}
                          style={{ width: 414, height: 896 }}
                          onMessage={(e) => activeWorkerPool.onMsg(i, e)}
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
                          injectedJavaScript={activeWorkerPool.scripts[i]}
                        />
                      </View>
                    </View>
                    <View style={styles.tileLabel} pointerEvents="none">
                      <Text style={styles.tileLabelText} numberOfLines={1}>{label}</Text>
                    </View>
                  </View>
                );
              })}

              {/* Pre-search parked worker tiles (FEATURE_PRESEARCH_ADD). Mounted
                  continuously from the qty screen (parking) through the commit,
                  so the loaded results page survives for the injected add — the
                  WebView is always 414×896; only the wrapper (offscreen vs live
                  tile) changes, so it never remounts. Shown live once committing. */}
              {presearchGrid && presearchSources.map((src, i) => {
                // Only the parked worker slots render as tiles; the cold slot is
                // the main WebView (its own cell), not a separate tile.
                if (i >= PARALLEL_ADD_WORKER_COUNT) return null;
                if (!presearchPool.workerUris[i]) return null;
                const item = presearchPool.workerItems[i];
                const label = item ? (item.searchTerm ?? item.ingredientName) : '…';
                return (
                  <View
                    key={'presearch-worker-' + i}
                    style={presearchCommitVisible ? [styles.tile, { width: tileW, height: tileH }] : styles.presearchOffscreen}
                  >
                    <View style={styles.tileClip} pointerEvents="none">
                      <View style={{ width: 414, height: 896, transform: [{ scale: presearchCommitVisible && tileScale > 0 ? tileScale : 1 }] }}>
                        <WebView
                          ref={(r) => { presearchWorkerRefs.current[i] = r; }}
                          source={src}
                          style={{ width: 414, height: 896 }}
                          onMessage={(e) => onPresearchWorkerMessage(i, e)}
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
                          injectedJavaScript={presearchScripts[i]}
                        />
                      </View>
                    </View>
                    {presearchCommitVisible && (
                      <View style={styles.tileLabel} pointerEvents="none">
                        <Text style={styles.tileLabelText} numberOfLines={1}>{label}</Text>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
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
                // Two distinct states. `boxChecked` is the checkbox flag alone and
                // gates the steppers — the + has to stay live at qty 0 or there is
                // no way back up. `included` is what actually runs, so it is what
                // the checkbox fill and the strikethrough report (MEAL-65).
                const boxChecked = checkedItems[i] ?? true;
                const included = boxChecked && !isZeroedOut(it);
                return (
                  <View key={i} style={[styles.qtyRow, !included && styles.qtyRowZeroed]}>
                    <TouchableOpacity onPress={() => toggleChecked(i)} style={styles.checkbox} testID={`qty-checkbox-${i}`} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      {included && <View testID={`qty-checked-${i}`} style={[styles.checkboxInner, { backgroundColor: storeColor }]} />}
                    </TouchableOpacity>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.ingName, !included && styles.ingNameZeroed]}>
                        {it.searchTerm ?? it.ingredientName}
                      </Text>
                      {it.dropdown?.selectedText ? (
                        <Text style={{ fontSize: 11, fontFamily: 'Inter_400Regular', color: Colors.text3 }}>
                          {it.dropdown.selectedText}
                        </Text>
                      ) : null}
                      {it.mealIngredients.map((mi, mIdx) => {
                        // This meal's amount, not the consolidated entry's. The
                        // entry carries whichever meal created it, so two meals
                        // sharing chicken both used to claim the first one's
                        // "2 lb" — on the one screen whose entire job is asking
                        // how much to buy (MEAL-92).
                        const w = ingredientWeight(it);
                        const measurement = w ? weightLabelLb(w.lb) : ingredientAmount(mi);
                        return (
                          <Text key={mIdx} style={styles.mealNames}>
                            {mi.mealName} calls for {measurement || `${mi.qty}`}
                          </Text>
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
                      disabled={atMin || !boxChecked}
                      style={[styles.qtyBtn, (atMin || !boxChecked) && { opacity: 0.3 }]}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.qtyBtnText}>−</Text>
                    </TouchableOpacity>
                      );
                    })()}
                    <Text style={styles.qtyNum} testID={`qty-num-${i}`}>
                      {(() => { const w = ingredientWeight(it); return w ? weightLabelLb(w.lb) : it.productQty; })()}
                    </Text>
                    <TouchableOpacity
                      onPress={() => updateQty(i, 1)}
                      disabled={!boxChecked}
                      style={[styles.qtyBtn, !boxChecked && { opacity: 0.3 }]}
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

        {/* login_check / searching / adding no longer render a spinner — the
            live browser above (fullscreen or tile grid) is the progress UI. */}

        {/* ── Step: searchResult ──────────────────────────────────────────── */}
        {step === 'searchResult' && (() => {
          const autoAdded = autoPickedItemsRef.current;
          // MEAL-119 items did not fail to be added — the cart may well hold them,
          // by weight, which is the whole reason they need a decision. Saying
          // "could not be added / out of stock" over them would be a lie the user
          // then has to unlearn on the card itself.
          const weighed = searchResults.filter((r) => r.reason === IN_CART_BY_WEIGHT).length;
          const allWeighed = weighed > 0 && weighed === searchResults.length;
          return (
            <>
              <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.listContent, { alignItems: 'center' }]}>
                <View style={{ marginBottom: 16 }}>
                  <Ionicons name="alert-circle" size={48} color="#f59e0b" />
                </View>
                <Text style={[styles.doneTitle, { marginBottom: 8 }]}>
                  {allWeighed
                    ? `${weighed} item${weighed !== 1 ? 's' : ''} need${weighed === 1 ? 's' : ''} your decision`
                    : `${searchResults.length} item${searchResults.length !== 1 ? 's' : ''} could not be added to cart`}
                </Text>
                <Text style={[styles.doneSub, { marginBottom: 20 }]}>
                  {allWeighed
                    ? `Already in your ${storeName} cart, priced by weight — we cannot tell whether the amount there is enough, so we did not add more.`
                    : 'This may be because the item is out of stock or the store no longer carries it.'}
                </Text>
                {!allWeighed && weighed > 0 && (
                  <Text style={[styles.doneSub, { marginBottom: 20 }]}>
                    {weighed} of them {weighed === 1 ? 'is' : 'are'} already in your cart priced by weight — you will be
                    asked whether to keep {weighed === 1 ? 'it' : 'them'} or add more.
                  </Text>
                )}
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
          // MEAL-119: the item is in the cart as a weight line and the only
          // "candidate" is that line (see inCartByWeightReview). Once the user
          // searches a real product instead, customSuggestions take over and this
          // is an ordinary review card again — they have chosen to pick a product,
          // so the normal add/save affordances are the right ones from then on.
          const inCartByWeight = !isChoose
            && currentReview.reason === IN_CART_BY_WEIGHT
            && customSuggestions.length === 0;
          console.log(`[Cart ${ts()}]`, 'review render', { isChoose, reviewIdx, candidateName: candidate?.productName, prefs: candidate?.preferences, needsPref, selectedSuggIdx, inCartByWeight });
          const canAdd = !customSearching && (
            selectedSuggIdx === 'custom'
              ? customText.trim().length > 0
              // OOS is only blocked in the add-to-cart / review flow. Choose
              // Product just saves the product as the ingredient's searchTerm for
              // future runs (no cart add), so an out-of-stock pick is allowed there.
              : candidate != null && (isChoose || !candidate.outOfStock) &&
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
                {inCartByWeight && (
                  <InCartByWeightNote cartName={currentReview.candidates[0]?.productName ?? null} />
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

                {/* Candidates header / loading / no-results empty state */}
                {customSearching ? (
                  // Loading icon while a custom search runs — replaces the stale list.
                  <View style={{ paddingVertical: 28, alignItems: 'center', gap: 8 }}>
                    <ActivityIndicator color={storeColor} />
                    <Text style={{ fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3 }}>
                      Searching{customSearchTerm ? ` for "${customSearchTerm}"` : ''}…
                    </Text>
                  </View>
                ) : hasCandidates ? (
                  <Text style={styles.suggHeader}>
                    {customSuggestions.length > 0
                      ? `Results for "${customSearchTerm}"`
                      // Not a suggestion and it must not claim to be one: this row
                      // is the line already sitting in the cart (MEAL-119).
                      : inCartByWeight ? 'In your cart now' : `${storeName} suggests`}
                  </Text>
                ) : (
                  // No results: make it explicit the user can search a different product
                  // name via the "Other — type a product name…" row just below.
                  <View style={styles.noResultsBox}>
                    <Text style={styles.noResultsTitle}>
                      {customSearchTerm ? `No results for "${customSearchTerm}"` : 'No products found'}
                    </Text>
                    <Text style={styles.noResultsBody}>
                      Type a different product name below to search {storeName} again.
                    </Text>
                  </View>
                )}

                {!customSearching && displayCandidates.map((c, i) => {
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
                          // Don't dim OOS rows in Choose Product — they're selectable there.
                          opacity: c.outOfStock && !isChoose ? 0.5 : 1,
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
                  // On an in-cart-by-weight card, 0 is a perfectly good answer
                  // ("keep what I have") rather than a missing one, so the stepper
                  // is not reddened and asks for EXTRA units instead of the qty.
                  const qtyRequired = !inCartByWeight && qty === 0;
                  return (
                    <View key={mi.mealId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ fontSize: 14, fontFamily: 'Inter_500Medium', color: qtyRequired ? '#ef4444' : Colors.text2, flex: 1 }} numberOfLines={1}>
                        {showMealName ? mi.mealName : inCartByWeight ? 'How much more to ask for' : 'Qty to add to cart'}
                      </Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <TouchableOpacity
                          onPress={() => adjustReviewMealQty(reviewIdx, mi.mealId, -1)}
                          disabled={qty === 0}
                          style={[styles.qtyBtn, qty === 0 && { opacity: 0.3 }]}
                        >
                          <Text style={styles.qtyBtnText}>−</Text>
                        </TouchableOpacity>
                        <Text style={{ fontSize: 14, fontFamily: 'Inter_600SemiBold', color: qtyRequired ? '#ef4444' : Colors.text1, minWidth: 36, textAlign: 'center' }}>
                          {isWeightCandidate ? weightLabel(qty) : qty}
                        </Text>
                        <TouchableOpacity onPress={() => { if (!isWeightCandidate || qty < maxWeightSteps) adjustReviewMealQty(reviewIdx, mi.mealId, 1); }} style={styles.qtyBtn}>
                          <Text style={styles.qtyBtnText}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
                {!isChoose && !inCartByWeight && totalQty === 0 && typeof selectedSuggIdx === 'number' && (
                  <Text style={styles.qtyHint}>Set a quantity above to add this to your cart.</Text>
                )}

                {isChoose ? (
                  // Choose-product flow: "Qty for this meal" + Back / Next→ / Save
                  <>
                    <View style={{ borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 12, gap: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 13, fontFamily: 'Inter_500Medium', color: chooseQty === 0 ? '#ef4444' : Colors.text2 }}>
                          Qty for this meal
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
                      {chooseQty === 0 && typeof selectedSuggIdx === 'number' && (
                        <Text style={styles.qtyHint}>Set how many this meal needs.</Text>
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
                          {customSearching
                            ? 'Searching…'
                            : (typeof selectedSuggIdx === 'number' && chooseQty === 0)
                              ? 'Choose Quantity'
                              : reviewIdx === searchResults.length - 1 ? 'Save' : 'Next →'}
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
                ) : inCartByWeight ? (
                  // MEAL-119: neither "pick a product" nor "out of stock" — the
                  // item is in the cart by weight and only the user can say whether
                  // that covers the meal. Its own three answers, none of which is
                  // an unattended re-add. See InCartByWeightActions.
                  <InCartByWeightActions
                    addQty={totalQty}
                    storeColor={storeColor}
                    // The two guards every other footer on this screen already
                    // had. Without the first, a decision taken mid-search advances
                    // the queue and the in-flight SEARCH_RESULT lands on the NEXT
                    // item's card, offering this ingredient's products under
                    // "Results for <previous term>"; without the second, "Add more"
                    // with "Other — type a product name…" selected and the box
                    // empty returns out of handleReviewDecision doing nothing at
                    // all — no add, no advance, no feedback.
                    searching={customSearching}
                    customTermMissing={selectedSuggIdx === 'custom' && customText.trim().length === 0}
                    onKeep={() => handleReviewDecision('keep')}
                    // 'add' (not 'update'): adds the units the user asked for
                    // without saving a cart line's title as the ingredient's
                    // product for every future run.
                    onAddMore={() => handleReviewDecision('add')}
                    onSkip={() => handleReviewDecision('skip')}
                    onBack={reviewIdx > 0
                      ? () => { const target = reviewIdx - 1; setReviewIdx(target); setPickedItems((prev) => prev.filter((p) => p.reviewIndex !== target)); }
                      : undefined}
                  />
                ) : (
                  // Review-unmatched flow: add to cart (with or without saving searchTerm).
                  <>
                    <TouchableOpacity
                      onPress={() => handleReviewDecision('update')}
                      disabled={!canAdd || customSearching}
                      style={[styles.primaryBtn, { backgroundColor: storeColor }, (!canAdd || customSearching) && { opacity: 0.4 }]}
                    >
                      <Text style={styles.primaryBtnText}>
                        {customSearching
                          ? 'Searching…'
                          : (typeof selectedSuggIdx === 'number' && totalQty === 0)
                            ? 'Choose Quantity'
                            : 'Add & Update Meal Ingredient'}
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

              {/* Full-screen product photo (MEAL-64), opened by tapping the
                  thumbnail. Lives here because the selected candidate's image
                  URL is scoped to this step. */}
              <ProductImageViewer
                uri={selectedImageUrl}
                visible={viewerOpen}
                onClose={() => setViewerOpen(false)}
              />
            </View>
          );
        })()}

        {/* ── Step: done ─────────────────────────────────────────────────── */}
        {step === 'done' && (() => {
          const wasChooseFlow = searchResults.length > 0 && searchResults.every(r => r.isChoose);
          const skippedNames = Object.values(skippedByIdx).filter(Boolean);
          const keptNames = Object.values(keptByIdx).filter(Boolean);
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
                        {failedNames.length > 0
                          ? `Could not add: ${failedNames.join(', ')}`
                          : `${totalFailed} item${totalFailed !== 1 ? 's' : ''} could not be added.`}
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
                    {/* Two different runs land here and they need different
                        words. If nothing was ever attempted (choose-a-product,
                        or every item skipped in review) the cart was never
                        touched. If adds WERE attempted and all came back failed,
                        "no products were selected" is simply false — and it is
                        exactly the run the cart check below probes, so it can
                        contradict the banner it sits above. */}
                    <Text style={styles.doneSub}>
                      {addsAttemptedRef.current > 0
                        ? "We couldn't confirm any adds."
                        : 'No products were selected or all were skipped.'}
                    </Text>
                    {/* A run that added nothing still gets the cart check now
                        (MEAL-47), and it is the run most likely to have found
                        something: an add that committed while the store's badge
                        read stale comes back as a failure. Without this the
                        finding had nowhere to render — the banner only existed
                        on the added>0 branch — and the user would re-add an item
                        already in their cart. */}
                    {cartDeltaWarning && (
                      <View style={styles.cartCheckBanner} testID="cart-check-warning">
                        <Ionicons name="alert-circle" size={18} color="#b45309" />
                        <Text style={styles.cartCheckBannerText}>{cartDeltaWarning}</Text>
                      </View>
                    )}
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

              {/* MEAL-119: weight lines the user decided were already enough.
                  Reported, not counted as added — Mealio added nothing for these,
                  and the count above must stay the count of what it did. */}
              {keptNames.length > 0 && (
                <View style={styles.skippedBanner} testID="snapshot-kept">
                  <Text style={styles.skippedBannerTitle}>
                    {keptNames.length} weight item{keptNames.length !== 1 ? 's' : ''} kept as already in your cart
                  </Text>
                  <Text style={styles.skippedBannerBody} numberOfLines={3}>
                    {keptNames.join(', ')}
                  </Text>
                </View>
              )}

              {!cartResultRows && !cartRowsTimedOut && (buildCartPageCountScript(lockedStoreId) || buildInlineCartScript(lockedStoreId)) && shouldProbeAfterRun({ addsAttempted: addsAttemptedRef.current, hasBaseline: cartCountBeforeRef.current != null }) ? (
                // Cart-page store (or inline side-panel store like ALDI) with a
                // baseline: the after-probe is reading the cart. Show a loading
                // state instead of the plain list so the breakdown doesn't flash
                // in. Same gate as the probe itself so the two can't disagree —
                // no baseline, or no add attempted, means no probe, so we skip
                // the spinner and fall through to the plain list below.
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
  // A parked pre-search worker while it's not being shown live: kept at a real
  // 414×896 viewport (so the results page paints and can be added into) but
  // pushed far offscreen and out of flow so it neither shows nor disturbs the
  // main WebView's layout.
  presearchOffscreen: { position: 'absolute', width: 414, height: 896, left: 0, top: 0, opacity: 0, transform: [{ translateX: 100000 }] },
  // Live-browser region (visible during every automation phase).
  browserOuter: {
    flex: 1,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  browserArea: { flex: 1, backgroundColor: Colors.border },
  // Single WebView fills the region (login, login_check, sequential, snapshot).
  fullWrap: { flex: 1 },
  fullCell: { flex: 1 },
  // Tile grid: main + live workers, 2-up wrapping, dropping as workers finish.
  gridWrap: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'flex-start',
    gap: 8,
    padding: 0,
  },
  tile: {
    backgroundColor: '#fff',
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  // Clips the oversized (414×896) worker WebView down to the tile after scaling.
  tileClip: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  tileLabel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(17,24,39,0.72)',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  tileLabelText: { color: '#fff', fontSize: 11, fontFamily: 'Inter_500Medium' },
  // Caption bar above the browser during login_check / searching / adding.
  captionBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
    gap: 8,
  },
  captionLabel: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text2 },
  // Wrapper around the login / blocker banner + action button.
  topBar: { backgroundColor: '#fff7ed' },
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

  // Progress bar (caption bar under the header during searching / adding).
  progressTrack: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.border,
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
  qtyHint: { fontSize: 12, fontFamily: 'Inter_500Medium', color: '#ef4444', marginTop: 2 },
  noResultsBox: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 10,
    gap: 4,
  },
  noResultsTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text1 },
  noResultsBody: { fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.text3, lineHeight: 17 },

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
