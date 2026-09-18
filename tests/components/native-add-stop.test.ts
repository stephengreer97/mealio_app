// A STOP MEANS NO NEW WRITE.
//
// nativeStop() used to be called only when a run stopped its own search
// prewarm. Closing the sheet and the add phase timing out did not stop a native
// add batch, and the batch loops never asked whether they had been stopped: the
// H-E-B driver went on to its one-by-one fallback writes and its retries of
// writes that had not landed, and Instacart's re-asked its write after a hash
// refresh. Each of those is a write into the user's REAL cart after they had
// cancelled, and one landing after the sheet's check-and-top-up read is an
// over-add.
//
// Driven through the shipped drivers with fetch mocked. What is asserted is the
// wire: how many cart writes went out after the stop.

import { HEB_NATIVE_RUN } from '../../src/lib/native-rail/heb';
import { instacartNativeRun } from '../../src/lib/native-rail/instacart';
import { nativeStop, __resetNativeRunForTests } from '../../src/lib/native-rail/run';

type Sent = { url: string; op: string | null };
let sent: Sent[] = [];
let handler: (s: Sent) => { status: number; body: string } = () => ({ status: 200, body: '{}' });

const realFetch = global.fetch;
beforeEach(() => {
  sent = [];
  __resetNativeRunForTests();
  global.fetch = jest.fn(async (url: any, init: any) => {
    let op: string | null = null;
    try { op = JSON.parse(init?.body ?? 'null')?.operationName ?? null; } catch { /* not json */ }
    const s = { url: String(url), op };
    sent.push(s);
    const r = handler(s);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body } as any;
  }) as any;
});
afterEach(() => { global.fetch = realFetch; });

const json = (v: unknown) => ({ status: 200, body: JSON.stringify(v) });

// ── H-E-B ────────────────────────────────────────────────────────────────────

const HEB_ITEMS = [1, 2, 3].map((n) => ({
  idx: n - 1, name: `item ${n}`, productId: `p${n}`, skuId: `s${n}`, quantity: 1,
}));
const emptyCart = json({ data: { cartV2: { __typename: 'Cart', items: [] } } });
const addedArm = json({ data: { addItemToCartV2: { __typename: 'Cart' } } });

async function runHeb() {
  const posted: Array<Record<string, unknown>> = [];
  const go = HEB_NATIVE_RUN.addBatch(HEB_ITEMS as never, { knownLines: null, absoluteQty: null });
  await go!((m) => { posted.push(m); });
  return posted;
}
const hebWrites = () => sent.filter((s) => s.op === 'cartItemsV2' || s.op === 'cartItemV2');

describe('H-E-B native add, stopped', () => {
  it('writes nothing when the stop lands during the baseline read', async () => {
    handler = (s) => {
      if (s.op === 'CartLines') { nativeStop(); return emptyCart; }
      return addedArm;
    };
    const posted = await runHeb();

    expect(hebWrites()).toHaveLength(0);
    expect(posted.find((m) => m.type === 'NET_ADD_DONE')).toMatchObject({ stopped: true, wrote: 0 });
  });

  it('starts no further one-by-one write once stopped mid-fallback', async () => {
    // The batch mutation is refused, so the driver falls back to one write per
    // item. The user closes the sheet while the first of those is out.
    handler = (s) => {
      if (s.op === 'CartLines') return emptyCart;
      if (s.op === 'cartItemsV2') return { status: 400, body: 'no' };
      if (s.op === 'cartItemV2') { nativeStop(); return addedArm; }
      return json({});
    };
    const posted = await runHeb();

    expect(sent.filter((s) => s.op === 'cartItemV2')).toHaveLength(1);
    expect(posted.find((m) => m.type === 'NET_ADD_DONE')).toMatchObject({ stopped: true });
  });

  it('does not retry an unlanded write after a stop', async () => {
    // The batch is accepted, the stop lands during the verifying read, and that
    // read shows nothing landed. Before, every "missing" item was written again.
    let reads = 0;
    handler = (s) => {
      if (s.op === 'CartLines') {
        reads += 1;
        if (reads === 2) nativeStop();
        return emptyCart;
      }
      if (s.op === 'cartItemsV2') {
        return json({ data: { a0: { __typename: 'Cart' }, a1: { __typename: 'Cart' }, a2: { __typename: 'Cart' } } });
      }
      return addedArm;
    };
    await runHeb();

    expect(sent.filter((s) => s.op === 'cartItemV2')).toHaveLength(0);
  });

  it('does not retry a failed write once stopped', async () => {
    // A 503 is retriable, and a retry is a new write. The stop lands while the
    // first attempt is out; the backoff must not send a second one.
    handler = (s) => {
      if (s.op === 'CartLines') return emptyCart;
      if (s.op === 'cartItemsV2') return { status: 400, body: 'no' };
      if (s.op === 'cartItemV2') { nativeStop(); return { status: 503, body: 'busy' }; }
      return json({});
    };
    await runHeb();

    expect(sent.filter((s) => s.op === 'cartItemV2')).toHaveLength(1);
  });

  it('still writes everything when nothing stops it', async () => {
    // The control: the checks must not cost an unstopped run a single write.
    let written = 0;
    handler = (s) => {
      if (s.op === 'CartLines') {
        const items = HEB_ITEMS.slice(0, written).map((it) => ({ product: { id: it.productId }, quantity: 1 }));
        return json({ data: { cartV2: { __typename: 'Cart', items } } });
      }
      if (s.op === 'cartItemsV2') return { status: 400, body: 'no' };
      written += 1;
      return addedArm;
    };
    const posted = await runHeb();

    expect(sent.filter((s) => s.op === 'cartItemV2')).toHaveLength(3);
    expect(posted.find((m) => m.type === 'NET_ADD_DONE')).toMatchObject({ wrote: 3 });
  });
});

// ── Instacart (ALDI) ─────────────────────────────────────────────────────────

const IC_ITEMS = [{ idx: 0, name: 'sour cream', productId: 'items_1-1', skuId: null, quantity: 1 }];
const SHOP_HTML = { status: 200, body: '<html>"shopId":"12345678" "zoneId":"87654321"</html>' };
const icWrites = () => sent.filter((s) => s.op === 'UpdateCartItemsMutation');

async function runAldi() {
  const posted: Array<Record<string, unknown>> = [];
  const go = instacartNativeRun('aldi').addBatch(IC_ITEMS as never, { knownLines: {}, absoluteQty: null });
  await go!((m) => { posted.push(m); });
  return posted;
}

describe('Instacart native add, stopped', () => {
  it('writes nothing when the stop lands while the shop is being read', async () => {
    handler = (s) => {
      if (s.url.includes('/search_v3/') || s.url.includes('/storefront')) { nativeStop(); return SHOP_HTML; }
      return json({ data: {} });
    };
    const posted = await runAldi();

    expect(icWrites()).toHaveLength(0);
    expect(posted.find((m) => m.type === 'NET_ADD_DONE')).toMatchObject({ stopped: true, wrote: 0 });
  });

  it('does not re-send the write after a hash refresh that a stop landed in', async () => {
    // The write comes back PERSISTED_QUERY_NOT_FOUND, the driver harvests fresh
    // hashes, and the sheet is closed while it does.
    const hash = 'a'.repeat(64);
    handler = (s) => {
      if (s.op === 'UpdateCartItemsMutation') {
        return json({ errors: [{ message: 'x', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }] });
      }
      if (s.url.endsWith('/storefront')) return { status: 200, body: '<script src="/app.js"></script>' };
      if (s.url.endsWith('/app.js')) {
        nativeStop();
        return { status: 200, body: `"UpdateCartItemsMutation":"${hash}"` };
      }
      return SHOP_HTML;
    };
    await runAldi();

    expect(icWrites()).toHaveLength(1);
  });
});
