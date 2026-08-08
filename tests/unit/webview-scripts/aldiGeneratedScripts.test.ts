// Byte-level pin on the JavaScript ALDI actually injects into the WebView.
//
// WHY A SNAPSHOT AND NOT AN ASSERTION
// The fixture tests (tests/fixture-tests/aldi.spec.ts) prove the injected JS
// *behaves* correctly against recorded ALDI HTML. They cannot prove it is
// UNCHANGED — a refactor that alters a poll bound, a regex, or a fallback URL
// can still pass every fixture while quietly changing what runs on a phone.
// This snapshot closes that gap: any edit to the generated text shows up as a
// reviewable diff instead of slipping through.
//
// It was written and recorded BEFORE aldi.ts was generalised into the shared
// Instacart Storefront adapter (MEAL-20), specifically so the refactor had to
// reproduce ALDI's injected JS byte for byte. It keeps earning its keep after:
// ALDI is the only storefront on that adapter that has ever run against a real
// site, so it is the reference tenant, and an unintended change to it is the
// most likely way the adapter breaks.
//
// Regenerate deliberately, never reflexively: `npx jest aldiGeneratedScripts -u`
// and read the diff. A changed snapshot means the code injected into a real
// user's WebView changed.
//
// Every snapshot below now opens with MEAL-31's selector-health prefix — the
// `(function(){ ... __mealioSelHealth ... })();` block. It is not ALDI logic and
// not part of the adapter: it is prepended to every store script by
// getStoreScripts, it hooks postMessage to sample the selectors the script that
// follows will query, and the store's own script begins on the line after it,
// unchanged. The snapshot covers it on purpose — a change to what the probe
// injects is a change to what runs on a phone, and this is the file that says so.

import { getStoreScripts } from '../../../src/lib/webview-scripts';
import { __resetAutomationConfigForTests } from '../../../src/lib/automation-config';

beforeEach(() => __resetAutomationConfigForTests());
afterAll(() => __resetAutomationConfigForTests());

describe('ALDI generated WebView scripts (bundled config)', () => {
  it('checkLoginScript', () => {
    expect(getStoreScripts('aldi')!.checkLoginScript).toMatchSnapshot();
  });

  it('extractProductsScript', () => {
    expect(getStoreScripts('aldi')!.extractProductsScript).toMatchSnapshot();
  });

  it('buildAddToCartScript', () => {
    expect(
      getStoreScripts('aldi')!.buildAddToCartScript('Happy Harvest Crushed Tomatoes 28 Oz', null, 3, null),
    ).toMatchSnapshot();
  });

  it('buildSearchScript', () => {
    expect(getStoreScripts('aldi')!.buildSearchScript('sour cream')).toMatchSnapshot();
  });

  it('buildSearchAndAddScript', () => {
    expect(
      getStoreScripts('aldi')!.buildSearchAndAddScript('organic broccoli', 2, null),
    ).toMatchSnapshot();
  });

  it('buildWorkerScript', () => {
    expect(getStoreScripts('aldi')!.buildWorkerScript!(3)).toMatchSnapshot();
  });
});

describe('ALDI StoreScripts non-script fields (bundled config)', () => {
  it('urls, domain and runtime flags', () => {
    const s = getStoreScripts('aldi')!;
    expect({
      storeUrl: s.storeUrl,
      loginUrl: s.loginUrl,
      cartUrl: s.cartUrl,
      domain: s.domain,
      appScheme: s.appScheme,
      reinjectLoginCheckOnNav: s.reinjectLoginCheckOnNav,
      forceSerialSearch: s.forceSerialSearch,
      workerCount: s.workerCount,
      workerStaggerMs: s.workerStaggerMs,
      cacheBustNav: s.cacheBustNav,
      spaSearch: s.spaSearch,
      isLoginPageUrl: typeof s.isLoginPageUrl,
    }).toMatchSnapshot();
  });

  it('getSearchUrl encodes the term into the Instacart /s?k= route', () => {
    const s = getStoreScripts('aldi')!;
    expect(s.getSearchUrl!('sour cream')).toMatchSnapshot();
    expect(s.getSearchUrl!('Jalapeños & Cream')).toMatchSnapshot();
  });

  // isSearchUrl / isLoginSuccessUrl are predicates, so pin their verdicts on
  // the URLs the cart engine actually feeds them rather than their source text.
  it('isSearchUrl / isLoginSuccessUrl verdicts', () => {
    const s = getStoreScripts('aldi')!;
    const urls = [
      'https://www.aldi.us',
      'https://www.aldi.us/store/aldi/storefront',
      'https://www.aldi.us/store/aldi/s?k=tortillas',
      'https://www.aldi.us/store/aldi/products/12345-happy-harvest',
      'https://www.aldi.us/en/weekly-specials',
      'https://www.instacart.com/store/aldi/s?k=tortillas',
      'https://delivery.publix.com/store/publix/s?k=milk',
    ];
    expect(
      urls.map((u) => ({
        url: u,
        isSearchUrl: s.isSearchUrl(u),
        isLoginSuccessUrl: s.isLoginSuccessUrl(u),
      })),
    ).toMatchSnapshot();
  });
});
