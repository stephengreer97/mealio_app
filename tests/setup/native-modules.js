// Native modules every component suite needs stubbed, in one place.
//
// WHY THIS EXISTS. Adding a CookieManager call inside WebViewCartSheet broke
// four suites at once with "Add RNCookieManagerIOS.h to your Xcode project" —
// a native module that cannot exist under jest. Patching each suite is how the
// fifth one gets missed, and the failure is a whole file that will not run
// rather than one assertion, so it reads as something much worse than it is.
//
// Only modules with no JS fallback belong here. Anything a suite might want to
// assert against stays mocked in the suite, where it is visible.

jest.mock('@react-native-cookies/cookies', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async () => ({})),
    set: jest.fn(async () => true),
    clearAll: jest.fn(async () => true),
    clearByName: jest.fn(async () => true),
  },
}));

// ── InteractionManager runs straight through ────────────────────────────────
//
// WebViewCartSheet mounts its store WebView in runAfterInteractions, so the qty
// screen paints and becomes touchable before Android starts building a Chromium
// renderer (Stephen, 2026-09-11: two seconds before the ingredients showed and
// the button could be tapped).
//
// This belongs here rather than in a suite, unlike everything above it, and for
// a different reason than "no JS fallback": runAfterInteractions waits for the
// FRAME LOOP to go idle, and under jest there is no frame loop at all. There is
// nothing for it to wait for, so every suite that renders the sheet would hang
// on a WebView that never arrives -- a dozen files, none of which are about
// timing. Running the callback straight through is what "no interactions in
// flight" means here.
//
// The DEFERRAL ITSELF is not tested through this stub, which would be circular.
// tests/components/webview-mounts-after-paint.test.tsx overrides it with one
// that never fires and proves the WebView is absent until the backstop timer.
jest.mock('react-native/Libraries/Interaction/InteractionManager', () => ({
  __esModule: true,
  default: {
    runAfterInteractions: (cb) => {
      if (typeof cb === 'function') cb();
      return { cancel: () => {} };
    },
    createInteractionHandle: () => 1,
    clearInteractionHandle: () => {},
  },
  runAfterInteractions: (cb) => {
    if (typeof cb === 'function') cb();
    return { cancel: () => {} };
  },
  createInteractionHandle: () => 1,
  clearInteractionHandle: () => {},
}));
