// Looking the ingredients up from the SELECTION screen, before the cart sheet
// is even open.
//
// The cart sheet has prewarmed its searches for a while, from the quantity
// screen. That is a real head start but a short one: on a measured 36-ingredient
// run the batch was still answering when the user tapped, and the run stood and
// waited 2.5s for it. Starting at the moment meals are ticked gives it several
// seconds more.
//
// Stephen's condition for doing it, and the whole subject of this file:
//
//   "what if I selected every meal, then remove all but 1. Are we going to do
//    lookup on a dozen meals? Is there a way to drop the unselected meals from
//    the prewarm?"
//
// Two mechanisms, both pinned here:
//
//   • Nothing is sent until the selection stops changing. A dozen taps in a
//     couple of seconds is a dozen calls in and nothing out.
//   • The batch is built from the selection AS IT STANDS when it fires, not
//     from the set that was current when any particular tap happened.
//
// The observable is the terms the hidden search probe is mounted with, because
// that IS what goes to the store. Asserting on the provider's internal maps
// would pass whether or not a request was ever made.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';

const mockKeychain = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockKeychain.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockKeychain.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockKeychain.delete(k); }),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));

// Both hidden probes are parked rather than run: jsdom has no WebView, so a
// test lands each answer at the moment it chooses.
jest.mock('../../src/components/SilentLoginProbe', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return {
    __esModule: true,
    default: (props: any) => {
      RealReact.useEffect(() => { ((globalThis as any).__loginProbes ||= []).push(props); }, []);
      return RealReact.createElement(RealView, { testID: `login-probe-${props.storeId}` });
    },
  };
});

jest.mock('../../src/components/SilentSearchProbe', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return {
    __esModule: true,
    default: (props: any) => {
      RealReact.useEffect(() => { ((globalThis as any).__searchProbes ||= []).push(props); }, []);
      return RealReact.createElement(RealView, { testID: `search-probe-${props.storeId}` });
    },
  };
});

jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    auth: {
      login: jest.fn(),
      logout: jest.fn(async () => ({ ok: true })),
      verify: jest.fn(async () => { throw new Error('no session'); }),
      renew: jest.fn(async () => ({})),
      verify2FA: jest.fn(),
    },
    creators: { getMe: jest.fn(async () => ({ creator: null })) },
    usage: { ...actual.usage, logOpen: jest.fn(async () => {}) },
  };
});

jest.mock('../../src/lib/push', () => ({ unregisterDevice: jest.fn(async () => {}) }));

import { AuthProvider, useAuth } from '../../src/context/AuthContext';
import { LoginPrewarmProvider, useLoginPrewarm } from '../../src/context/LoginPrewarmContext';
import { prewarmTermsForMeals } from '../../src/lib/prewarmTerms';
import { auth } from '../../src/lib/api';

const login = auth.login as jest.Mock;

const STORE = 'albertsons';   // a rail store; the prewarm only runs where one exists

type LoginProbeProps = { storeId: string; onLogin: Function; onResult: Function; onError: Function };
type SearchProbeProps = { storeId: string; terms: string[]; onCandidates: Function; onDone: Function };

const loginProbes = () => ((globalThis as any).__loginProbes ||= []) as LoginProbeProps[];
const searchProbes = () => ((globalThis as any).__searchProbes ||= []) as SearchProbeProps[];

/** Twelve meals, two ingredients each, all unchosen — the shape of the question. */
const MEALS = Array.from({ length: 12 }, (_, i) => ({
  id: `m${i}`,
  name: `Meal ${i}`,
  ingredients: [
    { ingredientName: `first-${i}`, productQty: 1, unit: 'qty', measure: null, searchTerm: null },
    { ingredientName: `second-${i}`, productQty: 1, unit: 'qty', measure: null, searchTerm: null },
  ],
}));

let prewarm: ReturnType<typeof useLoginPrewarm>;

function Screens() {
  const { user, login: doLogin, logout } = useAuth();
  prewarm = useLoginPrewarm();
  return (
    <>
      <Text testID="who">{user?.id ?? 'signed-out'}</Text>
      <TouchableOpacity testID="login" onPress={() => { void doLogin('a@example.com', 'pw'); }}>
        <Text>log in</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="logout" onPress={() => { void logout(); }}>
        <Text>log out</Text>
      </TouchableOpacity>
    </>
  );
}

async function renderApp() {
  const utils = render(
    <AuthProvider>
      <LoginPrewarmProvider>
        <Screens />
      </LoginPrewarmProvider>
    </AuthProvider>,
  );
  await act(async () => { await Promise.resolve(); });
  login.mockResolvedValue({ accessToken: 'token-A', user: { id: 'user-A', email: 'a@example.com' } });
  await act(async () => { fireEvent.press(utils.getByTestId('login')); });
  await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-A'));
  return utils;
}

/** The store answers the login check: signed in. */
async function signedInAt(storeId: string) {
  await act(async () => { prewarm.checkStore(storeId); });
  const probe = loginProbes().find((p) => p.storeId === storeId);
  if (!probe) throw new Error(`no login probe for ${storeId}`);
  await act(async () => { probe.onResult(storeId, true, undefined); jest.advanceTimersByTime(1); });
}

/** What MyMealsScreen does on a selection change, with the same derivation. */
function select(meals: typeof MEALS) {
  act(() => { prewarm.setSearchTerms(STORE, prewarmTermsForMeals(meals, STORE)); });
}

/** Let the debounce expire. */
async function settle() {
  await act(async () => { jest.advanceTimersByTime(5000); await Promise.resolve(); });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockKeychain.clear();
  (globalThis as any).__loginProbes = [];
  (globalThis as any).__searchProbes = [];
});
afterEach(() => { jest.useRealTimers(); });

describe('ticking everything and then unticking it', () => {
  it('looks up ONE meal when eleven of the twelve are unticked again', async () => {
    await renderApp();
    await signedInAt(STORE);

    // Tick all twelve, one tap at a time, the way a hand moves down a list.
    for (let i = 1; i <= 12; i += 1) {
      select(MEALS.slice(0, i));
      await act(async () => { jest.advanceTimersByTime(150); });
    }
    // ...then untick eleven of them.
    for (let i = 11; i >= 1; i -= 1) {
      select(MEALS.slice(0, i));
      await act(async () => { jest.advanceTimersByTime(150); });
    }
    // Still nothing sent: every tap restarted the clock.
    expect(searchProbes()).toHaveLength(0);

    await settle();

    // One batch, and it holds the surviving meal's two ingredients — not the
    // twenty-four that were ticked at the high-water mark.
    expect(searchProbes()).toHaveLength(1);
    expect(searchProbes()[0].storeId).toBe(STORE);
    expect(searchProbes()[0].terms.sort()).toEqual(['first-0', 'second-0']);
  });

  it('sends nothing at all when the selection is emptied before it settles', async () => {
    await renderApp();
    await signedInAt(STORE);

    select(MEALS.slice(0, 12));
    await act(async () => { jest.advanceTimersByTime(300); });
    select([]);
    await settle();

    expect(searchProbes()).toHaveLength(0);
  });
});

describe('switching store tabs', () => {
  // The same waste as unticking, arriving by a different door. Tapping a store
  // tab clears the selection and points the screen at another store, so the
  // meals ticked a second ago are not being shopped for any more — and a batch
  // for them must not go out because a debounce was already ticking.
  it('does not fire the batch the store you just left had pending', async () => {
    await renderApp();
    await signedInAt('heb');
    await signedInAt(STORE);

    // Ticking at H-E-B...
    act(() => { prewarm.setSearchTerms('heb', prewarmTermsForMeals(MEALS.slice(0, 2), 'heb')); });
    await act(async () => { jest.advanceTimersByTime(300); });
    // ...then straight to the Albertsons tab, which arrives with nothing ticked.
    act(() => { prewarm.setSearchTerms(STORE, []); });
    await settle();

    expect(searchProbes()).toHaveLength(0);
  });

  it('looks up the store you switched TO, once something is ticked there', async () => {
    await renderApp();
    await signedInAt('heb');
    await signedInAt(STORE);

    act(() => { prewarm.setSearchTerms('heb', prewarmTermsForMeals(MEALS.slice(0, 2), 'heb')); });
    await act(async () => { jest.advanceTimersByTime(300); });
    act(() => { prewarm.setSearchTerms(STORE, []); });
    select(MEALS.slice(0, 1));
    await settle();

    expect(searchProbes()).toHaveLength(1);
    expect(searchProbes()[0].storeId).toBe(STORE);
    expect(searchProbes()[0].terms.sort()).toEqual(['first-0', 'second-0']);
  });
});

describe('what it will and will not ask', () => {
  it('waits for the login check — a probe at a signed-out page answers nothing', async () => {
    await renderApp();
    select(MEALS.slice(0, 1));
    await settle();
    expect(searchProbes()).toHaveLength(0);

    // The moment the store comes back signed-in, the waiting selection goes.
    await signedInAt(STORE);
    await settle();
    expect(searchProbes()).toHaveLength(1);
    expect(searchProbes()[0].terms.sort()).toEqual(['first-0', 'second-0']);
  });

  it('never asks a store it has been told the user is signed OUT of', async () => {
    await renderApp();
    await act(async () => { prewarm.checkStore(STORE); });
    const probe = loginProbes().find((p) => p.storeId === STORE)!;
    await act(async () => { probe.onResult(STORE, false, undefined); jest.advanceTimersByTime(1); });

    select(MEALS.slice(0, 1));
    await settle();
    expect(searchProbes()).toHaveLength(0);
  });

  it('does not ask again for a term it has already answered', async () => {
    await renderApp();
    await signedInAt(STORE);

    select(MEALS.slice(0, 1));
    await settle();
    const first = searchProbes()[0];
    await act(async () => {
      first.onCandidates(STORE, 'first-0', [{ productId: '1' }]);
      first.onCandidates(STORE, 'second-0', [{ productId: '2' }]);
      first.onDone(STORE);
      jest.advanceTimersByTime(1);
    });

    // Untick, then tick the same meal again — a user changing their mind.
    select([]);
    select(MEALS.slice(0, 1));
    await settle();
    expect(searchProbes()).toHaveLength(1);   // no second batch

    // ...and the sheet gets the answers when it asks for them.
    const have = prewarm.getSearchResults(STORE, ['first-0', 'second-0']);
    expect([...have.keys()].sort()).toEqual(['first-0', 'second-0']);
  });

  it('only asks for what is NEW when the selection grows', async () => {
    await renderApp();
    await signedInAt(STORE);

    select(MEALS.slice(0, 1));
    await settle();
    await act(async () => { searchProbes()[0].onDone(STORE); jest.advanceTimersByTime(1); });

    select(MEALS.slice(0, 2));
    await settle();
    expect(searchProbes()).toHaveLength(2);
    expect(searchProbes()[1].terms.sort()).toEqual(['first-1', 'second-1']);
  });

  it('runs one batch at a time, whatever the selection does mid-flight', async () => {
    await renderApp();
    await signedInAt(STORE);

    select(MEALS.slice(0, 1));
    await settle();
    expect(searchProbes()).toHaveLength(1);

    // A batch is on the wire. Growing the selection now must not open a second.
    select(MEALS.slice(0, 3));
    await settle();
    expect(searchProbes()).toHaveLength(1);

    // It goes out when the first one is finished, and covers what is still wanted.
    await act(async () => { searchProbes()[0].onDone(STORE); jest.advanceTimersByTime(1); });
    expect(searchProbes()).toHaveLength(2);
    expect(searchProbes()[1].terms.sort()).toEqual(['first-1', 'first-2', 'second-1', 'second-2']);
  });
});

describe('standing down while a batch is on the wire', () => {
  // MEASURED 2026-09-02, and the worst case there is. The sheet opened 8s after
  // this probe started its batch; standing the probe down only stopped it
  // starting ANOTHER one, so the probe, the sheet's own prewarm and then the run
  // were all searching Albertsons at the same time. Every term came back
  // `no_response` and the user was handed the store to finish by hand.
  it('stops the batch, rather than only declining to start the next one', async () => {
    const utils = await renderApp();
    await signedInAt(STORE);
    select(MEALS.slice(0, 1));
    await settle();
    expect(utils.queryByTestId(`search-probe-${STORE}`)).not.toBeNull();

    // What MyMealsScreen does when the cart sheet opens.
    act(() => { prewarm.setSearchTerms(STORE, []); });
    expect(utils.queryByTestId(`search-probe-${STORE}`)).toBeNull();
  });

  it('keeps the answers that did arrive before it was stopped', async () => {
    await renderApp();
    await signedInAt(STORE);
    select(MEALS.slice(0, 1));
    await settle();
    await act(async () => {
      searchProbes()[0].onCandidates(STORE, 'first-0', [{ productId: '1' }]);
      jest.advanceTimersByTime(1);
    });

    act(() => { prewarm.setSearchTerms(STORE, []); });

    // The sheet still gets what was answered — that is the head start, and
    // stopping the probe must not throw it away.
    const have = prewarm.getSearchResults(STORE, ['first-0', 'second-0']);
    expect([...have.keys()]).toEqual(['first-0']);
  });

  it('will ask again for a term the stopped batch never answered', async () => {
    await renderApp();
    await signedInAt(STORE);
    select(MEALS.slice(0, 1));
    await settle();
    await act(async () => {
      searchProbes()[0].onCandidates(STORE, 'first-0', [{ productId: '1' }]);
      jest.advanceTimersByTime(1);
    });
    act(() => { prewarm.setSearchTerms(STORE, []); });

    // Back to the selection screen, same meal ticked again.
    select(MEALS.slice(0, 1));
    await settle();

    // Only the unanswered one. The answered term is served from cache.
    expect(searchProbes()).toHaveLength(2);
    expect(searchProbes()[1].terms).toEqual(['second-0']);
  });
});

describe('signing out', () => {
  it('unmounts the probe and drops what it had looked up', async () => {
    const utils = await renderApp();
    await signedInAt(STORE);
    select(MEALS.slice(0, 1));
    await settle();
    await act(async () => {
      searchProbes()[0].onCandidates(STORE, 'first-0', [{ productId: '1' }]);
      jest.advanceTimersByTime(1);
    });
    expect(utils.queryByTestId(`search-probe-${STORE}`)).not.toBeNull();

    await act(async () => { fireEvent.press(utils.getByTestId('logout')); });
    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('signed-out'));

    expect(utils.queryByTestId(`search-probe-${STORE}`)).toBeNull();
    expect(prewarm.getSearchResults(STORE, ['first-0']).size).toBe(0);
  });
});
