// In-memory ring buffer of console output, for attaching to bug reports.
//
// PRIVACY (Option A — strip secrets + direct identifiers, keep diagnostic detail):
// redaction runs at CAPTURE time so nothing sensitive ever sits in the buffer.
// We strip:
//   • secrets — JWTs/access tokens, Bearer/Authorization, password/cookie values
//   • email addresses (a direct identifier; the user id is already in the report
//     metadata, and emails carry no debugging value)
// We KEEP product/ingredient names and cart contents — they're the most useful
// signal for debugging a failed cart-add — along with store, step, reason,
// counts, worker ids, HTTP errors, timings. The privacy policy discloses that
// cart contents may appear in diagnostic logs attached to a bug report.
//
// Nothing is written to disk and nothing leaves the device until the user
// explicitly files a bug report. The buffer is capped so it can't grow unbounded.

const MAX_LINES = 600;
const buffer: string[] = [];

// ── Redaction ────────────────────────────────────────────────────────────────

const REDACTIONS: Array<[RegExp, string]> = [
  // JWT / access tokens (header.payload.signature)
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '‹token›'],
  // Bearer tokens + Authorization headers
  [/\bBearer\s+\S+/gi, 'Bearer ‹secret›'],
  // Cookies are entirely sensitive and multi-pair (k=v; k=v) — mask to EOL.
  [/((?:set-)?cookie"?\s*[:=]\s*).*/gi, '$1‹secret›'],
  [/("?(?:authorization|password|passwd|pwd|token|secret|access[_-]?token|refresh[_-]?token)"?\s*[:=]\s*)("?)[^",\s}]+/gi, '$1$2‹secret›'],
  // Email addresses (direct identifier)
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '‹email›'],
];

/** Redact secrets + PII from a single log line. Exported for tests. */
export function redactLogLine(line: string): string {
  let out = line;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

// ── Buffer ───────────────────────────────────────────────────────────────────

function push(line: string): void {
  buffer.push(redactLogLine(line));
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
}

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try { return JSON.stringify(a); } catch { return String(a); }
}

let installed = false;

/** Patch console.* so all output is mirrored (redacted) into the ring buffer.
 *  Call once at app startup. Idempotent. The original console behaviour is
 *  preserved. */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;
  (['log', 'info', 'warn', 'error'] as const).forEach((level) => {
    const orig = (console as any)[level]?.bind(console) ?? (() => {});
    (console as any)[level] = (...args: unknown[]) => {
      try {
        const ts = new Date().toISOString().slice(11, 19);
        push(`${ts} ${level.toUpperCase()} ${args.map(fmtArg).join(' ')}`);
      } catch {
        // never let capture break logging
      }
      orig(...args);
    };
  });
}

/** Recent session logs (redacted), oldest→newest, joined by newlines. */
export function getSessionLogs(): string {
  return buffer.join('\n');
}

/** Clear the buffer (e.g. after a report is sent). */
export function clearSessionLogs(): void {
  buffer.length = 0;
}
