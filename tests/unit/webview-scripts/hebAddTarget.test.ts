// Which card the H-E-B add script presses — the title comparison that decides
// WHAT gets bought.
//
// It matters here because TARGET_NAME does not always come from a search page.
// The MEAL-119 top-up presses "add more" against a CART ROW's own title (the
// synthesized candidate on the in-cart-by-weight card is that row), and every
// other comparison between those two sources in this pipeline normalizes first —
// cart-reconcile does not even offer a raw pass in front of its presence
// matching. A raw `===` there turns any punctuation or spacing difference between
// the cart's rendering of a name and the search page's into ADD_RESULT
// not_found: the user asked for more and got nothing.
//
// Run in a bare vm against a stub DOM rather than through Playwright, because the
// thing under test is one string comparison and the checkpoint is cheap: give the
// matched card no Add button and the script reports `no_button`, which means "I
// found it", against `not_found`, which means "I did not". The per-store proof
// that the real HEB DOM yields these cards at all lives in heb.spec.ts.

import * as vm from 'vm';
import { buildAddToCartScript } from '../../../src/lib/webview-scripts/heb';
import { normalizeName } from '../../../src/lib/webview-scripts/cart-count';

/** One search-results card: a title element, and no Add button (see above). */
function stubCard(title: string) {
  return {
    querySelector(selector: string) {
      if (/addToCart/i.test(selector)) return null; // the checkpoint
      return { textContent: title };
    },
  };
}

/**
 * Run the add script against a page showing `cardTitles`, and return everything
 * it posted back.
 *
 * setTimeout fires synchronously so the script's waits cost nothing; it never
 * reaches a polling loop, because the first card lookup already decides the
 * outcome we assert on.
 */
async function runAdd(targetName: string, cardTitles: string[]): Promise<Array<Record<string, any>>> {
  const posted: Array<Record<string, any>> = [];
  const cards = cardTitles.map(stubCard);
  const documentStub = {
    // 'input, textarea' — the keyboard suppression pass. Everything else asking
    // for a list on this page is asking for the product cards.
    querySelectorAll: (selector: string) => (/input|textarea/i.test(selector) ? [] : cards),
    // No grid wrapper, so __hebFindCards scopes to the document itself.
    querySelector: () => null,
    addEventListener: () => {},
    body: { click: () => {} },
  };
  const sandbox: any = {
    document: documentStub,
    location: { search: '', href: 'https://www.heb.com/search?q=x' },
    ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearTimeout: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  await vm.runInContext(buildAddToCartScript(targetName, null, 1, null), sandbox);
  return posted;
}

const result = (posted: Array<Record<string, any>>) => posted.find((m) => m.type === 'ADD_RESULT');
const debugSteps = (posted: Array<Record<string, any>>) =>
  posted.filter((m) => m.type === 'ADD_DEBUG').map((m) => m.step);

const CART_TITLE = 'H-E-B Boneless Chicken Breast, per lb';

describe('buildAddToCartScript — finding the card to press', () => {
  it('presses the card whose title matches exactly', async () => {
    const posted = await runAdd(CART_TITLE, ['H-E-B Ground Cumin', CART_TITLE]);
    // 'no_button' is this stub's success: the card was found and the script got
    // as far as reaching for its Add button.
    expect(result(posted)?.reason).toBe('no_button');
    expect(debugSteps(posted)).not.toContain('1_title_normalized');
  });

  it.each([
    ['a hyphen the cart renders and the search page does not', 'H-E-B Boneless Chicken Breast per lb'],
    ['a different comma / spacing', 'H-E-B  Boneless Chicken Breast,per lb'],
    ['a non-breaking space inside the brand', 'H E B Boneless Chicken Breast, per lb'],
    ['an en dash where the cart had hyphens', 'H–E–B Boneless Chicken Breast, per lb'],
  ])('still presses the right card when the two titles differ by %s', async (_why, searchTitle) => {
    // The divergence this branch actually hits. Reverted to a raw `===` only,
    // every one of these ends the press as not_found and the user is told the
    // top-up they asked for failed.
    const posted = await runAdd(CART_TITLE, ['H-E-B Ground Cumin', searchTitle]);
    expect(result(posted)?.reason).toBe('no_button');
    // …and it is reported as the fallback it is, not passed off as an exact hit.
    expect(debugSteps(posted)).toContain('1_title_normalized');
  });

  it('does NOT press a different product — normalization is not lenience', async () => {
    // The line that must not move. cartNameMatches would accept this on 0.6 token
    // overlap; this comparison decides which product to BUY, so a token subset
    // buying the wrong thing is worse than a reported failure.
    const posted = await runAdd(CART_TITLE, [
      'H-E-B Boneless Chicken Thighs, per lb',
      'H-E-B Boneless Chicken Breast Tenders, per lb',
    ]);
    expect(result(posted)?.reason).toBe('not_found');
  });

  it('reports not_found when the page holds no cards at all', async () => {
    expect(result(await runAdd(CART_TITLE, []))?.reason).toBe('not_found');
  });

  it('normalizes titles the same way the cart audit does', async () => {
    // The in-page __hebNormTitle is a copy of cart-count's normalizeName, which is
    // what makes "consistent with the rest of the pipeline" true rather than
    // aspirational. Checked by behaviour: two titles normalizeName calls equal must
    // match, and one it calls different must not.
    const searchTitle = 'H-E-B   Boneless-Chicken Breast (per lb)';
    expect(normalizeName(searchTitle)).toBe(normalizeName(CART_TITLE));
    expect(result(await runAdd(CART_TITLE, [searchTitle]))?.reason).toBe('no_button');

    const otherTitle = 'H-E-B Boneless Chicken Breast Thin Sliced, per lb';
    expect(normalizeName(otherTitle)).not.toBe(normalizeName(CART_TITLE));
    expect(result(await runAdd(CART_TITLE, [otherTitle]))?.reason).toBe('not_found');
  });
});
