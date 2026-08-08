import React, { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { AppState } from 'react-native';
import { useAuth } from './AuthContext';
import { creatorDrafts } from '../lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// CreatorDraftsContext (MEAL-89)
//
// How many recipes are waiting on this creator, and nothing else.
//
// It exists as a context rather than as state inside the review screen because
// the number is needed by MainTabs — which renders the badge — while the screen
// that changes it is mounted several levels below. The two would otherwise have
// to be reconciled by refetching on a timer, which means a creator watching the
// queue empty while the badge above it still says 3.
//
// **A badge is all this does.** Nothing here navigates, alerts, or opens
// anything. A creator who launched the app to add a meal to their cart gets to
// do exactly that; the count is there when they look at the tab bar, and going
// to deal with it is their decision. That is the design the ticket settled on
// after the blocking version was ruled out.
//
// It is also independent of push: the count comes from a plain GET on launch
// and on foreground, so a creator who denied notifications — or is running a
// build without remote push at all — sees the same badge as everyone else.
// ─────────────────────────────────────────────────────────────────────────────

interface CreatorDraftsValue {
  /** Drafts waiting on this creator. 0 for anyone who is not one. */
  waiting: number;
  /** Re-reads the count. Cheap: a HEAD count server-side, no recipes. */
  refresh: () => Promise<void>;
  /**
   * Records a count the server just told us as part of a decision, so the badge
   * settles immediately instead of a round trip later. The review screen calls
   * this with the `waiting` that came back from its own POST.
   */
  setWaiting: (waiting: number) => void;
}

const CreatorDraftsContext = createContext<CreatorDraftsValue | null>(null);

/**
 * How long the app has to have been backgrounded before returning to it counts
 * as a new visit worth re-reading the count for.
 *
 * The poller produces drafts every fifteen minutes, so a foreground event is
 * only ever interesting if some real time passed. Without a floor, every
 * momentary interruption — the share sheet, a permission dialog, the WebView
 * cart run handing control back — costs a request, and the cart flow alone
 * bounces through active several times in a run.
 */
const REFRESH_AFTER_MS = 60 * 1000;

export function CreatorDraftsProvider({ children }: { children: ReactNode }) {
  const { user, isCreator } = useAuth();
  const [waiting, setWaiting] = useState(0);
  const lastReadAt = useRef(0);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const { waiting: count } = await creatorDrafts.count();
      lastReadAt.current = Date.now();
      setWaiting(count ?? 0);
    } catch {
      // Best effort, and deliberately silent. A creator opening the app to use
      // it has no interest in an error about a count, and the next foreground
      // retries. The one thing not done here is zeroing the badge: a failed
      // read is not evidence that the queue is empty.
    }
  }, [user?.id]);

  // On sign-in and on launch. Cleared rather than refreshed on sign-out, so a
  // shared phone does not show the previous account's count to the next one.
  //
  // Dropped on ANY change of account, not only on a sign-out (MEAL-154). This
  // provider sits above the navigator, so the account key that remounts the tab
  // tree does not reach it, and a hand-over through the verification deep link
  // takes `user` from A straight to B without passing through null. Refreshing
  // alone would leave A's number on B's tab bar for the round trip the count
  // takes — and `isCreator` is not cover for that: it is reset for B at the same
  // moment, so whichever of the two requests answers first decides, and B being
  // a creator too makes A's count visible. This effect runs on the ID, so a
  // token renewal or a `refreshUser` does not flicker a live creator's badge.
  useEffect(() => {
    setWaiting(0);
    lastReadAt.current = 0;
    if (!user) return;
    void refresh();
  }, [user?.id, refresh]);

  // Re-read when a creator comes back to the app. This does not need to be
  // realtime — a poller that produces drafts every fifteen minutes does not
  // justify a socket — and a foreground is the moment the number is about to be
  // looked at.
  useEffect(() => {
    if (!user) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (Date.now() - lastReadAt.current < REFRESH_AFTER_MS) return;
      void refresh();
    });
    return () => sub.remove();
  }, [user?.id, refresh]);

  // Not gated on `isCreator` for the fetch — the endpoint answers 0 for anyone
  // who is not a creator, so asking early costs one cheap request and avoids a
  // badge that pops in a beat after the tab it sits on. It IS gated here,
  // because there is no Creator tab to badge otherwise and a stale count from a
  // revoked creator row should not linger on some other tab.
  const value: CreatorDraftsValue = {
    waiting: isCreator ? waiting : 0,
    refresh,
    setWaiting: (next: number) => { lastReadAt.current = Date.now(); setWaiting(next); },
  };

  return <CreatorDraftsContext.Provider value={value}>{children}</CreatorDraftsContext.Provider>;
}

/**
 * Returns a zeroed, inert value outside the provider rather than throwing.
 *
 * A badge is not worth crashing a screen over, and this is consumed by MainTabs
 * — which several tests render on its own.
 */
export function useCreatorDrafts(): CreatorDraftsValue {
  return useContext(CreatorDraftsContext) ?? {
    waiting: 0,
    refresh: async () => {},
    setWaiting: () => {},
  };
}
