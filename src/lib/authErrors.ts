/**
 * The api layer's error type, and the one question every auth caller has to
 * ask of it.
 *
 * A module of its own, not part of lib/api, because AuthContext depends on it
 * and a great many component suites replace lib/api wholesale with a partial
 * mock. A helper living there would be `undefined` in every one of them.
 */

export class ApiError extends Error {
  /**
   * `body` is the parsed JSON of the refusal, when there was one. Most callers
   * want only the sentence in `message`; a few routes answer a refusal with
   * something to act on as well (the creator sync route's 409 carries the run
   * already under way, the catalogue's 422 carries the reason it could not be
   * listed), and those callers read it here.
   */
  constructor(public status: number, message: string, public body?: any) {
    super(message);
  }
}

/**
 * Did the SERVER say this token is no good?
 *
 * Only a 401 or 403 is a verdict on the credentials. A dead network (fetch
 * rejects with a TypeError), our own 30s timeout (ApiError 408) and a 5xx are
 * all "nobody answered the question", and a caller that signs the user out on
 * one of those is signing them out for being in a lift.
 */
export function isAuthRejection(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

// ── Telling the app the session is gone ──────────────────────────────────────
//
// When a renew is REFUSED, lib/api clears the keychain. That alone left a
// zombie: AuthContext still held the user, the UI stayed signed in, every
// request went out with no token and 401'd, and nothing led back to the sign-in
// screen until the app was restarted. AuthContext registers here so the clear
// and the signed-out UI happen together.
let sessionExpiredHandler: (() => void) | null = null;

export function setSessionExpiredHandler(fn: (() => void) | null): void {
  sessionExpiredHandler = fn;
}

/** Called by lib/api after it has cleared a refused session. Never throws. */
export function notifySessionExpired(): void {
  try { sessionExpiredHandler?.(); } catch { /* never mask the 401 */ }
}
