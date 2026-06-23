// Feature flags. Flip these to roll capabilities in or out without code surgery.

// Background add-to-cart: when true, the WebView cart engine is owned by the
// root-level CartJobProvider (so it survives screen navigation) instead of being
// mounted inline by the screen that started it. Phase 1 is behavior-identical to
// the old inline modal; later phases add the floating status bubble and
// background execution. Flip to false to fall back to the original inline path.
export const FEATURE_BACKGROUND_CART = true;
