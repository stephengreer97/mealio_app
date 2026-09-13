// THE LOGIN CHECK ASKS OVER HTTP BEFORE IT BUILDS ANYTHING.
//
// Stephen, 2026-09-11: "Don't spawn webviews if we don't have to." Measured on
// his Pixel the same day, a Chromium renderer costs 8,499ms to build and the
// native login check costs about 400ms. So the probe stopped being the first
// move and became the last resort.
//
// The suites next door pin the probe path by stubbing the checker to send every
// store down it. This one pins the three branches that decide whether the probe
// runs at all:
//
//   answered natively   no probe, ever
//   empty cookie jar    no probe and no request either
//   needs a renderer    the probe, exactly as before
//
// Plus the race the change introduced, which is the one that could leak.
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

// `mock`-prefixed because jest hoists mock factories above every other
// statement, and only names starting with `mock` may be referenced from inside
// one. Without the prefix the whole file fails to transform rather than failing
// an assertion, which reads as something far worse than it is.
const mockLoginProbes: Array<{ storeId: string }> = [];
let mockCurrentUser: { id: string } | null = { id: 'a' };

jest.mock('../../src/components/SilentLoginProbe', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: (props: { storeId: string }) => {
      R.useEffect(() => { mockLoginProbes.push({ storeId: props.storeId }); }, []);
      return null;
    },
  };
});
jest.mock('../../src/components/SilentSearchProbe', () => ({
  __esModule: true, default: () => null,
}));

jest.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: mockCurrentUser }),
}));

import { LoginPrewarmProvider, useLoginPrewarm } from '../../src/context/LoginPrewarmContext';
import {
  __setLoginCheckerForTests, __resetLoginCheckerForTests, LoginVerdict,
} from '../../src/lib/native-login';

const verdict = (state: LoginVerdict['state']): LoginVerdict =>
  ({ state, how: 'from the test', ms: 1 });

let api: ReturnType<typeof useLoginPrewarm>;
function Harness() {
  api = useLoginPrewarm();
  return <Text>ready</Text>;
}

const mount = () => render(
  <LoginPrewarmProvider><Harness /></LoginPrewarmProvider>,
);

/** Let the check's promise chain and the deferred pump both run. */
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  mockLoginProbes.length = 0;
  mockCurrentUser = { id: 'a' };
});
afterEach(() => { __resetLoginCheckerForTests(); });

describe('the login check that costs no renderer', () => {
  it('answers signed IN without mounting a probe', async () => {
    __setLoginCheckerForTests(async () => verdict('in'));
    mount();
    await act(async () => { api.checkStore('heb'); });
    await flush();

    expect(mockLoginProbes).toEqual([]);
    expect(api.getStatus('heb')).toBe('loggedIn');
  });

  it('answers signed OUT without mounting a probe', async () => {
    // The empty-jar case reaches here too: it is the same verdict, reached
    // without even a request.
    __setLoginCheckerForTests(async () => verdict('out'));
    mount();
    await act(async () => { api.checkStore('heb'); });
    await flush();

    expect(mockLoginProbes).toEqual([]);
    expect(api.getStatus('heb')).toBe('loggedOut');
  });

  it('falls back to the probe when the store cannot be asked over HTTP', async () => {
    // Wegmans, measured: its bearer is encrypted in the site's own localStorage,
    // so there is no request that answers this. The renderer is the only way and
    // the fallback has to still work.
    __setLoginCheckerForTests(async () => verdict('needs-webview'));
    mount();
    await act(async () => { api.checkStore('heb'); });
    await flush();

    expect(mockLoginProbes.map((p) => p.storeId)).toEqual(['heb']);
  });

  it('does not start a second check for a store already being checked', async () => {
    // The window is real now: checkStore used to be synchronous and is not any
    // more, so two taps 100ms apart both used to arrive before any status was
    // written. The 'checking' latch is set BEFORE the await for this reason.
    let calls = 0;
    __setLoginCheckerForTests(async () => { calls += 1; return verdict('in'); });
    mount();
    await act(async () => { api.checkStore('heb'); api.checkStore('heb'); });
    await flush();

    expect(calls).toBe(1);
  });
});

describe('a verdict that arrives after the session ended', () => {
  it('is discarded rather than written into the next account', async () => {
    // THE FOURTH WRITER. LoginPrewarmContext's teardown note names three things
    // that outlived a sign-out; making the check asynchronous opened a ~400ms
    // window for a fourth. A verdict resolved under A must not land in B's
    // cache, or B's next run trusts A's store login.
    let release: (v: LoginVerdict) => void = () => {};
    __setLoginCheckerForTests(() => new Promise<LoginVerdict>((r) => { release = r; }));
    mount();
    await act(async () => { api.checkStore('heb'); });

    // The phone changes hands while the check is still out.
    mockCurrentUser = null;
    await act(async () => { release(verdict('in')); await Promise.resolve(); });

    expect(api.getStatus('heb')).not.toBe('loggedIn');
    expect(mockLoginProbes).toEqual([]);
  });
});
