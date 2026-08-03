// The unregister call's timeout (MEAL-88).
//
// Sign-out awaits unregisterDevice() before it clears the local session — the
// ordering is right, because once the access token is gone the call can no
// longer authenticate. What was wrong was the wait: on the shared 30 s default,
// signing out with no connectivity froze the UI for half a minute before
// anything happened.

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

import { push } from '../../src/lib/api';

/** A fetch that never answers but honours the abort signal, like a dead link. */
function hangingFetch() {
  return jest.fn((_url: string, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err: any = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
}

describe('push.unregister', () => {
  const realFetch = global.fetch;

  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); global.fetch = realFetch; });

  it('gives up in seconds, not the 30 s default that stalls sign-out', async () => {
    global.fetch = hangingFetch() as any;

    const result = push.unregister('ExponentPushToken[abc]').catch((err) => err);

    await jest.advanceTimersByTimeAsync(7_000);
    // Raced against an already-resolved promise so a still-pending call reads
    // as 'pending' here rather than hanging the test until Jest's own timeout.
    await expect(Promise.race([result, 'pending'])).resolves.toBe('pending');

    await jest.advanceTimersByTimeAsync(2_000);
    await expect(Promise.race([result, 'pending'])).resolves.toMatchObject({ status: 408 });
  });
});
