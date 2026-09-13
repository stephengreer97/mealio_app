// ONE VERDICT, TWO TRANSPORTS.
//
// Stephen, 2026-09-11: "when I do the ALDI login it continues with the
// automation before I get the chance to actually log in. Then I tried it again
// and it did let me sign in. The inconsistency scares me."
//
// THE SHAPE OF THAT BUG, because it is the one worth never repeating. The cart
// sheet skips its own login check outright when the prewarm says loggedIn -- "A
// POSITIVE signal, and the only one that skips the check". That was safe for as
// long as both answers came from the SAME probe. Moving the prewarm to native
// fetch made them two probes, and nobody checked that they answered the same
// question the same way. They did not: the native one dropped the cart
// requirement and swallowed a 401 from the query the injected rail calls the
// authentication fact.
//
// So the rule this file exists to enforce is not "the native check is correct".
// It is "the native check agrees with the rail it replaces". Where a rail is
// deliberately conservative, the native copy is conservative in the same place
// and for the same reason, even when a looser answer looks better.
// The rails reach getStoreWebViewUA for their headers, and that module imports
// react-native for Platform. This project runs under plain node, so the import
// is mocked rather than the suite moved -- a verdict is pure logic over an HTTP
// response and belongs in the fast project.
jest.mock('../../src/lib/webview-user-agent', () => ({
  getStoreWebViewUA: () => 'test-agent',
  setAndroidChromeMajor: () => {},
}));

import { INSTACART_NATIVE } from '../../src/lib/native-rail/instacart';
import { HEB_NATIVE } from '../../src/lib/native-rail/heb';

const UA = 'test-agent';

/** A fetch that answers by URL and operation name, in the order asked. */
function mockFetch(plan: Array<{ op?: string; status: number; body?: unknown }>) {
  const calls: string[] = [];
  return jest.fn(async (url: string, init?: RequestInit) => {
    let op = '';
    try { op = JSON.parse(String(init?.body ?? '{}')).operationName ?? ''; } catch { op = ''; }
    calls.push(op || String(url));
    const hit = plan.find((p) => !p.op || p.op === op);
    const entry = hit ?? { status: 500, body: {} };
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      text: async () => JSON.stringify(entry.body ?? {}),
      json: async () => entry.body ?? {},
    } as unknown as Response;
  });
}

const A_USER = { data: { currentUser: { id: 'u1', guest: false } } };
const ALDI_CART = { data: { userCarts: { carts: [{ id: 'c1', retailer: { slug: 'aldi' } }] } } };
const SOMEONE_ELSES_CART = { data: { userCarts: { carts: [{ id: 'c9', retailer: { slug: 'publix' } }] } } };

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('ALDI, natively, answers what the injected rail answers', () => {
  it('signed in only when there is a cart AT THIS RETAILER', async () => {
    global.fetch = mockFetch([
      { op: 'CurrentUser', status: 200, body: A_USER },
      { op: 'ActiveCarts', status: 200, body: ALDI_CART },
    ]) as never;
    const out = await INSTACART_NATIVE.session(UA);
    expect(out.ok).toBe(true);
    expect(out.session?.loggedIn).toBe(true);
    expect(out.session?.cartId).toBe('c1');
  });

  it('THE REGRESSION: a live CurrentUser with an expired ActiveCarts is signed OUT', async () => {
    // This is the exact divergence that reached Stephen. The injected rail keys
    // its whole verdict on ActiveCarts and answers 401 -> signed out; the native
    // copy asked CurrentUser, got a real user, and never looked at the 401 it
    // had just received. The run then started while he was being shown a login
    // screen, and only sometimes, because it depends which query expires first.
    global.fetch = mockFetch([
      { op: 'CurrentUser', status: 200, body: A_USER },
      { op: 'ActiveCarts', status: 401, body: { errors: [{ message: 'Not Authenticated' }] } },
    ]) as never;
    const out = await INSTACART_NATIVE.session(UA);
    expect(out.ok).toBe(true);
    expect(out.session?.loggedIn).toBe(false);
  });

  it('does not borrow another retailer\'s cart to call itself signed in', async () => {
    // An Instacart account holds carts across retailers. carts[0] is somebody
    // else's basket, and matching on it is how a Publix run went hunting for an
    // ALDI cart.
    global.fetch = mockFetch([
      { op: 'CurrentUser', status: 200, body: A_USER },
      { op: 'ActiveCarts', status: 200, body: SOMEONE_ELSES_CART },
    ]) as never;
    const out = await INSTACART_NATIVE.session(UA);
    expect(out.session?.loggedIn).toBe(false);
  });

  it('reads a guest as signed out even with a cart', async () => {
    // Stephen, 2026-09-07: a guest run adds fine and the user cannot see any of
    // it from their own account. A run like that reports success and delivers
    // nothing.
    global.fetch = mockFetch([
      { op: 'CurrentUser', status: 200, body: { data: { currentUser: { id: 'g', guest: true } } } },
      { op: 'ActiveCarts', status: 200, body: ALDI_CART },
    ]) as never;
    const out = await INSTACART_NATIVE.session(UA);
    expect(out.session?.loggedIn).toBe(false);
  });

  it('reads a 401 from the account query as signed out', async () => {
    global.fetch = mockFetch([{ op: 'CurrentUser', status: 401, body: {} }]) as never;
    const out = await INSTACART_NATIVE.session(UA);
    expect(out.ok).toBe(true);
    expect(out.session?.loggedIn).toBe(false);
  });

  it('a cart query that BROKE is inconclusive, never signed out', async () => {
    // A 5xx says something about the request and nothing about the user.
    // Answering "signed out" to it walls a signed-in user, which is the mistake
    // this project has made three times.
    global.fetch = mockFetch([
      { op: 'CurrentUser', status: 200, body: A_USER },
      { op: 'ActiveCarts', status: 503, body: {} },
    ]) as never;
    const out = await INSTACART_NATIVE.session(UA);
    expect(out.ok).toBe(false);
    expect(out.session).toBeUndefined();
  });

  it('an unreadable cart shape is inconclusive too', async () => {
    global.fetch = mockFetch([
      { op: 'CurrentUser', status: 200, body: A_USER },
      { op: 'ActiveCarts', status: 200, body: { data: {} } },
    ]) as never;
    const out = await INSTACART_NATIVE.session(UA);
    expect(out.ok).toBe(false);
  });
});

describe('H-E-B, natively, answers what the injected rail answers', () => {
  // Its rail's rule is one line: no `me` means signed out, a `me` means signed
  // in. Pinned here so the next person to add a second signal to one side has
  // to add it to both.
  it('signed in when me carries an id', async () => {
    global.fetch = mockFetch([
      { op: 'myPreferredStore', status: 200, body: { data: { me: { id: 'm1', preferredStore: { storeNumber: 243 } } } } },
      { op: 'SessionContext', status: 200, body: { data: { cartV2: { id: 'c', fulfillment: { store: { id: 476 }, curbsideFulfillmentMode: 'delivery' } } } } },
    ]) as never;
    const out = await HEB_NATIVE.session(UA);
    expect(out.session?.loggedIn).toBe(true);
    expect(out.session?.storeId).toBe('476');
  });

  it('signed out when me is null', async () => {
    global.fetch = mockFetch([
      { op: 'myPreferredStore', status: 200, body: { data: { me: null } } },
    ]) as never;
    const out = await HEB_NATIVE.session(UA);
    expect(out.ok).toBe(true);
    expect(out.session?.loggedIn).toBe(false);
  });

  it('a 403 from the wall is inconclusive, never signed out', async () => {
    // MEASURED 2026-09-11: H-E-B answered 403 with an Imperva challenge page for
    // 45 minutes, to the WebView and to their own website alike. A verdict of
    // "signed out" there would put a signed-in user on a sign-in screen they
    // cannot get past, because the wall is not about their account.
    global.fetch = mockFetch([{ op: 'myPreferredStore', status: 403, body: {} }]) as never;
    const out = await HEB_NATIVE.session(UA);
    expect(out.ok).toBe(false);
    expect(out.session).toBeUndefined();
  });
});
