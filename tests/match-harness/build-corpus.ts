// Corpus builder for the product-matching evaluation harness (MEAL-27).
//
// Reads the committed search-results fixtures, pulls out (a) the query the
// store was actually asked and (b) every product tile the store actually
// returned, and writes tests/match-harness/corpus.json.
//
//   npm run match-harness:build
//
// You only need to re-run this after re-capturing fixtures. The scorer reads
// the committed corpus.json, so `npm run match-harness` needs no browser.
//
// ── Why the query comes out of the page, not the capture config ──────────────
// fixture-capture-config.ts records the URL we ASKED the capture tool to visit,
// but several fixtures were captured off-script: walmart's
// search-results-out-of-stock.html is configured as `q=seasonal` yet the saved
// page is a search for "Butterball Gluten-Free Oven Roasted Turkey Breast,
// Deli-Sliced", and heb's is a search for "HEB season chicken thighs for
// fajitas". Labelling those pages against "seasonal" would have scored the
// matcher against a question it was never asked. So the query is read out of
// the saved DOM (the search input's value / the "Results for X" heading), which
// is what the store itself echoed back. Wegmans is the one storefront that
// renders neither, so its three queries come from the capture config — see
// QUERY_OVERRIDES.
//
// ── Why products are extracted here rather than by injecting the store scripts
// The real extractProducts scripts stop at 8 candidates and poll for an SPA
// that will never bootstrap in a static fixture. The harness wants every tile
// on the page, so it re-uses each store's *selectors* (kept in sync with
// SEL_FALLBACKS in the store script, see PRODUCT_EXTRACTORS) without the
// candidate cap or the timing machinery.

import { chromium } from 'playwright';
import { FIXTURE_LAUNCH_OPTIONS, installResourceBlocking } from '../fixture-runners/runScript';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures');
const OUT_FILE = path.resolve(__dirname, 'corpus.json');

/** Stores whose fixtures carry usable search-result pages. */
const STORES = ['heb', 'walmart', 'albertsons', 'aldi', 'amazon-fresh', 'wegmans'] as const;

/**
 * Fixtures that look like search results but carry no usable ingredient→result
 * pair. Excluded deliberately, with the reason, so nobody "fixes" this later by
 * quietly labelling fabricated data.
 */
const EXCLUDED: Record<string, string> = {
  'heb/search-results-stale-hoisin.html':
    'Deliberately stale capture: the page title is a "cilantro" search but the ' +
    'single tile is Lee Kum Kee Hoisin Sauce left over from the previous query. ' +
    'The query→result link is broken by design (it exists to test staleness ' +
    'detection), so it is not a labellable retrieval.',
  'walmart/search-results-with-variants.html':
    'A product detail page, not a search page — its 23 tiles are "similar items" ' +
    'carousels with no query behind them.',
  'amazon-fresh/search-results-qty-error.html':
    'Hand-trimmed 2KB fragment holding a "Quantity not updated" error string, no products.',
  'albertsons/search-results-collapsed-bubble.html':
    'Hand-trimmed 1KB fragment of a single qty bubble, no product tiles.',
  'wegmans/_synthetic-tile.html':
    'Synthetic tile authored for a selector test — not a real store response.',
};

/**
 * Wegmans renders no search box value and no results heading, so its query has
 * to come from the URL the capture tool was pointed at (fixture-capture-config.ts).
 * Kept as a literal table rather than importing that module so a config edit
 * can't silently relabel an already-captured page.
 */
const QUERY_OVERRIDES: Record<string, string> = {
  'wegmans/search-results-tortillas.html': 'la banderita burrito grande flour tortillas, extra large',
  'wegmans/search-results-sour-cream.html': 'wegmans sour cream',
  'wegmans/search-results-product-in-cart.html': 'wegmans sour cream',
  'wegmans/search-results-stepper-open.html': 'wegmans sour cream',
  'wegmans/search-results-out-of-stock.html': 'seasonal',
};

/**
 * Reads the query the store echoed back. Ordered most-specific first; the
 * "Results for X" headings are the most trustworthy because the store rendered
 * them from the query it actually served.
 */
const QUERY_FROM_PAGE = `(function () {
  function txt(el) { return el ? (el.textContent || '').trim() : ''; }
  // "Showing 770 results for "sour cream"" / "Results for "sour cream"(33)"
  var heads = Array.prototype.slice.call(document.querySelectorAll('h1,h2'));
  for (var i = 0; i < heads.length; i++) {
    var m = txt(heads[i]).match(/results? for\\s+["\\u201c]([^"\\u201d]+)["\\u201d]/i);
    if (m) return m[1].trim();
  }
  // The search box still holding what was typed.
  var inputs = Array.prototype.slice.call(document.querySelectorAll(
    'input[type="search"], input[name="q"], input[name="k"]'));
  for (var j = 0; j < inputs.length; j++) {
    if (inputs[j].value && inputs[j].value.trim()) return inputs[j].value.trim();
  }
  // Amazon/HEB put the query in the document title: "sour cream | HEB.com",
  // "Amazon.com : sour cream".
  var t = document.title || '';
  var tm = t.match(/^Amazon\\.com\\s*:\\s*(.+)$/i) || t.match(/^(.+?)\\s*\\|\\s*(?:HEB\\.com|H-E-B)$/i);
  if (tm) return tm[1].trim();
  return null;
})()`;

/**
 * Per-store product-name extraction. Selectors mirror SEL_FALLBACKS in the
 * matching store script — if a store script's selectors change, change these
 * too or the corpus silently shrinks (build-corpus fails on an empty page).
 */
const PRODUCT_EXTRACTORS: Record<string, string> = {
  // heb.ts: real result tiles are the only ones carrying data-qe-id="productCard",
  // scoped to the search grid so the sponsored/pairings carousels stay out.
  heb: `(function () {
    var scope = document.querySelector('[data-qe-id="productCardContainer"]')
      || document.querySelector('#search_product_grid') || document;
    var cards = Array.prototype.slice.call(scope.querySelectorAll('[data-qe-id="productCard"]'));
    if (!cards.length) cards = Array.prototype.slice.call(
      document.querySelectorAll('[data-component="product-card"], [data-qe-id="productCard"]'));
    return cards.map(function (c) {
      var t = c.querySelector('[data-qe-id="productTitle"]');
      return t ? t.textContent.trim() : null;
    });
  })()`,

  // walmart.ts keeps only cards inside [data-testid="item-stack"] — the genuine
  // results grid. Without that filter the "similar items" / "sponsored" rails
  // leak in and get labelled as if the store had returned them for the query.
  walmart: `(function () {
    function inSearchResults(card) {
      var n = card;
      for (var d = 0; d < 15 && n && n !== document.body; d++) {
        if (n.getAttribute && n.getAttribute('data-testid') === 'item-stack') return true;
        n = n.parentElement;
      }
      return false;
    }
    var cards = Array.prototype.slice.call(
      document.querySelectorAll('[data-automation-id="product"], [data-item-id]')).filter(inSearchResults);
    return cards.map(function (c) {
      var t = c.querySelector('[data-automation-id="product-title"], [data-automation-id="name"]');
      return t ? t.textContent.trim() : null;
    });
  })()`,

  wegmans: `(function () {
    return Array.prototype.slice.call(document.querySelectorAll('div.component--product-tile'))
      .map(function (c) {
        var t = c.querySelector('h3[data-testid="-baseHeading"]');
        return t ? t.textContent.trim() : null;
      });
  })()`,

  // amazon-fresh.ts carries two DOM variants (A = a card grid used on
  // storefront/carousel surfaces, B = the real search grid). On a SEARCH page
  // it deliberately uses CARD_B only, because the CARD_A selector also matches
  // "Customers frequently viewed" carousels. Every fixture here is a search
  // page, so this mirrors that: CARD_B, plus the same name-resolution ladder
  // and garbage-string filter getCardName() uses.
  'amazon-fresh': `(function () {
    function isGarbageName(text) {
      if (/^\\$[\\d]/.test(text)) return true;
      if (/^estimated/i.test(text)) return true;
      if (/Overall Pick|Amazon.s Choice/i.test(text)) return true;
      if (/out of.*stars/i.test(text)) return true;
      if (/SNAP EBT/i.test(text)) return true;
      if (/^[\\d$.,\\s/()%]+(?:off|each|lb|oz|ounce|count|fl)/i.test(text)) return true;
      if (/Positively reviewed|Purchased often|Returned infrequently/i.test(text)) return true;
      if (/^See all details$/i.test(text)) return true;
      if (/^Quantity not updated/i.test(text)) return true;
      return false;
    }
    return Array.prototype.slice.call(document.querySelectorAll('[data-component-type="s-search-result"]'))
      .map(function (card) {
        var h2 = null, h2s = card.querySelectorAll('h2');
        for (var i = 0; i < h2s.length; i++) {
          if (h2s[i].closest('.ax-qs__error, .qs-atc-plus, [class*="qs-widget"]')) continue;
          h2 = h2s[i]; break;
        }
        if (!h2 && h2s.length) h2 = h2s[0];
        var brandText = h2 ? h2.textContent.trim() : '';
        if (h2) {
          var aria = h2.getAttribute('aria-label');
          if (aria && aria.trim()) return aria.trim().replace(/\\s+/g, ' ').replace(/^Sponsored Ad - /i, '');
        }
        var asin = card.getAttribute('data-asin');
        if (asin) {
          var links = card.querySelectorAll('a[href*="' + asin + '"]');
          var best = '';
          for (var j = 0; j < links.length; j++) {
            if (links[j].querySelector('img')) continue;
            var t = links[j].textContent.trim().replace(/\\s+/g, ' ');
            if (t.toLowerCase() === brandText.toLowerCase()) continue;
            if (isGarbageName(t)) continue;
            if (t.length > best.length) best = t;
          }
          if (best) {
            var cleaned = best.replace(/^Sponsored Ad - /i, '');
            if (brandText && cleaned.toLowerCase().indexOf(brandText.toLowerCase()) !== 0) {
              cleaned = brandText + ', ' + cleaned;
            }
            return cleaned;
          }
        }
        if (h2) {
          var link = h2.closest('a');
          if (link) {
            var lt = link.textContent.trim().replace(/\\s+/g, ' ');
            if (lt) return lt.replace(/^Sponsored Ad - /i, '');
          }
        }
        return null;
      });
  })()`,

  // aldi.ts getProductName: ATC aria-label → image alt → URL slug.
  aldi: `(function () {
    var links = Array.prototype.slice.call(document.querySelectorAll('a[href*="/store/aldi/products/"]'));
    var out = [];
    for (var i = 0; i < links.length; i++) {
      var card = links[i].closest('li,article,div') || links[i];
      var name = null;
      var btn = card.querySelector('button[aria-label^="Add 1 "]');
      if (btn) {
        var m = (btn.getAttribute('aria-label') || '').match(/^Add 1 (?:item|ct)\\s+(.+)/i);
        if (m) name = m[1].trim();
      }
      if (!name) {
        var img = card.querySelector('img[alt]');
        if (img) {
          var alt = (img.getAttribute('alt') || '').trim();
          if (alt.length > 2 && !/placeholder|logo|banner/i.test(alt)) name = alt;
        }
      }
      if (!name) {
        var sm = (links[i].getAttribute('href') || '').match(/\\/products\\/\\d+-(.+)/);
        if (sm) name = sm[1].split('-').map(function (w) {
          return w.charAt(0).toUpperCase() + w.slice(1);
        }).join(' ');
      }
      out.push(name);
    }
    return out;
  })()`,

  // albertsons.ts reads the name off the ATC button's aria-label; there is no
  // stable title selector on that storefront. Products already in the cart show
  // a qty bubble instead of an ATC button and are therefore invisible here —
  // the same blind spot the live script has.
  albertsons: `(function () {
    return Array.prototype.slice.call(document.querySelectorAll('button[aria-label^="Add 1 unit of"]'))
      .map(function (b) {
        var m = (b.getAttribute('aria-label') || '').match(/^Add 1 unit of (.+)/i);
        return m ? m[1].trim() : null;
      });
  })()`,
};

export interface CorpusQuery {
  /** The ingredient / product string the store was searched for. */
  query: string;
  /** 'page' = read out of the saved DOM; 'capture-config' = QUERY_OVERRIDES. */
  queryProvenance: 'page' | 'capture-config';
  /** Fixture files this result list was merged from (same query, different UI state). */
  fixtures: string[];
  /** Every product tile on the page, in DOM order, deduped. */
  products: string[];
}

export interface Corpus {
  generatedBy: string;
  stores: Record<string, CorpusQuery[]>;
  excluded: Record<string, string>;
}

async function main() {
  // Same two layers the fixture runner uses, for the same reason (MEAL-150).
  //
  // This script never fetches anything: it reads the committed captures off disk
  // and `setContent`s them below. But the captures are real storefronts, and their
  // inline markup still points at the store's live bundles, trackers and beacons —
  // so a browser with no boundary will go and get them, carrying whatever those
  // pages carry. The corpus fixtures include cart contents, prices, an Albertsons
  // loyalty id and an email hash.
  //
  // The old handler here aborted script/stylesheet/font/image/media and
  // `continue()`d everything else — so `document`, `fetch`, `xhr` and `ping` were
  // all free to go out.
  //
  // What a real build actually issued: **10** `document` requests, every one a
  // DoubleClick floodlight beacon out of the HEB captures. No fetch/xhr/ping fired.
  // All ten carry `auiddc=`, a persistent ad id; two of them — from
  // search-results-product-in-cart and search-results-stepper-open — also carry
  // `u3=` product ids, `u5=` prices and `u6=` quantities.
  //
  // Ten and not more, for a reason worth knowing before anyone measures this file
  // again: the loop below reuses ONE page across all 30 fixtures, and the Walmart
  // captures carry a `<meta http-equiv="Content-Security-Policy">`. Walmart is
  // second in STORES, so from that fixture onward the page is locked and every
  // later `setContent` is muzzled — 164 CSP console errors on albertsons alone, and
  // zero requests. Load albertsons first and it attempts 40 by itself. Give each
  // fixture a fresh page and the captures attempt 57 in total, to eleven hosts
  // across three stores: 31 floodlight beacons plus insight.adsrvr.org,
  // safeframe.googlesyndication.com, websdk.ujet.co, www.google.com and
  // js.stripe.com.
  //
  // So 57 is what these captures WANT to send and 10 is what this builder sent. The
  // blocking happens in the renderer, before any route handler, so the 47 were never
  // the old handler's to forward either. Two earlier versions of this comment got
  // this wrong in both directions — first reporting 10 as though it were the whole
  // story, then "correcting" it to 57 and accusing the first of measuring one slice,
  // when 57 was the number from a harness this file does not use.
  //
  // The CSP muzzle is its own problem: 21 of 30 fixtures are parsed with none of
  // their inline machinery running. Extraction is DOM-only so the corpus is
  // unaffected, but any measurement taken through this loop is measuring a gagged
  // browser. Filed separately.

  // Keep both. The resolver rule is the boundary; installResourceBlocking is what
  // makes an intercepted navigation land on a known empty page instead of a network
  // error — which is also what keeps a live bundle from navigating the page away
  // mid-extraction, the thing the comment this replaces was worried about.
  const browser = await chromium.launch(FIXTURE_LAUNCH_OPTIONS);
  const context = await browser.newContext();
  await installResourceBlocking(context);
  const page = await context.newPage();

  const stores: Record<string, CorpusQuery[]> = {};
  const problems: string[] = [];

  for (const store of STORES) {
    const dir = path.join(FIXTURE_DIR, store);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('search-results-')).sort();
    // Same query captured in several UI states (stepper open, product in cart)
    // is ONE retrieval, not three — merge on the query string so the corpus
    // isn't padded with triplicates.
    const byQuery = new Map<string, CorpusQuery>();

    for (const file of files) {
      const key = `${store}/${file}`;
      if (EXCLUDED[key]) continue;

      const html = fs.readFileSync(path.join(dir, file), 'utf8');
      await page.setContent(html, { waitUntil: 'domcontentloaded' });

      const override = QUERY_OVERRIDES[key];
      const query = override ?? ((await page.evaluate(QUERY_FROM_PAGE)) as string | null);
      if (!query) {
        problems.push(`${key}: no query found in page and no override — skipped`);
        continue;
      }

      const raw = (await page.evaluate(PRODUCT_EXTRACTORS[store])) as (string | null)[];
      const products = raw.filter((n): n is string => !!n && n.trim().length > 1);
      if (!products.length) {
        problems.push(`${key}: 0 products extracted — selectors may have drifted`);
        continue;
      }

      const norm = query.trim();
      const existing = byQuery.get(norm);
      if (existing) {
        existing.fixtures.push(file);
        for (const p of products) if (!existing.products.includes(p)) existing.products.push(p);
      } else {
        byQuery.set(norm, {
          query: norm,
          queryProvenance: override ? 'capture-config' : 'page',
          fixtures: [file],
          products: [...new Set(products)],
        });
      }
    }
    stores[store] = [...byQuery.values()];
  }

  const corpus: Corpus = {
    generatedBy: 'npm run match-harness:build (tests/match-harness/build-corpus.ts)',
    stores,
    excluded: EXCLUDED,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(corpus, null, 2) + '\n');

  for (const [store, queries] of Object.entries(stores)) {
    const pairs = queries.reduce((n, q) => n + q.products.length, 0);
    console.log(`${store.padEnd(14)} ${String(queries.length).padStart(2)} queries  ${String(pairs).padStart(4)} pairs`);
  }
  if (problems.length) {
    console.log('\nProblems:');
    for (const p of problems) console.log('  - ' + p);
  }
  console.log(`\nWrote ${path.relative(process.cwd(), OUT_FILE)}`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
