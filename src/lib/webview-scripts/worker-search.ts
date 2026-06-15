// Generic parallel-search worker wrapper.
//
// The parallel pool (useParallelSearchPool) dispatches each ingredient to a
// hidden worker WebView that loads the store's search-results URL directly.
// Most stores already have an EXTRACT_PRODUCTS_SCRIPT that reads the current
// results page and posts { type: 'SEARCH_RESULT', candidates }. This wrapper
// reuses that script verbatim and only re-tags its output as a WORKER_RESULT
// carrying the worker's id — so we don't duplicate per-store extraction logic.
//
// Wegmans and ALDI predate this and ship their own purpose-built worker
// scripts (buildWegmansWorkerScript / buildAldiWorkerScript); those stay as
// is. New stores use this wrapper.

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
export function buildExtractWorker(workerId: number, extractScript: string): string {
  return `var WORKER_ID = ${workerId};
(function() {
  if (window.__mealioWorkerWrapped) return;
  window.__mealioWorkerWrapped = true;
  var posted = false;
  var rn = window.ReactNativeWebView;
  if (!rn || !rn.postMessage) return;
  var orig = rn.postMessage.bind(rn);

  // Cold-start warmup: a freshly-mounted worker WebView loads the search URL
  // with no warm session/cache, so the store's extractor (e.g. HEB waits a
  // fixed 800ms then checks once) can read the page before products paint and
  // report 0. When the FIRST extract on a given search URL comes back empty,
  // reload once — the second load is warm (cookies set, shell cached) and
  // renders like the sequential single-WebView case. Keyed by URL so each
  // dispatched ingredient gets its own one-shot retry; the flag is cleared
  // when a result is finally forwarded.
  var RETRY_KEY = 'mealioWorkerRetry:' + location.pathname + location.search;
  var alreadyRetried = false;
  try { alreadyRetried = sessionStorage.getItem(RETRY_KEY) === '1'; } catch (e) {}

  rn.postMessage = function(s) {
    try {
      var m = JSON.parse(s);
      if (m && m.type === 'SEARCH_RESULT') {
        if (posted) return;
        var candidates = m.candidates || [];
        // Empty on the first attempt for a real search page → warm up + reload.
        if (candidates.length === 0 && !alreadyRetried && location.search) {
          posted = true;
          try { sessionStorage.setItem(RETRY_KEY, '1'); } catch (e) {}
          setTimeout(function() { try { location.reload(); } catch (e) {} }, 700);
          return;
        }
        posted = true;
        try { sessionStorage.removeItem(RETRY_KEY); } catch (e) {}
        orig(JSON.stringify({ type: 'WORKER_RESULT', workerId: WORKER_ID, candidates: candidates }));
        return;
      }
    } catch (e) {}
    // Non-SEARCH_RESULT (debug etc.) — swallow to keep the worker bridge quiet.
  };
})();
${extractScript}`;
}
