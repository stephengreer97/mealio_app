// Albertsons family fixture tests (representative store: acme).
//
// The same scripts run against Safeway, Vons, Jewel-Osco, etc — they share
// selectors. We capture once for acme; rerun for other family members only
// if a specific store's DOM diverges.
//
// All tests auto-skip when their fixture file isn't present. Activate by
// running `npm run capture -- albertsons`.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildCartPageCountScript } from '../../src/lib/webview-scripts/cart-count';
import { storeFixtures } from './_helpers';
import type { FixtureRunner } from '../fixture-runners/runScript';

const { itWithFixture } = storeFixtures('albertsons');
// 'acme' is one of the Albertsons family IDs; getStoreScripts dispatches
// based on the family list inside webview-scripts/index.ts.
const scripts = getStoreScripts('acme')!;

const LOGIN_CACHE_KEY = 'mealio_albertsons_login_state';

/**
 * Replace sessionStorage with an in-page stub. The fixture is loaded via
 * setContent on an opaque origin where the real sessionStorage throws
 * SecurityError, and the script swallows that — so without a stub the cache
 * tests would pass vacuously. The stub also lets the test read back what the
 * script stored (see readCachedLoginState).
 */
async function stubSessionStorage(runner: FixtureRunner): Promise<void> {
  await runner.page.evaluate(() => {
    const store: Record<string, string> = {};
    (window as unknown as { __albStore: Record<string, string> }).__albStore = store;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = String(v);
        },
        removeItem: (k: string) => {
          delete store[k];
        },
      },
    });
  });
}

/** What the script has actually written to the stubbed cache (null if absent). */
async function readCachedLoginState(runner: FixtureRunner): Promise<string | null> {
  return runner.page.evaluate(
    (key) => {
      const store = (window as unknown as { __albStore?: Record<string, string> }).__albStore;
      return store && key in store ? store[key] : null;
    },
    LOGIN_CACHE_KEY,
  );
}

/**
 * Turn the captured logged-in header into the signed-out one by changing ONLY
 * span[data-qa="hdr-accnt-nm"] — which is all the platform changes. The span
 * already carries 'menu-nav__profile-button-sign-in-up dst-sign-in-up' while
 * holding a user's name; the aria-label stays "Account menu" in both states.
 * The rule still decides loggedOut because acctIsSignIn is tested before
 * acctIsMenu.
 */
async function flipHeaderToSignedOut(runner: FixtureRunner): Promise<void> {
  await runner.page.evaluate(() => {
    const span = document.querySelector('span[data-qa="hdr-accnt-nm"]');
    if (!span) throw new Error('fixture drift: span[data-qa="hdr-accnt-nm"] is gone');
    span.textContent = 'Sign in';
  });
}

/** Simulate a page reload: the JS-context latches go, sessionStorage survives. */
async function clearWindowLatches(runner: FixtureRunner): Promise<void> {
  await runner.page.evaluate(() => {
    delete (window as unknown as Record<string, unknown>).__albLoginPosted;
    delete (window as unknown as Record<string, unknown>).__albLoginCheckActive;
  });
}

/**
 * The MEAL-124 state: everything the logged-in capture has, EXCEPT the rendered
 * name. aria-label stays "Account menu" — that is the point, it is static markup
 * present in both auth states — and only span[data-qa="hdr-accnt-nm"] is emptied.
 * This is what pre-hydration, mid-render, and a slow auth bootstrap all look like.
 */
async function emptyAccountName(runner: FixtureRunner): Promise<void> {
  await runner.page.evaluate(() => {
    const span = document.querySelector('span[data-qa="hdr-accnt-nm"]');
    if (!span) throw new Error('fixture drift: span[data-qa="hdr-accnt-nm"] is gone');
    span.textContent = '';
  });
  // Guards, so no test built on this state can pass vacuously: the control still
  // announces itself as the account menu (what the buggy rule matched on) and its
  // rendered text is genuinely empty (what the fixed rule requires).
  const state = await runner.page.evaluate(() => {
    const link = document.querySelector('[data-qa="hdr-accnt-lnk"]');
    return {
      aria: link ? link.getAttribute('aria-label') : null,
      text: link ? (link.textContent || '').trim() : null,
    };
  });
  expect(state.aria).toMatch(/account\s*menu/i);
  expect(state.text).toBe('');
}

/**
 * Strip every "Sign Out"/"Log Out" string from the page. The click fallback's
 * terminal condition is that text appearing in body innerText, and the fixture
 * runner blocks stylesheets so the CSS-hidden account flyout is "visible" to
 * innerText — which is why the click fallback answers loggedIn on this capture.
 * Removing it is how a test can observe what the check does with NO evidence
 * either way.
 */
async function stripSignOutEvidence(runner: FixtureRunner): Promise<void> {
  await runner.page.evaluate(() => {
    const re = /sign\s*out|log\s*out/i;
    // Walk text nodes rather than guessing at containers.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const doomed: Text[] = [];
    let n: Node | null;
    // eslint-disable-next-line no-cond-assign
    while ((n = walker.nextNode())) {
      if (re.test(n.nodeValue || '')) doomed.push(n as Text);
    }
    doomed.forEach((t) => {
      t.nodeValue = '';
    });
    // aria-labels and titles also land in innerText for some elements.
    document.querySelectorAll('[aria-label], [title]').forEach((el) => {
      if (re.test(el.getAttribute('aria-label') || '')) el.setAttribute('aria-label', '');
      if (re.test(el.getAttribute('title') || '')) el.setAttribute('title', '');
    });
  });
  // Guard: if this didn't work the test below would pass for the wrong reason.
  const bodyText = await runner.page.evaluate(() => (document.body.innerText || '').toLowerCase());
  expect(bodyText).not.toMatch(/sign out|log out/);
}

/**
 * Make the account control AMBIGUOUS: aria-label that is neither a sign-in CTA
 * nor an "account menu", and an empty name span. Both the click fallback and
 * the headerSignIn branch are only reachable from this state.
 */
async function makeAccountControlAmbiguous(runner: FixtureRunner): Promise<void> {
  await runner.page.evaluate(() => {
    const link = document.querySelector('[data-qa="hdr-accnt-lnk"]');
    if (!link) throw new Error('fixture drift: [data-qa="hdr-accnt-lnk"] is gone');
    link.setAttribute('aria-label', 'Account');
    const span = document.querySelector('span[data-qa="hdr-accnt-nm"]');
    if (span) span.textContent = '';
  });
}

describe('Albertsons cart-page count (snapshot before/after)', () => {
  // Counts on /erums/cart: dedupe by product id (the page renders each item
  // twice for responsive layouts). Qty comes from the cart-qty display text,
  // NOT the stepper button id suffix (that suffix is a row index). Fixture has
  // Basmati x1 + Hunt's x1 → 2 units, 2 distinct items.
  itWithFixture(
    'cart-with-items.html',
    'sums cart line-item quantities (deduped) and posts CART_COUNT',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('acme')!);
      const result = await runner.waitForMessage('CART_COUNT', 8_000);
      expect(result.count).toBe(2);
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(2);
      const byName = Object.fromEntries(
        result.items.map((it: { name: string; qty: number }) => [it.name, it.qty]),
      );
      const basmati = Object.keys(byName).find((n) => /basmati/i.test(n));
      const hunts = Object.keys(byName).find((n) => /hunt/i.test(n));
      expect(basmati && byName[basmati]).toBe(1);
      expect(hunts && byName[hunts]).toBe(1);
    },
  );
});

describe('Albertsons regression: product already in cart (collapsed bubble)', () => {
  // When the searched product is already in the cart, Albertsons shows a
  // collapsed qty bubble (no ATC button) with a TRUNCATED aria-label. The add
  // script must match that bubble to the product and CLICK it (to reveal the
  // stepper) rather than bailing as "not found".
  //
  // BUDGET 30s, NOT 20s (MEAL-113). This is the second-slowest wait in the suite
  // and it is bimodal: 14766 / 14768 / 18342 ms over three idle runs, a fast and a
  // slow mode ~3.6s apart, with the slow mode at 92% of a 20s budget. See the note
  // in aldi.spec.ts for the same step measured on three other waits; the short
  // version is that both modes occur back to back on an unloaded box, so this is
  // not contention and 8% of headroom is not enough to tell a real slowdown from
  // the environmental one the project rule tells us to dismiss.
  itWithFixture(
    'search-results-collapsed-bubble.html',
    'matches the truncated bubble to the product and clicks it',
    async (runner) => {
      // Flag the bubble click (the static fixture has no real handler).
      await runner.page.evaluate(() => {
        const b = document.querySelector('[data-qa="qty-stppr-bbl"]');
        if (b) b.addEventListener('click', () => {
          (window as unknown as { __bubbleClicked?: boolean }).__bubbleClicked = true;
        });
      });
      const script = scripts.buildSearchAndAddScript(
        'Lucerne Heavy Whipping Cream - 16 Oz',
        1,
        null,
      );
      await runner.inject(script);
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 30_000);
      const clicked = await runner.page.evaluate(
        () => (window as unknown as { __bubbleClicked?: boolean }).__bubbleClicked === true,
      );
      expect(clicked).toBe(true);
    },
    { testTimeoutMs: 45_000 },
  );
});

describe('Albertsons family CHECK_LOGIN_SCRIPT', () => {
  // NOTE ON WHAT THESE FIXTURES CAN AND CANNOT PROVE (MEAL-42).
  //
  // An earlier version of this note said the fixtures cannot speak to the
  // signed-out state at all. That was wrong in both directions; corrected here.
  //
  // The signed-out half IS reachable from this capture. Albertsons reuses ONE
  // span for both states: in logged-in-home.html span[data-qa="hdr-accnt-nm"]
  // holds the user's name while still carrying the class list
  // 'menu-nav__profile-button-sign-in-up dst-sign-in-up' — the file's own
  // 2026-02 header note says as much. Setting that span's text to "Sign in" is
  // the whole difference, and the rule then decides loggedOut correctly because
  // acctIsSignIn is evaluated before acctIsMenu. The test below does exactly
  // that, so the signed-out half is no longer resting on the live logout helper
  // alone.
  //
  // What the note UNDERSTATED is the real risk, which is not "signed out": it is
  // any state where that name span is EMPTY, because nothing waits for it. The
  // poll waits for the ELEMENT; acctIsMenu then matches on the static
  // aria-label="Account menu", which is present regardless of auth state. So
  // pre-hydration, mid-render, or a slow auth bootstrap all reach 'loggedIn' in
  // single-digit ms. That, not the signed-out header, is where this rule is thin.
  //
  // Also note the fixture runner blocks stylesheets, so Bootstrap's `d-none`
  // never applies and hidden markup shows up in innerText. That is exactly why
  // the old body-text test was vacuous: logged-in-home.html contains "Sign Out"
  // in the (CSS-hidden) flyout markup, so scanning body text "passed" without
  // the click ever doing anything. Assert on attributes and script behaviour,
  // never on visibility. (It also means the logged-out background poll finds
  // "sign out" on its first tick here — which the stacked-poller test below
  // turns into a signal rather than fighting.)

  // The passive marker the fast path actually reads. Pins BOTH halves: the
  // account control's aria-label (what acctIsMenu matches) and the name span
  // inside it (documented at the top of albertsons.ts as the login marker).
  // If Albertsons renames either, this fails instead of the check silently
  // falling back to the slow click path.
  itWithFixture(
    'logged-in-home.html',
    'pins the passive logged-in marker: account control + hdr-accnt-nm span',
    async (runner) => {
      const marker = await runner.page.evaluate(() => {
        const link = document.querySelector('[data-qa="hdr-accnt-lnk"]');
        const nameSpan = document.querySelector('span[data-qa="hdr-accnt-nm"]');
        return {
          linkAria: link ? link.getAttribute('aria-label') : null,
          nameText: nameSpan ? (nameSpan.textContent || '').trim() : null,
        };
      });
      // Logged in, the control announces itself as the account menu…
      expect(marker.linkAria).toMatch(/account\s*menu/i);
      // …and the name span holds a user name, NOT a sign-in call to action.
      expect(marker.nameText).toBeTruthy();
      expect(marker.nameText).not.toMatch(/sign\s?in|sign\s?up|log\s?in|create account/i);
    },
  );

  // Non-vacuous replacement for the old body-text test: the verdict must be
  // reached WITHOUT clicking the account control. Previously the script clicked
  // and then waited a flat 1.5s; this asserts the click never happens, so a
  // regression back to the click path fails here rather than just getting slower.
  itWithFixture(
    'logged-in-home.html',
    'decides logged-in passively — no click on the account control',
    async (runner) => {
      await runner.page.evaluate(() => {
        (window as unknown as { __clicked: string[] }).__clicked = [];
        document.addEventListener(
          'click',
          (e) => {
            const t = e.target as Element;
            const el = (t.closest && t.closest('a,button')) || t;
            (window as unknown as { __clicked: string[] }).__clicked.push(
              el.getAttribute('data-qa') || el.tagName,
            );
          },
          true,
        );
      });

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(true);

      const clicked = await runner.page.evaluate(
        () => (window as unknown as { __clicked: string[] }).__clicked,
      );
      expect(clicked).toEqual([]);

      // And it decided from the passive marker, not the click fallback.
      const decision = runner
        .messagesOfType('LOGIN_DEBUG')
        .find((m) => m.step === 'passive_decision');
      expect(decision?.decided).toBe('loggedIn');
      expect(runner.messagesOfType('LOGIN_DEBUG').some((m) => m.step === 'after_click')).toBe(false);
    },
  );

  // ── MEAL-124: the empty account-name span ────────────────────────────────
  //
  // The reachable half of the risk MEAL-42's review identified, and the one the
  // note above this describe called out as where the rule is thin. Nothing waited
  // for the name: the poll waited for the ELEMENT, and acctIsMenu then matched
  // aria-label="Account menu", which is in the raw markup signed in or out. So
  // the check answered loggedIn in single-digit milliseconds off a header that
  // said nothing about whether anyone was signed in.
  //
  // These four tests pin, in order: that the empty span no longer decides
  // loggedIn; that with no evidence either way the verdict is signed OUT; that
  // the poll waits for a late-rendering name instead of guessing; and that
  // SWY_SHOP_TOKEN is deliberately not a decider.

  itWithFixture(
    'logged-in-home.html',
    'an empty account-name span decides nothing passively — no loggedIn from static markup',
    async (runner) => {
      await emptyAccountName(runner);

      await runner.inject(scripts.checkLoginScript);
      await runner.waitForMessage('LOGIN_STATUS', 12_000);

      const debug = runner.messagesOfType('LOGIN_DEBUG');
      const decision = debug.find((m) => m.step === 'passive_decision');
      // Was 'loggedIn'. The empty name is now named for what it is: no answer.
      expect(decision?.decided).toBe('ambiguous_empty_acct_name');
      expect(decision?.acctText).toBe('');
      // The poll spent its full budget waiting for a name that never came.
      expect(debug.find((m) => m.step === 'profile_btn')?.found).toBe(true);
      expect(debug.find((m) => m.step === 'profile_btn')?.nameReady).toBe(false);
      // And it fell through to the click check — real evidence — rather than
      // short-circuiting to a verdict.
      expect(debug.some((m) => m.step === 'after_click')).toBe(true);
    },
  );

  // THE DIRECTION THAT MATTERS. Same empty-span state, but with every
  // "Sign Out"/"Log Out" string stripped, so the click fallback finds nothing
  // either. An indeterminate state must resolve to signed OUT: that shows the
  // user a login wall. The old code's answer here was `true`, which runs every
  // search and every add against a signed-out session and fails in silence.
  itWithFixture(
    'logged-in-home.html',
    'indeterminate resolves to signed OUT, never signed in (fail closed)',
    async (runner) => {
      await stubSessionStorage(runner);
      await emptyAccountName(runner);
      await stripSignOutEvidence(runner);

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(false);

      const debug = runner.messagesOfType('LOGIN_DEBUG');
      expect(debug.find((m) => m.step === 'passive_decision')?.decided).toBe(
        'ambiguous_empty_acct_name',
      );
      expect(debug.find((m) => m.step === 'after_click')?.isLoggedIn).toBe(false);
      // Nothing positive was cached off a verdict we could not justify.
      expect(await readCachedLoginState(runner)).toBeNull();
    },
  );

  // The poll waits for the NAME, not the element. Empty the span, then let it
  // render "Sign in" 600ms later — which is what a slow auth bootstrap on a
  // signed-out page does. The verdict must follow the name that eventually
  // arrives. Before the fix this answered loggedIn immediately, contradicting a
  // header that was about to say "Sign in".
  itWithFixture(
    'logged-in-home.html',
    'waits for a late-rendering account name and follows it (was: answered before it rendered)',
    async (runner) => {
      await emptyAccountName(runner);
      await runner.page.evaluate(() => {
        setTimeout(() => {
          const span = document.querySelector('span[data-qa="hdr-accnt-nm"]');
          if (span) span.textContent = 'Sign in';
        }, 600);
      });

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(false);

      const debug = runner.messagesOfType('LOGIN_DEBUG');
      expect(debug.find((m) => m.step === 'profile_btn')?.nameReady).toBe(true);
      const decision = debug.find((m) => m.step === 'passive_decision');
      expect(decision?.decided).toBe('loggedOut');
      // Decided off the name that rendered, not the click fallback.
      expect(debug.some((m) => m.step === 'after_click')).toBe(false);
    },
  );

  // MEAL-15 found window.AB.userInfo.SWY_SHOP_TOKEN — the session bearer, which
  // Albertsons' own chat code labels okta_token — and proposed it as this check's
  // passive login marker. It is deliberately NOT a decider; the reasoning is at
  // the top of buildCheckLoginScript in albertsons.ts. This test pins the refusal
  // so nobody promotes it by accident, and pins that the diagnostic records
  // PRESENCE only: the value is a live bearer and must never reach a log.
  itWithFixture(
    'logged-in-home.html',
    'a present SWY_SHOP_TOKEN does not decide logged-in, and its value is never posted',
    async (runner) => {
      const TOKEN = 'z'.repeat(900);
      await runner.page.evaluate((tok) => {
        (window as unknown as { AB: unknown }).AB = {
          userInfo: { SWY_SHOP_TOKEN: tok, tokenExpiration: '1799999999' },
        };
      }, TOKEN);
      await emptyAccountName(runner);

      await runner.inject(scripts.checkLoginScript);
      await runner.waitForMessage('LOGIN_STATUS', 12_000);

      const decision = runner
        .messagesOfType('LOGIN_DEBUG')
        .find((m) => m.step === 'passive_decision');
      // A readable bearer does not license a passive logged-in verdict.
      expect(decision?.decided).toBe('ambiguous_empty_acct_name');
      // But it IS observed, so a real signed-in session can settle MEAL-15's
      // open question from a device log.
      expect(decision?.sessionMarker).toMatchObject({
        hasAB: true,
        hasToken: true,
        tokenLen: 900,
      });
      // Presence only — never the bearer itself, anywhere in the message stream.
      expect(JSON.stringify(runner.messages())).not.toContain(TOKEN);
    },
  );

  // ── The re-injection latch, pinned guard by guard ────────────────────────
  //
  // There are TWO guards and they do different jobs:
  //   (a) `if (window.__albLoginPosted) return;` at the top of the script, which
  //       stops a re-injection from re-running anything at all; and
  //   (b) the same check inside postStatus(), which stops a second verdict from
  //       a single run that reaches the exit twice.
  //
  // The test below ("posts exactly one LOGIN_STATUS") pins only their
  // CONJUNCTION: delete either guard on its own and it still passes, because
  // whichever one is left absorbs the second post. The two tests after it pin
  // (a) and (b) individually.
  itWithFixture(
    'logged-in-home.html',
    'posts exactly one LOGIN_STATUS when injected repeatedly in one context',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      await runner.waitForMessage('LOGIN_STATUS', 12_000);
      await runner.inject(scripts.checkLoginScript);
      await runner.inject(scripts.checkLoginScript);
      await new Promise((r) => setTimeout(r, 500));
      expect(runner.messagesOfType('LOGIN_STATUS')).toHaveLength(1);
    },
  );

  // (a) THE TOP GUARD, on its own. Its stated benefit is not "one LOGIN_STATUS"
  // — postStatus already delivers that — it is "don't stack a second 3-minute
  // background poller". After a logged-OUT verdict, postStatus has already
  // cleared __albLoginCheckActive, so with only the top guard removed a
  // re-injection re-runs full detection, early-returns inside postStatus, and
  // then falls into the background poll a second time. Nothing about the
  // LOGIN_STATUS count notices that; the poller's own output does.
  //
  // The fixture runner blocks CSS, so the hidden flyout's "Sign Out" is in
  // innerText and each poller emits LOGIN_COMPLETE on its first 2s tick. One
  // poller → one LOGIN_COMPLETE. The 'start' count is the same fact stated at
  // the other end of the script.
  itWithFixture(
    'logged-in-home.html',
    're-injection after a logged-out verdict starts no second background poller',
    async (runner) => {
      await stubSessionStorage(runner);
      await flipHeaderToSignedOut(runner);

      await runner.inject(scripts.checkLoginScript);
      expect((await runner.waitForMessage('LOGIN_STATUS', 12_000)).isLoggedIn).toBe(false);

      // Two more injections, as WebViewCartSheet/SilentLoginProbe would on nav.
      await runner.inject(scripts.checkLoginScript);
      await runner.inject(scripts.checkLoginScript);

      // Long enough for every poller's first tick (2s) to have fired.
      await new Promise((r) => setTimeout(r, 3_500));

      expect(runner.messagesOfType('LOGIN_COMPLETE')).toHaveLength(1);
      expect(
        runner.messagesOfType('LOGIN_DEBUG').filter((m) => m.step === 'start'),
      ).toHaveLength(1);
      expect(runner.messagesOfType('LOGIN_STATUS')).toHaveLength(1);
    },
  );

  // (b) THE postStatus GUARD, on its own — the case the top guard cannot cover,
  // because it is a single run reaching the exit twice. The click fallback posts
  // its verdict and THEN tidies up with document.body.click(); if that throws,
  // the catch calls postStatus(false, err). Without the guard the run would
  // contradict itself, and WebViewCartSheet (which does not latch) would drop a
  // signed-in user onto the login step.
  itWithFixture(
    'logged-in-home.html',
    'a throw after the verdict cannot post a contradicting second LOGIN_STATUS',
    async (runner) => {
      await makeAccountControlAmbiguous(runner); // forces the click fallback
      await runner.page.evaluate(() => {
        (document.body as unknown as { click: () => void }).click = () => {
          throw new Error('panel-close boom');
        };
      });

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(true);

      // Guard: it really did go through the click fallback, so the throw is on
      // the path this test claims to exercise.
      expect(runner.messagesOfType('LOGIN_DEBUG').some((m) => m.step === 'after_click')).toBe(
        true,
      );

      await new Promise((r) => setTimeout(r, 500));
      expect(runner.messagesOfType('LOGIN_STATUS')).toHaveLength(1);
    },
  );

  // ── The headerSignIn second signal ───────────────────────────────────────
  //
  // On real Albertsons markup the original selector matched NOTHING: the
  // platform ships no <header>, no <nav> and no [role="banner"] — the account
  // control sits in <div role="navigation" aria-label="Account and Cart">. The
  // branch read as a safety net that was not there, so [role="navigation"] was
  // added. This pins all three facts that decision rests on.
  itWithFixture(
    'logged-in-home.html',
    'headerSignIn scans a region that exists on this platform, without flipping a logged-in verdict',
    async (runner) => {
      const counts = await runner.page.evaluate(() => {
        const SIGNIN_RE = /sign\s?in|log\s?in|sign\s?up|create account/i;
        const hits = (sel: string) =>
          Array.from(document.querySelectorAll(sel)).filter((el) =>
            SIGNIN_RE.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')),
          ).length;
        return {
          legacyRegion: document.querySelectorAll(
            'header a, header button, nav a, nav button, [role="banner"] a, [role="banner"] button',
          ).length,
          navRegion: document.querySelectorAll('[role="navigation"] a, [role="navigation"] button')
            .length,
          navHits: hits('[role="navigation"] a, [role="navigation"] button'),
          documentWideHits: hits('a, button'),
        };
      });

      // Why the selector had to change: the old region is empty here.
      expect(counts.legacyRegion).toBe(0);
      // Why [role="navigation"] is the right widening: it exists…
      expect(counts.navRegion).toBeGreaterThan(0);
      // …and it holds no sign-in CTA while signed in, so it cannot post a false
      // loggedOut for a signed-in user.
      expect(counts.navHits).toBe(0);
      // Why it was NOT widened to the whole document: the signed-in page carries
      // sign-in/create-account controls in hidden dialogs (#menu,
      // #signin-dropdown, the <sign-in> form), which would do exactly that.
      expect(counts.documentWideHits).toBeGreaterThan(0);
    },
  );

  // And the branch now actually fires. With the account control ambiguous, a
  // sign-in CTA in the nav region is the only thing standing between us and the
  // click fallback — which, on this fixture, would answer loggedIn off the
  // CSS-hidden flyout. Revert the selector and this test fails.
  itWithFixture(
    'logged-in-home.html',
    'a sign-in CTA in the nav region decides loggedOut when the account control is ambiguous',
    async (runner) => {
      await makeAccountControlAmbiguous(runner);
      await runner.page.evaluate(() => {
        const nav = document.querySelector('[role="navigation"]');
        if (!nav) throw new Error('fixture drift: no [role="navigation"] region');
        const a = document.createElement('a');
        a.textContent = 'Sign In';
        nav.appendChild(a);
      });

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(false);
      expect(
        runner.messagesOfType('LOGIN_DEBUG').find((m) => m.step === 'passive_decision')?.decided,
      ).toBe('loggedOut');
    },
  );

  // The disclosure-correcting test (see the note at the top of this describe):
  // the signed-out half of the marker IS reachable from this capture. Only the
  // name span changes; aria-label stays "Account menu", and acctIsSignIn is
  // evaluated before acctIsMenu, so the verdict is loggedOut.
  itWithFixture(
    'logged-in-home.html',
    'flipping only the name span to "Sign in" decides loggedOut (acctIsSignIn beats acctIsMenu)',
    async (runner) => {
      // The span the platform reuses for both states, class list and all.
      const cls = await runner.page.evaluate(
        () => document.querySelector('span[data-qa="hdr-accnt-nm"]')?.className || '',
      );
      expect(cls).toContain('sign-in-up');

      await flipHeaderToSignedOut(runner);
      await runner.inject(scripts.checkLoginScript);

      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(false);
      const decision = runner
        .messagesOfType('LOGIN_DEBUG')
        .find((m) => m.step === 'passive_decision');
      expect(decision?.decided).toBe('loggedOut');
      // Decided off the account control itself, aria-label and all.
      expect(decision?.acctName).toMatch(/account\s*menu/i);
      expect(decision?.acctName).toMatch(/sign\s?in/i);
    },
  );

  // ── The sessionStorage cache (MEAL-42 follow-up) ─────────────────────────
  //
  // sessionStorage is stubbed rather than real because the fixture is loaded via
  // setContent on an opaque origin, where the real one throws SecurityError.
  // Stubbing keeps the test offline and deterministic; it exercises the same
  // getItem/setItem/removeItem calls the script makes, and lets the test read
  // back what the script stored.
  //
  // HISTORY, because one of these tests replaces a test that pinned a BUG.
  // The cache was originally consulted as an unconditional fast path ahead of
  // detection, and the test here asserted that the second run posted no
  // 'profile_btn' scan at all — i.e. it pinned "never re-detect once cached" as
  // if it were the desired behaviour. It is not: with nothing ever calling
  // removeItem, a cached 'in' answered true forever, including against a header
  // that plainly read "Sign In" after a logout or session expiry. That is a live
  // fault in WebViewCartSheet, which (unlike SilentLoginProbe) does not latch and
  // relies on a later LOGIN_STATUS:false to show the login step. The old
  // assertion is deliberately NOT preserved; the three tests below pin the
  // corrected contract instead:
  //   1. live detection always beats the cache (post-logout re-scan),
  //   2. the cache is still consulted when detection is inconclusive,
  //   3. a negative verdict clears a cached positive.

  // 1. THE REGRESSION. First run caches 'in'; then the header flips to the
  // signed-out shape and the window latches clear (a post-logout reload in the
  // same WebView). The verdict must follow the header, not the cache.
  itWithFixture(
    'logged-in-home.html',
    'post-logout reload re-detects and posts false — the cached positive does not win',
    async (runner) => {
      await stubSessionStorage(runner);

      await runner.inject(scripts.checkLoginScript);
      expect((await runner.waitForMessage('LOGIN_STATUS', 12_000)).isLoggedIn).toBe(true);
      // Guard: the positive really was cached, so this test can't pass vacuously.
      expect(await readCachedLoginState(runner)).toBe('in');

      runner.clearMessages();
      await flipHeaderToSignedOut(runner);
      await clearWindowLatches(runner);

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(false);

      const debug = runner.messagesOfType('LOGIN_DEBUG');
      const decision = debug.find((m) => m.step === 'passive_decision');
      expect(decision?.decided).toBe('loggedOut');
      expect(decision?.via).toBeUndefined(); // read the header, not the cache
      expect(debug.some((m) => m.step === 'profile_btn')).toBe(true); // it re-scanned

      // 3. And the disproved positive is gone, so nothing downstream can read it.
      expect(await readCachedLoginState(runner)).toBeNull();
    },
  );

  // 2. The one legitimate use, kept: an SSO landing page whose header has not
  // hydrated. Detection finds no account control at all, and WITHOUT the cache
  // the script would post isLoggedIn:false — the exact wrong answer
  // SilentLoginProbe latches. Simulated by removing the account control after a
  // successful first run.
  itWithFixture(
    'logged-in-home.html',
    'answers from sessionStorage when detection is inconclusive (unhydrated header)',
    async (runner) => {
      await stubSessionStorage(runner);

      await runner.inject(scripts.checkLoginScript);
      expect((await runner.waitForMessage('LOGIN_STATUS', 12_000)).isLoggedIn).toBe(true);

      runner.clearMessages();
      // Strip every account control: this is the header-less landing page.
      await runner.page.evaluate(() => {
        document
          .querySelectorAll(
            'button[aria-label*="account" i], button[aria-label*="profile" i], a[aria-label*="account" i]',
          )
          .forEach((el) => el.remove());
      });
      await clearWindowLatches(runner);

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(true);

      const debug = runner.messagesOfType('LOGIN_DEBUG');
      // Detection ran FIRST and came up empty — that is what licenses the cache.
      expect(debug.find((m) => m.step === 'profile_btn')?.found).toBe(false);
      expect(debug.find((m) => m.step === 'passive_decision')?.via).toBe('sessionStorage');
    },
  );

  // The cost of putting detection ahead of the cache, measured rather than
  // assumed. The claim the cache was originally sold on (~5s) was the
  // interstitial's dead poll, which the auth-URL bail already removes; a fresh
  // passive detection on the real captured homepage is tens of milliseconds.
  // Generous ceiling — this is a guard against someone reintroducing a 3s poll
  // on the happy path, not a benchmark.
  itWithFixture(
    'logged-in-home.html',
    'fresh passive detection costs milliseconds, not seconds',
    async (runner) => {
      const started = Date.now();
      await runner.inject(scripts.checkLoginScript);
      expect((await runner.waitForMessage('LOGIN_STATUS', 12_000)).isLoggedIn).toBe(true);
      const elapsed = Date.now() - started;
      // eslint-disable-next-line no-console
      console.log(`[MEAL-42] fresh passive detection: ${elapsed}ms`);
      expect(elapsed).toBeLessThan(500);
    },
  );

  // Pinning test: the captured account-panel DOM must contain "Sign Out"
  // / "Log Out" text. Catches real markup drift in the click fallback's
  // terminal condition.
  itWithFixture(
    'logged-in-account-panel-open.html',
    'captured account-panel DOM contains "Sign Out" marker',
    async (runner) => {
      const bodyText = await runner.page.evaluate(() =>
        (document.body.innerText || '').toLowerCase(),
      );
      expect(bodyText).toMatch(/sign out|log out/);
    },
  );
});

describe('Albertsons family CHECK_LOGIN on an SSO interstitial', () => {
  // Albertsons bounces through …/bin/safeway/unified/sso/authorize?code=… on the
  // way to the storefront. That page has no site header, so the old script polled
  // 3s for an account control, found none, and posted isLoggedIn:false —
  // measured at 3008ms to a WRONG answer, which SilentLoginProbe then latched
  // permanently (a login wall for an already-signed-in user).
  //
  // The fixture body is irrelevant here; the URL is the whole point, so any
  // header-less capture stands in for the interstitial.
  itWithFixture(
    'search-results-collapsed-bubble.html',
    'posts no verdict from an sso/authorize URL',
    async (runner) => {
      // Guard: if the navigation didn't take, this test would pass vacuously.
      const href = await runner.page.evaluate(() => window.location.href);
      expect(href).toContain('sso/authorize');

      await runner.inject(scripts.checkLoginScript);
      await new Promise((r) => setTimeout(r, 4_000)); // > the old 3s dead poll

      expect(runner.messagesOfType('LOGIN_STATUS')).toEqual([]);
      expect(
        runner.messagesOfType('LOGIN_DEBUG').some((m) => m.step === 'skip_auth_redirect'),
      ).toBe(true);
    },
    { url: 'https://www.albertsons.com/bin/safeway/unified/sso/authorize?code=test' },
  );
});

describe('Albertsons family regression: product already in cart (bubble state)', () => {
  itWithFixture(
    'search-results-product-in-cart.html',
    'completes without crashing when product is already in cart',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript('Sour Cream', 1, null);
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    },
  );
});

describe('Albertsons family regression: stepper already open', () => {
  itWithFixture(
    'search-results-stepper-open.html',
    'script handles a tile with the stepper already visible',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript('Sour Cream', 1, null);
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      expect(result).toBeDefined();
    },
  );
});

describe('Albertsons family EXTRACT_PRODUCTS_SCRIPT', () => {
  itWithFixture(
    'search-results-tortillas.html',
    'extracts ≥1 product candidate',
    async (runner) => {
      await runner.inject(scripts.extractProductsScript);
      const result = await runner.waitForMessage('SEARCH_RESULT', 12_000);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].productName).toBeTruthy();
    },
    // The extractor now bails unless it's on a real search-results page (guards
    // against scraping homepage/recommendation carousels), so load the fixture
    // under a matching URL.
    { url: 'https://www.albertsons.com/shop/search-results.html?q=tortillas' },
  );
});
