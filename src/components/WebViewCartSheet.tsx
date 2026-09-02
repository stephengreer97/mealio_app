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
  Animated,
  Easing,
  AccessibilityInfo,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import WebView, { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import FloatingPreviewImage from './FloatingPreviewImage';
import ProductImageViewer from './ProductImageViewer';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Colors } from '../constants/colors';
import { getStoreProduct } from '../lib/storeProducts';
import ExpandableNotice from './ui/ExpandableNotice';
import { Meal } from '../types';
// Two entry points on purpose: useStores() where the value is rendered, and
// getStores() at the two message-handler sites, which read the CURRENT catalog
// at call time for the same reason they read lockedStoreIdRef — a value captured
// in those closures can be several renders stale.
import { getStores } from '../lib/store-catalog';
import { useStores } from '../lib/store-catalog/useStores';
import { buildBlankPageRecoveryScript } from '../lib/webview-scripts/blank-page-recovery';
import { getStoreScripts, StoreScripts } from '../lib/webview-scripts';
import { getNetworkRail, railConfigKey, NETWORK_SESSION_MESSAGE_TYPES } from '../lib/webview-scripts/network-rail';
import { planSearchResume } from '../lib/webview-scripts/resume-search';
import CartRunAnimation from './CartRunAnimation';
import { isAuthRedirectUrl } from '../lib/webview-scripts/auth-urls';
import { useLoginPrewarm } from '../context/LoginPrewarmContext';
import { getStoreWebViewUA } from '../lib/webview-user-agent';
import { WEBVIEW_FINGERPRINT_SHIM } from '../lib/webview-fingerprint-shim';
import { usage } from '../lib/api';
import {
  ConsolidatedIngredient,
  consolidateIngredients,
} from '../lib/consolidateIngredients';
import { ingredientAmount, withPrep } from '../lib/formatMeasurement';
import { isChooseRun as isChooseRunItems } from '../lib/chooseRun';
import { ingredientWeight, weightLabelLb } from '../lib/weightDisplay';
import { useDraggablePreview } from '../lib/useDraggablePreview';
import { FEATURE_PARALLEL_ADD } from '../constants/features';
import { chooseAddStrategy } from '../lib/automation-config/decisions';
import Constants from 'expo-constants';
import { getAutomationConfig, getConfigVersion } from '../lib/automation-config';
import { setLastAutomationRun } from '../lib/lastAutomationRun';
import { AutomationTelemetry, createNoopTelemetry, addFailureCode, blockFailureCode } from '../lib/automation-telemetry';
import { SELECTOR_HEALTH_MESSAGE, SelectorHealthTally } from '../lib/selector-health';
import { buildCartCountScript, getCartPageUrl, buildCartPageCountScript, buildOpenCartScript, buildInlineCartScript, diffCartItems, isCountedCartSnapshot, CartItem, CartRow } from '../lib/webview-scripts/cart-count';
import { HebAddConfirmation, confirmDetail } from '../lib/webview-scripts/heb-cart-query';
import { auditCartAfterRun, buildCartVerdict, dropExplainedOverAdds, dropRecoveredFailures, isWeightPriced, isZeroedOut, reconcileFromWorkerReports, reconcileParallelAdd, shouldProbeAfterRun, splitUnverifiableTopUps, summarizeConfirmations, toIntendedItem, unitsForNames, AttemptedAdd, IntendedItem, OverAdd } from '../lib/cart-reconcile';
import { ConfirmedSource, RequestedCount, RunKind, RunSummaryFacts, correctConfirmedFromCart, countRequested, isRunComplete, runSummaryDetail, runSummaryFailureDetail } from '../lib/north-star';
import { scoreMatch } from '../lib/webview-scripts/_scoring';
import {
} from '../lib/webview-scripts/heb-network-search';
import { rankChoiceCandidates } from '../lib/chooseRanking';

// ── Types ────────────────────────────────────────────────────────────────────

interface MealIngredientQty {
  mealId: string;
  mealName: string;
  qty: number;
  /**
   * This meal's preparation for the row (MEAL-102). Per meal, not on the
   * consolidated entry, because two meals sharing an onion can want it diced and
   * sliced. Display only — nothing that builds a search term reads it, and the
   * "you searched for" line above deliberately prints `term` untouched.
   */
  prep?: string;
}

interface Candidate {
  productName: string;
  imageUrl: string | null;
  outOfStock: boolean;
  /** `preferenceId` is present only on network candidates — the page path builds
   *  these from a modal row label and has no id to give. */
  preferences: Array<{ text: string; value: string; preferenceId?: string }> | null;
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
  /** The store's per-item cap, when the extractor can see one. The network write
   *  sets an ABSOLUTE quantity, so cart-held + asked can exceed it. */
  maxOrderQuantity?: number | null;
}

interface SearchResult {
  term: string;
  candidates: Candidate[];
  mealIngredients: MealIngredientQty[];
  unit: string;
  measure: string | null;
  /** `quantity_limit_reached` is MEAL-202's: the cart already holds the store's
   *  per-item maximum, so there is nothing this run can add and a retry cannot
   *  change that. It reaches the review screen like any other definitive
   *  failure. */
  reason: 'out_of_stock' | 'no_results' | 'low_confidence' | 'needs_weight'
    | 'quantity_limit_reached' | 'needs_preference';
  isChoose: boolean; // true = choose-product flow (no searchTerm yet); false = review unmatched (searchTerm set but no match)
}

/**
 * MEAL-119: one count-ordered item whose cart line came back sold-by-weight.
 *
 * Not a failure and not a success. The store may well have added it, as a single
 * line at some poundage that cannot be compared to a ×3 — so the run neither
 * re-adds it (that buys the deli meat a second time) nor confirms it (that hands
 * the user one slice and calls the order complete). It is reported instead, on
 * the done screen, with no decision asked of the user.
 *
 * NARROWED by MEAL-148: where the item's per-click increment is known, the
 * poundage the line gained now answers the question outright, so those items are
 * confirmed or topped up by the missing clicks and never reach this banner. What
 * still does is the case the arithmetic cannot decide. See splitUnverifiableTopUps.
 */
interface UnverifiedWeightLine {
  /** What the meal asked for — the item's search term. */
  term: string;
  /** The sold-by-weight line the cart really holds under that name. */
  cartName: string;
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
  /** 'ingredient' when these candidates came from the SECOND search — the one
   *  by ingredient name, run because the chosen product returned nothing. Kept
   *  so the review screen and telemetry can tell "here is what we found for
   *  sour cream" from "here is what we found for the sour cream you picked". */
  searchedBy?: 'product' | 'ingredient';
}

interface PickedItem {
  searchTerm: string;
  productName: string;
  preference: { text: string } | null;
  qty: number;
  /** Sold-by-weight: the chosen weight (lb) to select at add time. */
  purchaseWeight?: number | null;
  /** The store's own ids for the picked product, when the search that produced
   *  it could see them — which on a rail store is always, because the rail's
   *  candidates come from the store's own API. They are what lets the pick be
   *  ADDED over the rail instead of clicked: PickedItem was name-only, built for
   *  a DOM path that found the card by its title. */
  productId?: string | null;
  skuId?: string | null;
  maxOrderQuantity?: number | null;
  purchasePreferenceId?: string | null;
  /** The review-queue index this pick was made for (manual-review picks only).
   *  Lets the "Back" button remove the pick that belongs to the item being left
   *  rather than blindly popping the last one — "Skip" advances WITHOUT pushing,
   *  so the last pick can belong to a much earlier item. */
  reviewIndex?: number;
}

export type Step = 'qty' | 'login_check' | 'login' | 'searching' | 'searchResult' | 'review' | 'adding' | 'done' | 'robot_challenge' | 'manual';

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
  /** `storeProduct` is the STORE'S OWN ID for what was picked, when the search
   *  that produced it could see one — which on a rail store is always. Saving it
   *  is what makes Choose Product once, add forever literal: the next run writes
   *  that id straight to the cart instead of searching the name and letting the
   *  store's ranking pick again. */
  onIngredientChosen?: (ingredientName: string, mealIds: string[], productName: string, mealQtys?: Record<string, number>, dropdown?: { type: string; selectedText: string; selectedValue: string } | null, purchaseWeight?: number | null, weightStep?: number | null, storeProduct?: { upc: string; name: string; sku?: string } | null) => void;
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

/**
 * The store's own id for a candidate, in the shape `storeProducts` keeps.
 *
 * Null when the search that produced the candidate could not see one -- a
 * page-read candidate has a name and nothing else. Returning null then is the
 * point: a row must not gain a key it cannot use, and `getStoreProduct` treats
 * a missing entry as "search for it", which is what today already does.
 */
/**
 * The product this row was chosen for at the store now running, or null.
 *
 * Null is the normal answer for a meal nobody has chosen for yet, and it means
 * exactly what it has always meant: search for it.
 */
function storedProductFor(item: { storeProducts?: Record<string, { upc: string; name: string; sku?: string }> | null },
                          storeId: string | null): { upc: string; name: string; sku?: string } | null {
  return getStoreProduct(item, storeId);
}

function railStoreProduct(c: { productId?: string | null; skuId?: string | null; productName?: string })
  : { upc: string; name: string; sku?: string } | null {
  if (!c || !c.productId) return null;
  return {
    upc: String(c.productId),
    name: c.productName ?? '',
    // H-E-B addresses a cart line by sku and refuses to build a write without
    // one, so a saved product that omitted it would be unusable there.
    ...(c.skuId ? { sku: String(c.skuId) } : {}),
  };
}

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

// Extra downward offset (px) for the floating preview's default rest in the Pick
// a Substitute flow so it doesn't sit too high vs Choose Product. Tune on-device.
const REVIEW_PREVIEW_Y_OFFSET = 28;

// Cart-check copy for one over-added product: bare name, or "name ×N" when more
// than one unclaimed unit of it landed.
function overAddLabel(o: OverAdd): string {
  return o.qty > 1 ? `${o.name} ×${o.qty}` : o.name;
}

// What to say when the run could not read the cart at all (MEAL-190).
//
// One string for every way it happens — the probe never answered, or it answered
// "I cannot prove this page is the cart" — because the user's situation is
// identical in all of them: we could not check your cart, go look. WHY we could
// not read it belongs in the log, which already carries `reason=` and `url=`.
//
// Deliberately not the cart-check wording. Those messages report something the
// cart SAID; this one reports that there is nothing to report.
function unverifiedCartMessage(storeName: string): string {
  return `Couldn't verify your ${storeName} cart — please double-check it.`;
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
  const storeColor = useStores().find((s) => s.id === lockedStoreId)?.color ?? '#dd0031';
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
  // Mirrored for onLoadEnd, which has []-deps.
  const loginPrewarmRef = useRef(loginPrewarm);
  loginPrewarmRef.current = loginPrewarm;

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
  // Same snapshot, reachable from the callbacks below that cannot close over it.
  // presearchOnInjectAdd has [] deps and captures nothing on purpose;
  // beginSearchFlow lists four deps, none of them the config, and is reached
  // through a closure chain that froze at an early render — which is why it
  // already resolves the store from a live ref rather than trusting what it
  // captured. Reading the config the same way (scriptsRef, lockedStoreIdRef) is
  // how the rest of this file solves that, and it keeps the per-open snapshot.
  const cfgFlagsRef = useRef(cfgFlags);
  cfgFlagsRef.current = cfgFlags;

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

  /**
   * End this run's telemetry: the terminal row a run that never reached 'done'
   * would otherwise never get, and the dispose() that EVERY run needs (MEAL-5).
   *
   * `run_summary` used to be emitted from exactly one place — the 'done' effect —
   * so it was a row about runs that finished, not a row about runs. Every other
   * way a run ends produced none: the user closing the sheet at the qty screen,
   * at a login, at a robot wall it was never going to get past, a sign-out ending
   * the job, a store that wedged until the user gave up. `logAutomationStart` has
   * already written an `automation_runs` row for all of those, so they were
   * present in the run table and absent from the funnel — the shape of gap that
   * reads as a smaller, healthier funnel rather than as missing data.
   *
   * It biases OPTIMISTICALLY, and that is the direction that matters: a run a
   * user abandons is not a random run. It is disproportionately one that was
   * going badly, so the rows that vanished are the failures.
   *
   * Outcome 'skipped', not 'error': the run did not fail, it stopped. 'skipped'
   * is the one non-success outcome that carries no failure code, so these rows
   * cannot leak into the code tally or the failure charts, and `detail.terminal`
   * lets the read side count or exclude them deliberately. Nothing here needs a
   * new member of StepOutcome or StepName, and that is on its own merits: this
   * app is the only producer of either (MEAL-29 retired the shared-vocabulary
   * claim that used to be the reason given here), so the reason not to add one is
   * that 'skipped' already says it, not that anything forbids it.
   *
   * `abandonedAt` is the actionable field: a pile of 'qty' is people changing
   * their mind before any automation ran, and a pile of 'robot_challenge' is a
   * store beating us. Those must not be one number.
   *
   * Reads nothing but refs, deliberately. It is called from a cleanup with `[]`
   * deps, so the closure it runs from may be the first render's — a rule that
   * holds as long as every value here is read through `.current`.
   */
  const endRun = useCallback(() => {
    const t = telemetryRef.current;
    // Keyed on the runId, not on the recorder: without one the server issued no
    // run, so there is no `automation_runs` row for this row to be the missing
    // half of, and the recorder is the no-op that drops everything anyway.
    // `automationCompletedRef` is what keeps a run that DID reach 'done' from
    // shipping a second terminal row on its way out — and a second row is not a
    // harmless duplicate: mealio_central's automation-trace takes the LAST
    // run_summary as the run's terminal row, so a 'skipped' one landing after a
    // clean finish blanks that run's code and relabels it in the drilldown.
    if (automationRunIdRef.current && !automationCompletedRef.current) {
      automationCompletedRef.current = true;
      t.record('run_summary', 'skipped', {
        detail: {
          terminal: 'abandoned',
          abandonedAt: stepRef.current,
          kind: runKindRef.current,
          requested: requestedRef.current.requested,
          // The same expression every finalize path computes setTotalAdded from,
          // read off the ref because this runs from a cleanup with no live state.
          itemsAdded: addResultsRef.current.filter((r) => r.success).length,
          runComplete: false,
        },
      });
    }
    // UNCONDITIONAL, and outside the guard above on purpose. dispose() sends what
    // is buffered and stops the retry timer; flush() would do only the first, and
    // a recorder whose uploads are failing re-arms that timer on every refused
    // attempt — forever, for the life of the process.
    //
    // A run that reaches 'done' needs this every bit as much as one that is
    // abandoned. It is the COMMON path: the done effect records the terminal row
    // and flushes, then this cleanup runs and takes the early return above, so
    // scoping the dispose to abandoned runs would have left the leak open on
    // every successful run and closed it only for the rare ones.
    void t.dispose();
  }, []);

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
      // Before the resets below wipe the runId and the completion flag this
      // needs to read.
      endRun();
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
  }, [visible, storeId, meals.length, cfgTelemetry, endRun]);

  // Being unmounted is an abandonment too, and it is the one that matters most:
  // the live mount site (CartJobContext, FEATURE_BACKGROUND_CART) renders this
  // with `visible` hardcoded true and ends a run by dropping the job, so the
  // close branch above never runs there. The refs it would have reset die with
  // the component anyway — but setLastAutomationRun writes module state that
  // outlives it, so a response landing after teardown could still name a run
  // nobody is watching. Its own effect, not a cleanup on the one above, which
  // would fire on every dependency change and cancel a legitimate start.
  //
  // It is also the ONLY place the live mount site can emit a terminal row from,
  // for the same reason: dropping the job unmounts this, so every run that ends
  // anywhere but the done screen ends here (MEAL-5).
  //
  // The `[]` is load-bearing, and it is what enforces both of those — not a
  // convention. `endRun` is stable, so listing it would buy nothing, but a dep
  // that ever DID change turns this cleanup into a mid-run event: it bumps the
  // generation, so the in-flight logAutomationStart response is discarded and
  // the run never gets a recorder at all.
  //
  // Measured with `[step]`, and the outcome depends on a race: if a step change
  // beats the logAutomationStart response the run uploads NOTHING, and if the
  // start lands first the run ships a false `skipped` terminal row for a run that
  // actually finished — losing login_check, add_click, confirm and the real `ok`
  // summary. The second is the worse one, and it is exactly the corruption the
  // single-terminal-row guard above exists to prevent. Neither failed a test
  // before this commit; both do now. So `endRun` reads refs only (see there) and
  // this list stays empty.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    automationGenRef.current += 1;
    endRun();
  }, []);

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
  // Mirrored for the message handlers, which have []-deps and would otherwise
  // read this run's initial empty array — the same reason skippedByIdxRef exists.
  const pickedItemsRef = useRef<PickedItem[]>([]);
  pickedItemsRef.current = pickedItems;
  // Draggable floating product-preview thumbnail (88x88, rests 12px from the
  // right). Tapping it opens the full-screen viewer (MEAL-64).
  const [viewerOpen, setViewerOpen] = useState(false);
  const preview = useDraggablePreview(88, 88, 12, () => setViewerOpen(true));
  // Re-center the thumbnail on each new ingredient being reviewed. The Pick a
  // Substitute flow rests slightly lower than Choose Product — its search box has
  // a reason line above it, so the centered default otherwise reads as too high.
  useEffect(() => {
    const rev = searchResultsRef.current[reviewIdx];
    preview.setDefaultOffset(rev && !rev.isChoose ? REVIEW_PREVIEW_Y_OFFSET : 0);
    // Close the viewer on the way to the next ingredient — it would otherwise
    // stay up showing the previous product's photo.
    setViewerOpen(false);
    preview.reset();
  }, [reviewIdx, preview.reset, preview.setDefaultOffset]);
  // Ingredients the user explicitly skipped while picking substitutes, keyed by
  // reviewIndex so re-deciding after Back clears the earlier skip. Reported on
  // the done snapshot — distinct from items the automation failed to add.
  const [skippedByIdx, setSkippedByIdx] = useState<Record<number, string>>({});
  // Mirror for onMessage, which is created once (deps []) and so closes over
  // this run's initial {}. The after-probe needs the skips to keep them out of
  // the cart's failed list (MEAL-199), and every skip is decided long before
  // that probe runs. Assigned during render rather than in an effect so a read
  // can never see a value one commit stale.
  const skippedByIdxRef = useRef<Record<number, string>>({});
  skippedByIdxRef.current = skippedByIdx;
  // MEAL-119: count items whose cart line came back sold-by-weight — neither
  // re-added nor confirmed, only reported (see UnverifiedWeightLine). Held apart
  // from `addResults` (Mealio added nothing for these, so they cannot be counted
  // as added), from `failedNames` (they may well have landed, so "could not add"
  // would be a lie) and from `skippedByIdx` (nobody chose anything — the run
  // never reaches the user with these).
  const [unverifiedWeightLines, setUnverifiedWeightLines] = useState<UnverifiedWeightLine[]>([]);
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
  // The most recent cart read, whatever phase produced it. Manual mode snapshots
  // this on the way in so the rows that appear while the USER is driving can be
  // told apart from rows this run put there (MEAL-197).
  const cartItemsLatestRef = useRef<CartItem[]>([]);
  // Terms handed to manual mode, and the cart as it stood when they were.
  const manualHandledRef = useRef<string[]>([]);
  const manualCartSnapshotRef = useRef<CartItem[]>([]);
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
  // Held as {title, detail} rather than one string so the banner can fold the
  // product LIST without folding the verdict (MEAL-176). Only ever read for
  // truthiness elsewhere — the run outcome and the funnel just ask whether the
  // cart disagreed with the run.
  const [cartDeltaWarning, setCartDeltaWarning] = useState<{ title: string; detail: string } | null>(null);
  // True once the done screen's verdict is the CART's rather than the run's
  // (MEAL-199). It gates the "Could not add" sub-line: that line and the banner
  // are now two renderings of one verdict, so printing both would restate the
  // absent items in consecutive sentences — the duplication this ticket exists
  // to remove, rebuilt from the same source instead of two.
  const [verdictFromCart, setVerdictFromCart] = useState(false);
  // The run could not read the cart AT ALL — held apart from cartDeltaWarning
  // rather than folded into it (MEAL-190).
  //
  // They read the same on the done screen, and they are opposite facts. A
  // cartDeltaWarning is something the cart SAID: it was read, and it disagreed
  // with the run. This is the absence of any reading, so nothing could have
  // disagreed — the item counts on such a run are the run's own report of itself,
  // and the cart diff is the only check that has ever contradicted one (MEAL-185,
  // MEAL-187, MEAL-188 all reported success on their own internal checks).
  //
  // Telling them apart is what the run's `outcome` rides on. Recorded as
  // `partial`, an unverified run claims a cart was checked and came up short — a
  // claim about a cart nobody saw, indistinguishable from a real under-add. On a
  // store whose cart URL redirects (Walmart today, HEB while heb.com/cart 302s)
  // that is potentially EVERY run, so the two have to be countable apart or one
  // store's redirect reads as a fleet-wide regression. mealio_central accepts
  // `unverified` as its own outcome; see app/api/usage/automation/route.ts there.
  const [cartUnverified, setCartUnverified] = useState<string | null>(null);
  const [addedNames, setAddedNames] = useState<string[]>([]);
  // Names of items that could not be added, shown on the done screen so the
  // failure is specific ("Sour Cream could not be added") instead of a bare count.
  const [failedNames, setFailedNames] = useState<string[]>([]);
  // Mirror of the above for onMessage, which is created once (deps []) and so
  // closes over this run's initial []. The after-probe corrects this list from
  // the cart read (see the RECOVERED branch), and it has to start from what the
  // screen is currently claiming. Written only through setFailedItems, so the
  // two cannot drift.
  const failedNamesRef = useRef<string[]>([]);
  const setFailedItems = useCallback((names: string[]) => {
    failedNamesRef.current = names;
    setFailedNames(names);
  }, []);

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
    // An ingredient the user SKIPPED at review is not a failure, whatever the
    // automation did with it first.
    //
    // The two are separate facts and the screen renders them separately — "Could
    // not add: X" above, "1 item you skipped: X" below — so an item in both lists
    // is named twice in the same breath, once as something that went wrong and
    // once as something the user chose. Measured on a device 2026-08-29: the
    // automation timed out searching for an onion, the user skipped it at review,
    // and the done screen reported it both ways.
    //
    // The skip is the later fact and the deliberate one, so it wins. Filtered
    // here rather than in handleReviewDecision because the skip can be recorded
    // before or after the failure, depending on which rail failed first.
    //
    // This is not the only path to the done screen — finishParallelAdd and the
    // after-probe both write the failed list without calling this. Neither is
    // reachable with a skip today (the first runs pre-review; the second goes
    // through auditCartAfterRun, which already excludes skippedNames). A new
    // finalize path would have to honour the same rule itself.
    const skipped = Object.values(skippedByIdxRef.current);
    const wasSkipped = (name: string) =>
      skipped.some((s) => s.trim().toLowerCase() === (name ?? '').trim().toLowerCase());
    const stillFailed = failures.map((f) => f.name).filter((n) => !wasSkipped(n));
    setFailedItems(stillFailed);
    // The COUNT is set here too, and that is the whole point of it living in one
    // function. `totalFailed` alone gates the "Could not add" line, and the line
    // falls back to a bare "N items could not be added." when it has no names —
    // so filtering the names while a caller set the count from the unfiltered
    // list just re-prints the same wrong claim with the item's name taken off
    // it. Measured on a device: one skipped ingredient, name correctly gone,
    // "1 item could not be added." still sitting above the skipped banner.
    setTotalFailed(stillFailed.length);
  }, [setFailedItems]);
  const activeItemsRef = useRef<ConsolidatedIngredient[]>([]);
  // ── Network run (MEAL-202) ────────────────────────────────────────────────
  // Search and add by asking the store, from one page, with no navigation. The
  // pools exist to load results pages concurrently; this needs no page, so it
  // replaces them rather than driving them.
  //
  // Everything it produces is funnelled into finishParallelAdd, the SAME
  // completion the add pool calls, so the reconcile, the review routing, the
  // done screen and the telemetry are untouched and cannot disagree with a
  // pool-driven run.
  const netSessionRef = useRef<{ storeId: string; shoppingContext: string } | null>(null);
  /**
   * When netSessionRef was answered, so the run can tell a session it can reuse
   * from one that has had time to go stale. See startNetworkRun.
   */
  const netSessionAtRef = useRef(0);
  /**
   * THE SECOND SEARCH, FOR ITEMS THE FIRST ONE FOUND NOTHING FOR.
   *
   * The rail searches the PRODUCT the user chose -- that is the whole point of
   * Choose Product once, add forever. When that product is delisted the search
   * returns nothing, and the review screen then asks the user to choose from an
   * empty list.
   *
   * So a term that comes back with NO results is searched again by INGREDIENT
   * name, and the review screen shows those instead. Only that case: a search
   * that returned near-variants (a different size, a store brand) is showing
   * better options than a fresh ingredient search would, and it keeps them.
   *
   * It goes out at the same moment as the writes, so it costs the run nothing
   * and the user never sees a second loading screen -- by the time the adds are
   * done the candidates are usually already here.
   */
  const netStoredProduct = useCallback(
    (item: { storeProducts?: Record<string, { upc: string; name: string; sku?: string }> | null }) =>
      storedProductFor(item, lockedStoreIdRef.current),
    [],
  );
  const netFallbackWantedRef = useRef<Map<number, string>>(new Map());
  const netFallbackCandidatesRef = useRef<Map<string, Candidate[]>>(new Map());
  const netFallbackPendingRef = useRef(false);
  const netStartFallbackSearchRef = useRef<() => void>(() => {});
  const netApplyFallbackCandidatesRef = useRef<() => void>(() => {});
  /** True once THIS run has the session it needs. A second answer to the same
   *  probe is then inert rather than a second start. */
  const netSessionSettledRef = useRef(false);
  /**
   * The cart as it stood before this run wrote anything, as the RAIL saw it.
   *
   * A fallback for when the page probe could not read the cart — which happens:
   * the before-snapshot navigates to /cart and can land somewhere else, and then
   * `cartItemsBeforeRef` is empty for the whole run. The rail reads the cart on
   * every write anyway, so the FIRST write's `cartBefore` is that same baseline,
   * and capturing it once costs nothing.
   */
  const netRunBaselineRef = useRef<CartItem[] | null>(null);
  // A choose run uses the rail to SEARCH and stops there — it wants candidates
  // for the Choose Products screen, not adds. Before DOM automation was removed
  // that job belonged to the parallel search pool.
  const netChooseOnlyRef = useRef(false);
  // What the animation shows. Only set during a network run, because it is the
  // only path that knows a real denominator up front — it asks for N terms and
  // writes M products, so the ring is a fraction rather than a spinner.
  const [netProgress, setNetProgress] = useState<{ done: number; total: number; label: string | null; phase: 'search' | 'add' } | null>(null);

  // ONE PROGRESS VALUE FOR THE WHOLE RUN.
  //
  // The bag was fed done/total, and search and add each counted their own list
  // from zero — so it filled to full on the last search, dropped to empty when
  // the first write landed, and filled again. Two honest counters, one dishonest
  // animation. The run is one thing to the user, so it gets one number: the
  // search owns the first half, the writes own the second, and it only ever
  // moves forward.
  const netPctRef = useRef(0);
  const [netPct, setNetPct] = useState<number | null>(null);
  const advanceNetPct = useCallback((phase: 'search' | 'add', done: number, total: number) => {
    const base = phase === 'search' ? 0 : 0.5;
    const raw = total > 0 ? base + 0.5 * Math.min(1, done / total) : base;
    if (raw > netPctRef.current) { netPctRef.current = raw; setNetPct(raw); }
  }, []);
  const resetNetPct = useCallback(() => { netPctRef.current = 0; setNetPct(null); }, []);
  // A run that is still going but has stopped counting looks broken. Stephen
  // watched one sit at 3/18 and had no way to tell it apart from a hang, so a
  // run that has not counted anything for a while says so out loud.
  const [netNote, setNetNote] = useState<string | null>(null);
  const bumpNetProgress = useCallback((label?: string | null) => {
    setNetNote(null);
    setNetProgress((p) => {
      if (!p) return p;
      const done = Math.min(p.done + 1, p.total);
      advanceNetPct(p.phase, done, p.total);
      return { ...p, done, label: label ?? p.label };
    });
  }, []);
  // True while the run is doing its own work and the user has nothing to do.
  //
  // login_check is included: the check is silent, the user cannot help, and the
  // page behind it is the storefront doing nothing. The login STEP is excluded
  // and must stay excluded — that is the one screen where the user has to see
  // and touch the page.
  //
  // Scoped to stores with a network rail. A page-path store genuinely uses that
  // WebView to search, so hiding it there would hide the work.
  //
  // Deliberately NOT gated on netProgress being set. It was, and that left the
  // WebView on screen for the seconds between entering a step and the run
  // producing its first number — the session probe, the before-cart snapshot,
  // the beat before the first search answers. The step alone decides, so there
  // is no window where the user sees a page they cannot use.
  const netRunVisual =
    !!getNetworkRail(lockedStoreIdRef.current)
    && (step === 'login_check' || step === 'searching' || step === 'adding');
  // Which protocol this store's rail speaks. Read from a ref rather than closed
  // over, for the same reason the rest of this file resolves the store that way:
  // the callbacks below froze at an early render.
  const netRail = useCallback(() => getNetworkRail(lockedStoreIdRef.current), []);

  /**
   * The login check this store uses: the network rail's session probe when it has
   * one, the DOM check otherwise.
   *
   * A helper rather than the choice written out at each site, because the choice
   * WAS written out at each site and three of the five were missed — so
   * Albertsons kept getting the DOM verdict from whichever entry point happened
   * to run, no matter what the converted ones did. Every injection of a login
   * check goes through here.
   */
  const loginCheckScript = useCallback(() => {
    const rail = getNetworkRail(lockedStoreIdRef.current);
    return rail ? rail.sessionScript() : scriptsRef.current!.checkLoginScript;
  }, []);
  const netCandidatesRef = useRef<Map<string, Candidate[]>>(new Map());
  // The term list of the live search phase, kept so it can be re-asked if the
  // page navigates out from under the script. netSearchInjectsRef caps that:
  // a store that reload-loops must not be re-injected into forever.
  const netSearchTermsRef = useRef<string[]>([]);
  const netSearchInjectsRef = useRef(0);
  const netFailedTermsRef = useRef<Set<string>>(new Set());
  const netResultsRef = useRef<Map<number, AddResult>>(new Map());
  const netActiveRef = useRef(false);
  const netPhaseRef = useRef<'idle' | 'prewarm' | 'session' | 'search' | 'add'>('idle');
  /** How long the run stands back for an in-flight prewarm, and how many times. */
  const NET_PREWARM_WAIT_MS = 300;
  /**
   * THREE SECONDS WAS NOT A WAIT, IT WAS A RACE.
   *
   * The prewarm and the run search the IDENTICAL terms. Standing back costs
   * time; not standing back costs a second batch of the same size against a
   * store whose search degrades under burst (MEAL-207). Measured on Albertsons,
   * six terms, 2026-09-01: the run gave up after 3s, both batches then ran
   * together for 100 seconds, and the first answer took 68 of them. The prewarm
   * alone had been answering fine.
   *
   * So the ceiling scales with the batch, because a bigger batch is both slower
   * to finish AND worse to duplicate. A prewarm that dies still releases the run
   * immediately — netPrewarmDoneRef is set on its failure paths too, so this
   * ceiling is only reached by one that is genuinely still working.
   */
  const netPrewarmMaxWaits = (terms: number) => Math.min(300, Math.max(60, terms * 15));
  /** How long a session answer stays good enough for the run to reuse instead of
   *  re-asking. The login check and the run happen seconds apart, so anything on
   *  this scale works; two minutes is short enough that a sheet left sitting
   *  re-reads rather than trusting a store the user may since have changed. */
  const NET_SESSION_REUSE_MS = 120_000;
  // ── Search prewarm ────────────────────────────────────────────────────────
  //
  // While the user is on the qty screen deciding quantities, the WebView is
  // already sitting on a signed-in store page doing nothing. The searches the
  // run is about to make do not depend on any of those decisions -- a quantity
  // changes what we WRITE, never what we look up -- so they can happen now.
  //
  // It is the one phase that can move off the critical path. Measured across 34
  // of Stephen's runs the search costs 97ms per term: 0.8s at eight items, 1.7s
  // at eighteen. Done here it costs the run nothing.
  //
  // Search only. Nothing is written, so a user who backs out has changed nothing
  // about their cart.
  const netPrewarmStartedRef = useRef(false);
  const netPrewarmCandidatesRef = useRef<Map<string, Candidate[]>>(new Map());
  const netPrewarmTermsRef = useRef<string[]>([]);
  /** How many times the run has stood back for an in-flight prewarm. Bounded so
   *  a prewarm that never answers cannot hold the run for ever. */
  const netPrewarmWaitsRef = useRef(0);
  const netStartSearchRef = useRef<() => void>(() => {});
  /** Set when the prewarm has finished (or given up). Diagnostic only now — the
   *  WebView stays mounted through the qty screen either way, because keeping
   *  the page LOADED is worth more than the prewarm that needed it. */
  const netPrewarmDoneRef = useRef(false);
  /** The qty screen's items, for onLoadEnd — which has []-deps and would
   *  otherwise read this run's initial empty list. */
  const qtyItemsRef = useRef<ConsolidatedIngredient[]>([]);
  const netTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** One write can speak for several items (same product, two ingredients).
   *  Maps the write's index to every item index it answers for. */
  const netWriteFanoutRef = useRef<Map<number, number[]>>(new Map());
  /** What the network run matched, by item index. Kept so a top-up can re-write
   *  the shortfall without searching again — it already knows the product. */
  const netMatchedRef = useRef<Map<number, {
    productId: string; skuId: string | null; name: string;
    purchasePreferenceId: string | null; maxOrderQuantity: number | null;
  }>>(new Map());
  /** This run went down the network route. The top-up reads it to decide whether
   *  it may stay on that rail. */
  const netRunRef = useRef(false);
  /** A network top-up is in flight; its results finalize the run. */
  const netTopUpRef = useRef<Map<number, ConsolidatedIngredient> | null>(null);
  /** Assigned once finishParallelAdd exists, so the add deadline can finalize
   *  without depending on a function declared after it. */
  const netFinalizeRef = useRef<() => void>(() => {});
  // Items the store refused because the cart ALREADY holds its per-item maximum.
  // Held separately from the failed list because "we could not add this" and
  // "your cart is already at the limit for this" are different things to be
  // told: the second is not a failure of the run, and re-running will not help.
  const [capReached, setCapReached] = useState<Array<{ name: string; detail: string }>>([]);

  // ── The "type a product name" row glows when a search found nothing ────────
  //
  // A search with no results leaves the user on a screen whose only useful
  // control is the one that looks least like a control: a row of placeholder
  // text under a list that is empty. The glow is there to say "this one" — it is
  // the only thing on the screen that can move the run forward.
  //
  // Held here rather than in the review branch because that branch re-runs on
  // every keystroke of the custom search; an animation started there would be
  // restarted, and a pulse that restarts reads as a flicker.
  const glowAnim = useRef(new Animated.Value(0)).current;

  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((on) => { if (alive) setReduceMotion(!!on); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (on) => setReduceMotion(!!on));
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  /**
   * True while the review screen is showing an item with nothing to choose from.
   *
   * Derived from the same two inputs the screen itself reads, rather than set
   * during its render: a setState in a render path that re-runs on every
   * keystroke of the custom search is a re-render loop waiting to happen.
   *
   * `customSuggestions` is what the user's own search returned, so the glow goes
   * out the moment they find something — it points at the control, it does not
   * decorate it.
   */
  const glowCustomRow = step === 'review'
    && customSuggestions.length === 0
    && (searchResults[reviewIdx]?.candidates.length ?? 0) === 0;
  useEffect(() => {
    if (!glowCustomRow || reduceMotion) {
      glowAnim.stopAnimation();
      // Settles at a steady, still-visible glow rather than nothing: with reduce
      // motion on, the row should still be the thing that stands out — it just
      // should not move.
      glowAnim.setValue(reduceMotion && glowCustomRow ? 1 : 0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0.25, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [glowCustomRow, reduceMotion, glowAnim]);
  // The pool path is declared BELOW the network path (it is the thing the
  // network path falls back to, so it reads better after it). A ref breaks the
  // cycle without reordering two hundred lines.
  // beginSearchFlow is defined above startAssistedMode and reaches it through a
  // ref, the same way it used to reach startParallelAdd. onLoadEnd reaches the
  // run restart the same way.
  const startAssistedModeRef = useRef<() => void>(() => {});
  const snapshotBeforeAndBeginSearchRef = useRef<() => void>(() => {});
  // onLoadEnd is a []-dep callback, so it reaches the resume through a ref for
  // the same reason startParallelAdd does.
  const netResumeSearchAfterNavRef = useRef<() => void>(() => {});
  // ── Manual add mode (MEAL-197 / MEAL-9 rung 3) ─────────────────────────────
  // The queue is search TERMS, not ingredients. Everything this mode needs is a
  // string to search for and a string to show the user, and `failedItems` is
  // already exactly that — the same names printed under "Could not add", so the
  // list the user is handed cannot drift from the list they were just shown.
  const [manualQueue, setManualQueue] = useState<string[]>([]);
  const [manualIdx, setManualIdx] = useState(0);
  // Every item the user has been walked past, by Skip or by Next. Not just the
  // skipped ones: measured on a device, finishing a pass left the offer reading
  // "Add the 2 remaining items myself" for the two items the user had just
  // handled — including one they had successfully added by hand.
  const [manualHandled, setManualHandled] = useState<string[]>([]);
  const [copiedList, setCopiedList] = useState(false);
  // A manual pass is its own reason to re-read the cart, even on a run that
  // attempted no adds of its own (every item bounced at review, say). Without
  // this the user could add five things by hand and land back on a done screen
  // still insisting nothing is there.
  const manualUsedRef = useRef(false);
  // What every "N items" on screen is counted against (MEAL-178). "items" means
  // UNITS — the total quantity, weight-priced lines counting 1 by presence — so
  // the labels measure the same thing the cart counters and the cart check do.
  // Separate from activeItemsRef because that one is re-pointed at the retry
  // subset by the reconcile top-up: counting off it would tell the user the run
  // added 2 items when it added 7, and only on the runs that went wrong.
  const runIntendedRef = useRef<IntendedItem[]>([]);
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
  // IntendedItem, not a structural copy of it: the increment (`weightStepLb`) has
  // to survive into the after-check, which is what lets a deli line the run added
  // by clicking be recognised as that item's rather than as an unintended add.
  const reconcileIntendedRef = useRef<IntendedItem[]>([]);
  // MEAL-119: the cart titles this run reports on the done screen as sold-by-weight
  // lines it could not verify (the unverified banner names each one). Held in a ref
  // because the only readers are inside onMessage (deps []), and BOTH of the
  // reconcile's exits announce over-adds — neither may also call one of these lines
  // an item "Mealio didn't intend to add". They are already accounted for, by name,
  // in the banner beside that warning; see dropExplainedOverAdds.
  const unverifiedCartNamesRef = useRef<string[]>([]);
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
  // MEAL-31: per-selector resolution, accumulated across every WebView this run
  // uses — the main one and both worker pools — and reported as ONE row at the
  // end. A ref rather than state: nothing renders from it, and a setState per
  // sample would re-render the sheet ~20 times a run to display nothing.
  const selectorHealthRef = useRef(new SelectorHealthTally());
  /** Fold a SELECTOR_HEALTH message in. Returns true when it was one. */
  const ingestSelectorHealth = useCallback((msg: { type?: string; sel?: unknown }): boolean => {
    if (msg?.type !== SELECTOR_HEALTH_MESSAGE) return false;
    selectorHealthRef.current.ingest(msg.sel);
    return true;
  }, []);
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

  /**
   * MEAL-122. The add funnel for the two worker POOLS.
   *
   * The body lives in lib/pool-add-funnel so a test can call the real mapping
   * with a real recorder — see the note there. What stays here is what only this
   * file knows: which pool is which, and (for the pre-search pool's cold slot)
   * whether an add was ever injected. The pre-search half is declared further
   * down, next to the cold-slot refs it has to read.
   */

  // Last script popped from the queue and injected. Re-injected if onLoadEnd
  // fires AGAIN for the same URL during the `searching` step before a result
  // arrives — this handles SSO/MSAL bootstrap reloads (e.g. Wegmans's first
  // navigation) that kill the just-injected script. Cleared on SEARCH_RESULT
  // or SEARCH_AND_ADD_RESULT, and when the next script is popped from queue.
  const inflightScriptRef = useRef<string | null>(null);

  // ── Wegmans parallel search pool (storeId === 'wegmans' choose-flow only) ──
  // Worker WebViews are gone with the page pools they served. One WebView is
  // mounted for the whole run and it never renders a storefront page: it exists
  // to carry the origin's cookies, which is the only thing the RN side cannot
  // hold for itself.
  // Worker count + initial-dispatch stagger are per-store, overridable, but the
  // GLOBAL defaults are kept low for anti-bot reasons: 3 workers (was 5), and a
  // 400ms staggered dispatch so they don't all fire in one simultaneous burst.
  // The stagger also activates the pool's per-worker jitter (i*base + random),
  // so the request pattern isn't a fixed metronome.
  // THE WORKER POOLS LIVED HERE.
  //
  // Three of them: a search pool, a fused search+add pool, and a pre-search pool
  // that parked loaded results pages across the qty screen so N adds could fire
  // within a second of the tap. All of them worked by driving hidden WebViews
  // through the storefront and clicking. Deleted 2026-09-01 with the rest of the
  // DOM path; git has them if they are ever wanted, and MEAL-210..213 ask whether
  // the four stores they served can have a real rail instead.

  // The pre-search worker scripts, their WebView sources and their message
  // handler went with the pool.

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
      manual: 'attention',
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
      manual: 'Add items yourself',
    };
    // Progress: per-item position through the search/add funnel. processedCount
    // advances once per ingredient and DOES trigger renders (unlike searchIdxRef,
    // and unlike totalAdded which the sequential search-and-add path never
    // updates — that left the ring frozen). The parallel search phase has no
    // per-item signal, so show the indeterminate spinner there.
    const total = activeItemsRef.current.length;
    // The pools owned the first 85% of this ring and the reconcile top-up the
    // rest. With them gone there are two shapes left: a rail run, whose own
    // progress drives the bag animation rather than this ring, and an assisted
    // run, where the user is walking the queue themselves.
    let progress: number | null = null;
    if (step === 'done') {
      progress = 1;
    } else if (parallelOriginalTotalRef.current > 0 && (step === 'searching' || step === 'adding')) {
      const retryCount = activeItemsRef.current.length;
      progress = retryCount > 0 ? Math.min(1, processedCount / retryCount) : 1;
    } else if (total > 0 && (step === 'searching' || step === 'adding')) {
      progress = Math.min(1, processedCount / total);
    }
    onStatusChange({ phase: step, kind: kindMap[step], label: labelMap[step], progress });
  }, [step, searchingLabel, storeName, onStatusChange, processedCount]);

  // The worker scripts and their WebView sources went with the pools.
  const finishParallelSearch = useCallback((resultsByIdx: Map<number, Candidate[]>) => {
    const active = activeItemsRef.current;
    const results: SearchResult[] = [];
    for (let idx = 0; idx < active.length; idx++) {
      const item = active[idx];
      const candidates = resultsByIdx.get(idx) ?? [];
      results.push({
        term: item.ingredientName,
        // Ranked for the same reason as the sequential choose branch below, and
        // this is the path that matters most: every store with a worker pool
        // (heb, walmart, albertsons, amazon) reaches the choose screen through
        // HERE, not through the SEARCH_RESULT handler. Only the forced-serial
        // stores (aldi, wegmans) take the other one. `item.ingredientName` is
        // the same value the sequential branch scores as `scoreTarget` — a
        // choose-flow item has no searchTerm, which is what makes it a choose.
        candidates: rankChoiceCandidates(item.ingredientName, candidates),
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

  // startParallelSearch drove the search pool. Gone; a choose run now asks the
  // rail and feeds finishParallelSearch directly.

  // ── Parallel ADD (FEATURE_PARALLEL_ADD) ─────────────────────────────────────

  // Probe the cart for its current contents → CART_COUNT (phase-tagged). Shared
  // by the done-screen after-snapshot and the parallel-add reconcile. Arms a
  // result-timeout so a cart page that never posts can't strand the flow.
  const triggerCartProbe = useCallback((phase: 'after' | 'reconcile') => {
    const sid = lockedStoreIdRef.current;
    // ASK THE RAIL FIRST — it needs no page.
    //
    // This navigation was the single largest fixed cost in a rail run: 2.0s
    // flat, on every run, more than searching eighteen items. It is also what
    // put the wrong breakdown on the done screen — it can land somewhere that
    // is not the cart (`reason: not_cart_page`), and then the run has no
    // baseline and credits itself with whatever the last write touched.
    //
    // cartRead posts the same CART_COUNT the page posts, so everything
    // downstream is untouched.
    const railForCart = getNetworkRail(sid);
    if (railForCart) {
      if (cartRowsTimeoutRef.current) clearTimeout(cartRowsTimeoutRef.current);
      cartRowsTimeoutRef.current = setTimeout(() => { cartRowsTimeoutRef.current = null; setCartRowsTimedOut(true); }, CART_ROWS_TIMEOUT_MS);
      if (cartProbeResultTimeoutRef.current) clearTimeout(cartProbeResultTimeoutRef.current);
      cartProbeResultTimeoutRef.current = setTimeout(() => {
        cartProbeResultTimeoutRef.current = null;
        console.log(`[Cart ${ts()}]`, 'cart probe timeout — no CART_COUNT for', phase);
        cartCountPendingRef.current = null;
        if (phase === 'reconcile') parallelReconcileArmedRef.current = false;
      }, cfgTimeouts.cartProbeResultMs);
      cartCountPendingRef.current = phase;
      console.log(`[Cart ${ts()}]`, 'cart probe over the network —', phase, 'no page load');
      webviewRef.current?.injectJavaScript(railForCart.cartRead());
      return;
    }
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
        setCartUnverified(unverifiedCartMessage(storeName));
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

  // ── The network run (MEAL-202) ────────────────────────────────────────────
  //
  // Three phases, each driven by one injected script on the MAIN WebView:
  //   session -> search every term -> add every matched item
  //
  // Nothing navigates. That is the entire speed argument: the ~1.8 s per
  // ingredient the pools exist to parallelise is page loading, and this does not
  // load pages.
  //
  // Any phase that cannot answer hands the whole run back to the pool path. That
  // is not caution for its own sake — a half-network run would have to reconcile
  // two different notions of what was attempted, and the pool path already works.

  // Nothing counted for 12s while a run is live => say "still working". The
  // timer restarts on every count, so a healthy run never shows this.
  const netCounted = netProgress?.done ?? -1;
  const netRunning = step === 'login_check' || step === 'searching' || step === 'adding';
  useEffect(() => {
    if (!netRunning) { setNetNote(null); return; }
    const t = setTimeout(() => setNetNote('Still working — this one is taking longer than usual'), 12_000);
    return () => clearTimeout(t);
  }, [netRunning, netCounted, step]);

  /**
   * Give up on the rail and hand the run to the user.
   *
   * This used to restart the item set through the DOM add pool. That pool is
   * gone, and the honest replacement is not another automation — it is telling
   * the user what we were trying to do and letting them do it. The searches are
   * still ours; only the clicking moves.
   */
  const netHandOverToUser = useCallback((why: string) => {
    if (!netActiveRef.current) return;
    netActiveRef.current = false;
    netPhaseRef.current = 'idle';
    if (netTimeoutRef.current) { clearTimeout(netTimeoutRef.current); netTimeoutRef.current = null; }
    console.log(`[Cart ${ts()}]`, 'network run: handing over to the user —', why);
    // The fast path's count is meaningless now — the pool is going to redo the
    // whole set. Leaving "3/18" on screen would freeze there for the rest of the
    // run. Drop to the unnumbered bag and say what is happening.
    setNetProgress({ done: 0, total: 0, label: 'Taking a slower route', phase: 'add' });
    setNetNote('Still working — this one is taking longer than usual');
    tel().record('search', 'error', { detail: { phase: 'network_fallback', why }, code: 'match_rejected' });
    startAssistedModeRef.current();
  }, []);

  /**
   * The add phase's deadline. Finalizes with what has come back instead of
   * handing over to the pool, because the pool would write a second time.
   */
  const netArmFinalize = useCallback((ms: number) => {
    if (netTimeoutRef.current) clearTimeout(netTimeoutRef.current);
    netTimeoutRef.current = setTimeout(() => {
      netTimeoutRef.current = null;
      if (!netActiveRef.current || netPhaseRef.current !== 'add') return;
      netActiveRef.current = false;
      netPhaseRef.current = 'idle';
      console.log(`[Cart ${ts()}]`, 'network run: add phase timed out — finalizing with what landed');
      tel().record('confirm', 'error', { detail: { phase: 'network_add_timeout' }, code: 'timeout' });
      // Items with no result at all are unresolved, not failed: a write may have
      // landed and simply not been reported, so claiming failure could send the
      // reconcile to add them a second time.
      const active = activeItemsRef.current;
      for (let i = 0; i < active.length; i++) {
        if (!netResultsRef.current.has(i)) {
          netResultsRef.current.set(i, {
            success: false, productName: null, reason: 'write_unresolved', candidates: [],
          });
        }
      }
      netFinalizeRef.current();
    }, ms);
  }, []);

  /** Arm a deadline so a phase that never answers cannot strand the run. */
  const netArm = useCallback((ms: number, why: string) => {
    if (netTimeoutRef.current) clearTimeout(netTimeoutRef.current);
    netTimeoutRef.current = setTimeout(() => {
      netTimeoutRef.current = null;
      netHandOverToUser(why);
    }, ms);
  }, [netHandOverToUser]);

  /**
   * Phase 3. Everything is matched; write it.
   *
   * Items with no exact match do not get written and do not fail silently — they
   * become an unsuccessful AddResult carrying their candidates, which is exactly
   * what a pool worker produces when it cannot match, so they land on the review
   * screen by the ordinary route.
   */
  // netStartSearch is defined above and can now finish the search phase itself,
  // when the prewarm already answered every term.
  const netStartAddsRef = useRef<() => void>(() => {});
  const netStartAdds = useCallback(() => {
    const active = activeItemsRef.current;
    const sess = netSessionRef.current;
    if (!sess) { netHandOverToUser('no_session_at_add'); return; }

    const toWrite: Array<{
      idx: number; productId: string; skuId: string | null; quantity: number; name: string;
      isWeightItem?: boolean; purchasePreferenceId?: string | null; maxOrderQuantity?: number | null;
    }> = [];
    netResultsRef.current = new Map();

    for (let idx = 0; idx < active.length; idx++) {
      const item = active[idx];
      const term = item.searchTerm ?? item.ingredientName;
      // A term the network could not answer for is not "no match" — it is "not
      // asked", so it must not be reported as though the store had nothing.
      //
      // It does NOT take the run with it. Falling the whole run back for one
      // unanswered term threw away eleven good answers and re-ran the entire
      // search the slow way — measured doing exactly that on the first device
      // run. The item goes to review instead, which is where an item nobody
      // could answer for belongs, and the user can pick or skip it.
      if (netFailedTermsRef.current.has(term)) {
        netResultsRef.current.set(idx, {
          success: false, productName: null, reason: 'search_unanswered', candidates: [],
        });
        continue;
      }
      // A ROW WE ALREADY HAVE THE ID FOR SKIPS THE MATCHER ENTIRELY.
      //
      // There is nothing to match: the identifier IS the choice. It goes
      // straight into the write batch, and the write's own verification against
      // the returned cart is what catches a retired id or a line the store marks
      // unavailable — the same checks a searched item gets, just after the
      // request rather than before it.
      const stored = netStoredProduct(item);
      if (stored) {
        netMatchedRef.current.set(idx, {
          productId: stored.upc, skuId: stored.sku ?? null,
          name: stored.name || item.ingredientName,
          purchasePreferenceId: null, maxOrderQuantity: null,
        });
        toWrite.push({
          idx,
          productId: stored.upc,
          skuId: stored.sku ?? null,
          quantity: Math.max(1, Math.round(item.productQty || 1)),
          name: stored.name || item.ingredientName,
          isWeightItem: false,
          purchasePreferenceId: null,
          maxOrderQuantity: null,
        });
        continue;
      }
      const candidates = netCandidatesRef.current.get(term) ?? [];
      // The SAME rule the page path uses: an exact name, in stock. Anything
      // looser here would add a product the user did not ask for, which is the
      // one thing the cart rules never allow.
      const exact = candidates.filter((c) => scoreMatch(term, c.productName) === 100);
      // WRITABILITY IS THE STORE'S RULE, NOT THIS FUNCTION'S. H-E-B addresses a
      // cart line by sku; Albertsons addresses it by product id and its search
      // returns no sku at all. Requiring both here meant no Albertsons candidate
      // could ever match, however good the search was.
      const rail = netRail();
      const canWrite = (c: Candidate) => (rail ? rail.writable(c) : !!c.productId && !!c.skuId);
      const match = exact.find((c) => !c.outOfStock && canWrite(c));
      if (!match) {
        // The reason has to distinguish three different situations, because the
        // reconcile routes on it and one of them must NOT be retried.
        //
        // An exact match that is OUT OF STOCK is a definitive failure: the store
        // has the product and will not sell it today, so re-running the same
        // search finds the same thing. Reporting it as low_confidence sent it to
        // the reconcile's top-up, which abandoned a rail that answered in 280 ms
        // and LOADED A PAGE to be told the same thing 1.8 s later — measured
        // doing exactly that on a device run.
        const outOfStockExact = exact.length > 0 && exact.every((c) => c.outOfStock);
        // Nothing at all came back for the chosen product. Ask again by
        // ingredient name so the review screen has something to offer. Skipped
        // when the two are the same string -- that search has already happened
        // and returned nothing.
        if (candidates.length === 0 && item.ingredientName
            && item.ingredientName !== term) {
          netFallbackWantedRef.current.set(idx, item.ingredientName);
        }
        netResultsRef.current.set(idx, {
          success: false,
          productName: outOfStockExact ? exact[0].productName : null,
          reason: candidates.length === 0
            ? 'no_results'
            : outOfStockExact ? 'out_of_stock' : 'low_confidence',
          candidates,
        });
        continue;
      }
      if (match.isWeightItem) {
        // Sold by weight: the user has to choose a weight, and an over-add on one
        // cannot be undone (MEAL-200). Route it to review like any unmatched item.
        netResultsRef.current.set(idx, {
          success: false, productName: match.productName, reason: 'needs_weight', candidates,
        });
        continue;
      }
      // The preference the user already chose, matched to the store's id for it.
      //
      // The page path clicks a modal row by its LABEL; the network path states an
      // id. Both come from the same choice, so the id is looked up by the label
      // that was chosen rather than asking again.
      //
      // A PRODUCT THAT OFFERS PREFERENCES IS NEVER WRITTEN ON A GUESS. Two ways
      // that could happen, and both add a variant nobody asked for:
      //
      //   - the user chose nothing, so the store would apply its own default —
      //     the page path refuses this too, declining to pick a card with a
      //     preference popup unless a choice was supplied (heb.ts);
      //   - the user chose something but the saved LABEL does not match any of
      //     the network's preference texts. The label was captured from a DOM
      //     modal row and these come from purchasePreferenceList, so wording or
      //     whitespace can drift. Sending nothing then means the store picks,
      //     and the run reports success for a variant the user did not choose.
      //
      // Either way it goes to review, where the user picks on the page. Silence
      // is the one outcome not available.
      const offersPreference = (match.preferences ?? []).some((pr) => pr.preferenceId);
      const chosenLabel = item.dropdown?.selectedText ?? null;
      const preference = chosenLabel
        ? (match.preferences ?? []).find((pr) => pr.text === chosenLabel)
        : undefined;
      if (offersPreference && !preference?.preferenceId) {
        netResultsRef.current.set(idx, {
          success: false,
          productName: match.productName,
          reason: 'needs_preference',
          candidates,
        });
        continue;
      }
      // Re-read after the find: the predicate proved these are present, but that
      // narrowing does not survive out of it.
      const productId = match.productId;
      const skuId = match.skuId ?? null;
      if (!productId) {
        netResultsRef.current.set(idx, {
          success: false, productName: match.productName, reason: 'low_confidence', candidates,
        });
        continue;
      }
      netMatchedRef.current.set(idx, {
        productId, skuId, name: match.productName,
        purchasePreferenceId: preference?.preferenceId ?? null,
        maxOrderQuantity: match.maxOrderQuantity ?? null,
      });
      toWrite.push({
        idx,
        productId,
        skuId,
        quantity: Math.max(1, Math.round(item.productQty || 1)),
        name: match.productName,
        isWeightItem: false,
        purchasePreferenceId: preference?.preferenceId ?? null,
        // The store's per-item cap. The write sets an ABSOLUTE quantity, so
        // cart-held + asked can exceed it and the store refuses the whole write —
        // which is what "Quantity limit reached." was on the first full device
        // run, for an avocado earlier test runs had already stocked up on.
        maxOrderQuantity: match.maxOrderQuantity ?? null,
      });
    }

    // ── Finding 3: two entries for one product would UNDER-add ───────────────
    //
    // The write is absolute and the cart baseline is read once, so two writes for
    // the same product become set(base+q1) then set(base+q2) — a final quantity
    // of base + max(q1,q2), not base + q1 + q2. Reachable on a mixed run:
    // consolidateIngredients deliberately does not merge ingredients that have no
    // searchTerm across meals, and both entries then resolve to the same product.
    //
    // Coalesced here rather than in the script, because the caller is the only
    // one that knows which item INDEXES each write speaks for — and every index
    // still needs its own result.
    const byProduct = new Map<string, typeof toWrite[number] & { forIdx: number[] }>();
    for (const w of toWrite) {
      const prior = byProduct.get(w.productId);
      if (prior) {
        prior.quantity += w.quantity;
        prior.forIdx.push(w.idx);
      } else {
        byProduct.set(w.productId, { ...w, forIdx: [w.idx] });
      }
    }
    const coalesced = [...byProduct.values()];
    if (coalesced.length !== toWrite.length) {
      console.log(`[Cart ${ts()}]`, 'network run: coalesced', toWrite.length, 'writes into', coalesced.length);
    }
    // One write speaks for several items; each of them gets its result.
    netWriteFanoutRef.current = new Map(coalesced.map((c) => [c.idx, c.forIdx]));

    if (toWrite.length === 0) {
      console.log(`[Cart ${ts()}]`, 'network run: nothing matched exactly — straight to review');
      netActiveRef.current = false;
      netPhaseRef.current = 'idle';
      finishParallelAdd(netResultsRef.current);
      return;
    }

    const rail = netRail();
    if (!rail) { netHandOverToUser('no_rail'); return; }
    const script = rail.addBatch(coalesced);
    if (!script) { netHandOverToUser('add_script_unbuildable'); return; }
    netPhaseRef.current = 'add';
    setStep('adding');
    // THE DENOMINATOR NEVER SHRINKS, AND A TOP-UP NEVER RESTARTS IT.
    //
    // Two separate things were making the count run backwards. It counted
    // `toWrite` (17) rather than the list the user asked for (18), so an item
    // with no product silently shrank the total; and the top-up re-entered here
    // and set total to 2, so the bag went 17/17 -> 0/2 -> 2/2 in front of the
    // user. Now the total is the active list for the whole run, items that were
    // never written start already counted (they are decided, just not added),
    // and the top-up leaves the progress alone — it is a correction, not a
    // second pass.
    if (!netTopUpRef.current) {
      const decided = Math.max(0, active.length - toWrite.length);
      setNetProgress({ done: decided, total: active.length, label: 'Adding to your cart', phase: 'add' });
      advanceNetPct('add', decided, active.length);
      setSearchingLabel(`Adding ${active.length} ingredients…`);
    }
    console.log(`[Cart ${ts()}]`, 'network run: writing', toWrite.length, 'of', active.length);
    // ONCE WRITING STARTS, FALLING BACK TO THE POOL IS FORBIDDEN.
    //
    // Every other phase can hand the run over safely because nothing has been
    // written yet. This one cannot: the pool re-adds the FULL active list by
    // clicking, and its click loop baselines off the card label — which by then
    // reflects our own writes — so it targets label + qty and the user ends up
    // with roughly double.
    //
    // The deadline was 45 s against a worst case of 62 s (an 8 s cart read plus
    // six waves of 9 s), so a slow or throttled store could reach it while writes
    // were still landing. It is longer now, and when it does fire it finalizes
    // with whatever came back rather than starting a second adding pass. The cart
    // read in the reconcile is what settles the truth either way.
    // COUNT THE ATTEMPTS. addsAttempted gates the done screen's after-probe
    // (shouldProbeAfterRun), and the only place incrementing it was the review
    // add — a page-path leftover. So a pure rail run reported ZERO adds
    // attempted, the probe never ran, and everything that depends on it went
    // with it: the cart-check verdict, the over-add safety net, and the
    // correction that finds an item the run called failed sitting in the cart.
    // It went unnoticed because a reconcile that finalizes suppresses the probe
    // by design, and the runs measured so far either ended there or had a review
    // add along the way to increment this by accident.
    addsAttemptedRef.current += toWrite.length;
    // AT THE SAME MOMENT AS THE WRITES, not after them. These items are not in
    // the batch -- nothing matched to write -- so this competes with the adds
    // for nothing but a connection, and by the time they finish the review
    // screen usually has its candidates. The user never sees a second search.
    netStartFallbackSearchRef.current();
    netArmFinalize(75_000);
    webviewRef.current?.injectJavaScript(script);
  }, [finishParallelAdd, netArm, netArmFinalize, netHandOverToUser, setStep]);
  // Lost in the DOM-removal merge, which took the branch's dependency list and
  // the line under it with it. Without this the ref stays the no-op it was
  // initialised with, so a run whose terms were all prewarmed reached "straight
  // to writing" and then silently wrote nothing.
  netStartAddsRef.current = netStartAdds;

  /**
   * Search by INGREDIENT name for the items whose chosen product returned
   * nothing. Same rail, same batch script, so every store with a rail gets this
   * and any future one gets it for free.
   */
  const netStartFallbackSearch = useCallback(() => {
    const wanted = [...netFallbackWantedRef.current.values()];
    if (wanted.length === 0) return;
    const sess = netSessionRef.current;
    const rail = netRail();
    if (!sess || !rail) return;
    const terms = [...new Set(wanted)];
    const script = rail.searchBatch(terms, sess);
    if (!script) return;
    netFallbackPendingRef.current = true;
    console.log(`[Cart ${ts()}]`, 'network run: nothing found for', terms.length,
      'chosen products — searching the ingredient name instead');
    webviewRef.current?.injectJavaScript(script);
  }, [netRail]);
  netStartFallbackSearchRef.current = netStartFallbackSearch;

  /**
   * Swap the fallback's candidates in before anything renders the review list.
   *
   * Only for the items that had NONE. An item with near-variants keeps them:
   * "the 24 oz of the thing you picked" beats twelve unrelated sour creams.
   */
  const netApplyFallbackCandidates = useCallback(() => {
    if (netFallbackWantedRef.current.size === 0) return;
    let swapped = 0;
    netFallbackWantedRef.current.forEach((name, idx) => {
      const got = netFallbackCandidatesRef.current.get(name);
      if (!got || got.length === 0) return;
      const entry = netResultsRef.current.get(idx);
      if (!entry || entry.success) return;
      netResultsRef.current.set(idx, { ...entry, candidates: got, searchedBy: 'ingredient' });
      swapped += 1;
    });
    if (swapped > 0) {
      console.log(`[Cart ${ts()}]`, 'network run: review shows ingredient-name results for', swapped, 'item(s)');
    }
  }, []);
  netApplyFallbackCandidatesRef.current = netApplyFallbackCandidates;

  /** Phase 2. One script, every term, no navigation. */
  const netStartSearch = useCallback(() => {
    const active = activeItemsRef.current;
    const sess = netSessionRef.current;
    if (!sess) { netHandOverToUser('no_session'); return; }
    // CHOOSE PRODUCT ONCE, ADD FOREVER -- so a row that already carries the
    // store's own id is not searched at all.
    //
    // Everything below this line exists to turn a NAME back into a product, and
    // for a row the user has already chosen for, that work re-decides a decision
    // they made: the store's relevance ranking gets a vote on every run, and
    // "the same product" degrades to "a name that scores 100 against the one we
    // wrote down". With the id there is nothing to re-decide and nothing to
    // search -- the run goes straight to writing.
    //
    // The id is not trusted blindly. The write verifies itself against the cart
    // it returns, so a retired id, a rejected write or a line the store marks
    // unavailable all come back as failures, and those fall through to the same
    // review the search path uses.
    const rail = netRail();
    if (!rail) { netHandOverToUser('no_rail'); return; }
    const needSearch = active.filter((i) => !netStoredProduct(i));
    const known = active.length - needSearch.length;
    if (known > 0) {
      console.log(`[Cart ${ts()}]`, 'network run:', known, 'of', active.length,
        'already chosen — writing those without searching');
    }
    const terms = Array.from(new Set(needSearch.map((i) => i.searchTerm ?? i.ingredientName).filter(Boolean)));
    if (!terms.length) {
      // Every row was already chosen. Nothing to look up at all.
      netSearchTermsRef.current = [];
      netPhaseRef.current = 'search';
      netStartAddsRef.current();
      return;
    }

    // WAIT FOR AN IN-FLIGHT PREWARM BEFORE OPENING A SECOND BURST.
    //
    // The user can tap while the prewarm's batch is still out — measured at
    // 0.2s after it went. Starting the run's own search then puts TWO batches
    // in the same page at once, which is both the burst shape a store is most
    // likely to challenge and pure waste, since the answers are already coming.
    //
    // Bounded: the prewarm's own deadline is the backstop, and if it has not
    // finished by then the run proceeds and searches what it is missing.
    if (netPrewarmStartedRef.current && !netPrewarmDoneRef.current
        && netPrewarmWaitsRef.current < netPrewarmMaxWaits(terms.length)) {
      netPrewarmWaitsRef.current += 1;
      console.log(`[Cart ${ts()}]`, 'network run: prewarm still answering — waiting for it rather than searching twice');
      setTimeout(() => netStartSearchRef.current(), NET_PREWARM_WAIT_MS);
      return;
    }

    // WHAT THE PREWARM ALREADY ANSWERED IS NOT ASKED AGAIN.
    //
    // Seeded rather than merged afterwards, so a term the prewarm has is never
    // in the batch at all: asking twice would double this run's search volume
    // against a store whose search is the part most likely to be shaped.
    netCandidatesRef.current = new Map();
    let reused = 0;
    for (const t of terms) {
      const got = netPrewarmCandidatesRef.current.get(t);
      if (got) { netCandidatesRef.current.set(t, got); reused += 1; }
    }
    const missing = terms.filter((t) => !netCandidatesRef.current.has(t));
    netFailedTermsRef.current = new Set();

    if (missing.length === 0) {
      // Everything was prewarmed. The run skips its search phase entirely.
      console.log(`[Cart ${ts()}]`, 'network run: all', terms.length, 'terms already prewarmed — straight to writing');
      netSearchTermsRef.current = terms;
      netPhaseRef.current = 'search';
      netStartAddsRef.current();
      return;
    }
    if (reused > 0) {
      console.log(`[Cart ${ts()}]`, 'network run: reusing', reused, 'prewarmed terms, searching', missing.length);
    }
    const script = rail.searchBatch(missing, sess);
    if (!script) { netHandOverToUser('search_script_unbuildable'); return; }
    netSearchTermsRef.current = terms;
    netSearchInjectsRef.current = 1;
    netPhaseRef.current = 'search';
    setStep('searching');
    setNetProgress({ done: 0, total: terms.length, label: 'Looking up ingredients', phase: 'search' });
    advanceNetPct('search', 0, terms.length);
    setSearchingLabel(`Searching ${terms.length} ingredients…`);
    console.log(`[Cart ${ts()}]`, 'network run: searching', terms.length, 'terms with no page load');
    // A FLAT 40 SECONDS THREW AWAY A SEARCH THAT WAS WORKING.
    //
    // Measured on Albertsons, six terms, 2026-09-01: the FIRST result took 40.0s
    // and the remaining five took 1.6s each. The cost is a cold connection on
    // the first request, not the search — but the flat window expired on the
    // same tick the first result arrived, so the run dropped to the page-driven
    // pool holding six good answers. That trade is backwards: the pool costs
    // minutes, and waiting costs seconds.
    //
    // So the window covers a slow start PLUS the terms, and is capped so a store
    // that has genuinely stopped answering still ends the phase.
    netArm(Math.min(45_000 + terms.length * 8_000, 180_000), 'search_timeout');
    webviewRef.current?.injectJavaScript(script);
  }, [netArm, netHandOverToUser, setStep]);
  // Same loss as netStartAddsRef above: the merge took the branch's dependency
  // list and the wiring line that followed it. Without this the prewarm-wait
  // retry calls a no-op, so a run that stood back for an in-flight prewarm never
  // came back to search what the prewarm had missed.
  netStartSearchRef.current = netStartSearch;

  /**
   * Re-ask for the terms that never came back, because the page navigated.
   *
   * The rail says "no page load" and means it — but that is a promise about what
   * the SCRIPT does, not about what the page does. On 2026-09-01 an 18-term run
   * put three searches in flight and heb.com committed a navigation ~450ms
   * later. Every in-flight fetch rejected as "TypeError: Failed to fetch" at
   * once, and then nothing: the other 15 terms were never attempted and
   * SEARCH_BATCH_DONE never arrived, because the document running the loop had
   * been torn down. The run sat at 3/18 until the 40s deadline.
   *
   * Three failures and SILENCE is the tell, and it is what separates this from a
   * bot defence — a store refusing us would have refused all 18. The presearch
   * workers loaded pages fine in that same second.
   *
   * So a navigation during the search phase is not fatal any more. Whatever has
   * already answered is kept, the rest are asked again in the new document.
   */
  const netResumeSearchAfterNav = useCallback(() => {
    const plan = planSearchResume(
      netSearchTermsRef.current,
      netCandidatesRef.current,
      netFailedTermsRef.current,
      netSearchInjectsRef.current,
    );
    if (plan.reason === 'nothing_outstanding') return;
    const sess = netSessionRef.current;
    const rail = netRail();
    if (!sess || !rail) return;
    if (plan.reason === 'too_many_injects') {
      console.log(`[Cart ${ts()}]`, 'network search: page navigated again, not re-asking');
      return;
    }
    const outstanding = plan.terms;
    const script = rail.searchBatch(outstanding, sess);
    if (!script) return;
    netSearchInjectsRef.current += 1;
    console.log(`[Cart ${ts()}]`, 'network search: page navigated, re-asking', outstanding.length,
      'of', netSearchTermsRef.current.length, 'terms');
    // A fresh document deserves a fresh window; the old one was spent loading.
    netArm(40_000, 'search_timeout');
    webviewRef.current?.injectJavaScript(script);
  }, [netArm, netRail]);

  /** Phase 1. Who is signed in, which store, pickup or delivery. */
  const startNetworkRun = useCallback(() => {
    netActiveRef.current = true;
    netRunRef.current = true;
    netMatchedRef.current = new Map();
    netSessionSettledRef.current = false;
    netFallbackWantedRef.current = new Map();
    netFallbackCandidatesRef.current = new Map();
    netFallbackPendingRef.current = false;
    netRunBaselineRef.current = null;
    netPrewarmWaitsRef.current = 0;
    netPhaseRef.current = 'session';
    setStep('searching');
    setSearchingLabel('Connecting…');
    // ALREADY ANSWERED? THEN DO NOT ASK AGAIN.
    //
    // The login check runs the SAME probe moments before this and keeps its
    // answer. Re-asking is pure cost: it cannot tell us anything new — the sheet
    // locks one store for the life of the run and the page has not moved — and
    // it can fail, which the answer we are holding cannot. The freshness window
    // is what keeps that honest: a sheet left open long enough for the user to
    // change stores in another tab starts over.
    const cached = netSessionRef.current;
    if (cached && Date.now() - netSessionAtRef.current < NET_SESSION_REUSE_MS) {
      console.log(`[Cart ${ts()}]`, 'network run: reusing the session from the login check —',
        'store=', cached.storeId, 'context=', cached.shoppingContext);
      // Settled BEFORE searching. netStartSearch can return without starting —
      // it stands back for an in-flight prewarm — so the phase is still
      // 'session' when it does, and a late duplicate probe answer would then be
      // taken as the run's own and open a SECOND search chain for the same
      // terms. The phase itself cannot carry this: moving it to 'search' would
      // also route the prewarm's own results to the run.
      netSessionSettledRef.current = true;
      netStartSearch();
      return;
    }
    netSessionRef.current = null;
    console.log(`[Cart ${ts()}]`, 'network run: reading the session');
    // Tried now AND re-tried on the next store page load.
    //
    // Every request here is same-origin, so the script is useless unless the
    // WebView is actually sitting on the store. It usually is by this point —
    // the login check and the cart baseline both put it there — but "usually"
    // produced a 20 s session timeout on the second device run, where this fired
    // while the page was still mid-navigation and the injection went nowhere.
    // Re-injecting is safe: the script only reads, and a duplicate answer is
    // ignored once the phase has moved on.
    netArm(25_000, 'session_timeout');
    const rail = netRail();
    if (!rail) { netHandOverToUser('no_rail'); return; }
    webviewRef.current?.injectJavaScript(rail.sessionScript());
  }, [netArm, setStep, netRail, netHandOverToUser, netStartSearch]);

  netResumeSearchAfterNavRef.current = netResumeSearchAfterNav;

  /**
   * End a network write phase.
   *
   * A first pass hands its results to `finishParallelAdd`, which reconciles them
   * against the cart. A TOP-UP must not: it is already the reconcile's own
   * correction, and reconciling it again would read the cart, find a shortfall,
   * and top up the top-up. It finishes the run, and the after-probe on the done
   * screen is what audits the result.
   */
  const netFinalize = useCallback(() => {
    // Before anything reads the results: an item whose chosen product returned
    // nothing shows the ingredient-name search instead of an empty list.
    netApplyFallbackCandidatesRef.current();
    const topUp = netTopUpRef.current;
    netTopUpRef.current = null;
    if (!topUp) { finishParallelAdd(netResultsRef.current); return; }
    const landed: { name: string; success: true }[] = [];
    netResultsRef.current.forEach((r) => {
      if (r.success) landed.push({ name: r.productName || '', success: true });
    });
    console.log(`[Cart ${ts()}]`, 'network top-up: finished —', landed.length, 'of', topUp.size, 'landed');
    // AND WHAT DID NOT LAND. Only the successes used to be recorded, so a top-up
    // that corrected nothing left its items in neither list: the reconcile had
    // already routed them out of `confirmed` as short, and nothing put them back
    // as failed. The done screen then offered no manual hand-over, because
    // manualCandidates reads the failed names and there were none — for an item
    // the run had just tried twice and not got.
    const stillMissing: { name: string; success: false; reason: string }[] = [];
    netResultsRef.current.forEach((r) => {
      if (!r.success) {
        stillMissing.push({
          name: r.productName || '', success: false, reason: r.reason || 'top_up_failed',
        });
      }
    });
    // ADDED to what the reconcile already confirmed, not replacing it: these are
    // the units it found short, and the pass that confirmed the rest still holds.
    addResultsRef.current = [...addResultsRef.current, ...landed, ...stillMissing];
    setTotalAdded(addResultsRef.current.filter((a) => a.success).length);
    setAddedNames(addResultsRef.current.filter((a) => a.success).map((a) => a.name));
    // compileFailedNames owns the failed list AND its count, and honours a skip.
    // Without it the names above are recorded and never rendered.
    compileFailedNames();

    // A TOP-UP MUST STILL SHOW WHAT THE RECONCILE COULD NOT FIX.
    //
    // The reconcile splits its findings two ways: quantities it can correct
    // itself (the top-up) and items it cannot (no results, ambiguous, declined),
    // which it pushes into searchResults for the user to deal with. This branch
    // went straight to 'done' and dropped the second half on the floor — run A
    // ended on the done screen with a White Onion that had matched nothing and
    // no mention of it anywhere. Route exactly as the pooled path does.
    // UNRESOLVED entries only. `searchResults` is the whole review QUEUE and it
    // is not emptied as the user works through it — a picked item keeps its slot
    // so Back can return to it. Testing the queue's length sent the run back to
    // the gate it had just come from: the user picked a substitute, the rail
    // wrote it, and they were handed the same "1 ingredient to review" screen for
    // the ingredient they had just resolved.
    const unresolved = searchResultsRef.current.filter((_, i) =>
      !pickedItemsRef.current.some((p) => p.reviewIndex === i)
      && !(i in skippedByIdxRef.current));
    if (unresolved.length > 0) {
      const allChoose = unresolved.every((r) => r.isChoose);
      console.log(`[Cart ${ts()}]`, 'network top-up: finished with', unresolved.length,
        'still needing the user →', allChoose ? 'review' : 'searchResult');
      setReviewIdx(0);
      setStep(allChoose ? 'review' : 'searchResult');
      return;
    }
    setStep('done');
  }, [finishParallelAdd, setStep]);
  netFinalizeRef.current = netFinalize;

  // onAddWorkerMessage handled WORKER_RESULT from the add pool. Gone with it.


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

  // onWorkerMessage handled WORKER_RESULT from the search pool. Gone with it.


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
      // A new open is a new prewarm. Without this the flag stays set from the
      // last one and the second run of a session searches on the critical path
      // again -- and worse, a different meal's ingredients would be matched
      // against whatever the previous open happened to look up.
      netPrewarmStartedRef.current = false;
      netPrewarmCandidatesRef.current = new Map();
      netPrewarmTermsRef.current = [];
      netPrewarmDoneRef.current = false;
      const consolidated = consolidateIngredients(meals);
      setItems(consolidated);
      setCheckedItems(consolidated.map(() => true));
      setSearchResults([]);
      setReviewIdx(0);
      setSelectedSuggIdx(0);
      setSelectedPreference(null);
      // Manual-mode state is per-run like everything else here (MEAL-197). Under
      // the shipping !FEATURE_BACKGROUND_CART mount this component survives
      // between runs, so a `manualHandled` left behind silently withholds the
      // same ingredient from the next meal's offer, `manualUsedRef` re-probes
      // the cart on every later run, and `copiedList` says "Copied" before
      // anything has been copied.
      setCapReached([]);
      netRunRef.current = false;
      netTopUpRef.current = null;
      netMatchedRef.current = new Map();
      setManualQueue([]);
      setManualIdx(0);
      setManualHandled([]);
      setCopiedList(false);
      manualUsedRef.current = false;
      manualHandledRef.current = [];
      manualCartSnapshotRef.current = [];
      setReviewMealQtys({});
      setPickedItems([]);
      setViewerOpen(false);
      preview.reset();
      setSkippedByIdx({});
      // Hand-cleared for the same reason as unverifiedCartNamesRef just below:
      // this ref is written outside render now, and under the
      // !FEATURE_BACKGROUND_CART mount the component survives between runs.
      skippedByIdxRef.current = {};
      // MEAL-119: reset alongside the skips. Harmless while FEATURE_BACKGROUND_CART
      // keeps this sheet keyed and conditionally mounted, but under the
      // !FEATURE_BACKGROUND_CART mount (MyMealsScreen) the component survives
      // between runs — run 2 would report run 1's unverified line on its done
      // screen and ship a stale count on the funnel.
      setUnverifiedWeightLines([]);
      unverifiedCartNamesRef.current = [];
      setCustomText('');
      setCustomSearching(false);
      setCustomSuggestions([]);
      setCustomSearchTerm('');
      setTotalAdded(0);
      setProcessedCount(0);
      setTotalFailed(0);
      setAddedNames([]);
      setFailedItems([]);
      setBlockReason(null);
      blockReasonRef.current = null;
      freshStoreUnavailableRef.current = false;
      extractWhyRef.current = {};
      // A fresh tally per run. This component survives between runs in the
      // SHIPPING configuration: FEATURE_BACKGROUND_CART is on, which is what
      // mounts the sheet at app root and keeps it alive across runs (the older
      // MyMealsScreen mount does the same). Without this, run 2 would report run
      // 1's selector samples — and it is a RATE, so carrying a healthy run's
      // denominator into a broken one is exactly the way to hide the break.
      selectorHealthRef.current = new SelectorHealthTally();
      // A rail store lands on its QUIET page: the rail needs the origin's
      // cookies and nothing else, and the storefront homepage was starving it.
      // A run that falls back to the page pool navigates itself from here.
      const landing = (getNetworkRail(lockedStoreIdRef.current)
        && scriptsRef.current!.railUrl) || scriptsRef.current!.storeUrl;
      console.log(`[Cart ${ts()}]`, 'initial webviewUri=', landing);
      setWebviewUri(landing);
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
      runIntendedRef.current = [];
      // North-star counters. 'add' is the default because it is the reading that
      // cannot silently hide a run: a shopping run mislabelled 'choose' would
      // vanish from the metric, while a choose run mislabelled 'add' shows up as
      // an obvious 0-of-0 that the requested===0 guard drops anyway.
      requestedRef.current = { requested: 0, weightRequested: 0 };
      runKindRef.current = 'add';
      cartReconciledRef.current = false;
      setCartResultRows(null);
      setNetProgress(null);
      setNetNote(null);
      resetNetPct();
      setCartRowsTimedOut(false);
      if (cartRowsTimeoutRef.current) { clearTimeout(cartRowsTimeoutRef.current); cartRowsTimeoutRef.current = null; }
      setCartDeltaWarning(null);
      setCartUnverified(null);
      setVerdictFromCart(false);

      // Reset Wegmans parallel worker state. The hook clears its queue,
      // active flag, timers, and worker URIs in one call — workers unmount
      // because isActive flips to false.

      // If any ingredient has no chosen product yet, skip the qty step and
      // auto-start the search/choose flow immediately.
      const hasUnchosen = consolidated.some((it) => !it.searchTerm);
      console.log(`[Cart ${ts()}]`, 'open: meals=', meals.length, 'consolidated=', consolidated.length, 'hasUnchosen=', hasUnchosen);
      if (hasUnchosen && consolidated.length > 0) {
        // Only search for ingredients that don't have a product chosen yet.
        const unchosen = consolidated.filter((it) => !it.searchTerm);
        const active = unchosen.filter((it) => it.productQty > 0);
        activeItemsRef.current = active.length > 0 ? active : unchosen;
        runIntendedRef.current = activeItemsRef.current.map(toIntendedItem);
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
          loadQueueRef.current = [loginCheckScript()];
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
  // For onLoadEnd's prewarm, which cannot read state.
  qtyItemsRef.current = items;
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
    // A manual pass means the user may have put things in the cart that this
    // run never attempted, so it re-reads regardless of the automated gate — but
    // still not without a baseline, since a diff needs something to diff against.
    const manualNeedsReread = manualUsedRef.current && cartCountBeforeRef.current != null;
    if (!manualNeedsReread && !shouldProbeAfterRun({
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
    // `unverified` sits between partial and success and is neither (MEAL-190). It
    // is checked AFTER cartDeltaWarning because a cart that was read and disagreed
    // is the louder, better-evidenced fact — the two are mutually exclusive in
    // practice, and if they ever co-occur the reading wins.
    //
    // Not folded into 'partial': that claims the cart was checked and came up
    // short, about a cart nobody saw. Not left as 'success' either — that was the
    // silence this ticket is about. mealio_central has to know the word before a
    // build sending it ships, or its allowlist stores NULL; see
    // app/api/usage/automation/route.ts there.
    const outcome: 'success' | 'partial' | 'unverified' | 'failed' =
      totalAdded === 0 ? 'failed' : cartDeltaWarning ? 'partial' : cartUnverified ? 'unverified' : 'success';
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
    // by which store it was. It was a store-keyed guess that this avoided when
    // `confirm` rows were absent on four of six stores; MEAL-122 has since made
    // the pools emit them, so the rows are there now — but the reason to key off
    // finalization stands on its own: a run's numerator comes from whichever rail
    // actually decided it, and the same store can finalize either way.
    // `requested === 0` is the choose-run / nothing-requested case, which has no
    // cart outcome to source.
    const confirmedSource: ConfirmedSource =
      kind === 'choose' || requested === 0
        ? 'none'
        : cartReconciledRef.current
          ? 'cart_reconcile'
          : 'worker_reports';
    const skippedInReview = Object.values(skippedByIdx).filter(Boolean).length;
    // MEAL-119: how many items the run could not verify because their cart line
    // came back sold-by-weight. Counted apart from skips (nobody chose these) and
    // from itemsAdded (Mealio added nothing for them). This is the run-level view
    // of how often the case fires, which is what MEAL-148 is sized against.
    const weightRowUnverified = unverifiedWeightLines.length;
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
    const summaryFacts: RunSummaryFacts = {
      outcome,
      itemsAdded: totalAdded,
      cartDeltaWarning: !!cartDeltaWarning,
      kind,
      requested,
      confirmedSource,
      weightRequested,
      skippedInReview,
      weightRowUnverified,
      runComplete: isRunComplete(requested, totalAdded),
    };
    if (outcome === 'failed') {
      // The run has no failure of its own — it failed because its steps did, so
      // it reports the one that best EXPLAINS them: severity order, not the most
      // frequent, because a store that blocked us used to show up as a pile of
      // ordinary confirmation misses (MEAL-123).
      //
      // The fallback used to carry the parallel add path, which emitted no step
      // rows at all: confirm_failed was the only thing still true there. MEAL-122
      // gave those pools per-item rows, so that path now has real codes and the
      // fallback should be reached only by a run that failed without recording a
      // single coded step — a login_check that never resolved, or a run abandoned
      // before any item settled. `codeSource: 'fallback'` in the detail is how the
      // read side can tell how often that is still happening.
      const primary = tel().primaryFailureCode();
      // The whole tally rides along with the chosen code, so ranking by severity
      // does not hide how often each code actually occurred (MEAL-123). Built in
      // north-star.ts because the result is at sanitizeDetail's key cap exactly and
      // the tally is the field the cap would drop — see runSummaryFailureDetail for
      // both ways it has been lost, and northStar.test.ts for what now holds it.
      tel().record('run_summary', 'error', {
        detail: runSummaryFailureDetail(summaryFacts, primary, tel().failureCodeSummary()),
        code: primary ?? 'confirm_failed',
      });
    } else {
      tel().record('run_summary', 'ok', { detail: runSummaryDetail(summaryFacts) });
    }
    // MEAL-31: what every configured selector did this run, as ONE row.
    //
    // Emitted BEFORE run_summary would have been the tidier reading order, but it
    // goes after deliberately: run_summary is the row most worth keeping if a
    // batch is dropped, and nothing should be able to delay it. This row is an
    // 'ok' reconcile so it never lands a code on the run's tally — a store having
    // half-drifted is not this run failing, and it must not colour the code the
    // dashboard groups on.
    //
    // It rides on `reconcile` rather than a step name of its own. The reason
    // recorded here was that StepName is a contract shared with the Kroger Brands
    // web extension and a member only this app emits would read as a hole on the
    // extension's chart; MEAL-29 established that there is no such counterparty,
    // so that is no longer a constraint and a step name of its own is available
    // to whoever wants one. It stays on `reconcile` because it IS a reconcile —
    // splitting it would need a reason of its own, and nobody has offered one.
    // `phase` in the detail is how it is told apart from the other reconcile rows
    // (the cart diff, the MEAL-47 recovery, the north-star correction) — the same
    // way those already tell each other apart.
    //
    // undefined when nothing was sampled: a run that never reached a store page,
    // or a store with no probed selectors. No row at all is the honest report,
    // and it is what keeps the volume cost of this feature at zero for a run that
    // measured nothing.
    const selectorDetail = selectorHealthRef.current.detail();
    if (selectorDetail) tel().record('reconcile', 'ok', { detail: selectorDetail });
    void tel().flush();
    // skippedByIdx / unverifiedWeightLines are read above; automationCompletedRef
    // keeps this to one firing per run whatever re-renders the extra dependencies
    // cause.
  }, [step, totalAdded, cartDeltaWarning, cartUnverified, skippedByIdx, unverifiedWeightLines, tel]);

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
  // The pre-search parking pool was started here. It held N results pages open
  // across the qty screen so that N DOM adds could fire within a second of the
  // tap. It is gone with the rest of the clicking (2026-09-01) and nothing
  // arms it: `presearchStartedRef` is never set, so every downstream gate that
  // reads it stays shut.

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
    runIntendedRef.current = active.map(toIntendedItem);
    searchIdxRef.current = 0;
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
    // A store with a network rail is asked over the network here too. Running the
    // DOM check first and the rail's session probe a moment later asked the same
    // question twice and let the weaker answer go first — and the DOM one is an
    // inference from markup that exists in both states, where the rail's is a
    // token the origin accepts, proven by a real cart read.
    loadQueueRef.current = [loginCheckScript()];
    navTo(scriptsRef.current!.storeUrl);
    armLoginCheckTimeout();
  };

  // ── Navigation to next search item ──────────────────────────────────────

  /**
   * Get the single WebView onto a results page for `term`, then run `script`.
   *
   * Two ways to do that, and the choice is the whole of MEAL-16's last defect.
   *
   * NAVIGATE to the store's own results URL when it has one. This is the path
   * the worker pool already uses — `buildSearchAndAddWorker` points a worker at
   * `getSearchUrl(term)` and injects the fused add onto the loaded results page
   * — and it is how 29 of 35 adds landed on the device on 2026-08-29, each in
   * about 800 ms.
   *
   * SEARCH IN-PAGE from the store homepage otherwise. That was the only path
   * here before, and on H-E-B it hangs: measured 7 retries out of 7 across four
   * runs, every one dying on the 15 s `searchMs` timeout with zero candidates.
   * Raising the timeout does not help — 800 ms against >15 000 ms is a hang, not
   * slowness. The cost is not just the wait: the review screen is handed an
   * empty candidate list, tells the user "No products found", and takes away the
   * substitute they could have picked. On run 9 it was also why a shortfall the
   * reconcile had CORRECTLY detected could not be repaired, so the cart stayed
   * two units short of what was asked for.
   *
   * The in-page branch stays for stores with no `getSearchUrl`, and the
   * already-on-a-results-page branch above is untouched — ALDI and Wegmans drive
   * their whole run through it, and nothing here has measured them.
   *
   * No injected script changes. `script` is the same one either way; it finds
   * its match on whatever results page it lands on, which is exactly what it
   * already does inside a worker.
   */
  // navigateToResultsOrSearchInPage and navigateToSearchItem lived here: the
  // sequential page walk. One ingredient at a time, load a results page or run
  // the storefront's own in-page search, then inject an extractor or a fused
  // search-and-add and wait for a message. Every store had its own selectors for
  // it and every one of them went stale eventually.
  //
  // Deleted 2026-09-01. Nothing injects a DOM search script any more, so the
  // SEARCH_RESULT and SEARCH_AND_ADD_RESULT handlers it fed are unreachable too.


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
      const names = addResultsRef.current.filter((r) => r.success).map((r) => r.name);
      setTotalAdded(added);
      setAddedNames(names);
      // No setTotalFailed here: compileFailedNames owns the failed count as well
      // as the failed names, so a skip cannot drop off one and survive on the other.
      compileFailedNames();
      setStep('done');
      return;
    }
    const item = itemsToAdd[idx];
    // THIS ADD POST-DATES THE RAIL'S BREAKDOWN, so that breakdown is now wrong.
    //
    // The rail reports the cart as it stood when the automated pass finished.
    // Anything the user then adds from the review screen lands after that
    // snapshot, so the done screen went on saying "19 added" while the cart held
    // 20 — the substitute they had just picked was in neither the added list nor
    // the unadded one. Dropping the rows puts the done screen back on the
    // after-probe, which reads the cart as it actually is. Same reasoning as the
    // reset before manual mode.
    if (idx === 0) {
      setCartResultRows(null);
      setCartRowsTimedOut(false);
      // ...and the after-probe has to be allowed to run, or dropping the rows
      // just leaves a spinner. The done step skips it when the reconcile has
      // already finalized, which it has by the time anyone reaches review. The
      // cart has changed since that reconcile, so its verdict is spent.
      reconcileFinalizedRef.current = false;
    }
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

    // ADD IT OVER THE RAIL. The user picked a product; the rail knows its id.
    //
    // This was the last add in Mealio that worked by clicking: navigate to a
    // results page, find the card by its TITLE, press its button. It was also
    // the most fragile — the substitute add died on a timeout the first time
    // anyone ever picked one on a device, because the in-page search it relied
    // on hangs on H-E-B.
    //
    // A rail store has no reason to do any of that. The candidate the user chose
    // came from the store's own API and carries its productId and skuId, so the
    // pick can be written the same way the run's own adds are. Shaped as a
    // top-up because that is exactly what it is: a correction the reconcile has
    // already accounted for, which must not be reconciled a second time.
    const railForPick = getNetworkRail(lockedStoreIdRef.current);
    if (railForPick && item.productId && item.skuId) {
      const script = railForPick.addBatch([{
        idx,
        productId: String(item.productId),
        skuId: String(item.skuId),
        quantity: Math.max(1, Math.round(item.qty || 1)),
        name: item.productName,
        purchasePreferenceId: item.purchasePreferenceId ?? null,
        maxOrderQuantity: item.maxOrderQuantity ?? null,
      }]);
      if (script) {
        console.log(`[Cart ${ts()}]`, 'review add over the network:', item.productName, 'x', item.qty);
        netTopUpRef.current = new Map([[idx, item as unknown as ConsolidatedIngredient]]);
        netResultsRef.current = new Map();
        netWriteFanoutRef.current = new Map();
        netActiveRef.current = true;
        netPhaseRef.current = 'add';
        netArmFinalize(45_000);
        webviewRef.current?.injectJavaScript(script);
        return;
      }
    }
    // Same routing as the search path, and for the same measured reason: this is
    // the SUBSTITUTE add — the user picked a product on the review screen and we
    // have to go get that exact one. It was reaching the results page through the
    // in-page SPA search, which on H-E-B hangs, and this add died on the 10 s
    // `addMs` timeout on 2026-08-29 the first time a substitute was ever picked
    // on a device.
    //
    // NO RAIL, OR A CANDIDATE WITH NO IDS: hand it to the user.
    //
    // Below here used to be the click: navigate to a results page, find the card
    // by title, press its button, and arm a ten-second timeout in case nothing
    // came back. That is deleted. A pick we cannot write is one we cannot make
    // any promise about, and the honest response is the same as everywhere else
    // now — show the user the search and let them add it.
    console.log(`[Cart ${ts()}]`, 'review add: no rail write for', item.productName, '— handing over');
    addResultsRef.current.push({ name: item.productName, success: false, reason: 'no_rail_write' });
    const remaining = itemsToAdd.slice(idx).map((p) => p.searchTerm).filter(Boolean);
    if (remaining.length > 0) { startAssistedModeRef.current(); return; }
    setStep('done');
  }, [setStep]);

  // Kick off the search phase (parallel pool when every active item is a
  // choose-flow ingredient and the store opts in, else the sequential WebView
  // flow). Extracted so the HEB cart-page before-probe can defer it until the
  // before-count lands.
  // Commit the parked pre-search workers: inject the add into each already-open
  // results page (jittered) instead of spinning up the fused add pool. Runs
  // AFTER the before-cart snapshot, so finishParallelAdd reconciles against a
  // real baseline. Results (keyed by original item index) are re-keyed to the
  // dense active-item order finishParallelAdd expects.
  // startPresearchCommit committed the parked pre-search adds. Gone.

  /**
   * Prewarm the searches while the user is on the qty screen.
   *
   * Fired from onLoadEnd, not from a step effect, and that is the whole trick:
   * the session probe reads a bootstrap object the page publishes, so asking
   * before the page has loaded gets nothing. It is also why the WebView is kept
   * mounted through this screen at all.
   *
   * Gated on a KNOWN signed-in user. A probe at a signed-out page answers
   * nothing and spends a request telling us what the prewarm already knew.
   *
   * Terms are read when it fires. Quantities can still change afterwards and it
   * does not matter: a quantity changes what is WRITTEN, never what is looked
   * up. An item added later simply is not prewarmed and the run searches it.
   */
  const maybeStartSearchPrewarm = useCallback(() => {
    if (netPrewarmStartedRef.current || stepRef.current !== 'qty') return;
    const rail = getNetworkRail(lockedStoreIdRef.current);
    if (!rail) return;
    if (loginPrewarmRef.current?.getStatus(lockedStoreIdRef.current) !== 'loggedIn') return;
    const terms = Array.from(new Set(
      qtyItemsRef.current.filter((it) => !isZeroedOut(it))
        // A row the user has already chosen for at this store has nothing to
        // look up — the run writes its saved id straight to the cart. Searching
        // it here would be work whose answer is thrown away, on the one phase
        // that exists to save the run time.
        .filter((it) => !netStoredProduct(it))
        .map((it) => it.searchTerm || it.ingredientName)
        .filter((t): t is string => !!t),
    ));
    if (terms.length === 0) return;
    netPrewarmStartedRef.current = true;
    netPhaseRef.current = 'prewarm';
    netPrewarmTermsRef.current = terms;
    console.log(`[Cart ${ts()}]`, 'search prewarm: asking the session for', terms.length, 'terms');
    webviewRef.current?.injectJavaScript(rail.sessionScript());
  }, []);

  const beginSearchFlow = useCallback(() => {
    setStep('searching');
    const active = activeItemsRef.current;
    const allChoose = active.length > 0 && active.every((it) => !it.searchTerm);
    // Two questions now, where there used to be six. DOM automation is gone, so
    // there is no pool to size, no worker script to look for, and nothing to
    // fall back to when a store cannot run one. A store either has a rail or the
    // user drives.
    // Through railConfigKey: the Albertsons family shares one config entry, so a
    // banner id finds nothing and reads as a store with no rail.
    const netCfg = getAutomationConfig().stores?.[railConfigKey(lockedStoreIdRef.current)] ?? {};
    // Capability, not a store name. A store qualifies when it HAS a rail and both
    // of its switches are on. H-E-B additionally requires cartSkuConfirm, because
    // that is what makes its write verifiable — Albertsons verifies from the
    // write's own response, which returns the whole cart, so it has no
    // equivalent switch to demand.
    const networkCapable = !!getNetworkRail(lockedStoreIdRef.current)
      && netCfg.networkSearch === true
      && netCfg.networkAdd === true
      && (lockedStoreIdRef.current !== 'heb' || netCfg.cartSkuConfirm === true);
    const strategy = chooseAddStrategy({ allChoose, networkCapable });
    console.log(`[Cart ${ts()}]`, 'beginSearchFlow: allChoose=', allChoose, 'activeLen=', active.length,
      'store=', lockedStoreIdRef.current, 'strategy=', strategy);
    if (strategy === 'network' || strategy === 'networkChoose') {
      netChooseOnlyRef.current = strategy === 'networkChoose';
      startNetworkRun();
      return;
    }
    startAssistedModeRef.current();
  }, [startNetworkRun]);

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
    //
    // Via the named predicate, not `prewarmed.count`: the truthiness slip is
    // invisible here and would throw away every EMPTY cart (count 0) — the same
    // 0-vs-null confusion this branch is about. isCountedCartSnapshot carries
    // that rule and is pinned by its own unit test.
    if (prewarmed && isCountedCartSnapshot(prewarmed)) {
      console.log(`[Cart ${ts()}]`, 'snapshotBefore: using PREWARMED baseline count=', prewarmed.count, 'lines=', prewarmed.items.length);
      cartCountBeforeRef.current = prewarmed.count;
      cartItemsBeforeRef.current = prewarmed.items;
      if (prewarmed.url && !getCartPageUrl(probeStoreId)) capturedCartUrlRef.current = prewarmed.url;
      beginSearchFlow();
      return;
    }
    // ASK THE RAIL FIRST — same reason as the after-probe: a rail store must
    // never load a page to learn what is in its own cart.
    const railForBefore = getNetworkRail(probeStoreId);
    if (railForBefore) {
      cartCountPendingRef.current = 'before';
      cartProbeBeginSearchRef.current = true;
      if (cartProbeTimeoutRef.current) clearTimeout(cartProbeTimeoutRef.current);
      cartProbeTimeoutRef.current = setTimeout(() => {
        cartProbeTimeoutRef.current = null;
        if (!cartProbeBeginSearchRef.current) return;
        console.log(`[Cart ${ts()}]`, 'network before-probe timed out — starting search without a baseline');
        cartProbeBeginSearchRef.current = false;
        cartCountPendingRef.current = null;
        beginSearchFlow();
      }, CART_PROBE_TIMEOUT_MS);
      console.log(`[Cart ${ts()}]`, 'snapshotBefore: reading the cart over the network, no page load');
      webviewRef.current?.injectJavaScript(railForBefore.cartRead());
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
  snapshotBeforeAndBeginSearchRef.current = snapshotBeforeAndBeginSearch;

  // ── WebView events ───────────────────────────────────────────────────────

  // Store scripts in a ref so callbacks always see the latest value without needing deps.
  const scriptsRef = useRef(scripts);
  scriptsRef.current = scripts;

  const onLoadEnd = useCallback((e: any) => {
    const url = e?.nativeEvent?.url ?? '';
    const s = scriptsRef.current;
    // Only process pages for this store — ignore about:blank and other internal loads.
    //
    // NOT FIXED, recorded: this is a substring test, so it matches any host that
    // merely CONTAINS the configured domain. That is how MEAL-136's wrong host
    // got past it — www.shopunitedsupermarkets.com contains the substring
    // "unitedsupermarkets.com", so the redirect to the storefront still looked
    // like "our store" and the flow carried on onto a marketing home page. The
    // substring is doing real work today (www./m. prefixes, per-banner
    // subdomains), and tightening it to a hostname suffix test is its own change
    // with its own blast radius across 20+ banners; MEAL-136 fixed the host.
    if (!s || !url.includes(s.domain)) {
      console.log(`[Cart ${ts()}]`, 'onLoadEnd url=', url, 'skipped: not store domain');
      return;
    }
    // A network run waiting on its session: the injection at run start can land
    // while the page is mid-navigation and go nowhere. This is the retry.
    if (netActiveRef.current && netPhaseRef.current === 'session') {
      console.log(`[Cart ${ts()}]`, 'network run: re-reading the session on', url.slice(0, 60));
      const railForSession = getNetworkRail(lockedStoreIdRef.current);
      if (railForSession) webviewRef.current?.injectJavaScript(railForSession.sessionScript());
      return;
    }
    // Manual mode injects NOTHING (MEAL-197). Checked before every other branch
    // — including the cold-slot one — so no stale ref from the automated run can
    // route a script into a page the user is driving by hand.
    if (stepRef.current === 'manual') {
      console.log(`[Cart ${ts()}]`, 'onLoadEnd url=', url, 'manual mode — no injection');
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
        // The challenge cleared. There is no sequential page walk to resume any
        // more, so the run restarts from the top — the rail re-reads the session
        // and the cart, which is what a run needs after being interrupted.
        robotChallengeResumeIdxRef.current = -1;
        console.log(`[Cart ${ts()}]`, 'onLoadEnd robot challenge cleared — restarting the run');
        lastLoadEndUrlRef.current = '';
        snapshotBeforeAndBeginSearchRef.current();
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
      // Always, now. This guard existed because SPA-search stores fire onLoadEnd
      // several times for one pushState route change without reloading, and a
      // re-inject there would spawn a second concurrent buildSearchAndAddScript
      // and post a duplicate result. Nothing long-running is injected into a
      // page any more -- the only queued scripts are cart reads for stores with
      // no rail -- so the duplicate it protected against cannot happen.
      const reinjectInflight = true;
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
    // The store page has loaded and the user is still choosing quantities: this
    // is the only moment the search prewarm can run, and the only place it can
    // know the page is ready to answer.
    maybeStartSearchPrewarm();
    // A login page that finished loading with an empty document is terminal for
    // the user — they cannot sign in to a blank sheet, and no check script can
    // report the problem because they all throw on the first document.body read.
    // Runs before the inject chain below so the reload happens instead of a
    // check script being fired into a document that has no body to inspect.
    // See buildBlankPageRecoveryScript for what the condition is and why one
    // reload is the whole of the remedy.
    if (stepRef.current === 'login') {
      webviewRef.current?.injectJavaScript(buildBlankPageRecoveryScript());
    }
    if (loadQueueRef.current.length > 0) {
      const script = loadQueueRef.current.shift()!;
      const label = script.slice(0, 60).replace(/\n/g, ' ');
      console.log(`[Cart ${ts()}]`, 'onLoadEnd injecting script:', label);
      inflightScriptRef.current = script;
      webviewRef.current?.injectJavaScript(script);
    } else if (stepRef.current === 'login_check' && s.checkLoginScript) {
      // Queue was consumed by a redirect (e.g. /fresh → /alm/storefront).
      // Re-inject the login check on the final page — the SAME check the step
      // started with, or this quietly downgrades a rail store to the DOM answer
      // on any redirect, which is most of them.
      console.log(`[Cart ${ts()}]`, 'onLoadEnd login_check step — re-injecting after redirect');
      webviewRef.current?.injectJavaScript(loginCheckScript());
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
        // The THIRD place login is decided, and the one that actually fires for
        // Albertsons: while the user is looking at the sign-in prompt, every page
        // load re-asks. It has to use the rail as well, or the store gets the DOM
        // verdict here no matter what the other two do — and this verdict starts
        // the run, so it is the one that can begin an automation underneath a
        // user who has not signed in yet.
        console.log(`[Cart ${ts()}]`, 'onLoadEnd login step — back on store, re-asking');
        webviewRef.current?.injectJavaScript(loginCheckScript());
      } else {
        console.log(`[Cart ${ts()}]`, 'onLoadEnd login step — not on store yet, skipping re-inject');
      }
    } else if (netActiveRef.current && netPhaseRef.current === 'search') {
      // The page moved while the search was running in it. Anything still
      // unanswered died with the old document — ask again in the new one.
      netResumeSearchAfterNavRef.current();
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
  }, [setStep]);

  // Anti-bot block (HTTP 403/429/503): surface the generic blocker so the user
  // can complete any challenge, then retry.
  const handleHttpBlock = useCallback((statusCode: number, url: string) => {
    if (!ANTI_BOT_STATUSES.includes(statusCode)) return;
    const s = scriptsRef.current;
    if (!s || !isLikelyPageUrl(url, s.domain)) return;
    const st = stepRef.current;
    // Only meaningful while we're driving the store; ignore once the user is in
    // the review/done UI or already looking at a challenge.
    // 'manual' is on this list for a stronger reason than the rest (MEAL-197):
    // surfacing the blocker would abandon the queue with no route back, and the
    // only button it offers is "Try again" — which restarts the whole add pass
    // and re-adds every item that already landed on this run.
    if (st === 'qty' || st === 'review' || st === 'searchResult' || st === 'done' || st === 'robot_challenge' || st === 'manual') return;
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
  // ── Manual add mode (MEAL-197) ─────────────────────────────────────────────
  //
  // MEAL-9's rung 3 — "deep link the user to the store's search results for that
  // item" — done statefully rather than as a one-shot link. The WebView is
  // already open on the store and already logged in, so handing over the wheel
  // costs one navigation per item and no new session.
  //
  // Nothing is injected while this mode runs (see onLoadEnd). That is the whole
  // point: the button being pressed is the STORE'S, so a script of ours running
  // alongside could add a second copy behind the user's back — the exact
  // over-add the cart governing principles forbid.
  // Cart rows that appeared while the user was driving. Quantity-aware, because
  // adding a second of something already in the cart shows up as a bigger qty on
  // an existing row rather than as a new one.
  const rowsAddedDuringManual = (before: CartItem[], after: unknown): string[] => {
    if (!Array.isArray(after)) return [];
    const qtyBefore = new Map<string, number>();
    for (const r of before) qtyBefore.set((r?.name ?? '').trim().toLowerCase(), (qtyBefore.get((r?.name ?? '').trim().toLowerCase()) ?? 0) + (r?.qty ?? 0));
    const grew: string[] = [];
    for (const r of after as CartItem[]) {
      const key = (r?.name ?? '').trim().toLowerCase();
      if (!key) continue;
      if ((r?.qty ?? 0) > (qtyBefore.get(key) ?? 0)) grew.push(r.name);
    }
    return grew;
  };

  const manualSearchUrlFor = useCallback((term: string) => {
    const s = getStoreScripts(lockedStoreIdRef.current);
    return s?.getSearchUrl ? s.getSearchUrl(term) : null;
  }, []);

  const startManualMode = useCallback((terms: string[]) => {
    if (terms.length === 0) return;
    const first = manualSearchUrlFor(terms[0]);
    // No search URL for this store means no manual mode; the done screen offers
    // the copyable list instead and never renders the button that lands here.
    if (!first) return;
    console.log(`[Cart ${ts()}]`, 'manual mode: start', terms.length, 'items', terms);
    manualUsedRef.current = true;
    manualHandledRef.current = terms;
    manualCartSnapshotRef.current = cartItemsLatestRef.current;
    setManualQueue(terms);
    setManualIdx(0);
    setManualHandled([]);
    manualHandledRef.current = [];
    // The clipboard holds the pre-manual list; a pass that shrinks the failed
    // list makes "Copied" a claim about a list that no longer exists.
    setCopiedList(false);
    // Drop the previous cart read AND the verdict built from it. The done screen
    // re-probes on the way back in, and all four of these are about to be stale:
    // leaving the banner up while discarding the rows would land the user on a
    // screen with no breakdown and a pre-manual sentence still asserting what
    // their cart holds — under a screen they reached by changing it.
    setCartResultRows(null);
    setCartRowsTimedOut(false);
    setCartDeltaWarning(null);
    setCartUnverified(null);
    setVerdictFromCart(false);
    // The offer is tappable while "Updating your cart…" is still spinning. An
    // after-probe left in flight would land during the manual pass and write its
    // results — undoing the clear above and rebuilding the verdict from a cart
    // read taken partway through.
    cartCountPendingRef.current = null;
    if (cartProbeResultTimeoutRef.current) { clearTimeout(cartProbeResultTimeoutRef.current); cartProbeResultTimeoutRef.current = null; }
    if (cartRowsTimeoutRef.current) { clearTimeout(cartRowsTimeoutRef.current); cartRowsTimeoutRef.current = null; }
    setStep('manual');
    navTo(first);
  }, [manualSearchUrlFor, navTo, setStep]);

  // Records that the user was walked past the item, not what came of it. Skip
  // and Next are both "you have seen this one" — the cart is what says whether
  // anything landed, settled by the re-probe on the way back to 'done'.
  //
  // Tracked as the user advances rather than set to the whole queue up front, so
  // closing the sheet halfway does not mark the unseen tail as handled.
  const advanceManual = useCallback((skipped: boolean) => {
    const cur = manualQueue[manualIdx];
    if (cur) {
      if (!manualHandledRef.current.includes(cur)) manualHandledRef.current = [...manualHandledRef.current, cur];
      setManualHandled((prev) => (prev.includes(cur) ? prev : [...prev, cur]));
    }
    const nextIdx = manualIdx + 1;
    const nextTerm = manualQueue[nextIdx];
    const nextUrl = nextTerm != null ? manualSearchUrlFor(nextTerm) : null;
    if (!nextUrl) {
      console.log(`[Cart ${ts()}]`, 'manual mode: finished at', nextIdx, 'of', manualQueue.length, 'handled=', manualHandledRef.current, 'lastWasSkip=', skipped);
      setStep('done');
      return;
    }
    setManualIdx(nextIdx);
    navTo(nextUrl);
  }, [manualQueue, manualIdx, manualSearchUrlFor, navTo, setStep]);

  /**
   * The whole run, handed to the user.
   *
   * Mealio searches each ingredient and shows the results; the user adds what
   * they want and taps Next. This is what a store without a rail gets, and it is
   * the same machinery the manual fallback has always used — the difference is
   * only that it is now a first-class route rather than a rescue.
   *
   * It replaces four DOM routes (presearch, parallelSearch, parallelAdd,
   * serial), all of which worked by clicking the storefront. They are gone: the
   * selectors went stale, the clicks raced the page's own navigation, and an add
   * could report success without landing. Searching and letting the user add
   * cannot fail in any of those ways, because it never claims anything it has
   * not seen.
   */
  const startAssistedMode = useCallback(() => {
    const terms = activeItemsRef.current
      .map((i) => i.searchTerm || i.ingredientName)
      .filter((t): t is string => !!t);
    if (terms.length === 0) { setStep('done'); return; }
    console.log(`[Cart ${ts()}]`, 'assisted: handing', terms.length, 'searches to the user');
    startManualMode(terms);
  }, [startManualMode, setStep]);
  startAssistedModeRef.current = startAssistedMode;

  // MEAL-9's floor. Deliberately not gated on a store adapter or a live session:
  // this is what the user gets when everything else has failed, so it must not be
  // able to fail itself.
  const copyFailedList = useCallback(async () => {
    const names = failedNamesRef.current;
    if (names.length === 0) return;
    await Clipboard.setStringAsync(names.join('\n'));
    setCopiedList(true);
  }, []);

  const retryAfterBlock = useCallback(() => {
    setBlockReason(null);
    blockReasonRef.current = null;
    freshStoreUnavailableRef.current = false;
    robotChallengeResumeIdxRef.current = -1;
    consecutiveTimeoutsRef.current = 0;
    searchIdxRef.current = 0;
    onSearchPageRef.current = false;
    loadQueueRef.current = [loginCheckScript()];
    lastLoadEndUrlRef.current = '';
    expectedNavUrlRef.current = '';
    setStep('login_check');
    setSearchingLabel('Checking login…');
    navTo(scriptsRef.current!.storeUrl);
    armLoginCheckTimeout();
  }, [setStep, armLoginCheckTimeout]);

  // Manual "I'm already logged in" recovery from the login step. If detection
  // timed out or posted logged-out on a slow load but the user is in fact
  // signed in, one tap re-runs the check from a fresh store load and, if logged
  // in, proceeds without the user re-entering anything. Universal safety net so
  // a genuinely-logged-in user is never stranded on the login prompt.
  const recheckLogin = useCallback(() => {
    searchIdxRef.current = 0;
    onSearchPageRef.current = false;
    loadQueueRef.current = [loginCheckScript()];
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
        // MEAL-31's samples ride the same bridge as everything else and there is
        // one per script completion, so they are folded in and dropped BEFORE the
        // log line — otherwise the console buffer the bug-report path uploads
        // fills with selector maps nobody reads.
        if (ingestSelectorHealth(msg)) return;
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

        if (msg.type === 'BLANK_PAGE') {
          // The login page arrived with no body. `retried: true` means the
          // reload did not fix it, so the emptiness is the store's answer rather
          // than a truncated stream — worth seeing in a device log, since the
          // recovery deliberately stops after one attempt and the user is then
          // looking at the same blank sheet this was meant to clear.
          console.log(`[Cart ${ts()}]`, 'BLANK_PAGE on login step — retried=', !!msg.retried,
            'hasBody=', !!msg.hasBody, msg.url);
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
            console.log(`[Cart ${ts()}]`, 'LOGIN_STATUS true: storeId=', lockedStoreIdRef.current, 'activeLen=', activeItemsRef.current.length);
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
          // reason/url are what make a `count: null` diagnosable: the count alone
          // says "unknown", while `reason=not_cart_page url=<href>` says a wrong
          // DOMAIN_MAP host sent us somewhere that was never the cart (MEAL-136),
          // or that the cart URL itself redirected away (MEAL-152). Nothing
          // downstream stores either field, so this line and SilentLoginProbe's
          // are the whole audit trail — log them or the script's named reason
          // reaches nobody, and a redirect stays indistinguishable from a
          // selector miss.
          console.log(`[Cart ${ts()}]`, 'CART_COUNT phase=', phase, 'count=', count, 'reason=', msg.reason ?? null, 'status=', msg.status ?? null, 'ms=', msg.ms ?? null, 'tries=', msg.tries ?? null, 'detail=', msg.detail ?? null, 'url=', msg.url);
          if (Array.isArray(msg.items)) cartItemsLatestRef.current = msg.items as CartItem[];
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
            // A cart read that says "empty" while the rail holds landed verdicts is
            // not a reading, it is a failure to read (MEAL-16, run 7 of 2026-08-14).
            //
            // Under the Imperva wall the /cart page renders with no rows and the
            // count script posts `{count: 0, items: []}` with `reason: null` and
            // `onBlockedPage: false` — indistinguishable, to everything downstream,
            // from a genuinely empty cart. `[]` is an array, so the `!rows` guard
            // below never fired, and reconcile re-added all 18 items on top of the
            // 12 it had just been told were `landed`. Stephen's cart ended 12 units
            // over across 10 lines.
            //
            // The contradiction is already in this function's own hands: the rail
            // computed those verdicts six lines up, from the same `attempts`. A
            // read that disagrees with them about the whole cart loses, and the run
            // falls into the path below — which trusts the worker reports and says
            // out loud that the cart could not be checked. That is the honest
            // answer, and critically it does NOT re-add anything.
            //
            // Deliberately narrow: it needs `landed` to be non-empty. A run that
            // genuinely added nothing produces no verdicts, so an empty cart still
            // reads as an empty cart.
            const cartReadContradictsRail =
              !!rows && rows.filter((r) => r.added).length === 0 && verdicts.landed.length > 0;
            if (cartReadContradictsRail) {
              console.log(`[Cart ${ts()}]`, 'cart read says EMPTY but the rail confirmed',
                verdicts.landed.length, 'landed — treating as UNREAD, not as an empty cart');
            }
            if (!rows || cartReadContradictsRail) {
              // Can't diff per-item → trust the worker results, because there is
              // nothing better to trust.
              //
              // This used to say "parallel add is HEB-only, so this is just a
              // safety fallback". Both halves are wrong now. Walmart, Amazon Fresh
              // and the Albertsons family are all on the parallel-add path (only
              // ALDI and Wegmans force serial) — and MEAL-152 makes this branch the
              // EXPECTED outcome rather than a rarity: a cart page that cannot
              // prove it is the cart now posts no `items` at all, deliberately, so
              // a Walmart /cart redirect lands here every time. That is the
              // degradation the guard promises, and this is where it is paid.
              // SAY SO. The run just fell back to believing its own workers, and
              // until MEAL-190 it did that in silence (MEAL-190).
              //
              // The two ways a reconcile can fail to read the cart were reported
              // asymmetrically, and the silent one is the LIKELY one. A probe that
              // never answers hits the timeout in triggerCartProbe, which sets
              // exactly this warning. A probe that answers "I cannot prove this is
              // the cart" — `count: null`, no `items`, which is what the MEAL-152
              // page-identity guard posts — landed here and went to the done screen
              // with no warning at all. The comment below calls that the EXPECTED
              // outcome rather than a rarity, so the quieter path was also the
              // more common one.
              //
              // It matters because this is the state in which nothing can
              // contradict the run: every silent add defect (MEAL-185's multi-qty
              // under-add, MEAL-187's unhydrated zero, MEAL-188's over-adding
              // retry) reports success on its own internal checks, and the cart
              // diff is the only thing that ever disagreed. A run with no diff and
              // no warning presents a guess as a verified result.
              //
              // Same string as the timeout path, deliberately: the user's
              // situation is identical — we could not check your cart, go look.
              // Splitting hairs about WHY we could not read it belongs in the log,
              // which already carries `reason=` and `url=`.
              //
              // Held in its own state rather than in cartDeltaWarning, because the
              // two say opposite things about the cart and the run's `outcome` is
              // computed from which one is set — see the state declaration.
              setCartUnverified(unverifiedCartMessage(storeName));
              const { confirmed: wins, failed: lost } = reconcileFromWorkerReports(attempts);
              addResultsRef.current = wins.map((w) => ({ name: w.name, success: true }));
              setTotalAdded(wins.length);
              setTotalFailed(lost.length);
              setAddedNames(wins.map((w) => w.name));
              setFailedItems(lost.map((l) => l.name));
              reconcileFinalizedRef.current = true;
              setStep('done');
              return;
            }
            const outcome = reconcileParallelAdd(attempts, rows.filter((r) => r.added));
            const confirmed = outcome.confirmed.map((c) => ({ name: c.name, success: true }));
            // Two destinations for a shortfall — see splitUnverifiableTopUps.
            // `retry` is re-added unattended. `unverified` is the
            // count-item-on-a-weight-row disagreement: the cart plausibly already
            // holds the item, so re-adding buys it twice and confirming it claims
            // a delivery nobody checked. Those items are therefore neither
            // re-added nor confirmed — only reported, below and on the done
            // screen. Nothing is in both, and nothing is dropped.
            const routing = splitUnverifiableTopUps(outcome);
            // Re-add only the missing units; re-adding the full qty would
            // over-add the units that already landed.
            const retryItems: ConsolidatedIngredient[] = routing.retry.map(
              (t) => ({ ...active[t.index], productQty: t.shortfall }),
            );
            const reviewFailures: SearchResult[] = outcome.definiteFailures
              // A cap already met is definitive AND has nothing to review.
              //
              // It reaches the user through its own done-screen banner, which
              // exists precisely so they are not told to go add it by hand — the
              // store would refuse them too. A review card would say exactly
              // that, with no candidates to pick from (the network add reports
              // none) and no explanatory line for the reason, so it would render
              // as a bare "pick a substitute" for an item whose problem is that
              // the cart is already full of it.
              .filter((f) => f.reason !== 'quantity_limit_reached')
              .map((f) => {
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
            // The disagreements, as a REPORT — deliberately not review cards and
            // deliberately not part of `retryItems`. Set before either exit below,
            // because both of them land on the done screen where this renders.
            //
            // Under-adding, and saying so. The alternative branches are an
            // unattended re-add of the full quantity (an over-add, and money) or a
            // presence confirm off the weight row (a silent under-add): a stated
            // under-add is the only one of the three that does not break a rule
            // without telling anyone.
            //
            // MEAL-148 took the deciding away from this branch: an increment item
            // whose per-click weight we know is settled by arithmetic upstream —
            // productQty × increment, snapped to the line's own option ladder,
            // against the poundage the line gained — and comes back as a
            // confirmation or as a top-up of the clicks that are missing. Only what
            // the arithmetic refused to decide still arrives here.
            const unverified: UnverifiedWeightLine[] = routing.unverified.map((u) => ({
              term: active[u.index]?.searchTerm || active[u.index]?.ingredientName || u.cartName,
              cartName: u.cartName,
            }));
            setUnverifiedWeightLines(unverified);
            // The cart lines that banner names. Recorded before either exit below,
            // because BOTH announce over-adds and neither may also call one of these
            // rows unintended — the banner has already accounted for them, and one
            // line described twice ("we couldn't verify this" beside "nothing
            // intended this") is a contradiction that talks the user into deleting a
            // thing they asked for. See dropExplainedOverAdds.
            unverifiedCartNamesRef.current = routing.unverified.map((u) => u.cartName).filter(Boolean);
            // Keep the full intended set: the retry branch below narrows
            // activeItemsRef to the top-up subset, and the final cart check needs
            // the whole set to spot units no item intended.
            reconcileIntendedRef.current = outcome.intended;
            console.log(`[Cart ${ts()}]`, 'reconcile: confirmed=', confirmed.length, 'retry=', retryItems.length, retryItems.map((i) => i.searchTerm), 'review=', reviewFailures.length, reviewFailures.map((r) => `${r.term}:${r.reason}`));
            if (routing.unverified.length > 0) {
              console.log(`[Cart ${ts()}]`, 'reconcile: COUNT ITEM ON WEIGHT ROW — neither re-adding nor confirming, reporting only',
                routing.unverified.map((u) => `${active[u.index]?.searchTerm ?? u.index}→${u.cartName} (short ${u.shortfall})`));
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
              // How often the intent-vs-cart-row disagreement is left UNDECIDED —
              // items the run could neither re-add nor confirm. Nobody is asked
              // anything, so the name says what actually happened. Since MEAL-148
              // the deciding cases (increment known, poundage read) never reach it,
              // so this is now the size of what the arithmetic cannot answer — a
              // number that should trend to zero as the increment is captured for
              // more products, and a signal if it doesn't.
              weightRowUnverified: routing.unverified.length,
            };
            if (retryItems.length === 0 && reviewFailures.length === 0 && routing.unverified.length === 0) {
              tel().record('reconcile', 'ok', { detail: reconcileDetail });
            } else {
              // A top-up means the cart is short of what the workers claimed —
              // that's the confirmation rail being wrong, and it outranks the
              // review pile because it's the part we got wrong ourselves. An
              // unverified item is the same family: the add was dispatched and the
              // cart cannot corroborate what landed, which is confirm_failed
              // however it is routed. With neither, the row reflects the review
              // failures, which reconcile only ever routes here for out_of_stock /
              // no_results.
              tel().record('reconcile', 'error', {
                detail: reconcileDetail,
                code: retryItems.length > 0 || routing.unverified.length > 0
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
              // NOTE for the funnel (MEAL-122): this re-points the run's active
              // items at the retry subset and restarts the index, so every
              // telemetry row the top-up emits from here carries an `itemIndex`
              // in a NARROWED space. A 5-item run with a 2-item top-up emits
              // itemIndex 0-4 under path 'parallel_add' and 0-1 under 'fused',
              // and index 1 means a different item in each. `path` disambiguates
              // them, but "count distinct itemIndex" does not work across a run.
              activeItemsRef.current = retryItems;
              searchIdxRef.current = 0;
              onSearchPageRef.current = false;
              // Top-up owns the last 15%: reset the counter so it fills 85% → 100%
              // across this reconcile subset (see the progress effect).
              setProcessedCount(0);
              // Units, not lines (MEAL-178) — and here they genuinely differ:
              // each retry item's productQty is its SHORTFALL, so one line short
              // by three is three items being topped up.
              const topUpUnits = unitsForNames(
                retryItems.map((i) => i.searchTerm || i.ingredientName),
                retryItems.map(toIntendedItem),
              );
              setSearchingLabel(`Topping up ${topUpUnits} item${topUpUnits === 1 ? '' : 's'} we couldn't confirm…`);

              // ── Stay on the network rail for the top-up too (MEAL-202) ──────
              //
              // The top-up was the last place a network run still loaded pages.
              // It does not need to: the run already matched these products, so
              // the shortfall is a write, not a search. Re-searching would spend
              // ~1.8 s per item to rediscover an id we are holding.
              //
              // The write is ABSOLUTE and the script re-reads the cart for its own
              // baseline, so sending the shortfall is right: base is what the cart
              // holds NOW, after the adds this top-up is correcting for.
              //
              // Only for items the network actually matched. A retry item with no
              // match — one that reached the top-up some other way — has no id to
              // write, and those fall through to the page path below.
              if (netRunRef.current && netMatchedRef.current.size > 0) {
                const writes: Array<{
                  idx: number; productId: string; skuId: string | null; quantity: number; name: string;
                  purchasePreferenceId?: string | null; maxOrderQuantity?: number | null;
                }> = [];
                const stillNeedsPage = new Map<number, ConsolidatedIngredient>();
                routing.retry.forEach((t, n) => {
                  const m = netMatchedRef.current.get(t.index);
                  const shortfall = Math.max(1, Math.round(retryItems[n].productQty || 1));
                  if (!m) { stillNeedsPage.set(t.index, retryItems[n]); return; }
                  writes.push({
                    idx: t.index, productId: m.productId, skuId: m.skuId,
                    quantity: shortfall, name: m.name,
                    purchasePreferenceId: m.purchasePreferenceId,
                    maxOrderQuantity: m.maxOrderQuantity,
                  });
                });
                const script = writes.length > 0 ? (getNetworkRail(lockedStoreIdRef.current)?.addBatch(writes) ?? null) : null;
                if (script && stillNeedsPage.size === 0) {
                  console.log(`[Cart ${ts()}]`, 'network top-up: re-writing', writes.length, 'without a page load');
                  // The cart is about to change again, so the verdict this
                  // reconcile just reached is spent. Left set, the done step
                  // skips its after-probe and nothing ever re-reads the cart —
                  // which is how a failure the cart DISPROVES went unnoticed:
                  // the run reported the item failed, the top-up was refused
                  // too, and the read that would have found it sitting in the
                  // cart never ran. Same reasoning as a review add.
                  reconcileFinalizedRef.current = false;
                  netTopUpRef.current = new Map(routing.retry.map((t, n) => [t.index, retryItems[n]]));
                  netResultsRef.current = new Map();
                  netWriteFanoutRef.current = new Map();
                  netActiveRef.current = true;
                  netPhaseRef.current = 'add';
                  setStep('adding');
                  netArmFinalize(45_000);
                  webviewRef.current?.injectJavaScript(script);
                  return;
                }
                console.log(`[Cart ${ts()}]`, 'network top-up: falling back to pages —',
                  writes.length, 'writable of', routing.retry.length);
              }

              // The top-up needed a page. There are no pages any more: an item
              // the rail cannot re-write is one we cannot correct on the user's
              // behalf, so we say so and hand them the searches.
              console.log(`[Cart ${ts()}]`, 'network top-up: cannot write these — handing over');
              startAssistedModeRef.current();
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
            // every intended item was confirmed.
            // Minus the unverified weight lines: those are accounted for by the
            // banner that names them, so they are not rows "nothing explains".
            // Applied here and not inside reconcileParallelAdd, whose overAdds must
            // stay the exact residue of its claim (credited + overAddUnits ===
            // cartUnits) — the row is still consumed as nothing's claim, it just
            // isn't reported as unwanted on top of being reported as unverified.
            const unexplainedOver = dropExplainedOverAdds(outcome.overAdds, unverifiedCartNamesRef.current);
            if (unexplainedOver.length > 0) {
              const lockedName = getStores().find((s) => s.id === lockedStoreIdRef.current)?.name ?? storeName;
              const list = unexplainedOver.map(overAddLabel).join(', ');
              const units = unexplainedOver.reduce((n, o) => n + o.qty, 0);
              console.log(`[Cart ${ts()}]`, 'reconcile: OVER-ADD detected', unexplainedOver);
              setCartDeltaWarning({
                title: `Cart check: your ${lockedName} cart has ${units} item(s) Mealio didn't intend to add. Please review your cart.`,
                detail: `Mealio did not add: ${list}`,
              });
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
            const lockedName = getStores().find((s) => s.id === lockedStoreIdRef.current)?.name ?? storeName;
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
              // THE REVISED INTENT, not the one the run started with.
              //
              // A review pick REPLACES what an ingredient means: the user asked
              // for "H-E-B Texas Roots Fresh White Onion", the store had no such
              // thing, and they chose "Fresh White Onion" instead. runIntendedRef
              // already records that swap; recomputing from activeItemsRef here
              // threw it away, so the audit went looking for a Texas Roots onion,
              // did not find one, and had a spare Fresh White Onion in the cart
              // that nothing claimed — reported as "your cart has 1 item Mealio
              // did not add". It had just added it, on purpose, because the user
              // asked it to.
              //
              // This bites hardest when two ingredients resolve to the SAME
              // product, which is exactly the case here: one onion matched
              // directly and the other got there by substitution, so the cart
              // gained two and the audit expected one.
              active: runIntendedRef.current.length > 0
                ? runIntendedRef.current
                : activeItemsRef.current.map(toIntendedItem),
              reconcileIntended: reconcileIntendedRef.current,
              countBefore: cartCountBeforeRef.current,
              countAfter: count,
              // A skipped ingredient was never attempted, so the cart not having
              // it is what the user asked for — it must not come back as a
              // cart-sourced failure beside the skipped banner that already
              // reports it plainly (MEAL-199 review). Read from the ref because
              // onMessage closes over this run's initial state.
              // Plus anything handed to manual mode (MEAL-197). The product the
              // user picks by hand is titled by the STORE — "H-E-B Fresh Mint,
              // 0.5 oz" against an intended "Soli Organic Fresh Mint, 0.5 oz" —
              // and this audit matches names exactly. Left in, a successful
              // manual add reads as a failure ("Mealio could not add …") AND
              // re-offers the item the user just added. We cannot verify these
              // by name, so we do not claim anything about them.
              skippedNames: [...Object.values(skippedByIdxRef.current), ...manualHandledRef.current],
              // The unverified weight lines survive into this cart read too, still
              // unclaimable by the count items they belong to. Held out of `over`
              // because the done screen renders that warning beside the banner
              // that already names them.
              explainedRows: unverifiedCartNamesRef.current,
              // The other half of the manual problem. The row the user added is
              // one this run did not intend, which is the definition of an
              // over-add — and "your cart has 1 item Mealio did not add" about a
              // product they chose thirty seconds ago is nonsense. Rows that grew
              // while the USER was driving are theirs.
              //
              // A separate input from `explainedRows` because the two want
              // opposite things: a weight row has to STAY in the pool (it is its
              // intended item, and dropping it makes that item read as absent —
              // cartVerdict.test.ts proves it), while these are accounted for by
              // nothing and must leave it.
              userAddedRows: manualHandledRef.current.length > 0
                ? rowsAddedDuringManual(manualCartSnapshotRef.current, msg.items)
                : [],
            });
            // `over` and `countShortfall` are no longer read here: they used to
            // be assembled into copy at this call site, and that job moved into
            // buildCartVerdict (MEAL-199). They are still on `findings`, which is
            // what the verdict is built from.
            const { missing, short, recovered } = findings;
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
              // Correct what the screen SAYS, not just what the fleet records
              // (MEAL-177). "Could not add: Sour Cream" is printed one line above
              // this banner, and it is the only place the user is ever told an
              // item failed — there is no live per-item failure rail, and the
              // mid-run "Items Not Added" gate carries search failures, which are
              // held out of the intended set and so can never come back as a
              // recovery. So the banner was a rebuttal of the sentence directly
              // above it, or (on the nothing-added branch, the likelier one for a
              // recovery) a correction to a claim that never named anything.
              //
              // Dropped from failed, deliberately not moved to added: a `loose`
              // recovery is a name match and the added headline is the run's own
              // claim about what it put there. The banner says what holds either
              // way — it is in your cart, don't add it again.
              const stillFailed = dropRecoveredFailures(failedNamesRef.current, recovered);
              if (stillFailed.length !== failedNamesRef.current.length) {
                setFailedItems(stillFailed);
                // Kept in step by hand because the two are set together on every
                // finalize path (see compileFailedNames' callers); totalFailed
                // alone gates the "Could not add" line, so leaving it behind
                // would re-print the corrected items as a bare count.
                setTotalFailed(stillFailed.length);
              }
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
            // ONE message, built from the cart (MEAL-199).
            //
            // What the screen says about this run is now decided in one place and
            // read off one source. The failed list is set from the same verdict,
            // so the sentence naming items as absent and the sentence explaining
            // the cart can no longer be two views computed from two observers —
            // which is what made "Could not add: Sour Cream" sit above "Sour
            // Cream is already in your cart".
            const verdict = buildCartVerdict({
              storeName: lockedName,
              findings,
              // Only consulted when the cart could not be read. It is passed
              // regardless so the no-read branch has something honest to fall
              // back to, labelled as the run's own account rather than the
              // cart's.
              reportedFailed: failedNamesRef.current,
              // Null on purpose: MEAL-190 owns the "we could not read your cart"
              // copy and renders it from its own state. See buildCartVerdict.
              unreadReason: null,
            });
            setVerdictFromCart(verdict.cartBacked);
            if (verdict.cartBacked) {
              // The cart decides what failed. `dropRecoveredFailures` above
              // corrected this list item by item against the run's version;
              // this replaces it outright, which is the same correction taken to
              // its conclusion — an item is absent because the cart does not
              // show it, not because the run said so and nothing overturned it.
              setFailedItems(verdict.notAdded);
              setTotalFailed(verdict.notAdded.length);
              setCartDeltaWarning(verdict.title ? { title: verdict.title, detail: verdict.detail } : null);
            }
            // No cart read leaves both alone: the run's own failed list stands
            // as the screen already has it, and cartUnverified says out loud
            // that nothing checked it.
          }
          return;
        }

        // ── Network run (MEAL-202) ──────────────────────────────────────
        //
        // These only ever arrive while a network run is in flight. Guarded on
        // netActiveRef so a late message from an abandoned run cannot revive it
        // after the pool has taken over — which would leave two paths writing
        // results for the same items.
        if (NETWORK_SESSION_MESSAGE_TYPES.includes(msg.type)) {
          // The same probe answers the login gate. When it arrives during
          // login_check it IS the login check, so it is translated into the
          // verdict that step expects rather than being routed through the run.
          if (stepRef.current === 'login_check' || stepRef.current === 'login') {
            const onLoginStep = stepRef.current === 'login';
            console.log(`[Cart ${ts()}]`, 'login answered over the network:', JSON.stringify(msg).slice(0, 200));
            if (!msg.ok) {
              // Could not answer — usually the page had not finished its
              // bootstrap. Not a signed-out user, and saying so would wall one,
              // so the DOM check gets the page instead.
              console.log(`[Cart ${ts()}]`, 'network session inconclusive —', msg.why, '— falling back to the DOM check');
              webviewRef.current?.injectJavaScript(scriptsRef.current!.checkLoginScript);
              return;
            }
            tel().record('login_check', 'ok', {
              detail: { isLoggedIn: !!msg.loggedIn, source: 'network_session' },
            });
            loginCheckActiveRef.current = false;
            if (loginCheckTimeoutRef.current) { clearTimeout(loginCheckTimeoutRef.current); loginCheckTimeoutRef.current = null; }
            // KEEP THE ANSWER. This probe and the run's own session probe ask the
            // page the identical question and get the identical reply — the store
            // and the shopping context are right here in `msg`. Throwing it away
            // and asking again seconds later is what stalled Stephen's run of
            // 2026-09-01: the second ask landed on a store homepage still busy
            // with its own bootstrap, took 26 s to answer a question needing no
            // network at all, missed the 25 s deadline by 1.4 s, and dropped 20
            // items into the page-driven pool — the "taking a slower route"
            // screen he sat in front of for minutes.
            if (msg.loggedIn && msg.storeId && msg.shoppingContext) {
              netSessionRef.current = {
                storeId: String(msg.storeId), shoppingContext: String(msg.shoppingContext),
              };
              netSessionAtRef.current = Date.now();
            }
            if (msg.loggedIn) snapshotBeforeAndBeginSearch();
            else if (!onLoginStep) {
              setStep('login');
              lastLoadEndUrlRef.current = '';
            }
            // Already on the login step and still signed out: stay put. Saying it
            // again would re-render the sheet under someone mid-sign-in.
            return;
          }
          // THE PREWARM'S OWN SESSION. It is not a run — netActiveRef is false
          // and must stay false — so it is answered before the run's gate below.
          // ...and ONLY while the user is still on the qty screen. A prewarm
          // that had not finished when they tapped would otherwise answer the
          // RUN's session probe with its own branch and re-issue the whole
          // batch — the run then searches every term a second time, which is
          // the one thing this feature exists to avoid.
          if (netPhaseRef.current === 'prewarm' && !netActiveRef.current
              && stepRef.current === 'qty') {
            if (!msg.ok || !msg.loggedIn || !msg.storeId || !msg.shoppingContext) {
              console.log(`[Cart ${ts()}]`, 'search prewarm: no usable session — leaving it to the run');
              netPhaseRef.current = 'idle';
              netPrewarmDoneRef.current = true;
              return;
            }
            const sess = { storeId: String(msg.storeId), shoppingContext: String(msg.shoppingContext) };
            netSessionRef.current = sess;
            netSessionAtRef.current = Date.now();
            const railP = getNetworkRail(lockedStoreIdRef.current);
            const scriptP = railP?.searchBatch(netPrewarmTermsRef.current, sess) ?? null;
            if (!scriptP) { netPhaseRef.current = 'idle'; netPrewarmDoneRef.current = true; return; }
            console.log(`[Cart ${ts()}]`, 'search prewarm: searching', netPrewarmTermsRef.current.length,
              'terms while the user is on the qty screen');
            webviewRef.current?.injectJavaScript(scriptP);
            return;
          }
          if (!netActiveRef.current || netPhaseRef.current !== 'session') return;
          if (netSessionSettledRef.current) return;
          if (netTimeoutRef.current) { clearTimeout(netTimeoutRef.current); netTimeoutRef.current = null; }
          console.log(`[Cart ${ts()}]`, 'network run: session', JSON.stringify(msg));
          if (!msg.ok) { netHandOverToUser('session_' + (msg.why || 'failed')); return; }
          if (!msg.loggedIn) {
            // The gate did its job. Hand the user the login screen exactly as the
            // page-based login check would have.
            netActiveRef.current = false;
            netPhaseRef.current = 'idle';
            setStep('login');
            return;
          }
          if (!msg.storeId || !msg.shoppingContext) { netHandOverToUser('session_no_store'); return; }
          netSessionRef.current = { storeId: String(msg.storeId), shoppingContext: String(msg.shoppingContext) };
          netSessionAtRef.current = Date.now();
          // Same reason as the reuse path: consumed once, so a duplicate answer
          // cannot open a second search chain.
          netSessionSettledRef.current = true;
          netStartSearch();
          return;
        }
        if ((msg.type === 'SEARCH_RESULT' || msg.type === 'SEARCH_RESULT_FAILED')
            && msg.source === 'network' && isCustomSearchRef.current) {
          // A substitute search is a network search too, and it is NOT part of
          // the run's batch — the gate below would drop it, because by review
          // time the run is over and netActiveRef is false.
          isCustomSearchRef.current = false;
          if (customSearchTimeoutRef.current) { clearTimeout(customSearchTimeoutRef.current); customSearchTimeoutRef.current = null; }
          const subs: Candidate[] = msg.type === 'SEARCH_RESULT' ? (msg.candidates ?? []) : [];
          console.log(`[Cart ${ts()}]`, 'CUSTOM SEARCH network result:', subs.length, 'candidates');
          setCustomSuggestions(subs);
          setCustomSearching(false);
          setSelectedSuggIdx(0);
          setCustomText('');
          return;
        }
        if ((msg.type === 'SEARCH_RESULT' || msg.type === 'SEARCH_RESULT_FAILED') && msg.source === 'network') {
          // Both outcomes are an answer, so both advance the ring — a term the
          // store had nothing for is progress, not a stall.
          bumpNetProgress(typeof msg.term === 'string' ? msg.term : null);
        }
        if (msg.type === 'SEARCH_RESULT_FAILED' && msg.source === 'network') {
          if (!netActiveRef.current) return;
          console.log(`[Cart ${ts()}]`, 'network search failed for', String(msg.term).slice(0, 30), '—', msg.why,
            'status=', msg.status ?? null, 'ms=', msg.ms ?? null, 'vis=', msg.vis ?? null,
            'worstTick=', msg.worstTickMs ?? null, 'keyTail=', msg.keyTail ?? null,
            'variant=', msg.variant ?? null, 'first=', msg.firstVariant ?? null,
            'firstStatus=', msg.firstStatus ?? null, 'detail=', msg.detail ?? null);
          if (typeof msg.term === 'string') netFailedTermsRef.current.add(msg.term);
          return;
        }
        if (msg.type === 'SEARCH_BATCH_DONE'
            && netPrewarmStartedRef.current && !netPrewarmDoneRef.current
            && netPhaseRef.current !== 'search') {
          console.log(`[Cart ${ts()}]`, 'search prewarm: done —',
            netPrewarmCandidatesRef.current.size, 'terms answered before the user tapped');
          netPhaseRef.current = 'idle';
          netPrewarmDoneRef.current = true;
          return;
        }
        if (msg.type === 'SEARCH_BATCH_DONE') {
          if (!netActiveRef.current || netPhaseRef.current !== 'search') return;
          if (netTimeoutRef.current) { clearTimeout(netTimeoutRef.current); netTimeoutRef.current = null; }
          console.log(`[Cart ${ts()}]`, 'network search done:', netCandidatesRef.current.size, 'answered,',
            netFailedTermsRef.current.size, 'failed');
          if (netChooseOnlyRef.current) {
            // A CHOOSE run: the user picks the product, so the rail's job ended
            // with the search. Hand the candidates to the same function the
            // parallel search pool used to call, so the Choose Products screen
            // is fed identically however the search was done — the pool is gone,
            // the screen it filled is not.
            netChooseOnlyRef.current = false;
            netActiveRef.current = false;
            netPhaseRef.current = 'idle';
            const byIdx = new Map<number, Candidate[]>();
            activeItemsRef.current.forEach((item, idx) => {
              const term = item.searchTerm || item.ingredientName;
              byIdx.set(idx, netCandidatesRef.current.get(term) ?? []);
            });
            console.log(`[Cart ${ts()}]`, 'network choose: handing', byIdx.size, 'results to the choose screen');
            finishParallelSearch(byIdx);
            return;
          }
          netStartAdds();
          return;
        }
        if (msg.type === 'NET_ADD_RESULT') {
          bumpNetProgress(typeof msg.name === 'string' ? msg.name : null);
          if (!netActiveRef.current || netPhaseRef.current !== 'add') return;
          const at = typeof msg.idx === 'number' ? msg.idx : -1;
          if (at < 0) return;
          console.log(`[Cart ${ts()}]`, 'network add', msg.name, msg.success ? 'ok' : ('failed: ' + msg.reason));
          // A STORED ID THAT DID NOT WORK NEEDS SOMETHING TO OFFER INSTEAD.
          //
          // A row written from a saved product id never went through the search,
          // so when its write is refused -- the id retired, the line marked
          // unavailable -- there are no candidates for the review screen. The
          // ingredient-name search that a no-results row gets up front is fired
          // for it HERE instead, on the failure, because that is the first
          // moment we know it is needed. It costs a request only for the items
          // that actually failed.
          if (!msg.success && at >= 0) {
            const failed = activeItemsRef.current[at];
            const wasStored = !!(failed && netStoredProduct(failed));
            if (wasStored && failed.ingredientName
                && !netFallbackWantedRef.current.has(at)) {
              netFallbackWantedRef.current.set(at, failed.ingredientName);
              netStartFallbackSearchRef.current();
            }
          }
          if (!msg.success && msg.reason === 'quantity_limit_reached') {
            setCapReached((prev) => (prev.some((c) => c.name === msg.name)
              ? prev
              : [...prev, { name: String(msg.name ?? ''), detail: String(msg.detail ?? '') }]));
          }
          // Per-item telemetry, which the network path had none of.
          //
          // addFailureCode is only reached from the SEARCH_AND_ADD_RESULT /
          // ADD_RESULT handlers and the pool recorder, so every failure on this
          // rail was landing on the dashboard as nothing at all — the primary
          // path, invisible.
          if (msg.success) {
            tel().record('confirm', 'ok', { detail: { via: 'network', name: msg.name } });
          } else {
            tel().record('confirm', 'error', {
              detail: { via: 'network', name: msg.name, reason: msg.reason, note: msg.detail },
              code: addFailureCode(msg.reason),
            });
          }
          const speaksFor = netWriteFanoutRef.current.get(at) ?? [at];
          for (const target of speaksFor) {
            netResultsRef.current.set(target, {
              success: !!msg.success,
              productName: msg.name ?? null,
              reason: msg.success ? null : (msg.reason ?? 'cart_not_incremented'),
              candidates: [],
              // A RAIL WRITE THAT SUCCEEDED IS A CONFIRMED LANDING, and the
              // reconcile has to be told so.
              //
              // This was dropped, and MEAL-16 is what that costs. The guard there
              // says an empty cart read which contradicts a confirmed landing is
              // UNREAD, not empty — because `[]` is still an array, nothing
              // downstream could tell the two apart, and reconcile re-added 18
              // items on top of the 12 already in the cart. That guard weighs the
              // read against `confirm`, so a rail result with no confirm was
              // invisible to it.
              //
              // The rail does not guess: it verifies each write from that write's
              // own response, which returns the cart. Saying so in the shape the
              // reconcile already understands is what keeps the protection now
              // that the rail is the only path there is.
              confirm: msg.success
                ? {
                    state: 'landed', reason: 'network_write', via: 'network',
                    skuId: typeof msg.skuId === 'string' ? msg.skuId : null,
                    productId: typeof msg.productId === 'string' ? msg.productId : null,
                  } satisfies HebAddConfirmation
                : null,
            });
          }
          return;
        }
        if (msg.type === 'NET_ADD_DONE') {
          if (!netActiveRef.current || netPhaseRef.current !== 'add') return;
          if (netTimeoutRef.current) { clearTimeout(netTimeoutRef.current); netTimeoutRef.current = null; }
          netActiveRef.current = false;
          netPhaseRef.current = 'idle';
          console.log(`[Cart ${ts()}]`, 'network run: wrote', msg.wrote, 'of', msg.count);
          // The done screen's breakdown, straight from the rail's own cart reads.
          //
          // It used to come from a page load: navigate this WebView to the cart
          // page after the run and scrape the rows. That was the last DOM read
          // left on a rail whose whole point is not loading pages, and it is why
          // the breakdown could vanish — the navigation can time out, and then
          // there is nothing to build from (MEAL-209).
          //
          // Set here rather than waiting for the probe so the screen is correct
          // even when the probe never answers. The probe still runs for the
          // reconcile, and if it answers it overwrites this with the same rows.
          if (Array.isArray(msg.cartBefore) && Array.isArray(msg.cartAfter)) {
            if (cartRowsTimeoutRef.current) { clearTimeout(cartRowsTimeoutRef.current); cartRowsTimeoutRef.current = null; }
            // Diff against the cart as it was when the RUN started, not as it
            // was when this write started.
            //
            // A top-up's own before/after only differs by the items it topped
            // up, so the done screen flagged 2 of 17 rows as added and showed
            // the other 15 in grey as though they had been there all along. The
            // user had just watched us add them. The run's baseline is the only
            // honest "before" for a screen that says what THIS RUN did.
            // The FIRST write's cartBefore, kept for the rest of the run.
            //
            // Falling back to `msg.cartBefore` was not enough. On a run whose
            // page probe failed — `CART_COUNT phase=before count=null
            // reason=not_cart_page`, because the cart URL landed on the
            // homepage — cartItemsBeforeRef stays empty, so the TOP-UP's own
            // before/after became the baseline and the done screen credited the
            // run with the one item the top-up wrote. Measured: eleven items
            // written, all eleven landed, and the screen said one. Stephen saw
            // spinach and nothing else.
            if (netRunBaselineRef.current == null) {
              netRunBaselineRef.current = msg.cartBefore as CartItem[];
            }
            const runBaseline = cartItemsBeforeRef.current.length
              ? cartItemsBeforeRef.current
              : netRunBaselineRef.current;
            const netRows = diffCartItems(runBaseline, msg.cartAfter as CartItem[]);
            console.log(`[Cart ${ts()}]`, 'network run: cart breakdown from the rail —', netRows.length,
              'rows,', netRows.filter((r) => r.added).length, 'added, no page load');
            setCartResultRows(netRows);
          }
          // A first pass hands its results to the reconcile, which is the same
          // completion the add pool calls — so nothing downstream can tell a
          // network run from a pooled one. A TOP-UP finishes the run instead:
          // it IS the reconcile's correction, and reconciling it again would
          // find a shortfall and top up the top-up. See netFinalize.
          netFinalizeRef.current();
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

        // The SEARCH_AND_ADD_RESULT and sequential SEARCH_RESULT handlers lived
        // here. Both answered DOM scripts -- the fused search-and-add, and the
        // page extractor -- and nothing injects either any more.
        // A network SEARCH_RESULT is keyed by TERM and collected for the batch,
        // not fed to the sequential handler below — that one assumes it is the
        // answer to the ONE item the run is currently walking, and a batch posts
        // twelve of them in no particular order.
        // A PREWARM ANSWER IS KEPT WHATEVER THE PHASE SAYS.
        //
        // It used to be gated on phase === 'prewarm', and there is a gap: the
        // user taps, the run sets the phase to 'session', and every prewarm
        // answer still in flight lands in neither store. Measured on a 19-item
        // run — the user tapped 0.2s after the prewarm's batch went out, six
        // answers fell in the gap, and the run re-searched all nineteen terms
        // instead of the thirteen it was missing. The prewarm cost a burst and
        // saved nothing.
        if (msg.type === 'SEARCH_RESULT' && msg.source === 'network'
            && netPrewarmStartedRef.current && !netPrewarmDoneRef.current
            && netPhaseRef.current !== 'search') {
          if (typeof msg.term === 'string' && Array.isArray(msg.candidates)) {
            netPrewarmCandidatesRef.current.set(msg.term, msg.candidates as Candidate[]);
          }
          return;
        }
        if (msg.type === 'SEARCH_RESULT' && msg.source === 'network') {
          // The request's own clock, so a slow store and a starved JS thread
          // stop looking the same in the log.
          console.log(`[Cart ${ts()}]`, 'net search', msg.variant ?? null, String(msg.term).slice(0, 28),
            'ms=', msg.ms ?? null, 'vis=', msg.vis ?? null, 'worstTick=', msg.worstTickMs ?? null,
            'bytes=', msg.bytes ?? null, 'n=', (msg.candidates || []).length);
          // THE FALLBACK BATCH ARRIVES DURING THE ADD PHASE, by design — it is
          // fired alongside the writes so the user never waits for it. The phase
          // gate below would drop it on the floor, so it is answered first.
          if (typeof msg.term === 'string' && Array.isArray(msg.candidates)
              && netFallbackPendingRef.current
              && [...netFallbackWantedRef.current.values()].includes(msg.term)) {
            netFallbackCandidatesRef.current.set(msg.term, msg.candidates as Candidate[]);
            return;
          }
          if (!netActiveRef.current || netPhaseRef.current !== 'search') return;
          if (typeof msg.term === 'string' && Array.isArray(msg.candidates)) {
            netCandidatesRef.current.set(msg.term, msg.candidates as Candidate[]);
          }
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
    [navigateToAddItem, ingestSelectorHealth],
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

    // ON A NETWORK STORE, A SUBSTITUTE SEARCH IS A NETWORK SEARCH.
    //
    // The DOM path below drives the store's own header search box, which only
    // exists on a search page. A network run loads no pages, so it arrives at
    // this screen parked on the cart, the script finds no input and returns
    // silently, and the only thing that happens is the recovery timeout fifteen
    // seconds later. Stephen typed "Onion" and watched exactly that.
    //
    // The rail can answer this directly — it is the same search the run itself
    // used, for one term instead of eighteen.
    const netRailForSub = getNetworkRail(lockedStoreIdRef.current);
    const subSession = netSessionRef.current;
    const subScript = netRailForSub && subSession
      ? netRailForSub.searchBatch([trimmed], subSession)
      : null;

    if (customSearchTimeoutRef.current) clearTimeout(customSearchTimeoutRef.current);
    customSearchTimeoutRef.current = setTimeout(() => {
      customSearchTimeoutRef.current = null;
      if (!isCustomSearchRef.current) return; // result already arrived
      console.log(`[Cart ${ts()}]`, 'CUSTOM SEARCH timeout for', trimmed, '— re-enabling review buttons');
      isCustomSearchRef.current = false;
      loadQueueRef.current = [];
      setCustomSuggestions([]);
      setCustomSearching(false);
    }, CUSTOM_SEARCH_TIMEOUT_MS);

    if (subScript) {
      // No page load is coming, so nothing must be left queued for one — a
      // stale extract would otherwise fire on some later unrelated navigation.
      loadQueueRef.current = [];
      console.log(`[Cart ${ts()}]`, 'CUSTOM SEARCH over the network for', trimmed);
      webviewRef.current?.injectJavaScript(subScript);
      return;
    }

    // NO RAIL, NO SUGGESTIONS. This used to drive the store's own header search
    // and scrape the results page. A store without a rail never reaches the
    // review screen at all now -- its whole run is assisted -- so rather than
    // keep a DOM scraper alive for a path nobody walks, say so immediately
    // instead of making the user wait out the fifteen-second recovery timeout.
    console.log(`[Cart ${ts()}]`, 'CUSTOM SEARCH: no rail for this store — no suggestions');
    if (customSearchTimeoutRef.current) { clearTimeout(customSearchTimeoutRef.current); customSearchTimeoutRef.current = null; }
    isCustomSearchRef.current = false;
    setCustomSuggestions([]);
    setCustomSearching(false);
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
      if (skippedName) {
        // The ref is written HERE as well as during render, and the difference
        // shows on the last skip in the queue. `skippedByIdxRef` is assigned
        // while rendering, so it only catches up on the next commit — and
        // skipping the final ingredient advances straight to the done screen,
        // where compileFailedNames reads the ref in the same tick. Measured on
        // a device 2026-08-29: six items skipped, five dropped off "Could not
        // add" and the sixth was still named there and in the skipped banner.
        skippedByIdxRef.current = { ...skippedByIdxRef.current, [reviewIdx]: skippedName };
        setSkippedByIdx((prev) => ({ ...prev, [reviewIdx]: skippedName }));
      }
    }

    if (action !== 'skip' && currentReview) {
      const displayCandidates = customSuggestions.length > 0 ? customSuggestions : currentReview.candidates;
      const candidate = typeof selectedSuggIdx === 'number' ? displayCandidates[selectedSuggIdx] : null;
      // 'choose' only saves the product for future runs (no cart add), so an
      // out-of-stock pick is allowed; 'add'/'update' hit the cart, so OOS stays blocked.
      if (candidate && (action === 'choose' || !candidate.outOfStock)) {
        // Re-deciding this ingredient after a Back: drop any earlier skip for it,
        // since adding now supersedes it.
        // The ref is cleared alongside the state for the same reason the skip
        // path writes it: it now has a writer that does not wait for a render,
        // so an adder without a remover would leave a stale skip behind for any
        // path that finalizes in the same tick.
        if (reviewIdx in skippedByIdxRef.current) {
          const nextRef = { ...skippedByIdxRef.current };
          delete nextRef[reviewIdx];
          skippedByIdxRef.current = nextRef;
        }
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
            railStoreProduct(candidate),
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
            productId: candidate.productId ?? null,
            skuId: candidate.skuId ?? null,
            maxOrderQuantity: candidate.maxOrderQuantity ?? null,
            purchasePreferenceId: needsPref && prefText
              ? (candidate.preferences?.find((o) => o.text === prefText)?.preferenceId ?? null)
              : null,
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
              railStoreProduct(candidate),
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
      const names = addResultsRef.current.filter((r) => r.success).map((r) => r.name);
      setTotalAdded(added);
      setAddedNames(names);
      // No setTotalFailed here: compileFailedNames owns the failed count as well
      // as the failed names, so a skip cannot drop off one and survive on the other.
      compileFailedNames();
      setStep('done');
      return;
    }
    // The review decision supersedes the pre-run intent (MEAL-178). A reviewed
    // item's quantity is `PickedItem.qty` — seeded at 0 and set by the user on
    // the review screen — and its identity is the store title that was picked,
    // which is also the name the run will report back. Counting these off the
    // pre-run productQty instead reads a x3 request against a x1 pick and tells
    // the user "3 items added to your cart!" when one landed; on a header-badge
    // store it also raises a cart-check warning against a correct run, because
    // the per-item audit that would have caught the discrepancy needs cart rows.
    // Matched on searchTerm, which is exactly the `name` toIntendedItem built.
    const superseded = new Set(itemsToAdd.map((p) => p.searchTerm));
    const revised = itemsToAdd.map((p) => ({
      name: p.productName || p.searchTerm,
      expectedQty: Math.max(1, p.qty || 1),
      isWeight: p.purchaseWeight != null,
    }));
    const applyPicks = (prev: IntendedItem[]) => [
      // Items settled before review (added inline on the combined path) keep the
      // intent they ran with — no pick ever revised them.
      ...prev.filter((i) => !superseded.has(i.name)),
      ...revised,
    ];
    runIntendedRef.current = applyPicks(runIntendedRef.current);
    // AND THE RECONCILE'S SNAPSHOT, which is the one the cart audit actually
    // reads: auditCartAfterRun takes `intendedAll = reconcileIntended.length > 0
    // ? reconcileIntended : active`, so revising only `active` changes nothing on
    // any run that reconciled — which is every network run.
    //
    // It is captured DURING the reconcile, before the user has picked anything,
    // so it still called the ingredient by the name the store had no match for.
    // The audit then hunted a "H-E-B Texas Roots Fresh White Onion" that was
    // never going to be there and found a "Fresh White Onion" nothing claimed,
    // and said both: "Could not add" the one, "Mealio did not add" the other.
    // Same onion, chosen by the user thirty seconds earlier.
    if (reconcileIntendedRef.current.length > 0) {
      reconcileIntendedRef.current = applyPicks(reconcileIntendedRef.current);
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

  /**
   * Why one item did not make it into the cart, in the user's words.
   *
   * The gate used to carry one blanket sentence — "this may be because the item
   * is out of stock or the store no longer carries it" — for every item, which
   * was a guess covering two possibilities out of five. The network rail reports
   * a real per-item reason, so the screen can stop guessing.
   *
   * The distinction is not cosmetic. "Out of stock" and "no exact match" ask the
   * user for completely different things: the first is nothing they can fix by
   * choosing better, the second is exactly that.
   *
   * Returns null for a reason with no honest sentence, and the caller keeps the
   * general note for those rather than inventing one.
   */
  /**
   * Why this item did not make it into the cart, in the user's words.
   *
   * The run already knows — every add path records a reason on its result — but
   * the done screen was printing bare names ("Could not add: Sour Cream, Eggs"),
   * so a user was told two of ten failed and never told why. The reasons come
   * from whichever path ran: the page/worker results, or the network rail's.
   */
  const failureReasonFor = useCallback((name: string): string | null => {
    const want = String(name || '').toLowerCase();
    // The reconcile's results carry `name`, the rail's carry `productName` —
    // same fact, different key, so both are checked.
    for (const r of addResultsRef.current) {
      if (!r.success && String(r.name || '').toLowerCase() === want) return r.reason ?? null;
    }
    for (const r of netResultsRef.current.values()) {
      if (!r.success && String(r.productName || '').toLowerCase() === want) return r.reason ?? null;
    }
    return null;
  }, []);

  const unaddedReasonText = useCallback((reason: string | null | undefined, store: string): string | null => {
    switch (reason) {
      case 'out_of_stock':
        // The store HAS this product and will not sell it today. Choosing again
        // will not help, which is why it reads differently from a bad match.
        return `Out of stock at ${store}`;
      case 'no_results':
        return `${store} had no match for this`;
      case 'low_confidence':
        return 'No exact match — pick the right product';
      case 'needs_weight':
        return 'Sold by weight — choose an amount';
      case 'needs_preference':
        return 'Needs a choice, like thickness or ripeness';
      case 'quantity_limit_reached':
        return `Your cart is already at ${store}'s limit for this`;
      case 'search_unanswered':
        return 'We could not check this one';
      default:
        return null;
    }
  }, []);

  const titleMap: Record<Step, string> = {
    qty: isChooseRun ? 'Choose Products' : 'Add to Cart',
    login_check: 'Connecting…',
    login: `Log in to ${storeName}`,
    searching: currentReview?.isChoose ? 'Choosing Products…' : 'Finding Products…',
    searchResult: 'Items Not Added',
    // Three things land on this one step and only two of them are substitutions.
    // A `needs_weight` item is NOT a failed match — Mealio found the product
    // exactly and is asking for a poundage (the body says "Sold by weight —
    // choose how much to add"). Heading that "Pick a Substitute" tells the user
    // the match failed when nothing failed. The old name was vague enough to
    // cover both; a name that says what to DO cannot be, so it branches.
    review: currentReview?.isChoose
      ? `Choose Product (${reviewIdx + 1} of ${searchResults.length})`
      : currentReview?.reason === 'needs_weight'
        ? `Choose an Amount (${reviewIdx + 1} of ${searchResults.length})`
        : `Pick a Substitute (${reviewIdx + 1} of ${searchResults.length})`,
    adding: 'Adding to Cart…',
    done: 'Done!',
    manual: manualQueue.length > 0
      ? `Add It Yourself (${Math.min(manualIdx + 1, manualQueue.length)} of ${manualQueue.length})`
      : 'Add It Yourself',
    // One generic title for every "Mealio can't drive the store" state — the
    // banner tells the user what to do; the specific cause no longer matters.
    robot_challenge: `Action needed on ${storeName}`,
  };

  // ── Derived: live-browser layout ───────────────────────────────────────────

  // The tile grid showed the worker pools' WebViews side by side. There are no
  // workers now: one WebView, and the user may be driving it.

  // The browser region is on-screen for every automation phase now (no more
  // spinner). It's hidden — but the main WebView stays mounted — while the user
  // is in a panel step (qty is not mounted at all; review/searchResult/done keep
  // the WebView alive behind the panel for the cart snapshot).
  /**
   * HOLD THE SCREEN ON FOR THE WHOLE RUN.
   *
   * A cart run is the one time the user is watching and NOT touching: they tap
   * "Add ingredients", then watch an animation for a minute or more. The Pixel's
   * display timeout is 30 seconds. When the screen sleeps, Android suspends the
   * WebView's renderer -- and everything the rail does lives in that renderer.
   *
   * MEASURED 2026-09-02, from inside the injected script:
   *   worstTickMs: 59231     a 1-second interval that fired 59 SECONDS late
   *   sinceInjectMs: 100060  the script alive for 100s to do ~3s of work
   *   ms: 105968             a "request" that was really one 3s request
   *                          spanning a frozen document
   *   vis: 'visible'         the page had no idea it had been suspended
   * against, on the same store minutes earlier with the screen awake:
   *   search 288-758ms per term, cart read 529ms, session script 435ms.
   *
   * So the endpoints were never slow. The document was asleep. This is also why
   * the run looked like it stalled and then delivered everything at once.
   */
  useEffect(() => {
    if (!visible) return;
    let held = true;
    activateKeepAwakeAsync('mealio-cart-run').catch(() => { held = false; });
    return () => {
      if (!held) return;
      try { deactivateKeepAwake('mealio-cart-run'); } catch { /* already gone */ }
    };
  }, [visible]);

  const browserVisible =
    step === 'login_check' || step === 'login' || step === 'searching' ||
    step === 'adding' || step === 'robot_challenge' || step === 'manual';
  // THE MAIN WEBVIEW STAYS MOUNTED THROUGH THE QTY SCREEN ON A RAIL STORE.
  //
  // Two things need it, and the second one is worth more than the first.
  //
  // 1. The search prewarm has somewhere to run.
  //
  // 2. THE PAGE IS ALREADY LOADED WHEN THE RUN STARTS. It was not before, and
  //    that is the whole of the slow login. The WebView mounted when the run
  //    began, so the session probe was injected into a document that was still
  //    navigating; the injection died with it, and the run waited for the next
  //    onLoadEnd to ask again. Measured across 34 runs: 0.42s when the page was
  //    ready, 2.68s when it was not, and nothing in between — two clean groups,
  //    which is what "wait for the next page load" looks like rather than a slow
  //    network.
  //
  // Not gated on the prewarm being unfinished, deliberately. Unmounting the
  // moment it completes would send the page away again and put the run back to
  // loading it from scratch — which is the cost this is here to remove.
  const prewarmNeedsWebView = !!getNetworkRail(lockedStoreId);
  // Nothing tiles beside the main WebView any more.
  const gridMode = false;

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
    total = step === 'searching' ? activeItemsRef.current.length : addingItemsRef.current.length;
    idx = step === 'searching' ? searchIdxRef.current : addingIdxRef.current;
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
        {(step !== 'qty' || prewarmNeedsWebView) && (
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
          ) : step === 'manual' ? (
            <View style={styles.topBar} testID="manual-bar">
              <Text style={styles.loginBanner}>
                Find <Text style={{ fontFamily: 'Inter_600SemiBold' }}>{manualQueue[manualIdx] ?? ''}</Text> in the
                {' '}{storeName} page below and add it yourself, then tap Next.
              </Text>
              <View style={styles.manualBtnRow}>
                <TouchableOpacity
                  style={[styles.retryBtn, styles.manualBtn]}
                  onPress={() => advanceManual(true)}
                  testID="manual-skip"
                >
                  <Text style={styles.retryBtnText}>Skip</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.retryBtn, styles.manualBtn, { backgroundColor: storeColor, borderColor: storeColor }]}
                  onPress={() => advanceManual(false)}
                  testID="manual-next"
                >
                  <Text style={[styles.retryBtnText, { color: '#fff' }]}>
                    {manualIdx + 1 >= manualQueue.length ? 'Finish' : 'Next'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (step === 'searching' || step === 'adding' || step === 'login_check') && !netRunVisual ? (
            // On a network run the bag IS the status: it says what is happening
            // and how far along it is, and this bar said the same thing twice in
            // less detail. The pooled path has no animation, so it keeps it.
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
            {/* A network run loads no pages, so the WebView is a blank rectangle
                doing nothing — and showing it invites the user to touch a page
                the run does not need touched. It stays MOUNTED (the scripts run
                inside it) and is moved off-screen; the animation takes the
                space. Unmounting it would kill the run. */}
            {netRunVisual && (
              <CartRunAnimation
                progress={step === 'login_check' ? null : netPct}
                label={step === 'login_check' ? null : (netProgress?.label ?? null)}
                title={step === 'login_check' ? `Checking your ${storeName} account` : null}
                note={netNote}
              />
            )}
            <View
              style={netRunVisual ? styles.hiddenLayer : (gridMode ? styles.gridWrap : styles.fullWrap)}
              pointerEvents={netRunVisual ? 'none' : 'auto'}
            >
              {/* Main WebView cell — always the first child so it never remounts.
                  Fills the region normally; becomes one tile in grid mode. Not
                  mounted during qty (the region only renders then to keep the
                  parked pre-search tiles alive). */}
              {/* Main WebView cell — always the first child so it never remounts. */}
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

              {/* The worker tiles rendered the pools' WebViews. Both pools are gone. */}
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
                  {/* Items, not lines. Two of these ingredients had a quantity of
                      2, so "18 ingredients" undercounted what was about to go in
                      the cart by exactly the amount the user had asked for. */}
                  {meals.length} meal{meals.length !== 1 ? 's' : ''} · {(() => {
                    const n = items.reduce((sum, it) => sum + Math.max(0, Math.round(it.productQty || 0)), 0);
                    return `${n} item${n !== 1 ? 's' : ''}`;
                  })()}
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
                            {/* The preparation trails this meal's amount, not the
                                product name above it (MEAL-102) — the name on
                                this row is what we search the store for. */}
                            {mi.mealName} calls for {withPrep(measurement || `${mi.qty}`, mi.prep)}
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
          // Units, not rows (MEAL-178). The queue LENGTH still drives the button
          // below — how many screens the user is about to step through is a count
          // of ingredients, and inflating it by quantity would promise five
          // screens and show three.
          const unaddedUnits = unitsForNames(searchResults.map((r) => r.term), runIntendedRef.current);
          const autoAddedUnits = unitsForNames(autoAdded.map((p) => p.searchTerm), runIntendedRef.current);
          return (
            <>
              <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.listContent, { alignItems: 'center' }]}>
                <View style={{ marginBottom: 16 }}>
                  <Ionicons name="alert-circle" size={48} color="#f59e0b" />
                </View>
                <Text style={[styles.doneTitle, { marginBottom: 8 }]}>
                  {unaddedUnits} item{unaddedUnits !== 1 ? 's' : ''} could not be added to cart
                </Text>
                {/* Kept only for items whose reason has no honest sentence. Where
                    every item can say why, a blanket guess underneath them is
                    worse than nothing — it offers two explanations for problems
                    that are already named, and one of them will be wrong. */}
                {searchResults.some((r) => !unaddedReasonText(r.reason, storeName)) && (
                  <Text style={[styles.doneSub, { marginBottom: 20 }]}>
                    This may be because the item is out of stock or the store no longer carries it.
                  </Text>
                )}
                {autoAdded.length > 0 && (
                  <Text style={[styles.doneSub, { marginBottom: 20 }]}>
                    {autoAddedUnits} item{autoAddedUnits !== 1 ? 's' : ''} matched and will be added automatically.
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
                      {(() => {
                        const why = unaddedReasonText(r.reason, storeName);
                        return why ? (
                          <Text
                            testID={`unadded-reason-${i}`}
                            style={{ fontSize: 12.5, fontFamily: 'Inter_400Regular', color: Colors.text3, marginTop: 3 }}
                          >
                            {why}
                          </Text>
                        ) : null;
                      })()}
                    </View>
                  ))}
                </View>
              </ScrollView>
              <View style={styles.footer}>
                <TouchableOpacity
                  onPress={() => setStep('review')}
                  style={[styles.primaryBtn, { backgroundColor: storeColor }]}
                >
                  {/* MEAL-182 left this alone deliberately. It now shares no word
                      with the step it opens, which is a real gap — but the queue
                      behind it is mixed (substitutions AND sold-by-weight amount
                      choices, see the title branch above), so no single verb
                      covers it, and inventing a third one beside "substitute"
                      would be worse than the gap. Naming is Stephen's call;
                      raised on the ticket rather than guessed at here. */}
                  <Text style={styles.primaryBtnText}>
                    Review {searchResults.length} Ingredient{searchResults.length !== 1 ? 's' : ''} →
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
                          <Text key={mIdx} style={styles.searchedMeals}>{mi.mealName} • {withPrep(measurement, mi.prep)}</Text>
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
                      : `${storeName} suggests`}
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

                {/* Custom search option.
                    When the search found NOTHING this is the only control on the
                    screen that can move the run forward — and it is the one that
                    looks least like a control, being placeholder text under an
                    empty list. The glow points at it. */}
                <View>
                  {!hasCandidates && (
                    <Animated.View
                      pointerEvents="none"
                      testID="custom-row-glow"
                      style={[
                        styles.customGlow,
                        { borderColor: storeColor, shadowColor: storeColor, opacity: glowAnim },
                      ]}
                    />
                  )}
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
                </View>
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
                  const qtyRequired = qty === 0;
                  return (
                    <View key={mi.mealId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ fontSize: 14, fontFamily: 'Inter_500Medium', color: qtyRequired ? '#ef4444' : Colors.text2, flex: 1 }} numberOfLines={1}>
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
                {!isChoose && totalQty === 0 && typeof selectedSuggIdx === 'number' && (
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
          const unverified = unverifiedWeightLines;
          // Every "N item(s)" below is a UNIT count (MEAL-178). `totalAdded` and
          // `totalFailed` stay product counts — the north-star metric and the
          // telemetry rows are defined on them — so the units are derived here,
          // at the display boundary, from the names each count was built from.
          // Same fallback as failedUnits below: this branch renders only when
          // totalAdded > 0, and a headline reading "0 items added" would be a
          // worse lie than the product count it replaced.
          const addedUnits = addedNames.length > 0
            ? unitsForNames(addedNames, runIntendedRef.current)
            : totalAdded;
          // Only reachable with no names at all (every finalize path compiles
          // them), and with no names there is nothing to resolve quantities
          // against — the product count is then the most that is true.
          // What "Add it yourself" hands over (MEAL-197).
          //
          // Failed AND skipped, and the skipped half is the important one. On a
          // device run of a 12-ingredient meal, the two items H-E-B could not
          // match reached the mid-run "Items Not Added" gate, offered wrong
          // substitutes (tea bags, for fresh mint), and were skipped — so they
          // landed in `skippedNames`, `failedNames` came back EMPTY, and the
          // hand-over never appeared on the one run that needed it.
          //
          // "Skip this ingredient" on the Pick a Substitute screen does not mean
          // "I don't want this". An ingredient the user did not want was
          // unchecked on the qty screen and never entered the run at all;
          // reaching review means they asked for it and none of the offered
          // substitutes were it. That user still wants fresh mint.
          //
          // Offering is not adding — nothing enters the cart without their tap —
          // so the failure mode of including these is a button they ignore,
          // against a dead end for the failure mode of leaving them out.
          //
          // `failedNames` is used rather than the run's own failure list because
          // MEAL-199 corrects it against the cart read, so an item the cart
          // turned out to hold is already struck and never offered.
          const manualCandidates = [...failedNames, ...skippedNames]
            .filter((n, i, a) => a.indexOf(n) === i)
            // Minus everything a manual pass already walked the user past. Skip
            // AND Next: they have been given the storefront for this item once,
            // and offering it again asks the same question twice.
            .filter((n) => !manualHandled.includes(n));
          const manualAvailable = manualCandidates.length > 0 && !!getStoreScripts(lockedStoreId)?.getSearchUrl;
          const failedUnits = failedNames.length > 0
            ? unitsForNames(failedNames, runIntendedRef.current)
            : totalFailed;
          const skippedUnits = unitsForNames(skippedNames, runIntendedRef.current);
          // ONE banner for both cart-check outcomes, because the user's next move
          // is the same either way: go look at your cart. They are separate STATE
          // (see the declarations) because the run's telemetry outcome turns on
          // which one is set — a cart that was read and disagreed is not the same
          // fact as a cart that was never read — but that distinction is for the
          // fleet view, not for someone standing in a kitchen.
          //
          // The reading wins when both are somehow set: it says something specific
          // about the cart, and "we couldn't check" would be a strictly weaker
          // claim rendered over a stronger one.
          // ONE banner definition for the two done-screen branches (MEAL-174).
          // They drifted before precisely because the markup was written twice.
          //
          // `cartUnverified` has no list to fold — it is one sentence saying the
          // cart could not be read — so it renders as the plain banner it always
          // was. Only a cart that WAS read produces names, and only those get the
          // expandable treatment.
          const cartNotice: { title: string; detail: string } | null =
            cartDeltaWarning ?? (cartUnverified ? { title: cartUnverified, detail: '' } : null);
          const cartCheckBanner = !cartNotice ? null : cartNotice.detail ? (
            <ExpandableNotice
              testID="cart-check-warning"
              containerStyle={styles.cartCheckBanner}
              title={cartNotice.title}
              body={cartNotice.detail}
            />
          ) : (
            <View style={styles.cartCheckBanner} testID="cart-check-warning">
              <Ionicons name="alert-circle" size={18} color="#b45309" />
              <Text style={styles.cartCheckBannerText}>{cartNotice.title}</Text>
            </View>
          );
          return (
            <>
              {/* ONE scroll view over the whole result (MEAL-198).
                *
                * Everything above the breakdown — the title, the "could not add"
                * line, the cart-check banner, the skipped notice and the weight
                * notice — used to sit in a fixed-height View, with the breakdown
                * scrolling inside it. So the banners did not push the page down,
                * they SQUEEZED the breakdown toward zero height: on a run with
                * several warnings the user got a screen of warnings and a sliver
                * of the thing the warnings were about, which is precisely the run
                * where they most need to read it.
                *
                * Nesting two vertical scroll views is what produced that, so the
                * inner ones are plain Views now and this is the only scroller.
                * The footer stays OUTSIDE it — "Open cart" and "Done" are the way
                * off this screen and must not scroll away. */}
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }}>
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
                      {addedUnits} item{addedUnits !== 1 ? 's' : ''} added to your {storeName} cart!
                    </Text>
                    {/* Suppressed once the cart has spoken (MEAL-199): the banner
                        below is built from the same verdict and already names
                        these items, so printing both restates them in
                        consecutive sentences. Until then this is the only place
                        a failure is named, so it must stay. */}
                    {totalFailed > 0 && !verdictFromCart && (
                      failedNames.length > 0 ? (
                        // One line per item WITH its reason. A bare list of names
                        // tells a user two of ten failed and leaves them to guess
                        // whether the store was out of stock, could not match the
                        // product, or hit a purchase limit — which are three
                        // different things they would do three different things
                        // about.
                        <View style={{ marginTop: 2 }}>
                          {failedNames.map((n) => {
                            const why = unaddedReasonText(failureReasonFor(n), storeName);
                            return (
                              <Text key={n} style={[styles.doneSub, { color: '#b45309' }]} testID="done-failed-row">
                                {why ? `${n} — ${why}` : `${n} — could not be added`}
                              </Text>
                            );
                          })}
                        </View>
                      ) : (
                        <Text style={[styles.doneSub, { color: '#b45309' }]}>
                          {failedUnits} item{failedUnits !== 1 ? 's' : ''} could not be added.
                        </Text>
                      )
                    )}
                    {cartCheckBanner}
                  </>
                ) : (
                  <>
                    <View style={styles.doneIconWrap}>
                      <Ionicons name="information-circle-outline" size={56} color="#6b7280" />
                    </View>
                    <Text style={styles.doneTitle}>No items were added.</Text>
                    {/* Two different runs land here and they need different
                        words. If nothing was ever attempted (choose-a-product,
                        or every item skipped while picking substitutes) the
                        cart was never touched. If adds WERE attempted and all
                        came back failed,
                        "no products were selected" is simply false — and it is
                        exactly the run the cart check below probes, so it can
                        contradict the banner it sits above. */}
                    {/* "We couldn't confirm any adds" is the RUN's account of
                        itself, so it steps aside once the cart has given one
                        (MEAL-199) — the banner below says what the cart holds,
                        and the two together read as a hedge beside a fact.
                        The "nothing was selected" half is not a confirmation
                        claim at all and always stands. */}
                    {!(verdictFromCart && addsAttemptedRef.current > 0) && (
                      <Text style={styles.doneSub}>
                        {addsAttemptedRef.current > 0
                          ? "We couldn't confirm any adds."
                          : 'No products were selected or all were skipped.'}
                      </Text>
                    )}
                    {/* A run that added nothing still gets the cart check now
                        (MEAL-47), and it is the run most likely to have found
                        something: an add that committed while the store's badge
                        read stale comes back as a failure. Without this the
                        finding had nowhere to render — the banner only existed
                        on the added>0 branch — and the user would re-add an item
                        already in their cart. */}
                    {cartCheckBanner}
                  </>
                )}
              </View>

              {/* Ingredients the user chose to skip during review. Distinct from
                  the automation-failure count above — these were passed over on
                  purpose, so we surface them plainly rather than as a warning. */}
              {skippedNames.length > 0 && (
                // Tap to see ALL of them (MEAL-177). Collapsed it renders what it
                // always did — the count, and the names under a 3-line cap — so
                // nothing that used to be readable stopped being. What is new is
                // that the cap now LIFTS: before, a run that skipped a dozen
                // items showed three of them with no way to reach the rest, and
                // looked complete while doing it.
                //
                // Count and wording come from main, not from this branch: the
                // count is UNITS (MEAL-178) and the phrasing is MEAL-182's. Taking
                // this branch's title wholesale would have silently reverted both.
                <ExpandableNotice
                  testID="snapshot-skipped"
                  containerStyle={styles.skippedBanner}
                  title={`${skippedUnits} item${skippedUnits !== 1 ? 's' : ''} you skipped`}
                  body={skippedNames.join(', ')}
                />
              )}

              {/* MEAL-202: the store's per-item cap, already met by what the cart
                  holds. Its own banner rather than a line in "could not add",
                  because it is not a failure of the run and re-running changes
                  nothing — the user's cart simply already has as many as H-E-B
                  will sell them. Saying only "could not add" would send them to
                  add it by hand, which the store would refuse too. */}
              {capReached.length > 0 && (
                <View style={styles.skippedBanner} testID="snapshot-cap-reached">
                  <Text style={styles.skippedBannerTitle}>
                    {capReached.length} item{capReached.length !== 1 ? 's' : ''} already at {storeName}'s limit
                  </Text>
                  <Text style={styles.skippedBannerBody} numberOfLines={4}>
                    {capReached.map((c) => c.name).join(', ')}
                    {' — '}your cart already holds as many as {storeName} allows per order, so we
                    did not add more.
                  </Text>
                </View>
              )}

              {/* MEAL-119: count items whose cart line came back priced by weight.
                  Reported, and only reported. Not counted as added (Mealio added
                  nothing for them), not counted as failed (the store may well have
                  added them), and no decision is asked of the user — reconciling
                  the two is Mealio's job, and MEAL-148 is where it gets done by
                  comparing the expected weight against the line's real poundage.
                  Until then, saying we could not verify it is the most that is
                  true, and saying it is what keeps the under-add from being a
                  silent one. */}
              {unverified.length > 0 && (
                <View style={styles.skippedBanner} testID="snapshot-unverified-weight">
                  {/* Already a unit count under MEAL-178's definition and left
                      alone deliberately: each of these IS one sold-by-weight
                      line, and a weight line counts 1 by presence. */}
                  <Text style={styles.skippedBannerTitle}>
                    {unverified.length} item{unverified.length !== 1 ? 's' : ''} we could not verify
                  </Text>
                  <Text style={styles.skippedBannerBody} numberOfLines={4}>
                    {unverified.map((u) => `${u.term} (cart has "${u.cartName}")`).join(', ')}
                    {' — '}charged by weight, so we cannot tell whether the amount there covers your
                    meal. We did not add any more.
                  </Text>
                </View>
              )}

              {!cartResultRows && !cartRowsTimedOut && (buildCartPageCountScript(lockedStoreId) || buildInlineCartScript(lockedStoreId)) && (manualUsedRef.current ? cartCountBeforeRef.current != null : shouldProbeAfterRun({ addsAttempted: addsAttemptedRef.current, hasBaseline: cartCountBeforeRef.current != null })) ? (
                // Cart-page store (or inline side-panel store like ALDI) with a
                // baseline: the after-probe is reading the cart. Show a loading
                // state instead of the plain list so the breakdown doesn't flash
                // in. Same gate as the probe itself so the two can't disagree —
                // no baseline, or no add attempted, means no probe, so we skip
                // the spinner and fall through to the plain list below.
                <View style={{ minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                  <ActivityIndicator size="small" color={storeColor} />
                  <Text style={{ fontSize: 13, color: Colors.text3, fontFamily: 'Inter_400Regular' }}>
                    Updating your {storeName} cart…
                  </Text>
                </View>
              ) : cartResultRows ? (
                // Cart-page stores: full cart breakdown — added qty in green with
                // a +, pre-existing qty in grey. Qty shown on each row.
                <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 }}>
                    <Text style={{ fontSize: 13, fontFamily: 'Inter_600SemiBold', color: Colors.text2 }}>
                      Your {storeName} cart
                    </Text>
                    <Text style={{ fontSize: 13, fontFamily: 'Inter_600SemiBold', color: Colors.text2 }}>
                      {/* "19 items" next to "Your H-E-B cart" was read as "19 items
                          added". It is the whole cart. Say both numbers, so the
                          green rows and the total stop looking like the same
                          claim. */}
                      {(() => {
                        const total = cartResultRows.reduce((s, r) => s + r.qty, 0);
                        // diffCartItems emits added and pre-existing quantities as
                        // SEPARATE rows, so qty on an added row is the added amount.
                        const added = cartResultRows.reduce((s, r) => s + (r.added ? r.qty : 0), 0);
                        return added > 0 && added !== total
                          ? `${added} added · ${total} in cart`
                          : `${total} item${total !== 1 ? 's' : ''}`;
                      })()}
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
                </View>
              ) : addedNames.length > 0 ? (
                <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
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
                </View>
              ) : (
                null
              )}

              </ScrollView>

              <View style={[styles.footer, { gap: 8 }]}>
                {!wasChooseFlow && totalAdded > 0 && (
                  <TouchableOpacity
                    onPress={handleOpenCart}
                    style={[styles.primaryBtn, { backgroundColor: storeColor }]}
                  >
                    <Text style={styles.primaryBtnText}>Open {storeName} Cart to Checkout</Text>
                  </TouchableOpacity>
                )}
                {/* MEAL-9 rung 3 (MEAL-197): a failed add stops being a dead
                    end. The store is open, the session is live, and we know what
                    to search for — so the user can finish by hand rather than
                    abandon Mealio and shop with no list. */}
                {manualAvailable && (
                  <TouchableOpacity
                    onPress={() => startManualMode(manualCandidates)}
                    style={[styles.secondaryBtn, { borderColor: storeColor }]}
                    testID="manual-start"
                  >
                    <Text style={[styles.secondaryBtnText, { color: storeColor }]}>
                      Add {manualCandidates.length === 1 ? 'it' : `the ${manualCandidates.length} remaining items`} myself
                    </Text>
                  </TouchableOpacity>
                )}
                {/* MEAL-9 rung 4, the floor. Works with no store adapter, no
                    session and no network: the user still leaves with the list. */}
                {failedNames.length > 0 && (
                  <TouchableOpacity onPress={copyFailedList} style={styles.linkBtn} testID="manual-copy">
                    <Text style={[styles.linkBtnText, { color: storeColor }]}>
                      {copiedList ? 'Copied' : 'Copy the list instead'}
                    </Text>
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

  // DRAWN, for the same reason as hiddenLayer below: a full-size alpha-0 view is
  // one Android stops drawing, and a WebView it stops drawing is a renderer
  // Chromium throttles. This is the wrapper during qty -- which is exactly when
  // the search prewarm is working -- so hiding it that way cost the prewarm a
  // 28-second freeze and the run then WAITED on it.
  webviewHidden: { position: 'absolute', top: 0, left: 0, width: 2, height: 2, opacity: 0.01, pointerEvents: 'none' as const },
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
  // Hidden but FULL SIZE. It must keep its real dimensions: the after-run cart
  // probe navigates this WebView to the cart page and counts what rendered, and
  // that probe runs while the step is still 'adding' — i.e. while this is
  // hidden. A 1x1 box would leave the cart page with nothing to lay out and the
  // count would come back empty, which is precisely the done-screen breakdown
  // this is meant to preserve. Invisible and untouchable, not small.
  // KEPT DRAWN, NOT HIDDEN. This is the layer holding the WebView while the run
  // animation is on screen, and it used to be `opacity: 0, zIndex: -1` at full
  // size -- fully transparent AND pushed behind its own parent. Android then
  // stops drawing it, Chromium treats the page as hidden, and the renderer is
  // throttled to a standstill.
  //
  // MEASURED 2026-09-02 from inside the injected script, screen on, app in
  // front: a one-second setInterval fired 34 SECONDS late, while
  // document.visibilityState still read 'visible' -- Android WebView only
  // updates that on window visibility, never on being covered, which is why
  // this hid for so long. The requests themselves were 288-758ms throughout.
  //
  // So the layer stays DRAWN: two pixels in the corner at 1% opacity, under the
  // animation. Invisible to the user, alive to Chromium. The rail is on
  // robots.txt doing pure fetches, so it has no use for a viewport.
  hiddenLayer: {
    position: 'absolute', left: 0, top: 0, width: 2, height: 2,
    opacity: 0.01,
  },
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
  manualBtnRow: { flexDirection: 'row', gap: 8, alignSelf: 'stretch' },
  manualBtn: { flex: 1, alignItems: 'center' },
  linkBtn: { paddingVertical: 10, alignItems: 'center' },
  linkBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
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
  // Sits BEHIND the row and matches its box exactly, so the glow reads as the
  // row's own edge rather than a rectangle around it. Only `opacity` animates,
  // which keeps it on the native driver — animating a shadow or a border colour
  // would drop to the JS thread and stutter on the scroll this lives inside.
  customGlow: {
    position: 'absolute',
    top: -2, left: -2, right: -2,
    bottom: 4,          // the row carries marginBottom: 6
    borderRadius: 12,
    borderWidth: 2,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 8,
    elevation: 6,
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
