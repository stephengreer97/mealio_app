/**
 * THE SAME FOUR QUESTIONS, ASKED WITHOUT A CHROMIUM RENDERER.
 *
 * Stephen, 2026-09-11: "I want you to test login detection, cart read, search,
 * and add without a webview for every store."
 *
 * The rails already do all four with fetch(). The WebView was never providing
 * the requests, only the ORIGIN they went from: cookies, localStorage, and (for
 * Instacart's hash refresh) the page's own resource list. On Android, RN's fetch
 * shares the WebView's cookie jar -- proven on the device, H-E-B answered signed
 * in from native fetch in 166ms against a renderer that costs 8,499ms to build.
 *
 * So this is the same HTTP, from the other side of the bridge.
 *
 * WALMART IS DELIBERATELY ABSENT. Stephen, 2026-09-11: "Walmart is on pause for
 * now" -- its bot detection is why walmart.io is the intended path there, and a
 * native rail for it would be built on the assumption he has already ruled out.
 *
 * WHAT THIS IS NOT, yet. These are spike implementations for measuring, not a
 * replacement for the rails. They share no code with the injected scripts, so a
 * shape that drifts in one does not drift in the other -- which is exactly the
 * duplication _scoring.ts and _retry.ts exist to avoid, and is a debt to settle
 * before any of this ships. It is worth paying for now because the question
 * being answered is "does the store answer us at all", not "is this the right
 * abstraction".
 */

/** One store's answer to one question, in a shape the probe can render. */
export type NativeResult = {
  ok: boolean;
  /** HTTP status, or null when the request never got one. */
  status: number | null;
  ms: number;
  /** A short human line. Never a token, never a cookie value. */
  detail: string;
};

export type NativeSession = {
  loggedIn: boolean;
  /** Whatever the store needs to identify the shop: store number, shop id. */
  storeId?: string | null;
  shoppingContext?: string | null;
  /** Cart identity, where the store has one and the later calls need it. */
  cartId?: string | null;
};

export type NativeCandidate = {
  productId: string;
  skuId?: string | null;
  productName: string;
  price?: string | null;
  outOfStock?: boolean;
};

/**
 * A store, answered natively. Every method returns rather than throws: a probe
 * that dies on the first failure measures one store instead of four.
 */
export type NativeRail = {
  id: string;
  label: string;
  /** Origin whose cookies this rail needs, for the jar count the probe reports. */
  origin: string;
  session(ua: string): Promise<NativeResult & { session?: NativeSession }>;
  cartRead(ua: string, s: NativeSession): Promise<NativeResult & { count?: number | null; lines?: number | null }>;
  search(ua: string, s: NativeSession, term: string): Promise<NativeResult & { candidates?: NativeCandidate[] }>;
  /**
   * THE ONLY ONE THAT WRITES. Adds a single unit of one product.
   *
   * Kept behind its own call, and behind its own tap in the probe, because
   * everything else here is a question and this one is a change to a real cart
   * the user shops from. It reports what it added so it can be undone.
   */
  add(ua: string, s: NativeSession, c: NativeCandidate): Promise<NativeResult & { added?: boolean }>;
};

/** Shared JSON POST. Returns the parsed body and the status, never throwing. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; json: any; text: string }> {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: '*/*', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* the body is the answer either way */ }
  return { status: r.status, json, text };
}

/** Wraps a call so a throw becomes a result rather than ending the run. */
export async function timed<T extends object>(
  fn: () => Promise<T & { ok: boolean; status: number | null; detail: string }>,
): Promise<T & NativeResult> {
  const t0 = Date.now();
  try {
    const out = await fn();
    return { ...out, ms: Date.now() - t0 } as T & NativeResult;
  } catch (e) {
    return {
      ok: false, status: null, ms: Date.now() - t0,
      detail: `threw: ${String(e).slice(0, 140)}`,
    } as unknown as T & NativeResult;
  }
}
