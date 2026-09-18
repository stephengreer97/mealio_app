// The end of an in-app platform connect: `mealio://creator/connect?...`.
//
// Two things ride on these helpers. `readConnectRedirect` decides whether the
// app exchanges a code, says "you cancelled", or shows a failure; and
// `isCreatorConnectRedirect` is what keeps the root navigator's deep-link
// handler from acting on the same URL when Android delivers it as a link.

import {
  CREATOR_CONNECT_REDIRECT,
  isCreatorConnectRedirect,
  parseQuery,
  readConnectRedirect,
} from '../../src/lib/creatorConnectUrl';

describe('isCreatorConnectRedirect', () => {
  it('matches the redirect the connect session waits for, with or without a query', () => {
    expect(isCreatorConnectRedirect(CREATOR_CONNECT_REDIRECT)).toBe(true);
    expect(isCreatorConnectRedirect('mealio://creator/connect?platform=tiktok&code=a&state=b')).toBe(true);
    expect(isCreatorConnectRedirect('mealio://creator/connect/?outcome=cancelled')).toBe(true);
  });

  it('matches the same path arriving as an app link', () => {
    expect(isCreatorConnectRedirect('https://mealio.co/creator/connect?platform=youtube&code=a&state=b')).toBe(true);
    expect(isCreatorConnectRedirect('https://www.mealio.co/creator/connect')).toBe(true);
  });

  it('leaves every other link alone', () => {
    expect(isCreatorConnectRedirect('mealio://meal/p/p1')).toBe(false);
    expect(isCreatorConnectRedirect('mealio://verified?token=x')).toBe(false);
    expect(isCreatorConnectRedirect('mealio://kroger/connected')).toBe(false);
    expect(isCreatorConnectRedirect('mealio://creator/connected')).toBe(false);
    expect(isCreatorConnectRedirect('https://mealio.co/creator')).toBe(false);
    expect(isCreatorConnectRedirect('https://evil.test/creator/connect')).toBe(false);
  });
});

describe('readConnectRedirect', () => {
  it('reads a code and state, decoded', () => {
    expect(readConnectRedirect('mealio://creator/connect?platform=youtube&code=4%2F0Ab&state=ey.J9')).toEqual({
      kind: 'code', code: '4/0Ab', state: 'ey.J9',
    });
  });

  it('reads a cancel on the platform screen', () => {
    expect(readConnectRedirect('mealio://creator/connect?platform=tiktok&outcome=cancelled')).toEqual({ kind: 'cancelled' });
  });

  it('reads any failure reason, not only expired', () => {
    expect(readConnectRedirect('mealio://creator/connect?platform=tiktok&outcome=failed&reason=unavailable'))
      .toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(readConnectRedirect('mealio://creator/connect?platform=tiktok&outcome=failed&reason=no-code'))
      .toEqual({ kind: 'failed', reason: 'no-code' });
    expect(readConnectRedirect('mealio://creator/connect?platform=tiktok&outcome=failed'))
      .toEqual({ kind: 'failed', reason: null });
  });

  it('treats a redirect with half a grant as a failure, never an exchange', () => {
    expect(readConnectRedirect('mealio://creator/connect?code=abc').kind).toBe('failed');
    expect(readConnectRedirect('mealio://creator/connect').kind).toBe('failed');
  });

  it('parses by hand, keeps the first of a repeated key and ignores a fragment', () => {
    expect(parseQuery('mealio://x?a=1&a=2&b=%20c#frag')).toEqual({ a: '1', b: ' c' });
    expect(parseQuery('mealio://x?bad=%E0%A4%A&ok=1')).toEqual({ ok: '1' });
  });
});
