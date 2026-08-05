// Generic parallel-search worker wrapper.
//
// The parallel pool (useParallelSearchPool) dispatches each ingredient to a
// hidden worker WebView that loads the store's search-results URL directly.
// Most stores already have an EXTRACT_PRODUCTS_SCRIPT that reads the current
// results page and posts { type: 'SEARCH_RESULT', candidates }. This wrapper
// reuses that script verbatim and only re-tags its output as a WORKER_RESULT
// carrying the worker's id — so we don't duplicate per-store extraction logic.
//
// Wegmans and the Instacart Storefront banners predate this and ship their own
// purpose-built worker scripts (buildWegmansWorkerScript /
// buildInstacartWorkerScript); those stay as is. New stores use this wrapper.

/**
 * Wraps a store's EXTRACT_PRODUCTS_SCRIPT so it runs as a pool worker.
 *
 * Behavior:
 *  - Overrides ReactNativeWebView.postMessage *before* the extract runs, so the
 *    SEARCH_RESULT it eventually posts is re-emitted as WORKER_RESULT with the
 *    baked-in workerId (and its candidates preserved).
 *  - Swallows the extract's debug/other messages so 5 concurrent workers don't
 *    flood the bridge.
 *  - Guards against double-posting if the page fires the injection twice.
 *
 * The worker WebView is pointed at the search-results URL (getSearchUrl), so
 * by the time the injected script runs the results page is already loading;
 * the extract script's own polling handles "results not painted yet".
 */
/**
 * Wraps a store's buildSearchAndAddScript so it runs as a parallel-ADD pool
 * worker. The worker WebView is pointed at getSearchUrl(term) + '#mealio=<json>'
 * (the per-item term/qty/preference ride in the hash, since the injected script
 * is fixed per worker). The add script reads the hash, finds the best match on
 * the loaded results page, adds it (confirming via the store's cart badge), and
 * posts SEARCH_AND_ADD_RESULT — which we re-tag as WORKER_RESULT carrying the
 * worker id, success, and matched product name.
 */
export function buildSearchAndAddWorker(workerId: number, addScript: string): string {
  return `var WORKER_ID = ${workerId};
(function() {
  if (window.__mealioAddWorkerWrapped) return;
  window.__mealioAddWorkerWrapped = true;
  var posted = false;
  var rn = window.ReactNativeWebView;
  if (!rn || !rn.postMessage) return;
  var orig = rn.postMessage.bind(rn);
  rn.postMessage = function(s) {
    try {
      var m = JSON.parse(s);
      if (m && (m.type === 'SEARCH_AND_ADD_RESULT' || m.type === 'ADD_RESULT')) {
        if (posted) return;
        posted = true;
        orig(JSON.stringify({
          type: 'WORKER_RESULT', workerId: WORKER_ID, isAdd: true,
          success: !!m.success, productName: m.productName || null,
          reason: m.reason || null, candidates: m.candidates || [],
          storeUnavailable: !!m.storeUnavailable
        }));
        return;
      }
      if (m && (m.type === 'WORKER_DEBUG' || m.type === 'EXTRACT_DEBUG')) {
        m.type = 'WORKER_DEBUG'; m.workerId = WORKER_ID; orig(JSON.stringify(m)); return;
      }
    } catch (e) {}
    // Swallow the add script's other diagnostics to keep the bridge quiet.
  };
})();
${addScript}`;
}

/**
 * Wraps a store's EXTRACT_PRODUCTS_SCRIPT for the PRE-SEARCH PARKING flow
 * (FEATURE_PRESEARCH_ADD). Unlike buildExtractWorker (which posts a single
 * WORKER_RESULT and is done) this installs a durable postMessage override that
 * re-tags TWO phases of the worker's life onto the bridge:
 *
 *   1. Park phase — the extract script posts SEARCH_RESULT once the results page
 *      has painted → re-emitted as WORKER_RESULT { phase: 'search', candidates }.
 *      The worker then just sits on the loaded page.
 *   2. Commit phase — later, the controller injects the store's
 *      buildAddToCartScript into the SAME open page; its ADD_RESULT /
 *      SEARCH_AND_ADD_RESULT is re-emitted as
 *      WORKER_RESULT { phase: 'add', success, productName }.
 *
 * Each phase can post exactly once (independent guards), so the search park
 * doesn't consume the add's slot and vice-versa.
 */
export function buildPresearchWorker(workerId: number, extractScript: string): string {
  return `var WORKER_ID = ${workerId};
(function() {
  if (window.__mealioPresearchWrapped) return;
  window.__mealioPresearchWrapped = true;
  var postedSearch = false, postedAdd = false;
  var rn = window.ReactNativeWebView;
  if (!rn || !rn.postMessage) return;
  var orig = rn.postMessage.bind(rn);
  rn.postMessage = function(s) {
    try {
      var m = JSON.parse(s);
      if (m && m.type === 'SEARCH_RESULT') {
        if (postedSearch) return;
        postedSearch = true;
        orig(JSON.stringify({ type: 'WORKER_RESULT', workerId: WORKER_ID, phase: 'search', candidates: m.candidates || [], storeUnavailable: !!m.storeUnavailable }));
        return;
      }
      if (m && (m.type === 'ADD_RESULT' || m.type === 'SEARCH_AND_ADD_RESULT')) {
        if (postedAdd) return;
        postedAdd = true;
        orig(JSON.stringify({ type: 'WORKER_RESULT', workerId: WORKER_ID, phase: 'add', success: !!m.success, productName: m.productName || null, reason: m.reason || null, candidates: m.candidates || [], storeUnavailable: !!m.storeUnavailable }));
        return;
      }
      if (m && (m.type === 'WORKER_DEBUG' || m.type === 'EXTRACT_DEBUG')) {
        m.type = 'WORKER_DEBUG'; m.workerId = WORKER_ID; orig(JSON.stringify(m)); return;
      }
    } catch (e) {}
    // Swallow other diagnostics to keep the bridge quiet under concurrency.
  };
})();
${extractScript}`;
}

export function buildExtractWorker(workerId: number, extractScript: string): string {
  return `var WORKER_ID = ${workerId};
(function() {
  if (window.__mealioWorkerWrapped) return;
  window.__mealioWorkerWrapped = true;
  var posted = false;
  var rn = window.ReactNativeWebView;
  if (!rn || !rn.postMessage) return;
  var orig = rn.postMessage.bind(rn);

  rn.postMessage = function(s) {
    try {
      var m = JSON.parse(s);
      if (m && m.type === 'SEARCH_RESULT') {
        if (posted) return;
        posted = true;
        orig(JSON.stringify({ type: 'WORKER_RESULT', workerId: WORKER_ID, candidates: m.candidates || [], storeUnavailable: !!m.storeUnavailable }));
        return;
      }
      // Forward the extractor's diagnostic messages (tagged with the worker
      // id) so cold-start behavior is visible in the RN logs during dev.
      if (m && (m.type === 'EXTRACT_DEBUG' || m.type === 'WORKER_DEBUG')) {
        m.type = 'WORKER_DEBUG';
        m.workerId = WORKER_ID;
        orig(JSON.stringify(m));
        return;
      }
    } catch (e) {}
    // Other messages (PRICE_DEBUG, PREF_DEBUG, …) — swallow to keep the bridge quiet.
  };
})();
${extractScript}`;
}
