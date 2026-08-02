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
export const FEATURE_PARALLEL_ADD = true;  // LOCAL pilot — uncommitted

// Concurrency cap for parallel add-to-cart. The sequential reconciliation pass
// re-adds anything the concurrent pass missed (false positives from the shared
// cart counter). Kept low (was 5) to reduce the concurrent-request burst that
// aggressive WAFs score as automation; the dispatch is also staggered + jittered.
export const PARALLEL_ADD_WORKERS = 3;

// Pre-search parking: while the user is still on the ingredients (qty) screen —
// and the silent pre-warm says they're already logged in — spin the parallel
// workers up early and PARK each on its loaded search-results page WITHOUT
// adding. When the user taps add-to-cart we inject the add straight into the
// already-open page, so the search latency is paid before the tap. Deselecting
// an ingredient makes its worker abandon and pull the next queued one.
//
// This reshapes the WAF-tuned worker lifecycle (workers stay mounted across the
// search→add boundary) and MUST be validated on a real Android device before it
// ships. Default OFF: when off, add-to-cart runs the existing fused search+add
// path unchanged.
export const FEATURE_PRESEARCH_ADD = true;  // LOCAL device test (iPhone over Metro)

// Push opt-in prompt in the Creator Portal (MEAL-88). The plumbing — permission,
// token registration, rotation, tap routing — ships regardless; this flag only
// controls whether creators are ASKED unprompted.
//
// OFF until there is something to deliver. iOS grants exactly one system prompt
// per install, and asking before the creator draft queue (MEAL-89) can send
// anything spends it on a promise we don't keep yet: the creators who say no are
// unreachable for good. Notifications can still be turned on deliberately from
// Account → Notifications, which is what makes the whole path testable today.
// Flip to true in the same change that ships the first sender.
export const FEATURE_PUSH_PROMPT = false;

// Randomized human-like delay before each parked worker commits its add, so N
// adds don't fire in one machine-gun burst the instant the user taps. Base +
// up to one base of jitter (≈0.5s average).
export const ADD_COMMIT_JITTER_MS = 500;
