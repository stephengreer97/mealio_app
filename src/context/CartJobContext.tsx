import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BackHandler, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import WebViewCartSheet, {
  CartJobStatus,
  WebViewCartSheetProps,
} from '../components/WebViewCartSheet';
import CartStatusBubble from '../components/CartStatusBubble';
import { STORES } from '../constants/stores';
import { Colors } from '../constants/colors';
import { useAuth } from './AuthContext';
import { clearSessionLogs } from '../lib/logBuffer';
import { clearLastAutomationRun } from '../lib/lastAutomationRun';

// ─────────────────────────────────────────────────────────────────────────────
// CartJobProvider owns the single add-to-cart job for the whole app.
//
// The WebView cart engine (WebViewCartSheet) is mounted HERE, at the app root,
// so it survives navigation between screens. In layer mode the sheet can slide
// offscreen (collapsed) while its WebView keeps running, so the job runs in the
// background behind a floating status bubble:
//   • Start expanded. Login is handled UP FRONT in the foreground.
//   • Once work enters search/add, auto-collapse to the bubble.
//   • Steps that need the user (login, robot challenge) force the sheet open.
//   • Review-needed / done show a warning / check on the bubble; the user taps
//     to expand (we don't yank the sheet open under them).
// ─────────────────────────────────────────────────────────────────────────────

type CartJobParams = Pick<
  WebViewCartSheetProps,
  'meals' | 'storeId' | 'storeName' | 'onIngredientChosen'
> & {
  /** Called when the job sheet is dismissed, after the job is cleared. */
  onClose?: () => void;
};

interface CartJobContextValue {
  startJob: (params: CartJobParams) => void;
  closeJob: () => void;
  isActive: boolean;
}

const CartJobContext = createContext<CartJobContextValue | null>(null);

export function useCartJob(): CartJobContextValue {
  const ctx = useContext(CartJobContext);
  if (!ctx) {
    throw new Error('useCartJob must be used within a CartJobProvider');
  }
  return ctx;
}

export function CartJobProvider({ children }: { children: React.ReactNode }) {
  // Signing out has to END the run, not just wipe what it already wrote — see
  // the sign-out effect below. Safe to read here: App.tsx mounts this provider
  // inside AuthProvider (it has to be, since a job is only ever started from a
  // signed-in screen), so there is no ordering problem to solve.
  const { user } = useAuth();
  const [job, setJob] = useState<CartJobParams | null>(null);
  const [status, setStatus] = useState<CartJobStatus | null>(null);
  // Expanded = full sheet visible; collapsed = slid offscreen + bubble shown.
  const [expanded, setExpanded] = useState(true);
  // Bumped on every startJob so the sheet REMOUNTS fresh each run. Without this,
  // starting a second job while the first is still active (e.g. its done/snapshot
  // state was never dismissed) only swaps props on the same instance, so the old
  // step ('done' → cart snapshot) leaks into the new run.
  const [jobKey, setJobKey] = useState(0);
  const prevPhaseRef = useRef<string | null>(null);
  // One-time "keep the app open" notice, shown when the job first goes
  // background (in-app background can't survive the app being fully closed).
  const [showKeepOpen, setShowKeepOpen] = useState(false);
  const noticeShownRef = useRef(false);

  const jobRef = useRef<CartJobParams | null>(null);
  jobRef.current = job;

  const startJob = useCallback((params: CartJobParams) => {
    prevPhaseRef.current = null;
    noticeShownRef.current = false;
    setShowKeepOpen(false);
    setStatus(null);
    setExpanded(true);
    setJobKey((k) => k + 1);
    setJob(params);
  }, []);

  const closeJob = useCallback(() => {
    const onClose = jobRef.current?.onClose;
    setJob(null);
    setStatus(null);
    setExpanded(true);
    setShowKeepOpen(false);
    noticeShownRef.current = false;
    prevPhaseRef.current = null;
    onClose?.();
  }, []);

  // ── Sign-out ends the run ──────────────────────────────────────────────────
  //
  // AuthContext.logout clears the console ring buffer and the recorded cart run,
  // but clearing is not enough on its own: this provider sits ABOVE
  // NavigationContainer, so the navigator swapping to the auth stack does not
  // unmount it, and in layer mode the sheet is a plain root View (collapsed to
  // `pointerEvents: 'none'`) rather than a modal. So the WebView kept automating
  // straight through a sign-out — still logging product names, failed adds and
  // ingredient names into the buffer that logout had just emptied, enough lines
  // in one run to refill all 600. On a shared phone the next person could then
  // file a report carrying the previous person's cart, attached to their own
  // token-verified userId. It also left one account's store page sitting on top
  // of the next account's login screen.
  //
  // Ending the job fixes both: the sheet unmounts, the WebView goes with it, and
  // nothing is left running to write anything more.
  const endedBySignOutRef = useRef(false);
  useEffect(() => {
    if (user || !jobRef.current) return;
    endedBySignOutRef.current = true;
    closeJob();
  }, [user, closeJob]);

  // The teardown above is asynchronous — a render, then this provider's effect,
  // then the commit that unmounts the sheet — and logout's clears happen at the
  // START of it. A cart run emits a line every few hundred ms and a
  // logAutomationStart round trip is 100-500ms, so either can land inside that
  // window and survive a clear that has already run. Clearing again once `job`
  // is actually null closes it: React destroys the removed subtree's effects
  // before running the effects of the same commit, so by the time this fires the
  // sheet's unmount cleanup has already bumped its generation counter and no
  // in-flight start can write either.
  //
  // Guarded by the ref rather than by `!user`, because both are null at app
  // launch and a signed-out launch must keep its login diagnostics — those are
  // exactly what a "can't sign in" report needs to carry.
  useEffect(() => {
    if (job || !endedBySignOutRef.current) return;
    endedBySignOutRef.current = false;
    clearSessionLogs();
    clearLastAutomationRun();
  }, [job]);

  // Map status transitions to expand/collapse decisions.
  const handleStatus = useCallback((st: CartJobStatus) => {
    setStatus(st);
    prevPhaseRef.current = st.phase;
    // Steps that need the user must be in the foreground. Otherwise we leave the
    // sheet as-is — the live browser grid stays visible through automation. The
    // user chooses when to minimize to the bubble (see minimize()).
    if (st.kind === 'attention') {
      setExpanded(true);
    }
  }, []);

  // Minimize the sheet to the floating bubble. When the user does this mid-run
  // (search/add in flight), surface the one-time "keep the app open" notice,
  // since a backgrounded in-app job can't survive the app being fully closed.
  const minimize = useCallback(() => {
    setExpanded(false);
    const phase = prevPhaseRef.current;
    if ((phase === 'searching' || phase === 'adding') && !noticeShownRef.current) {
      noticeShownRef.current = true;
      setShowKeepOpen(true);
    }
  }, []);

  // Android hardware back: when the sheet is expanded over the app, collapse it
  // to the bubble rather than letting back escape the (modeless) overlay.
  useEffect(() => {
    if (!job || !expanded) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      minimize();
      return true;
    });
    return () => sub.remove();
  }, [job, expanded, minimize]);

  const value = useMemo<CartJobContextValue>(
    () => ({ startJob, closeJob, isActive: job !== null }),
    [startJob, closeJob, job],
  );

  const storeColor = job
    ? STORES.find((s) => s.id === job.storeId)?.color ?? Colors.brand
    : Colors.brand;

  return (
    <CartJobContext.Provider value={value}>
      {children}
      {job && (
        <WebViewCartSheet
          key={jobKey}
          visible
          presentation="layer"
          collapsed={!expanded}
          meals={job.meals}
          storeId={job.storeId}
          storeName={job.storeName}
          onClose={closeJob}
          onMinimize={minimize}
          onStatusChange={handleStatus}
          onIngredientChosen={job.onIngredientChosen}
        />
      )}
      {job && !expanded && status && (
        <CartStatusBubble
          status={status}
          storeColor={storeColor}
          onPress={() => setExpanded(true)}
        />
      )}

      <Modal
        visible={showKeepOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setShowKeepOpen(false)}
      >
        <View style={styles.noticeBackdrop}>
          <View style={styles.noticeCard}>
            <Text style={styles.noticeTitle}>Keep Mealio open</Text>
            <Text style={styles.noticeBody}>
              Mealio is adding your items in the background. Please stay in the app
              until the progress ring finishes — leaving will pause it.
            </Text>
            <TouchableOpacity
              style={[styles.noticeBtn, { backgroundColor: storeColor }]}
              onPress={() => setShowKeepOpen(false)}
            >
              <Text style={styles.noticeBtnText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </CartJobContext.Provider>
  );
}

const styles = StyleSheet.create({
  noticeBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  noticeCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 22,
    width: '100%',
    maxWidth: 340,
  },
  noticeTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 8 },
  noticeBody: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text2, lineHeight: 20, marginBottom: 18 },
  noticeBtn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  noticeBtnText: { color: '#fff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
});
