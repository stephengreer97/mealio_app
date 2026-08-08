import { useEffect, useRef } from 'react';
import { useAuth } from './AuthContext';

/**
 * Run `onEnd` when the signed-in session ends — whether that is a sign-out, or
 * another account taking over without one.
 *
 * WHY THIS EXISTS (MEAL-146). Every privacy teardown in the app used to key on
 * `user` going null, because a sign-out was taken to be the only way a person
 * stops being the signed-in user. It is not. RootNavigator handles the email
 * verification deep link (`mealio://verified?token=…`) by calling
 * `loginWithToken` with no signed-in check, and registers that listener
 * app-wide — so on a shared phone, A is signed in, B taps the link in their own
 * email, and `user` goes A → B without ever passing through null. Nothing keyed
 * on null fires. A's console ring buffer (which deliberately retains product
 * names and cart contents, and which a bug report attaches), A's recorded cart
 * run, A's prewarm cache and A's queued ingredient saves all carry straight into
 * B's session, under B's token-verified userId.
 *
 * So the boundary reported here is "the account changed", of which "the account
 * became nobody" is one case. It generalises: any future path into an
 * authenticated session gets the same teardown without having to remember to ask
 * for it.
 *
 * WHAT THIS DOES NOT CLOSE, because the name invites the wrong assumption. This
 * closes the DIAGNOSTIC leak chain across the account boundary — the ring
 * buffer, the recorded cart run, the cart engine, the prewarm cache and the
 * ingredient-save queue. The account boundary itself is still open here:
 *
 *   • MEAL-154 — the previous account's CONTENT stays on screen. Nothing
 *     unmounts on a hand-over (MainTabs is rendered while `user` is truthy) and
 *     MyMealsScreen reloads only on focus, so B can be looking at A's saved
 *     meals. DiscoverScreen has the same shape. That is a bigger hole than this
 *     one: it is directly visible and needs no bug report to surface it.
 *
 * And one that WAS open and is now closed, kept here because it is the reason
 * this mechanism cannot be assumed to see every hand-over on its own:
 *
 *   • MEAL-155 — `loginWithToken` used to write the new token to SecureStore
 *     BEFORE validating it, and lib/api reads the token per request. A transient
 *     verify failure therefore left `user` as A in React state while every
 *     request authenticated as B, bypassing this mechanism entirely because
 *     `beginSession` never ran. Fixed by validating first: the token now reaches
 *     the keychain only after `auth.verify(token)` has answered, so the stored
 *     token and `user` cannot disagree. The general point stands — this hook
 *     only fires on what reaches `beginSession`, so any future path that can
 *     change who the app authenticates as must go through it.
 *
 * What this deliberately does NOT fire on:
 *
 *   • The same account being re-set — a token renewal, a `refreshUser`, any
 *     re-render that hands down a fresh User object. Keyed on `user.id`, never
 *     on object identity: clearing a live user's logs and cancelling their
 *     in-flight cart run because their profile object changed identity would be
 *     the same bug wearing different clothes.
 *   • A sign-in from signed-out (null → B), including the first of the process.
 *     Nothing ended. A signed-out launch's login diagnostics are exactly what a
 *     "it will not let me sign in" report needs to carry, and B's own session
 *     must not be torn down as it starts.
 *   • Mounting into an already-signed-in session. The first observation only
 *     records who is here — there is no earlier session this consumer could have
 *     inherited anything from.
 */
export function useSessionEnd(onEnd: () => void): void {
  const { user } = useAuth();

  // Held in a ref so the effect below can depend on the user id ALONE. Depending
  // on the callback would re-run the effect on every render that recreates it,
  // which would make the guard's correctness depend on each caller remembering
  // to memoise — not a property worth resting a privacy boundary on.
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  // `undefined` = not observed yet. Distinct from `null` = observed, and nobody
  // was signed in; mounting mid-session must not read as a transition.
  const seenIdRef = useRef<string | null | undefined>(undefined);
  const userId = user?.id ?? null;

  useEffect(() => {
    const previous = seenIdRef.current;
    // Recorded first and unconditionally: every early return below still has to
    // leave the next comparison looking at the right predecessor. Recording
    // after a bail-out is how an ordinary sign-out-then-sign-in would later read
    // as A → B and tear down the new session's own state.
    seenIdRef.current = userId;
    if (previous === undefined) return; // first observation
    if (previous === userId) return;    // same account, or still nobody
    if (previous === null) return;      // signed-out → signed-in
    onEndRef.current();
  }, [userId]);
}
