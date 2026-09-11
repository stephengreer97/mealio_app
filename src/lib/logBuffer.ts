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

/**
 * Longest single captured line, applied BEFORE redaction.
 *
 * THE REDACTION IS THE COST, and it scales with the line. This capture runs in
 * the SHIPPED app -- it has to, because a bug report attaches getSessionLogs()
 * and gating it on __DEV__ would send every production report with no logs at
 * all -- so every console call pays five regex passes over whatever it was
 * handed.
 *
 * Measured 2026-09-11 against the real dev log: a typical 180-char line costs
 * 0.005ms, and the cart-breakdown lines, which are a whole cart serialised, are
 * 12.7 KB and cost 0.512ms EACH. That is a hundredfold difference for lines
 * nobody reads to the end, and one cart run writes hundreds of them.
 *
 * 2000 characters is past the end of every line worth reading and two thirds of
 * the way into none of them. Truncating first rather than after is the entire
 * point: a regex that never sees the other 10 KB never walks it.
 */
const MAX_LINE_CHARS = 2000;

const buffer: string[] = [];

// ── Redaction ────────────────────────────────────────────────────────────────

const REDACTIONS: Array<[RegExp, string]> = [
  // JWT / access tokens.
  //
  // NOT anchored on all three parts any more. The clip above cuts a line at
  // MAX_LINE_CHARS, and a token that straddles that boundary loses its
  // signature -- so a header.payload rule would stop matching and leave two
  // thirds of a token sitting in the buffer. Half a token is still half a token,
  // and anything that opens with the base64 of {"alg": is one: eyJ is not a
  // prefix ordinary log text produces.
  [/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g, '‹token›'],
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

/** Cut a line to MAX_LINE_CHARS, saying so, so a truncated line cannot be
 *  misread as the whole thing. */
function clip(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}… +${line.length - MAX_LINE_CHARS} chars`;
}

function push(line: string): void {
  // Clipped BEFORE redaction, never after: the regexes are the cost and they
  // scale with what they are given.
  buffer.push(redactLogLine(clip(line)));
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
}

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  // Clipped here too, so a 12 KB cart array does not travel through the join
  // and the redaction only to be cut at the end.
  try { return clip(JSON.stringify(a) ?? String(a)); } catch { return String(a); }
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
