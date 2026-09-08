/**
 * Sign-out has to reach the caches the cookie jar does not cover.
 *
 * Stephen: "is there anything we can do to make log out of grocery stores work
 * on ALDI?" The jar clearing is real -- the session is HttpOnly and the rail
 * calls same-origin /graphql, so a cleared jar leaves nothing to present. What
 * it never touched is localStorage, where the rail keeps the shop id and the
 * delivery zone the SIGNED-IN session chose. His captures showed it: shopFrom
 * "cache", the same shop id 8583, on both sides of a sign-out.
 */
import {
  loadEpoch, bumpEpoch, resetEpoch,
} from '../../src/lib/store-session-epoch-storage';
import { currentEpoch, epochKey } from '../../src/lib/store-session-epoch';
import * as SecureStore from 'expo-secure-store';
import { buildInstacartSessionScript } from '../../src/lib/webview-scripts/instacart-network';

jest.mock('expo-secure-store', () => {
  const mem: Record<string, string> = {};
  return {
    __mem: mem,
    getItemAsync: jest.fn(async (k: string) => (k in mem ? mem[k] : null)),
    setItemAsync: jest.fn(async (k: string, v: string) => { mem[k] = v; }),
    deleteItemAsync: jest.fn(async (k: string) => { delete mem[k]; }),
  };
});

const mem = (SecureStore as unknown as { __mem: Record<string, string> }).__mem;

beforeEach(async () => {
  for (const k of Object.keys(mem)) delete mem[k];
  jest.clearAllMocks();
  await resetEpoch();
});

describe('the sign-out generation', () => {
  it('starts at zero and leaves the key exactly as it was', async () => {
    // Generation zero must emit the ORIGINAL key, or shipping this would
    // orphan every existing install's caches for no reason.
    await loadEpoch();
    expect(currentEpoch()).toBe(0);
    expect(epochKey('__mealio_ic_shop_v1')).toBe('__mealio_ic_shop_v1');
  });

  it('changes every key when the button bumps it', async () => {
    await loadEpoch();
    const before = epochKey('__mealio_ic_shop_v1');
    await bumpEpoch();
    const after = epochKey('__mealio_ic_shop_v1');
    expect(after).not.toBe(before);
    expect(currentEpoch()).toBe(1);
  });

  it('survives a restart, so the sign-out is not undone by relaunching', async () => {
    await loadEpoch();
    await bumpEpoch();
    await resetEpoch();          // wipes memory AND storage
    expect(currentEpoch()).toBe(0);
    mem['mealio.storeSession.epoch'] = '4';   // as if a previous install had bumped
    await loadEpoch();
    expect(currentEpoch()).toBe(4);
    expect(epochKey('k')).toBe('k_g4');
  });

  it('reads a broken keychain as generation zero, not as a new generation', async () => {
    // The safe direction. Inventing a generation because storage hiccuped would
    // silently discard every store's cache on a device with nothing wrong.
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keychain'));
    await loadEpoch();
    expect(currentEpoch()).toBe(0);
  });

  it('takes effect for this session even when the write fails', async () => {
    // A failed write means it does not survive a restart. Ignoring the button
    // the user just pressed would be the bigger wrong.
    await loadEpoch();
    (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error('full'));
    await bumpEpoch();
    expect(currentEpoch()).toBe(1);
  });

  it('rejects a stored value that is not a positive number', async () => {
    mem['mealio.storeSession.epoch'] = 'not-a-number';
    await loadEpoch();
    expect(currentEpoch()).toBe(0);
  });
});

describe('what the injected script actually carries', () => {
  it('stamps the rail caches, so a bump orphans them', async () => {
    // The point of the whole mechanism, asserted on the emitted script rather
    // than on the helper: the key the PAGE reads has to change.
    await loadEpoch();
    const before = buildInstacartSessionScript('aldi');
    expect(before).toContain("'__mealio_ic_shop_v1'");

    await bumpEpoch();
    const after = buildInstacartSessionScript('aldi');
    expect(after).toContain("'__mealio_ic_shop_v1_g1'");
    // And the old key is nowhere in it, or the page would still find the entry.
    expect(after).not.toContain("'__mealio_ic_shop_v1'");
  });

  it('stamps the zone and the ops cache too, not just the shop', async () => {
    await loadEpoch();
    await bumpEpoch();
    const script = buildInstacartSessionScript('aldi');
    expect(script).toContain('__mealio_ic_ops_v1_g1');
    // The zone cache is written by the search script, not the session one.
    expect(buildInstacartSessionScript('aldi')).not.toContain('__mealio_ic_ops_v1\'');
  });
});

describe('the sign-out button keeps calling it', () => {
  // A SOURCE CHECK, and worth saying so plainly rather than dressing it up as
  // behaviour. Nothing in the suite renders AccountScreen's sign-out row -- it
  // is a heavy screen behind an Alert confirmation -- so without this, deleting
  // the bumpEpoch() call would leave every test green while the button silently
  // went back to clearing cookies and nothing else. That is exactly the failure
  // this whole change exists to fix, so it gets a tripwire even a coarse one.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'screens', 'account', 'AccountScreen.tsx'), 'utf8');

  it.each([
    ['CookieManager.clearAll', 'the cookie jar, which carries the session itself'],
    ['prewarm.forgetAll', 'the cached login answers, which outlive the cookies'],
    ['bumpEpoch', 'the rail caches in localStorage, which outlive both'],
  ])('still clears %s -- %s', (call) => {
    expect(src).toContain(call);
  });

  it('imports bumpEpoch from the storage module, not the pure one', () => {
    // The pure module has no bumpEpoch. Importing from it would be a compile
    // error today, but the split is subtle enough to be worth pinning.
    expect(src).toContain("from '../../lib/store-session-epoch-storage'");
  });
});

// ── THE SAME BUG, WORSE, ON ANOTHER STORE ───────────────────────────────────
//
// Stephen: "any of these bugs you [found], would they affect any other store?"
//
// Yes, and the worst instance was not the one that prompted the question. The
// Wegmans rail caches a bearer token AND a refresh token in the store origin's
// localStorage, and posts grant_type=refresh_token to mint new access tokens
// from the cached refresh token for up to 24 hours. CookieManager.clearAll
// never touches localStorage, so "sign out of all grocery stores" left Wegmans
// able to mint fresh sessions.
//
// A stale shop id can be orphaned and forgotten about. A live refresh token
// cannot, so those keys are swept rather than merely stamped.
describe('sweeping old generations', () => {
  const { sweepOldGenerationsJs } = require('../../src/lib/store-session-epoch');

  it('names the current key as one to KEEP, not one to remove', async () => {
    await loadEpoch();
    await bumpEpoch();
    const js = sweepOldGenerationsJs(['__mealio_weg_tok_v1']);
    expect(js).toContain('__mealio_weg_tok_v1_g1');
    // The base name appears too -- it is what old entries are matched against.
    expect(js).toContain('__mealio_weg_tok_v1');
  });

  it('emits something that runs, and removes only what it should', async () => {
    await loadEpoch();
    await bumpEpoch();
    const store: Record<string, string> = {
      '__mealio_weg_tok_v1': 'OLD-BEARER',           // pre-epoch, must go
      '__mealio_weg_tok_v1_g1': 'CURRENT',           // current, must stay
      '__mealio_weg_rt_v1_g0': 'OLDER-REFRESH',      // an older generation
      'glassCartIdMap': "WALMART'S OWN",             // not ours, must stay
      'unrelated': 'keep me',
    };
    const localStorage = {
      get length() { return Object.keys(store).length; },
      key: (i: number) => Object.keys(store)[i] ?? null,
      removeItem: (k: string) => { delete store[k]; },
    };
    // eslint-disable-next-line no-new-func
    new Function('localStorage', sweepOldGenerationsJs(
      ['__mealio_weg_tok_v1', '__mealio_weg_rt_v1'],
    ))(localStorage);

    expect(Object.keys(store).sort()).toEqual(
      ['__mealio_weg_tok_v1_g1', 'glassCartIdMap', 'unrelated'].sort());
  });

  it('leaves a store its OWN keys, which we only read', async () => {
    // Walmart's cart map is Walmart's key, not ours. Stamping or sweeping it
    // would break the read rather than protect anything.
    await loadEpoch();
    const js = sweepOldGenerationsJs(['__mealio_ic_shop_v1']);
    expect(js).not.toContain('glassCartIdMap');
  });

  it('is a no-op at generation zero, so an upgrade deletes nothing', async () => {
    await loadEpoch();
    const store: Record<string, string> = { '__mealio_weg_tok_v1': 'live' };
    const localStorage = {
      get length() { return Object.keys(store).length; },
      key: (i: number) => Object.keys(store)[i] ?? null,
      removeItem: (k: string) => { delete store[k]; },
    };
    // eslint-disable-next-line no-new-func
    new Function('localStorage', sweepOldGenerationsJs(['__mealio_weg_tok_v1']))(localStorage);
    expect(store['__mealio_weg_tok_v1']).toBe('live');
  });
});

// ── A STORE'S OWN KEY, CLEARED ONCE ─────────────────────────────────────────
//
// Walmart keeps glassCartIdMap in localStorage and its isGuest flag is the
// WHOLE of that rail's login check. localStorage outlives CookieManager
// .clearAll, so after signing out of every grocery store the stale map still
// said isGuest:false and the probe reported a signed-out user as SIGNED IN.
// Measured on the Pixel 2026-09-07, on the last store whose login had not been
// driven yet -- which is why it survived every earlier pass.
//
// It cannot be stamped like our own keys: we do not write it, and renaming it
// would break the read it exists for. So it is deleted, exactly once per
// sign-out.
describe('clearing a store’s own cache after a sign-out', () => {
  const { sweepForeignKeysOnceJs } = require('../../src/lib/store-session-epoch');

  function run(js: string, store: Record<string, string>) {
    const localStorage = {
      get length() { return Object.keys(store).length; },
      key: (i: number) => Object.keys(store)[i] ?? null,
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    // eslint-disable-next-line no-new-func
    if (js) new Function('localStorage', js)(localStorage);
  }

  it('does nothing at all before the first sign-out', async () => {
    // A fresh install has nothing to clear, and clearing would break the
    // storefront once for no reason.
    await loadEpoch();
    expect(sweepForeignKeysOnceJs(['glassCartIdMap'])).toBe('');
  });

  it('clears the key on the first run after a sign-out', async () => {
    await loadEpoch();
    await bumpEpoch();
    const store: Record<string, string> = { glassCartIdMap: '{"isGuest":false}', other: 'keep' };
    run(sweepForeignKeysOnceJs(['glassCartIdMap']), store);
    expect(store.glassCartIdMap).toBeUndefined();
    expect(store.other).toBe('keep');
  });

  it('leaves it alone on every run after that', async () => {
    // The store rebuilds the map immediately, and deleting it on every run
    // would throw away the cart identity mid-session.
    await loadEpoch();
    await bumpEpoch();
    const store: Record<string, string> = { glassCartIdMap: 'old' };
    const js = sweepForeignKeysOnceJs(['glassCartIdMap']);
    run(js, store);
    store.glassCartIdMap = 'rebuilt by the storefront';
    run(js, store);
    expect(store.glassCartIdMap).toBe('rebuilt by the storefront');
  });

  it('clears again after the NEXT sign-out', async () => {
    await loadEpoch();
    await bumpEpoch();
    const store: Record<string, string> = { glassCartIdMap: 'a' };
    run(sweepForeignKeysOnceJs(['glassCartIdMap']), store);
    store.glassCartIdMap = 'rebuilt';
    await bumpEpoch();
    run(sweepForeignKeysOnceJs(['glassCartIdMap']), store);
    expect(store.glassCartIdMap).toBeUndefined();
  });
});
