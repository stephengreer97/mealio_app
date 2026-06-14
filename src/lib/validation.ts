// Shared form-field validators.
//
// Extracted from the auth screens (Login / Signup / ForgotPassword), which
// each inlined the same email regex. Centralized so the rule is unit-testable
// and consistent — the Maestro signup flow can't reach the invalid-email
// branch (keyboard blocks the submit button), so this is its real coverage.

/**
 * Loose email check matching the auth screens' intent: non-empty local part,
 * an "@", a domain, and a dot-suffix. Deliberately permissive — server-side
 * verification is the real gate; this only catches obviously-malformed input.
 */
export function isValidEmail(email: string): boolean {
  return /\S+@\S+\.\S+/.test(email);
}
