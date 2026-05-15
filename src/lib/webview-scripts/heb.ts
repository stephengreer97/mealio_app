// Injectable JavaScript strings for H-E-B WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.

export const HEB_URL = 'https://www.heb.com';
export const HEB_LOGIN_URL = 'https://www.heb.com/my-account/login';
export const HEB_CART_URL = 'https://www.heb.com/cart';

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

    // Poll for the profile button (up to 3s, usually < 1s).
    var profileBtn = null;
    for (var pi = 0; pi < 15; pi++) {
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
    // Logged in: stays on heb.com (account page/panel opens)
    // Not logged in: navigates to accounts.heb.com (kills this script;
    //   onLoadEnd fallback in WebViewCartSheet detects the login page)
    profileBtn.click();

    // Wait for a potential redirect. If not logged in, HEB navigates to
    // accounts.heb.com within ~1s which kills this script. If we're still
    // running after 2s, we were not redirected and are logged in.
    await wait(2000);

    // Still here — close any panel that opened and report logged in.
    document.body.click();
    await wait(200);
    window.__hebLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: true }));
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

  var CARD_SEL = '[data-component="product-card"], [data-qe-id="productCard"]';

  await wait(800);

  var TITLE_SEL = '[data-qe-id="productTitle"]';

  var cards = Array.from(document.querySelectorAll(CARD_SEL)).slice(0, 20);
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
  async function handleWeightDropdown(qty) {
    var targetLbs = qty * 0.25;
    var allSelects = Array.from(document.querySelectorAll('select'));
    for (var si = 0; si < allSelects.length; si++) {
      var sopts = Array.from(allSelects[si].options);
      if (!sopts.some(function(o) { return /\\blbs?\\b/i.test(o.textContent); })) continue;
      var sBest = null, sBestDiff = Infinity;
      for (var soi = 0; soi < sopts.length; soi++) {
        var sv = parseFloat(sopts[soi].textContent);
        if (!isNaN(sv)) { var sd = Math.abs(sv - targetLbs); if (sd < sBestDiff) { sBestDiff = sd; sBest = sopts[soi]; } }
      }
      if (sBest) {
        allSelects[si].value = sBest.value || sBest.textContent.trim();
        allSelects[si].dispatchEvent(new Event('change', { bubbles: true }));
        allSelects[si].dispatchEvent(new Event('input', { bubbles: true }));
        await wait(400);
        var confirmBtn = document.querySelector('button[data-qe-id="cartQuantityTrigger"]');
        if (confirmBtn) { confirmBtn.click(); await wait(400); }
        return true;
      }
    }
    var listbox = document.querySelector('[role="listbox"]');
    if (listbox) {
      var lbOpts = Array.from(listbox.querySelectorAll('[role="option"]'));
      if (lbOpts.some(function(o) { return /\\blbs?\\b/i.test(o.textContent); })) {
        var lbBest = null, lbBestDiff = Infinity;
        for (var lbi = 0; lbi < lbOpts.length; lbi++) {
          var lv = parseFloat(lbOpts[lbi].textContent);
          if (!isNaN(lv)) { var ld = Math.abs(lv - targetLbs); if (ld < lbBestDiff) { lbBestDiff = ld; lbBest = lbOpts[lbi]; } }
        }
        if (lbBest) { lbBest.click(); await wait(400); return true; }
      }
    }
    return false;
  }

  var CARD_SEL = '[data-component="product-card"], [data-qe-id="productCard"]';
  var TITLE_SEL = '[data-qe-id="productTitle"]';

  await wait(800);

  var cards = Array.from(document.querySelectorAll(CARD_SEL));
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
    addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    addBtn.click();
    await wait(600);

    // Check for weight dropdown (e.g. fresh fish/meat sold by lb)
    if (await handleWeightDropdown(QTY)) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: true }));
      return;
    }

    // For qty > 1: after first add, button may become an incrementer OR stay as ATC.
    for (var j = 1; j < QTY; j++) {
      var btn = targetCard.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
      if (!btn) btn = targetCard.querySelector('button[data-qe-id="addToCart"]');
      if (!btn) break;
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') break;
      btn.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(100);
      btn.click();
      if (j < QTY - 1) await wait(500);
    }
  } else {
    // hasPopup but no recorded preference — try clicking and check for weight dropdown
    addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    addBtn.click();
    await wait(700);
    if (await handleWeightDropdown(QTY)) {
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
  var CARD_SEL = '[data-component="product-card"], [data-qe-id="productCard"]';
  var TITLE_SEL = '[data-qe-id="productTitle"]';

  async function handleWeightDropdown(qty) {
    var targetLbs = qty * 0.25;
    var allSelects = Array.from(document.querySelectorAll('select'));
    for (var si = 0; si < allSelects.length; si++) {
      var sopts = Array.from(allSelects[si].options);
      if (!sopts.some(function(o) { return /\\blbs?\\b/i.test(o.textContent); })) continue;
      var sBest = null, sBestDiff = Infinity;
      for (var soi = 0; soi < sopts.length; soi++) {
        var sv = parseFloat(sopts[soi].textContent);
        if (!isNaN(sv)) { var sd = Math.abs(sv - targetLbs); if (sd < sBestDiff) { sBestDiff = sd; sBest = sopts[soi]; } }
      }
      if (sBest) {
        allSelects[si].value = sBest.value || sBest.textContent.trim();
        allSelects[si].dispatchEvent(new Event('change', { bubbles: true }));
        allSelects[si].dispatchEvent(new Event('input', { bubbles: true }));
        await wait(400);
        var confirmBtn = document.querySelector('button[data-qe-id="cartQuantityTrigger"]');
        if (confirmBtn) { confirmBtn.click(); await wait(400); }
        return true;
      }
    }
    var listbox = document.querySelector('[role="listbox"]');
    if (listbox) {
      var lbOpts = Array.from(listbox.querySelectorAll('[role="option"]'));
      if (lbOpts.some(function(o) { return /\\blbs?\\b/i.test(o.textContent); })) {
        var lbBest = null, lbBestDiff = Infinity;
        for (var lbi = 0; lbi < lbOpts.length; lbi++) {
          var lv = parseFloat(lbOpts[lbi].textContent);
          if (!isNaN(lv)) { var ld = Math.abs(lv - targetLbs); if (ld < lbBestDiff) { lbBestDiff = ld; lbBest = lbOpts[lbi]; } }
        }
        if (lbBest) { lbBest.click(); await wait(400); return true; }
      }
    }
    return false;
  }

  await wait(800);

  var CRITICAL = new Set(['organic','grass','fed','free','range','cage','large','small','jumbo',
    'medium','extra','spicy','mild','hot','sweet','whole','skim','nonfat','lowfat',
    'salted','unsalted','sodium','boneless','skinless','lean','ground']);
  function scoreMatch(a, b) {
    function n(s) { return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\\s+/g, ' ').trim(); }
    var na = n(a), nb = n(b);
    if (na === nb) return 100;
    var wa = na.split(' ').filter(Boolean), sb = new Set(nb.split(' ').filter(Boolean));
    for (var i = 0; i < wa.length; i++) { if (CRITICAL.has(wa[i]) && !sb.has(wa[i])) return 0; }
    var m = wa.filter(function(w) { return sb.has(w); }).length;
    var p = m / wa.length;
    if (p < 0.7) return 0;
    return Math.min(99, Math.round(p * 100));
  }

  var cards = Array.from(document.querySelectorAll(CARD_SEL)).slice(0, 20);
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
      if (await handleWeightDropdown(QTY)) {
        // Weight select handled — nothing more to do
      } else {
        // For qty > 1: after first add, button may become an incrementer OR stay as ATC.
        for (var j = 1; j < QTY; j++) {
          var incrBtn = bestCard.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
          if (!incrBtn) incrBtn = bestCard.querySelector('button[data-qe-id="addToCart"]');
          if (!incrBtn) break;
          if (incrBtn.disabled || incrBtn.getAttribute('aria-disabled') === 'true') break;
          incrBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
          await wait(100);
          incrBtn.click();
          if (j < QTY - 1) await wait(500);
        }
      }
    }

    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }));
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
