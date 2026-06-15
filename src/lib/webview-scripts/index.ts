// Store scripts registry — maps storeId → injectable WebView scripts.

import {
  HEB_URL, HEB_LOGIN_URL, HEB_CART_URL,
  CHECK_LOGIN_SCRIPT, EXTRACT_PRODUCTS_SCRIPT,
  buildAddToCartScript as hebBuildATC,
  buildSearchScript as hebBuildSearch,
  buildSearchAndAddScript as hebBuildSearchAndAdd,
} from './heb';
import { getScripts as getWalmartScripts } from './walmart';
import { getScripts as getAlbertsonsScripts, ALBERTSONS_FAMILY_IDS } from './albertsons';
import { getScripts as getAldiScripts } from './aldi';
import { getScripts as getAmazonFreshScripts } from './amazon-fresh';
import { getScripts as getWegmansScripts } from './wegmans';
import { buildExtractWorker } from './worker-search';

export interface StoreScripts {
  storeUrl: string;
  loginUrl: string;
  cartUrl: string;
  domain: string;
  appScheme?: string;
  /** Returns true if the URL is a search results page for this store. */
  isSearchUrl: (url: string) => boolean;
  /** Returns true if the URL indicates a successful login redirect. */
  isLoginSuccessUrl: (url: string) => boolean;
  /** Injected to check if the user is logged in. Posts LOGIN_STATUS. */
  checkLoginScript: string;
  /** Injected on search results page. Posts SEARCH_RESULT with candidates. */
  extractProductsScript: string;
  /** Builds script to add a specific product to cart. Posts ADD_RESULT. */
  buildAddToCartScript: (productName: string, preference: { text: string } | null, qty: number) => string;
  /** Builds script to navigate to search results for a term. */
  buildSearchScript: (term: string) => string;
  /** Builds script to search + auto-add if match found. Posts SEARCH_AND_ADD_RESULT. */
  buildSearchAndAddScript: (term: string, qty: number, dropdown: { type: string; selectedText: string; selectedValue: string } | null) => string;
  // ── Parallel product search (optional) ──────────────────────────────────
  // A store that provides BOTH of these opts into the 5-worker parallel pool
  // for the choose-product flow: WebViewCartSheet dispatches each ingredient
  // to a hidden worker WebView loaded at getSearchUrl, injects
  // buildWorkerScript, and collects WORKER_RESULT. Omit them to stay on the
  // sequential single-WebView path.
  /** Direct search-results URL for a term (loads results without typing). */
  getSearchUrl?: (term: string) => string;
  /** Injected JS for one worker; posts WORKER_RESULT with the workerId. */
  buildWorkerScript?: (workerId: number) => string;
}

// ── HEB adapter ──────────────────────────────────────────────────────────────

const hebScripts: StoreScripts = {
  storeUrl: HEB_URL,
  loginUrl: HEB_LOGIN_URL,
  cartUrl: HEB_CART_URL,
  domain: 'heb.com',
  appScheme: 'heb://',
  isSearchUrl: (url) => url.includes('/search'),
  // Do NOT match the OIDC callback — it must complete its redirect chain
  // to set session cookies. onLoadEnd re-injection handles post-login detection.
  isLoginSuccessUrl: () => false,
  checkLoginScript: CHECK_LOGIN_SCRIPT,
  extractProductsScript: EXTRACT_PRODUCTS_SCRIPT,
  buildAddToCartScript: hebBuildATC,
  buildSearchScript: hebBuildSearch,
  buildSearchAndAddScript: hebBuildSearchAndAdd,
  getSearchUrl: (term) => 'https://www.heb.com/search?q=' + encodeURIComponent(term),
  buildWorkerScript: (workerId) => buildExtractWorker(workerId, EXTRACT_PRODUCTS_SCRIPT),
};

// ── Lookup ───────────────────────────────────────────────────────────────────

export function getStoreScripts(storeId: string): StoreScripts | null {
  switch (storeId) {
    case 'heb':            return hebScripts;
    case 'walmart':        return getWalmartScripts();
    case 'aldi':           return getAldiScripts();
    case 'amazon':         return getAmazonFreshScripts();
    case 'wegmans':        return getWegmansScripts();
    default:
      if (ALBERTSONS_FAMILY_IDS.includes(storeId)) {
        return getAlbertsonsScripts(storeId);
      }
      return null;
  }
}
