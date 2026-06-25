// Injectable JavaScript strings for H-E-B WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.

export const HEB_URL = 'https://www.heb.com';
export const HEB_LOGIN_URL = 'https://www.heb.com/my-account/login';
export const HEB_CART_URL = 'https://www.heb.com/cart';

// ── Shared: find genuine search-result cards (skip carousels) ──────────────────
//
// HEB's search page layers several "product-card" components on top of the real
// results: a "<term>'s perfect pairings" entity carousel and a two-panel
// sponsored rail. Those use MiniProductCardBody — they carry
// data-component="product-card" but NOT data-qe-id="productCard". For a "Yogurt"
// search the pairings carousel led with "H-E-B Classic Granola", which the old
// selector ([data-component="product-card"], [data-qe-id="productCard"]) grabbed
// in DOM order as the first candidate.
//
// Genuine result tiles are the only ones with data-qe-id="productCard", and they
// live inside the search grid (#search_product_grid / [data-qe-id="productCardContainer"]).
// Select on that id, scoped to the grid, and fall back to the legacy combined
// selector only if the page exposes no productCard ids at all (older DOM variant).
const HEB_FIND_CARDS_FN = `
  function __hebFindCards() {
    var grid = document.querySelector('[data-qe-id="productCardContainer"]')
      || document.querySelector('#search_product_grid');
    var scope = grid || document;
    var real = Array.prototype.slice.call(scope.querySelectorAll('[data-qe-id="productCard"]'));
    if (real.length > 0) return real;
    return Array.prototype.slice.call(scope.querySelectorAll('[data-component="product-card"], [data-qe-id="productCard"]'));
  }
`;

// ── Shared: read only FRESH results (skip the previous search's stale cards) ────
//
// HEB is an SPA: an in-page search changes the URL to /search?q=<newterm> and
// fetches results asynchronously, leaving the PREVIOUS search's product cards
// mounted for a beat. A naive "cards.length > 0" poll grabs those stale cards
// immediately (e.g. a "Cilantro" search returning the prior "Hoisin Sauce" page).
//
// HEB echoes the searched query into <h1 id="searchGridHeader">, which only
// updates once the new results render. So gate card-reads on the header matching
// the term in the URL. Falls back to whatever is present after gateMs (so an
// unusual/missing header can't stall the flow) and stops entirely after maxMs.
// Depends on __hebFindCards (interpolate HEB_FIND_CARDS_FN first).
const HEB_WAIT_FRESH_FN = `
  function __hebExpectedTerm() {
    try {
      var m = /[?&]q=([^&]*)/.exec(window.location.search || '');
      return m ? decodeURIComponent(m[1].replace(/\\+/g, ' ')) : '';
    } catch (e) { return ''; }
  }
  function __hebNorm(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\\s+/g, ' ').trim();
  }
  function __hebHeaderFresh(expectedNorm) {
    if (!expectedNorm) return true; // no q param (e.g. a product page) — nothing to gate on
    var header = document.querySelector('#searchGridHeader');
    var ht = __hebNorm(header ? header.textContent : '');
    return !!ht && ht.indexOf(expectedNorm) !== -1;
  }
  async function __hebFreshCards(waitFn, maxMs, gateMs) {
    var expected = __hebNorm(__hebExpectedTerm());
    var cards = [];
    var waited = 0;
    while (waited < maxMs) {
      var fresh = waited >= gateMs || __hebHeaderFresh(expected);
      cards = __hebFindCards().slice(0, 20);
      if (fresh && cards.length > 0) break;
      await waitFn(200);
      waited += 200;
    }
    return { cards: cards, waitedMs: waited };
  }
`;

// ── Login check ───────────────────────────────────────────────────────────────

/**
 * Injected on HEB page load. Posts { type: 'LOGIN_STATUS', isLoggedIn: bool }.
 */
export const CHECK_LOGIN_SCRIPT = `(async function() {
  if (window.__hebLoginCheckActive) return;
  window.__hebLoginCheckActive = true;
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  try {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));

    // Poll for the profile button (up to ~10s on a slow network, usually < 1s).
    // The page itself may not have rendered yet on a bad connection, so we wait
    // for the button rather than giving up early and reporting logged-out.
    var profileBtn = null;
    for (var pi = 0; pi < 50; pi++) {
      profileBtn = document.querySelector('button[aria-label*="account" i]')
        || document.querySelector('button[aria-label*="profile" i]');
      if (profileBtn) break;
      await wait(200);
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG', step: 'profile_btn',
      found: !!profileBtn,
      ariaLabel: profileBtn ? profileBtn.getAttribute('aria-label') : null
    }));

    if (!profileBtn) {
      window.__hebLoginCheckActive = false;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false }));
      return;
    }

    // Click the profile icon. Two outcomes:
    // Logged in: stays on heb.com and opens an in-page account panel that
    //   contains a "Log out" control.
    // Not logged in: navigates to accounts.heb.com (kills this script;
    //   onLoadEnd fallback in WebViewCartSheet detects the login page).
    profileBtn.click();

    // Require POSITIVE proof of login: poll for the panel's "Log out" / "Sign
    // out" control to appear (up to ~3s). NEVER infer login from the absence of
    // a redirect — a slow network can stall the logged-out redirect past our
    // wait and make a signed-out session look signed-in. If the marker never
    // appears we report logged-out and the user is shown the login webview.
    // Collect visible text INCLUDING one level of shadow DOM — HEB's account
    // panel may render inside a web component whose text document.body.innerText
    // does not see (which would make a logged-in panel look logged-out).
    function deepText() {
      var out = document.body.innerText || '';
      var hosts = document.querySelectorAll('*');
      for (var hi = 0; hi < hosts.length; hi++) {
        var sr = hosts[hi].shadowRoot;
        if (sr) { try { out += ' ' + (sr.textContent || ''); } catch (e) {} }
      }
      return out;
    }
    var LOGGED_IN_RE = /log ?out|sign ?out/;
    var loggedIn = false;
    var lastText = '';
    for (var ci = 0; ci < 40; ci++) {           // up to ~8s for the panel to render
      await wait(200);
      lastText = deepText().toLowerCase();
      if (LOGGED_IN_RE.test(lastText)) { loggedIn = true; break; }
    }

    if (!loggedIn) {
      // Diagnostic: dump what the panel actually rendered so we can pick a
      // reliable logged-in marker when the default one misses.
      var shadowHosts = 0;
      var allEls = document.querySelectorAll('*');
      for (var si = 0; si < allEls.length; si++) { if (allEls[si].shadowRoot) shadowHosts++; }
      var panels = Array.prototype.slice.call(
        document.querySelectorAll('[role="dialog"], aside, [class*="drawer" i], [class*="panel" i], [class*="account" i]'), 0, 6
      ).map(function(d) {
        return { tag: d.tagName, cls: (d.getAttribute('class') || '').slice(0, 60), text: (d.innerText || '').trim().slice(0, 220) };
      });
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'LOGIN_DEBUG', step: 'panel_miss',
        shadowHosts: shadowHosts,
        textSample: lastText.slice(0, 1500),
        panels: panels
      }));
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'panel_check', loggedIn: loggedIn }));

    // Close any panel that opened, then report the proven state.
    document.body.click();
    await wait(200);
    window.__hebLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: loggedIn }));
  } catch(e) {
    window.__hebLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;

// ── Product extraction ────────────────────────────────────────────────────────

/**
 * Injected after navigating to a HEB search results page.
 * Extracts product candidates and reads preference options for applicable products.
 * Posts { type: 'SEARCH_RESULT', candidates: [...] }.
 */
export const EXTRACT_PRODUCTS_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // Suppress mobile keyboard throughout — any input that receives focus gets inputmode="none".
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);
${HEB_FIND_CARDS_FN}
${HEB_WAIT_FRESH_FN}
  // Poll for the product grid instead of a single 800ms check. A warm webview
  // (sequential flow) paints cards almost immediately, but a freshly-mounted
  // worker webview (parallel flow) needs several seconds on its first load to
  // bootstrap HEB's SPA before the grid renders — a one-shot 800ms wait read
  // an empty page and reported 0. Poll up to ~14s; return as soon as cards for
  // the SEARCHED TERM appear (header gate), so we never read the previous
  // search's stale cards and the warm case stays fast. Past gateMs (8s) we
  // accept whatever is present so an unusual header can't stall the flow.
  var __fresh = await __hebFreshCards(wait, 14000, 8000);
  var cards = __fresh.cards;
  var waitedMs = __fresh.waitedMs;
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'poll_done', url: window.location.href, cardCount: cards.length, waitedMs: waitedMs }));

  var TITLE_SEL = '[data-qe-id="productTitle"]';

  if (cards.length === 0) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: [] }));
    return;
  }

  var seen = new Set();
  var candidates = [];

  for (var ci = 0; ci < cards.length; ci++) {
    var card = cards[ci];
    var nameEl = card.querySelector(TITLE_SEL);
    var name = nameEl ? nameEl.textContent.trim() : null;
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var addBtn = card.querySelector('button[data-qe-id="addToCart"]');
    var btnText = addBtn ? addBtn.textContent.trim() : '';
    var outOfStock = /out of stock|notify me|unavailable/i.test(btnText);
    var hasPopup = addBtn ? addBtn.getAttribute('aria-haspopup') === 'true' : false;
    var hasAnyDropdown = addBtn ? (!!addBtn.getAttribute('aria-haspopup') && addBtn.getAttribute('aria-haspopup') !== 'false') : false;
    var isWeightItem = /H-E-B (Deli|Fish Market)/i.test(name) && (hasAnyDropdown || /, lb$/i.test(name));
    var imgEl = card.querySelector('img');
    var imageUrl = imgEl ? imgEl.src : null;
    var priceEl = card.querySelector('[data-qe-id="productPrice"]')
      || card.querySelector('[data-testid*="price" i]')
      || card.querySelector('[class*="ProductPrice" i]')
      || card.querySelector('[class*="product-price" i]');
    if (ci === 0) {
      var dbg = {
        cardHtml: card.innerHTML.slice(0, 800),
        priceElFound: !!priceEl,
        priceElHtml: priceEl ? priceEl.outerHTML.slice(0, 400) : null,
        addBtnFound: !!addBtn,
        ariaHasPopup: addBtn ? addBtn.getAttribute('aria-haspopup') : null,
        hasPopup: hasPopup,
        outOfStock: outOfStock,
        addBtnHtml: addBtn ? addBtn.outerHTML.slice(0, 400) : null,
      };
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PRICE_DEBUG', dbg: dbg }));
    }
    var price = null;
    if (priceEl) {
      var strikeEl = priceEl.querySelector('[data-testid="strike-through-price"]');
      if (strikeEl) {
        // Sale price: find the leaf span after the strikethrough that contains a $ amount.
        var saleSource = strikeEl.nextElementSibling || strikeEl.parentElement;
        if (saleSource) {
          var saleSpans = Array.from(saleSource.querySelectorAll('span'));
          var saleLeaf = saleSpans.find(function(s) { return /\\$\\d/.test(s.textContent) && !s.querySelector('span'); });
          price = saleLeaf ? saleLeaf.textContent.trim() : (saleSource.textContent.match(/\\$[\\d.]+/) || [])[0] || null;
        }
      } else {
        // Regular price: find the leaf span that starts with a $ amount (excludes unit "each", per-oz spans).
        var allSpans = Array.from(priceEl.querySelectorAll('span'));
        var leafPrice = allSpans.find(function(s) { return /^\\s*\\$\\d/.test(s.textContent) && !s.querySelector('span'); });
        if (leafPrice) {
          price = leafPrice.textContent.trim();
        } else {
          price = (priceEl.textContent.match(/\\$[\\d.]+/) || [])[0] || null;
        }
      }
    }
    if (price) {
      price = price.split('(')[0].trim();
      if (!price || !/\\d/.test(price)) price = null;
    }

    var preferences = null;
    if (hasPopup && !outOfStock && addBtn && candidates.length < 5) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PREF_DEBUG', step: 'clicking_add', name: name }));
        addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(100);
        addBtn.click();

        // Poll for a dialog that actually contains preference rows (ignores unrelated dialogs like video.js modals).
        var modal = null;
        var rows = [];
        for (var mi = 0; mi < 40; mi++) {
          // Check dedicated containers first
          var prefContainer = document.querySelector('[data-qe-id="preferencesRowContainer"]');
          if (!prefContainer) { var fs = document.querySelector('fieldset[aria-live="polite"]'); if (fs) prefContainer = fs.parentElement || fs; }
          if (prefContainer) {
            var prefRows = Array.from(prefContainer.querySelectorAll('[class*="preferenceContainer"]')).filter(function(r) { return r.tagName !== 'LABEL'; });
            if (prefRows.length > 0) { modal = prefContainer; rows = prefRows; break; }
          }
          // Search all dialogs for one containing preference rows
          var dialogs = Array.from(document.querySelectorAll('[role="dialog"],[role="presentation"]')).filter(function(d) { return d.getAttribute('aria-label') !== 'Search'; });
          for (var di = 0; di < dialogs.length; di++) {
            var dRows = Array.from(dialogs[di].querySelectorAll('[class*="preferenceContainer"]')).filter(function(r) { return r.tagName !== 'LABEL'; });
            if (dRows.length > 0) { modal = dialogs[di]; rows = dRows; break; }
          }
          if (modal) break;
          await wait(100);
        }

        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PREF_DEBUG', step: 'modal_found', found: !!modal, modalTag: modal ? (modal.getAttribute('data-qe-id') || modal.getAttribute('role') || modal.tagName) : null }));
        if (modal) {
          var opts = [];
          for (var ri = 0; ri < rows.length; ri++) {
            var row = rows[ri];
            var label = row.querySelector('label, [class*="preferenceName"]');
            var labelText = label ? label.textContent.trim() : null;
            if (labelText) opts.push({ text: labelText, value: labelText });
          }
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PREF_DEBUG', step: 'rows_found', rowCount: rows.length, opts: opts, modalHtml: rows.length === 0 ? modal.innerHTML.substring(0, 2000) : null }));
          if (opts.length > 0) preferences = opts;

          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
          var closeBtn = modal.querySelector('button[aria-label*="close" i]');
          if (closeBtn) closeBtn.click();
          await wait(400);
        }
      } catch(e) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PREF_DEBUG', step: 'error', err: String(e) }));
      }
    } else if (ci < 3) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PREF_DEBUG', step: 'skipped', name: name, hasPopup: hasPopup, outOfStock: outOfStock, candidatesLen: candidates.length }));
    }

    candidates.push({ productName: name, imageUrl: imageUrl, outOfStock: outOfStock, preferences: preferences, price: price, isWeightItem: isWeightItem });
    if (candidates.length >= 8) break;
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: candidates }));
})();true;`;

// ── Add to cart ───────────────────────────────────────────────────────────────

/**
 * Builds a script that adds a specific product to the HEB cart.
 * The script finds the product card by exact name, handles preferences, and clicks add N times.
 * Posts { type: 'ADD_RESULT', success: bool, reason?: string }.
 */
export function buildAddToCartScript(
  productName: string,
  preference: { text: string } | null,
  qty: number,
): string {
  const escapedName = JSON.stringify(productName);
  const escapedPref = preference ? JSON.stringify(preference) : 'null';

  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // Suppress mobile keyboard for the entire add-to-cart operation.
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.querySelectorAll('input, textarea').forEach(function(el) { el.setAttribute('inputmode', 'none'); });
  document.addEventListener('focusin', __noKbd, true);

  var TARGET_NAME = ${escapedName};
  var PREFERENCE = ${escapedPref};
  var QTY = ${qty};

  // Handles fresh fish/meat items where Add to Cart opens a weight picker.
  // 1 qty = 0.25 lbs. Tries native <select> then ARIA [role="listbox"].
  async function handleWeightDropdown(qty, scope) {
    var targetLbs = qty * 0.25;
    // Search ONLY the target product's own card, then a weight-picker modal that
    // our Add click opened — never page-wide. Otherwise a sibling product sold by
    // weight (e.g. a "..., lb" bulk item with its own inline dropdown sitting in
    // the same search results) gets a weight selected and added too.
    function pickIn(root) {
      var selects = Array.from(root.querySelectorAll('select'));
      for (var si = 0; si < selects.length; si++) {
        var sopts = Array.from(selects[si].options);
        if (!sopts.some(function(o) { return /\\blbs?\\b/i.test(o.textContent); })) continue;
        var sBest = null, sBestDiff = Infinity;
        for (var soi = 0; soi < sopts.length; soi++) {
          var sv = parseFloat(sopts[soi].textContent);
          if (!isNaN(sv)) { var sd = Math.abs(sv - targetLbs); if (sd < sBestDiff) { sBestDiff = sd; sBest = sopts[soi]; } }
        }
        if (sBest) {
          selects[si].value = sBest.value || sBest.textContent.trim();
          selects[si].dispatchEvent(new Event('change', { bubbles: true }));
          selects[si].dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
      var listbox = root.querySelector('[role="listbox"]');
      if (listbox) {
        var lbOpts = Array.from(listbox.querySelectorAll('[role="option"]'));
        if (lbOpts.some(function(o) { return /\\blbs?\\b/i.test(o.textContent); })) {
          var lbBest = null, lbBestDiff = Infinity;
          for (var lbi = 0; lbi < lbOpts.length; lbi++) {
            var lv = parseFloat(lbOpts[lbi].textContent);
            if (!isNaN(lv)) { var ld = Math.abs(lv - targetLbs); if (ld < lbBestDiff) { lbBestDiff = ld; lbBest = lbOpts[lbi]; } }
          }
          if (lbBest) { lbBest.click(); return true; }
        }
      }
      return false;
    }
    var handledRoot = null;
    if (scope && pickIn(scope)) handledRoot = scope;
    if (!handledRoot) {
      var dialog = document.querySelector('[role="dialog"]:not([aria-label="Search"]), [role="presentation"]:not([aria-label="Search"])');
      if (dialog && (!scope || !scope.contains(dialog)) && pickIn(dialog)) handledRoot = dialog;
    }
    if (!handledRoot) return false;
    await wait(400);
    var confirmBtn = handledRoot.querySelector('button[data-qe-id="cartQuantityTrigger"]') || document.querySelector('button[data-qe-id="cartQuantityTrigger"]');
    if (confirmBtn) { confirmBtn.click(); await wait(400); }
    return true;
  }

  var TITLE_SEL = '[data-qe-id="productTitle"]';
${HEB_FIND_CARDS_FN}
  await wait(800);

  var cards = __hebFindCards();
  var targetCard = null;
  for (var ci = 0; ci < cards.length; ci++) {
    var el = cards[ci].querySelector(TITLE_SEL);
    if (el && el.textContent.trim() === TARGET_NAME) {
      targetCard = cards[ci];
      break;
    }
  }

  if (!targetCard) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'not_found' }));
    return;
  }

  var addBtn = targetCard.querySelector('button[data-qe-id="addToCart"]');
  if (!addBtn) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_button' }));
    return;
  }

  var hasPopup = addBtn.getAttribute('aria-haspopup') === 'true';
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '1_btn', hasPopup: hasPopup, hasPref: !!PREFERENCE, qty: QTY, name: TARGET_NAME }));

  if (hasPopup && PREFERENCE) {
    addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    addBtn.click();
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '2_atc_clicked' }));

    var modal = null;
    for (var mi = 0; mi < 15; mi++) {
      modal = document.querySelector('[data-qe-id="preferencesRowContainer"]');
      if (!modal) {
        var fs = document.querySelector('fieldset[aria-live="polite"]');
        if (fs) modal = fs.parentElement || fs;
      }
      if (!modal) modal = document.querySelector('[role="dialog"]:not([aria-label="Search"]),[role="presentation"]:not([aria-label="Search"])');
      if (modal) break;
      await wait(150);
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '3_modal', found: !!modal }));

    if (!modal) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_modal' }));
      return;
    }

    // Poll for preference rows (modal shell may render before rows appear)
    var rows = [];
    for (var pri = 0; pri < 20; pri++) {
      rows = Array.from(modal.querySelectorAll('[class*="preferenceContainer"]')).filter(function(r) { return r.tagName !== 'LABEL'; });
      if (rows.length > 0) break;
      await wait(100);
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '4_rows', rowCount: rows.length }));

    // Find matching preference row (fall back to first row)
    var targetRow = null;
    for (var ri = 0; ri < rows.length; ri++) {
      var lbl = rows[ri].querySelector('label, [class*="preferenceName"]');
      if (lbl && lbl.textContent.trim() === PREFERENCE.text) { targetRow = rows[ri]; break; }
    }
    if (!targetRow && rows.length > 0) targetRow = rows[0];
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '5_targetRow', found: !!targetRow }));

    if (!targetRow) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_row' }));
      return;
    }

    var alreadyInCart = !!targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '6_alreadyInCart', alreadyInCart: alreadyInCart }));

    if (alreadyInCart) {
      // Already in cart — increment for all QTY units
      for (var j = 0; j < QTY; j++) {
        var incr = targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '7_incr_already', j: j, found: !!incr }));
        if (incr) { incr.scrollIntoView({ behavior: 'instant', block: 'center' }); await wait(100); incr.click(); await wait(300); }
      }
    } else {
      // Click the row's trigger button to add first unit
      var triggerBtn = targetRow.querySelector('button[data-qe-id="cartQuantityTrigger"], button[data-testid="preference-quantity-trigger"]');
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '7_trigger', found: !!triggerBtn, triggerHtml: triggerBtn ? triggerBtn.outerHTML.slice(0, 200) : null }));
      if (!triggerBtn) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_trigger' }));
        return;
      }
      triggerBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(100);
      triggerBtn.click();
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '8_trigger_clicked' }));

      // Poll for increment button — confirms HEB committed the add
      var addConfirmed = false;
      for (var ci = 0; ci < 20; ci++) {
        if (targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]')) { addConfirmed = true; break; }
        await wait(200);
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '9_add_confirmed', addConfirmed: addConfirmed }));

      // Click increment for remaining units
      for (var j = 1; j < QTY; j++) {
        var incr = targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '10_incr', j: j, found: !!incr }));
        if (incr) { incr.scrollIntoView({ behavior: 'instant', block: 'center' }); await wait(100); incr.click(); await wait(300); }
      }
    }

    // Dismiss modal
    await wait(300);
    document.body.click();
    await wait(300);
  } else if (!hasPopup) {
    // Deterministic commit confirmation: wait for the top-right header cart
    // badge to actually increment before reporting success. Its aria-label reads
    // "Go to Cart page. N items in your cart. $X". Holding here until the count
    // ticks up means (a) we only report success when the add really committed,
    // and (b) the RN side won't navigate (and race-cancel the add request)
    // before it lands. When the item is already in the cart, HEB reuses this
    // same addToCart button as the "add 1 more" incrementer.
    function cartCount() {
      var el = document.querySelector('[data-qe-id="headerCartButtonDesktop"], [data-testid="cart-link"]');
      var a = el ? (el.getAttribute('aria-label') || '') : '';
      var m = a.match(/(\\d+)\\s*items?/i);
      return m ? parseInt(m[1], 10) : -1;
    }
    async function waitForCartIncrease(prev, maxTicks) {
      if (prev < 0) { await wait(2500); return true; }   // badge unreadable → generous settle (slow networks)
      for (var w = 0; w < maxTicks; w++) {
        if (cartCount() > prev) return true;
        await wait(200);
      }
      return false;
    }

    var cartBefore = cartCount();
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '2_preclick', cartBefore: cartBefore, visible: addBtn.offsetParent !== null, disabled: addBtn.disabled || addBtn.getAttribute('aria-disabled') === 'true' }));

    addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    addBtn.click();
    await wait(400);

    // Weight dropdown (fresh fish/meat sold by lb) intercepts before any cart change.
    if (await handleWeightDropdown(QTY, targetCard)) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: true }));
      return;
    }

    var committed = await waitForCartIncrease(cartBefore, 50);   // up to ~10s (slow networks)
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '3_postclick', cartAfter: cartCount(), committed: committed }));
    if (!committed) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'cart_not_incremented' }));
      return;
    }

    // Remaining units: same button is the "add 1 more" incrementer; wait for each tick.
    for (var j = 1; j < QTY; j++) {
      var prev = cartCount();
      var btn = targetCard.querySelector('button[data-qe-id="addToCart"]');
      if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') break;
      btn.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(100);
      btn.click();
      await waitForCartIncrease(prev, 40);
    }
  } else {
    // hasPopup but no recorded preference — try clicking and check for weight dropdown
    addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    addBtn.click();
    await wait(700);
    if (await handleWeightDropdown(QTY, targetCard)) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: true }));
      return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'pref_required' }));
    return;
  }

  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: true }));
})();true;`;
}

/**
 * Injected on a HEB search results page for ingredients that already have a searchTerm.
 * Scores candidates against the searchTerm, finds the best in-stock match (no popup/preferences),
 * adds it to cart immediately, and posts SEARCH_AND_ADD_RESULT.
 * On failure, posts { success: false, reason, candidates } so the item can go to review.
 */
export function buildSearchAndAddScript(
  searchTerm: string,
  qty: number,
  dropdown: { type: string; selectedText: string; selectedValue: string } | null = null,
): string {
  const escapedTerm = JSON.stringify(searchTerm);
  const escapedDropdown = dropdown ? JSON.stringify(dropdown) : 'null';
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))
      e.target.setAttribute('inputmode', 'none');
  }
  document.addEventListener('focusin', __noKbd, true);

  var SEARCH_TERM = ${escapedTerm};
  var QTY = ${qty};
  var DROPDOWN = ${escapedDropdown};
  // Parallel-add worker mode: the pool injects ONE fixed script per worker, so
  // each item's term/qty/preference ride in the URL hash (#mealio=<json>). When
  // present, override the baked-in defaults. No hash → sequential flow, unchanged.
  try {
    if (location.hash && location.hash.indexOf('#mealio=') === 0) {
      var __mq = JSON.parse(decodeURIComponent(location.hash.slice(8)));
      if (__mq) {
        if (typeof __mq.term === 'string') SEARCH_TERM = __mq.term;
        if (typeof __mq.qty === 'number') QTY = __mq.qty;
        if (__mq.dropdown !== undefined) DROPDOWN = __mq.dropdown;
      }
    }
  } catch (e) {}
  // Cart-badge confirmation (mirrors buildAddToCartScript): gate success on the
  // header cart count actually rising, so each (parallel) worker only reports
  // success when its add truly committed. Unreadable badge → 2.5s settle.
  function __cartCount() {
    var el = document.querySelector('[data-qe-id="headerCartButtonDesktop"], [data-testid="cart-link"]');
    var a = el ? (el.getAttribute('aria-label') || '') : '';
    var m = a.match(/(\\d+)\\s*items?/i);
    return m ? parseInt(m[1], 10) : -1;
  }
  async function __waitForCartIncrease(prev, ticks) {
    if (prev < 0) { await wait(2500); return true; }
    for (var w = 0; w < ticks; w++) { if (__cartCount() > prev) return true; await wait(200); }
    return false;
  }
  var __cartBefore = -1;
  var TITLE_SEL = '[data-qe-id="productTitle"]';
${HEB_FIND_CARDS_FN}
${HEB_WAIT_FRESH_FN}

  async function handleWeightDropdown(qty, scope) {
    var targetLbs = qty * 0.25;
    // Search ONLY the target product's own card, then a weight-picker modal that
    // our Add click opened — never page-wide. Otherwise a sibling product sold by
    // weight (e.g. a "..., lb" bulk item with its own inline dropdown sitting in
    // the same search results) gets a weight selected and added too.
    function pickIn(root) {
      var selects = Array.from(root.querySelectorAll('select'));
      for (var si = 0; si < selects.length; si++) {
        var sopts = Array.from(selects[si].options);
        if (!sopts.some(function(o) { return /\\blbs?\\b/i.test(o.textContent); })) continue;
        var sBest = null, sBestDiff = Infinity;
        for (var soi = 0; soi < sopts.length; soi++) {
          var sv = parseFloat(sopts[soi].textContent);
          if (!isNaN(sv)) { var sd = Math.abs(sv - targetLbs); if (sd < sBestDiff) { sBestDiff = sd; sBest = sopts[soi]; } }
        }
        if (sBest) {
          selects[si].value = sBest.value || sBest.textContent.trim();
          selects[si].dispatchEvent(new Event('change', { bubbles: true }));
          selects[si].dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
      var listbox = root.querySelector('[role="listbox"]');
      if (listbox) {
        var lbOpts = Array.from(listbox.querySelectorAll('[role="option"]'));
        if (lbOpts.some(function(o) { return /\\blbs?\\b/i.test(o.textContent); })) {
          var lbBest = null, lbBestDiff = Infinity;
          for (var lbi = 0; lbi < lbOpts.length; lbi++) {
            var lv = parseFloat(lbOpts[lbi].textContent);
            if (!isNaN(lv)) { var ld = Math.abs(lv - targetLbs); if (ld < lbBestDiff) { lbBestDiff = ld; lbBest = lbOpts[lbi]; } }
          }
          if (lbBest) { lbBest.click(); return true; }
        }
      }
      return false;
    }
    var handledRoot = null;
    if (scope && pickIn(scope)) handledRoot = scope;
    if (!handledRoot) {
      var dialog = document.querySelector('[role="dialog"]:not([aria-label="Search"]), [role="presentation"]:not([aria-label="Search"])');
      if (dialog && (!scope || !scope.contains(dialog)) && pickIn(dialog)) handledRoot = dialog;
    }
    if (!handledRoot) return false;
    await wait(400);
    var confirmBtn = handledRoot.querySelector('button[data-qe-id="cartQuantityTrigger"]') || document.querySelector('button[data-qe-id="cartQuantityTrigger"]');
    if (confirmBtn) { confirmBtn.click(); await wait(400); }
    return true;
  }

  await wait(800);

  var CRITICAL = new Set(['organic','grass','fed','free','range','cage','large','small','jumbo',
    'medium','extra','spicy','mild','hot','sweet','whole','skim','nonfat','lowfat',
    'salted','unsalted','sodium','boneless','skinless','lean','ground']);
  // Dual normalization to handle stores that mangle ñ/é/etc. inconsistently
  // across renderings (Walmart strips ñ entirely on certain queries; others
  // may NFD-decompose). Score both ways and take the better.
  function normDiacritic(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\\s+/g, ' ').trim();
  }
  function normStrip(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
      .replace(/[^\\x00-\\x7f]/g, '').replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\\s+/g, ' ').trim();
  }
  function scoreOne(na, nb) {
    if (na === nb) return 100;
    var wa = na.split(' ').filter(Boolean), sb = new Set(nb.split(' ').filter(Boolean));
    for (var i = 0; i < wa.length; i++) { if (CRITICAL.has(wa[i]) && !sb.has(wa[i])) return 0; }
    var m = wa.filter(function(w) { return sb.has(w); }).length;
    var p = m / wa.length;
    if (p < 0.7) return 0;
    return Math.min(99, Math.round(p * 100));
  }
  function scoreMatch(a, b) {
    var s1 = scoreOne(normDiacritic(a), normDiacritic(b));
    var s2 = scoreOne(normStrip(a), normStrip(b));
    return Math.max(s1, s2);
  }

  // Wait for results matching the searched term before scoring — otherwise an
  // in-page SPA search reads the previous search's cards still on the page and
  // either mis-adds or falsely reports "couldn't match".
  var cards = (await __hebFreshCards(wait, 14000, 8000)).cards;
  var candidates = [];
  var seen = new Set();
  var bestCard = null, bestBtn = null, bestName = null;
  var bestHasPopup = false;

  for (var ci = 0; ci < cards.length; ci++) {
    var card = cards[ci];
    var nameEl = card.querySelector(TITLE_SEL);
    var name = nameEl ? nameEl.textContent.trim() : null;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    var addBtn = card.querySelector('button[data-qe-id="addToCart"]');
    var btnText = addBtn ? addBtn.textContent.trim() : '';
    var oos = /out of stock|notify me|unavailable/i.test(btnText);
    var hasPopup = addBtn ? (!!addBtn.getAttribute('aria-haspopup') && addBtn.getAttribute('aria-haspopup') !== 'false') : false;
    var isWt = /H-E-B (Deli|Fish Market)/i.test(name) && (hasPopup || /, lb$/i.test(name));
    var imgEl = card.querySelector('img');
    candidates.push({ productName: name, imageUrl: imgEl ? imgEl.src : null, outOfStock: oos, preferences: null, price: null, isWeightItem: isWt });
    // Accept hasPopup products when a saved dropdown preference is available
    if (!bestName && scoreMatch(SEARCH_TERM, name) === 100 && !oos && (!hasPopup || DROPDOWN)) {
      bestCard = card; bestBtn = addBtn; bestName = name; bestHasPopup = hasPopup;
    }
    if (candidates.length >= 8) break;
  }

  if (!bestName || !bestBtn) {
    var hasExactOos = candidates.some(function(c) { return scoreMatch(SEARCH_TERM, c.productName) === 100 && c.outOfStock; });
    var reason = candidates.length === 0 ? 'no_results' : hasExactOos ? 'out_of_stock' : 'low_confidence';
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: reason, candidates: candidates }));
    return;
  }

  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '0_best_found', bestName: bestName, bestHasPopup: bestHasPopup, hasDropdown: !!DROPDOWN, qty: QTY }));
  try {
    __cartBefore = __cartCount();
    bestBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    bestBtn.click();

    if (bestHasPopup && DROPDOWN) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '1_clicked_addBtn', bestName: bestName, dropdown: DROPDOWN }));
      // Open preference modal — fixed wait matches the extension
      await wait(500);
      var modal = null;
      modal = document.querySelector('[role="dialog"]:not([aria-label="Search"]),[role="presentation"]:not([aria-label="Search"])');
      if (!modal) modal = document.querySelector('[data-qe-id="preferencesRowContainer"]');
      if (!modal) { var pfs = document.querySelector('fieldset[aria-live="polite"]'); if (pfs) modal = pfs.parentElement || pfs; }
      if (!modal) {
        var allModals = document.querySelectorAll('[class*="Popover"], [class*="Modal"]');
        for (var moi = 0; moi < allModals.length; moi++) { if (allModals[moi].getAttribute('aria-label') !== 'Search') { modal = allModals[moi]; break; } }
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '2_modal_search', found: !!modal, modalSel: modal ? (modal.getAttribute('data-qe-id') || modal.getAttribute('role') || modal.tagName) : null }));
      if (!modal) {
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_modal', candidates: candidates }));
        return;
      }
      // Poll for preference rows to appear (up to 20×100ms = 2s, matching the extension)
      var rows = [];
      for (var pri = 0; pri < 20; pri++) {
        rows = Array.from(modal.querySelectorAll('[class*="preferenceContainer"]')).filter(function(r) { return r.tagName !== 'LABEL'; });
        if (rows.length > 0) break;
        await wait(100);
      }
      var rowLabels = rows.map(function(r) { var l = r.querySelector('label, [class*="preferenceName"]'); return l ? l.textContent.trim() : '(no label)'; });
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '3_preference_rows', rowCount: rows.length, rowLabels: rowLabels, lookingFor: DROPDOWN.selectedText }));
      var targetRow = null;
      for (var ri = 0; ri < rows.length; ri++) {
        var lbl = rows[ri].querySelector('label, [class*="preferenceName"]');
        var lt = lbl ? lbl.textContent.trim() : '';
        if (lt === DROPDOWN.selectedText || lt === DROPDOWN.selectedValue) { targetRow = rows[ri]; break; }
      }
      if (!targetRow && rows.length > 0) targetRow = rows[0];
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '4_target_row', found: !!targetRow, usedFallback: !targetRow }));
      if (!targetRow) {
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_modal', candidates: candidates }));
        return;
      }
      await wait(200);
      // If item is already in cart (increment button present), use it directly
      var alreadyInCart = !!targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
      var triggerBtn = alreadyInCart ? null : targetRow.querySelector('button[data-qe-id="cartQuantityTrigger"], button[data-testid="preference-quantity-trigger"]');
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '5_trigger_btn', alreadyInCart: alreadyInCart, found: !!(triggerBtn || alreadyInCart) }));
      if (!triggerBtn && !alreadyInCart) {
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_modal', candidates: candidates }));
        return;
      }
      if (alreadyInCart) {
        // Already in cart — click increment for each unit of QTY
        for (var j = 0; j < QTY; j++) {
          var incr2 = targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
          if (incr2) { incr2.scrollIntoView({ behavior: 'instant', block: 'center' }); await wait(100); incr2.click(); await wait(300); }
        }
      } else {
        triggerBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(100);
        triggerBtn.click();
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '6_trigger_clicked' }));
        // Poll for increment button — confirms HEB committed the add
        var addConfirmed = false;
        for (var ci2 = 0; ci2 < 20; ci2++) {
          if (targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]')) { addConfirmed = true; break; }
          await wait(200);
        }
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '6b_add_confirmed', addConfirmed: addConfirmed }));
        // For qty > 1, click increment for remaining quantities
        for (var j = 1; j < QTY; j++) {
          var incr = targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
          if (incr) { incr.scrollIntoView({ behavior: 'instant', block: 'center' }); await wait(100); incr.click(); await wait(300); }
        }
      }
      // Dismiss modal — click outside (document.body) to close without canceling the add.
      // Avoid clicking the modal's close button (it can cancel the add) or Escape (same risk).
      document.body.click();
      await wait(400);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '7_modal_dismissed' }));
    } else {
      // No preference modal — standard add (may include weight-select items like Fish Market by lb)
      await wait(600);
      if (await handleWeightDropdown(QTY, bestCard)) {
        // Weight select handled — nothing more to do
      } else if (QTY > 1) {
        // Multi-quantity: confirm each unit via the card button label, which reads
        // "N added" — the quantity for THIS product, unaffected by sibling workers
        // touching the shared header cart badge. Confirm the first unit, then click
        // "add 1 more" for each remaining unit, waiting for the label to tick up
        // each time (with one retry) so a dropped click is caught instead of
        // silently under-adding. (qty 1 needs none of this — the cart-increase gate
        // below confirms the single unit.)
        var __cardAddedQty = function() {
          var b = bestCard.querySelector('button[data-qe-id="addToCart"]');
          var m = (b ? (b.textContent || '') : '').match(/(\\d+)\\s*added/i);
          return m ? parseInt(m[1], 10) : 0;
        };
        var __waitAddedQty = async function(target, ticks) {
          for (var w = 0; w < ticks; w++) { if (__cardAddedQty() >= target) return true; await wait(200); }
          return false;
        };
        await __waitAddedQty(1, 15);   // let the first unit's label settle (~3s max)
        for (var j = 1; j < QTY; j++) {
          var prevQty = __cardAddedQty();
          if (prevQty >= QTY) break;
          var incrBtn = bestCard.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]')
                     || bestCard.querySelector('button[data-qe-id="addToCart"]');
          if (!incrBtn || incrBtn.disabled || incrBtn.getAttribute('aria-disabled') === 'true') break;
          incrBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
          await wait(100);
          incrBtn.click();
          if (!(await __waitAddedQty(prevQty + 1, 30))) { incrBtn.click(); await __waitAddedQty(prevQty + 1, 25); }
        }
      }
    }

    var __committed = await __waitForCartIncrease(__cartBefore, 50);
    // Parallel-worker mode: the badge can tick up from a SIBLING worker's add,
    // so __committed may pass while our OWN cart POST is still in flight. The
    // pool re-navigates this worker the instant we post the result, which would
    // cancel that request. Give it a beat to flush first. (The sequential flow
    // has the RN-side navigation buffer, so it skips this.)
    if (__committed && location.hash && location.hash.indexOf('#mealio=') === 0) await wait(450);
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify(__committed
      ? { type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }
      : { type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'cart_not_incremented', productName: bestName, candidates: candidates }));
  } catch(e) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: candidates }));
  }
})();true;`;
}

/**
 * Injected on the HEB homepage (or any HEB page).
 * Clicks the search icon if needed, types the term, and submits — navigating to search results.
 * The WebView will fire onNavigationStateChange once the /search URL loads.
 */
export function buildSearchScript(term: string): string {
  const escaped = JSON.stringify(term);
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  var term = ${escaped};

  // Suppress mobile keyboard — set inputmode="none" on any input that gets focused,
  // including inputs opened by HEB's own JS when the search dialog appears.
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.querySelectorAll('input, textarea').forEach(function(el) { el.setAttribute('inputmode', 'none'); });
  document.addEventListener('focusin', __noKbd, true);

  // If already on a search page, the search input is directly in the header — no icon click needed.
  var alreadyOnResults = window.location.href.includes('/search');

  if (!alreadyOnResults) {
    // Open the search dialog by clicking the search icon button.
    var openBtn = document.querySelector('button[aria-label="Open search"], button[aria-label*="search" i]:not([type="submit"])');
    if (openBtn) { openBtn.click(); await wait(400); }
  }

  // Find the search input — prefer dialog/modal input first, then fall back to page-level.
  var input = document.querySelector('dialog input[type="search"], [role="dialog"] input[type="search"], .modal input[type="search"], [class*="modal" i] input[type="search"]');
  if (!input) {
    input = document.querySelector('input[type="search"], input[placeholder*="Search"], input[placeholder*="search"], input[name="search"], input[name="q"]');
  }

  if (!input) { return; }

  // Set value programmatically via the native setter — no focus() call so the
  // mobile keyboard never appears.
  var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(50);
  setter.call(input, term);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(100);

  var submit = null;
  if (input.parentElement) submit = input.parentElement.querySelector('button[type="submit"]');
  if (!submit) {
    var container = input.closest('form') || input.closest('[role="search"]') || input.closest('div');
    if (container) submit = container.querySelector('button[type="submit"], button[aria-label*="Search" i]:not([aria-label*="Open"])');
  }
  if (submit) {
    submit.click();
  } else {
    var form = input.closest('form');
    if (form) {
      form.submit();
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }
  document.removeEventListener('focusin', __noKbd, true);
})();true;`;
}
