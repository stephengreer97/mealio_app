/**
 * The api layer's error type, and the one question every auth caller has to
 * ask of it.
 *
 * A module of its own, not part of lib/api, because AuthContext depends on it
 * and a great many component suites replace lib/api wholesale with a partial
 * mock. A helper living there would be `undefined` in every one of them.
 */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
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
