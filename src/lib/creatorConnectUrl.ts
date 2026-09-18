// The redirect a platform connect round trip ends on (pure, no React Native).
//
// The server's OAuth callback, for a connect started with `client: 'app'`,
// redirects to `mealio://creator/connect` with the outcome in the query:
//
//   ?platform=<p>&code=<code>&state=<state>     consent given; exchange it
//   ?platform=<p>&outcome=cancelled             the creator said no on the platform's screen
//   ?platform=<p>&outcome=failed&reason=<code>  e.g. `expired`
//
// `WebBrowser.openAuthSessionAsync` hands that URL back to the caller that
// opened the session. It is never a deep link for the rest of the app to act
// on, which is what `isCreatorConnectRedirect` is for.

/** Where `openAuthSessionAsync` waits for the platform to send the creator back. */
export const CREATOR_CONNECT_REDIRECT = 'mealio://creator/connect';

/**
 * Is this URL the end of a connect round trip?
 *
 * By path, whatever the scheme: on Android the same redirect can arrive as an
 * app link (`https://mealio.co/creator/connect?...`) as well as on the custom
 * scheme, and neither is the root navigator's to handle.
 */
export function isCreatorConnectRedirect(url: string): boolean {
  return /^mealio:\/\/creator\/connect\/?(?:[?#]|$)/i.test(url)
    || /^https?:\/\/(?:www\.)?mealio\.co\/creator\/connect\/?(?:[?#]|$)/i.test(url);
}

/**
 * The query of a URL as a plain map, parsed by hand.
 *
 * React Native's `URL` / `URLSearchParams` are partial (several methods throw
 * "not implemented"), and Jest runs against Node's complete ones, so a parser
 * built on them passes every test here and fails on a device.
 */
export function parseQuery(url: string): Record<string, string> {
  const q = url.indexOf('?');
  if (q === -1) return {};
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash === -1 ? undefined : hash);
  const out: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      if (key in out) continue; // first one wins; a repeated key is not ours
      out[key] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      // A malformed escape is not a value we could have sent.
    }
  }
  return out;
}

export type ConnectRedirect =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string | null };

/** What a connect redirect says happened. Anything unreadable is a failure. */
export function readConnectRedirect(url: string): ConnectRedirect {
  const params = parseQuery(url);
  if (params.outcome === 'cancelled') return { kind: 'cancelled' };
  if (params.outcome === 'failed') return { kind: 'failed', reason: params.reason || null };
  if (params.code && params.state) return { kind: 'code', code: params.code, state: params.state };
  return { kind: 'failed', reason: params.reason || null };
}
