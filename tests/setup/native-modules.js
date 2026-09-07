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
