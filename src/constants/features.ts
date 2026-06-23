// Feature flags. Flip these to roll capabilities in or out without code surgery.

// Background add-to-cart: when true, the WebView cart engine is owned by the
// root-level CartJobProvider (so it survives screen navigation) instead of being
// mounted inline by the screen that started it. Phase 1 is behavior-identical to
// the old inline modal; later phases add the floating status bubble and
// background execution. Flip to false to fall back to the original inline path.
export const FEATURE_BACKGROUND_CART = true;

// Parallel add-to-cart: route the regular add flow (items that already have a
// search term) through the parallel worker pool — each worker searches AND adds
// one product concurrently — instead of adding sequentially. Only applies to
// stores with parallel search (getSearchUrl + buildWorkerScript, no
// forceSerialSearch → HEB, Walmart, Amazon, Albertsons); Wegmans and ALDI run
// serial regardless. Per-worker confirmation via the cart-count badge (> prev)
// is the correctness guard. Experiment flag, off by default while we pilot HEB.
export const FEATURE_PARALLEL_ADD = false;

// Concurrency cap for parallel add-to-cart. The sequential reconciliation pass
// re-adds anything the concurrent pass missed (false positives from the shared
// cart counter), so we can run wide for speed.
export const PARALLEL_ADD_WORKERS = 5;
