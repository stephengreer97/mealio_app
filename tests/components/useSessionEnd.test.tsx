// The transition table for `useSessionEnd` itself (MEAL-146).
//
// Every privacy teardown in the app now hangs off this one hook, and the two
// things it must NOT do are as load-bearing as the thing it must: firing on a
// token renewal would clear a live user's diagnostics and kill their in-flight
// cart run, and firing on an ordinary sign-in would delete the signed-out
// launch's own login output — exactly what a "it will not let me sign in"
// report needs to carry.
//
// The consumers are pinned end to end against real providers elsewhere
// (account-switch-boundary.test.tsx, cart-signout-boundary.test.tsx,
// prewarm-signout.test.tsx, mymeals-signout-ingredient-saves.test.tsx). This
// file exists because those consumers cannot reach every branch: nothing is
// mounted while signed out for a null → B teardown to damage, so the guard that
// stops one is invisible from outside. It is still the guard the next consumer
// will lean on.

import { act, render } from '@testing-library/react-native';
import React from 'react';

/**
 * A real context, driven by re-render, so `user` changes the way it really does
 * — from above, with a fresh object each time.
 */
jest.mock('../../src/context/AuthContext', () => {
  const RealReact = jest.requireActual('react');
  const Ctx = RealReact.createContext({ user: null });
  return {
    __esModule: true,
    AuthTestContext: Ctx,
    useAuth: () => RealReact.useContext(Ctx),
  };
});

import { useSessionEnd } from '../../src/context/useSessionEnd';

const { AuthTestContext } = jest.requireMock('../../src/context/AuthContext') as any;

type U = { id: string } | null;

/** Every time the hook decided a session had ended. */
let ends = 0;
/**
 * Mount-effect runs of a plain sibling in the same tree. Only read by the
 * StrictMode test, to prove React really did double-invoke there rather than
 * the test passing because nothing ran twice.
 */
let effectRuns = 0;

function Consumer() {
  useSessionEnd(() => { ends += 1; });
  return null;
}

function Witness() {
  React.useEffect(() => { effectRuns += 1; }, []);
  return null;
}

function Host({ user }: { user: U }) {
  return (
    <AuthTestContext.Provider value={{ user }}>
      <Consumer />
      <Witness />
    </AuthTestContext.Provider>
  );
}

/**
 * StrictMode has to be the ELEMENT handed to `render`, not returned from a
 * component that is. Measured under this runner: a StrictMode one level down
 * runs a mount effect once, a top-level one runs it twice — so wrapping it in a
 * component would have made the double-invocation test below silently vacuous,
 * which is what `Witness` is there to catch.
 */
const strictly = (user: U) => <React.StrictMode><Host user={user} /></React.StrictMode>;

const A = () => ({ id: 'user-A' });
const B = () => ({ id: 'user-B' });

function mount(user: U) {
  ends = 0;
  effectRuns = 0;
  return render(<Host user={user} />);
}

async function become(r: ReturnType<typeof render>, user: U) {
  await act(async () => { r.update(<Host user={user} />); });
}

describe('useSessionEnd', () => {
  it('says nothing when it mounts into a session already in progress', async () => {
    // A provider or screen mounting mid-session has inherited nothing — there is
    // no earlier session for it to be holding anyone else's state from.
    mount(A());
    expect(ends).toBe(0);
  });

  it('says nothing when it mounts with nobody signed in', async () => {
    mount(null);
    expect(ends).toBe(0);
  });

  it('fires when a different account takes over without a sign-out', async () => {
    // The MEAL-146 transition: the verification deep link calls loginWithToken
    // with no signed-in check, so A → B never passes through null.
    const r = mount(A());
    await become(r, B());
    expect(ends).toBe(1);
  });

  it('fires on a sign-out', async () => {
    // The MEAL-142 transition, which is now just one case of the above.
    const r = mount(A());
    await become(r, null);
    expect(ends).toBe(1);
  });

  it('stays silent when the same account is handed down as a new object', async () => {
    // A token renewal and a refreshUser both do this, several times a session.
    const r = mount(A());
    await become(r, A());
    await become(r, A());
    expect(ends).toBe(0);
  });

  it('stays silent on a sign-in from signed out', async () => {
    const r = mount(null);
    await become(r, B());
    expect(ends).toBe(0);
  });

  it('stays silent on the sign-in that follows a sign-out', async () => {
    // The sequencing trap: the departing id has to be forgotten AS the sign-out
    // is reported, not left behind for the next sign-in to be compared against.
    // Recording it after any bail-out makes this read as A → B and tears down
    // B's own fresh session.
    const r = mount(A());
    await become(r, null);
    expect(ends).toBe(1);
    await become(r, B());
    expect(ends).toBe(1);
  });

  it('survives its own effect being run twice for one commit', async () => {
    // StrictMode double-invokes effects in development, and Fast Refresh re-runs
    // them too. Both hand this hook the id it has already recorded — which is
    // the only way the "same account" branch is reachable at all, since the
    // effect otherwise depends on the id and React does not re-run it for an
    // unchanged one. Without that branch, a development build would tear down a
    // live session on mount.
    ends = 0;
    effectRuns = 0;
    const r = render(strictly(A()));
    expect(effectRuns).toBeGreaterThan(1); // the double-invocation really happened
    expect(ends).toBe(0);
    await act(async () => { r.update(strictly(A())); });
    expect(ends).toBe(0);
    await act(async () => { r.update(strictly(B())); });
    expect(ends).toBe(1);
  });
});
