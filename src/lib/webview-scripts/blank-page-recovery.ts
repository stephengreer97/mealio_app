// Recovery for a login page that finished loading with nothing in it.
//
// WHAT BREAKS. Several stores answer the first request for their storefront with
// a streamed document and then, from their own JS, bounce through an OAuth
// session probe (Albertsons: www.albertsons.com -> ciam.albertsons.com/oauth2/
// .../authorize -> back) before the body has finished arriving. The redirect
// aborts the in-flight stream, and what the WebView is left holding is a
// document with a fully populated <head> and NO <body> element at all. It paints
// white. readyState is 'complete', onLoadEnd has fired, and every check script
// injected into it throws on the first document.body read, so nothing downstream
// reports a problem either — the user just sees a blank sheet where the store's
// sign-in should be. Observed on Albertsons on a Pixel 6, where it is the state
// the login step lands in on the FIRST surface; a plain reload renders the page
// in full, which is what this does.
//
// WHY IT IS SAFE TO RELOAD. The condition is not "looks empty" — it is a
// document whose body element is missing or holds zero element children. A page
// that rendered at all fails that test, so a working store page is never
// reloaded. The latch lives in sessionStorage rather than a window global
// precisely because a reload destroys the JS context: without it the reload
// would re-run this script, find the page broken again if the bounce repeats,
// and loop. One attempt per document, then we leave it alone and let the login
// step behave as it did before.
//
// Only wired into the login step, where a blank page is terminal for the user.
// Elsewhere a blank document is the automation's problem to report, not
// something to paper over with a reload.
export function buildBlankPageRecoveryScript(): string {
  return `
  (function () {
    try {
      var body = document.body;
      var empty = !body || body.children.length === 0;
      if (!empty) return;
      var LATCH = '__mealioBlankReload';
      var already = false;
      try { already = window.sessionStorage.getItem(LATCH) === '1'; } catch (e) {}
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'BLANK_PAGE',
        url: String(window.location.href).slice(0, 200),
        hasBody: !!body,
        retried: already,
      }));
      if (already) return;
      try { window.sessionStorage.setItem(LATCH, '1'); } catch (e) {}
      window.location.reload();
    } catch (e) {}
  })();
  true;
  `;
}
