// WHAT "NO COOKIES FOR THIS ORIGIN" IS ALLOWED TO MEAN.
//
// Stephen, 2026-09-14: "I am having to log into ALDI every time I open Mealio."
//
// MEASURED on his iPhone across four app opens, 2026-09-16. Every store, every
// time, and always within 64ms of the app starting:
//
//   [native-login] https://www.heb.com  jar: 0 cookie(s)
//   [native-login] https://www.aldi.us  jar: 0 cookie(s)
//   heb     native login check: out (63ms) - no cookies for this origin
//   wegmans native login check: out (52ms) - no cookies for this origin
//   aldi    native login check: out (47ms) - no cookies for this origin
//
// Every one of those reads ran BEFORE any WKWebView had been built in the
// process, and iOS resolves that call through
// WKWebsiteDataStore.defaultDataStore.httpCookieStore (RNCookieManagerIOS.m:122)
// -- a store that is loaded lazily. The same check, run deep into a session on
// 2026-09-14 with WebViews already up, DID find cookies and answered
// `currentUser.guest: signed out`.
//
// So an empty WebKit store at cold start does not distinguish "this user has no
// session" from "this object is not readable yet", and the free negative was
// turning the second into a sign-in screen on every store.
//
// NSHTTPCookieStorage is the other store, it is not lazy, and the WebViews sync
// into it via sharedCookiesEnabled -- so the negative now needs both to agree.
// On Android the useWebKit flag is ignored and both calls answer identically
// (CookieManagerModule.java:130), which is why this costs nothing there.
jest.mock('../../src/lib/webview-user-agent', () => ({
  getStoreWebViewUA: () => 'test-agent',
  setAndroidChromeMajor: () => {},
}));

const get = jest.fn();
jest.mock('@react-native-cookies/cookies', () => ({
  __esModule: true,
  default: { get: (...a: unknown[]) => get(...a) },
}));

import { checkLogin } from '../../src/lib/native-login';

/**
 * Albertsons, because its capability says nativeLogin:false -- so the check
 * answers from the jar alone and returns 'needs-webview' without a single
 * request. A store that goes to the network would be testing the rail instead.
 */
const ask = () => checkLogin('albertsons');
const jar = (names: string[]) =>
  Object.fromEntries(names.map((n) => [n, { value: 'x' }]));

/** @param webkit what get(url,true) answers @param shared what get(url,false) does */
const jars = (webkit: string[], shared: string[]) => {
  get.mockReset();
  get.mockImplementation(async (_url: string, useWebKit: boolean) =>
    jar(useWebKit ? webkit : shared));
};

describe('the free negative', () => {
  it('still fires when BOTH stores are empty', () => {
    // The case it was written for, and the reason it is worth having: a user who
    // has never signed into this store is told so without building a renderer.
    jars([], []);
    return ask().then((v) => {
      expect(v.state).toBe('out');
      expect(v.how).toContain('no cookies for this origin');
    });
  });

  it('does NOT fire when only the WebKit store reads empty', () => {
    // Stephen's iPhone. The shared store has the cookies; the lazy one has not
    // woken up. Answering 'out' here is what put a sign-in screen in front of a
    // signed-in user on every store, every launch.
    jars([], ['__Host-instacart_sid', '_ga']);
    return ask().then((v) => expect(v.state).toBe('needs-webview'));
  });

  it('does NOT fire when only the shared store reads empty', () => {
    // The mirror, so this cannot be satisfied by reading one store and calling
    // it two.
    jars(['__Host-instacart_sid'], []);
    return ask().then((v) => expect(v.state).toBe('needs-webview'));
  });

  it('asks both stores rather than the same one twice', () => {
    jars([], []);
    return ask().then(() => {
      const flags = get.mock.calls.map((c: unknown[]) => c[1]);
      expect(flags).toContain(true);
      expect(flags).toContain(false);
    });
  });

  it('treats a store that throws as unreadable, never as empty', () => {
    // An unreadable jar is not an empty one -- walling a user because a native
    // module failed is the worst of both answers.
    get.mockReset();
    get.mockImplementation(async () => { throw new Error('native module gone'); });
    return ask().then((v) => expect(v.state).toBe('needs-webview'));
  });
});
