// The page's sku and the cart's sku are the SAME identifier (MEAL-139).
//
// This is the fact MEAL-200 is built on. H-E-B's add-to-cart request declares
// `$skuId: String!`, so the value we read off a search page has to be the value
// the store recognises — otherwise the add is built on an id the store rejects,
// and nothing before checkout would tell us.
//
// A cold review challenged this as unverifiable from the committed captures. It
// is verifiable, and this test is that verification: two products appear in BOTH
// a search page's embedded payload and a cart capture's Apollo state, and the
// ids agree in both cases.
//
// A data test, deliberately not a browser one. What is under test is an agreement
// between two captured payloads, not the behaviour of a script.

import fs from 'fs';
import path from 'path';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'heb');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** productId -> SKUs[0].id, out of a search page's embedded render payload. */
function skusFromSearchPayload(html: string): Map<string, string> {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  const out = new Map<string, string>();
  if (!m) return out;
  const walk = (o: unknown) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    const rec = o as Record<string, unknown>;
    const skus = rec.SKUs;
    if (rec.id != null && Array.isArray(skus) && skus.length > 0) {
      const first = skus[0] as Record<string, unknown> | undefined;
      if (first && first.id != null) out.set(String(rec.id), String(first.id));
    }
    Object.values(rec).forEach(walk);
  };
  walk(JSON.parse(m[1]));
  return out;
}

/** productId -> sku, out of a cart capture's CartItem entries. */
function skusFromCartCapture(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /"CartItem:item#(\d+)#"\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const ref = html.slice(m.index, m.index + 2000).match(/"sku":\{"__ref":"SKU:([0-9]+)"\}/);
    if (ref) out.set(m[1], ref[1]);
  }
  return out;
}

describe('the page sku is the cart sku', () => {
  const cart = skusFromCartCapture(read('cart-with-weight-item.html'));
  const search = skusFromSearchPayload(read('search-results-weight-dropdown-closed.html'));

  it('finds skus on both sides at all', () => {
    // Guards the test itself: a regex that silently stops matching would make
    // every assertion below vacuously true.
    expect(cart.size).toBeGreaterThan(0);
    expect(search.size).toBeGreaterThan(0);
  });

  it('agrees on every product the two captures share', () => {
    const shared = [...search.keys()].filter((id) => cart.has(id));
    expect(shared.length).toBeGreaterThan(0);
    for (const id of shared) {
      expect(`${id} -> ${search.get(id)}`).toBe(`${id} -> ${cart.get(id)}`);
    }
  });

  it('agrees on the bulk coffee line specifically', () => {
    // Named so a future reader can check it by hand against the captures.
    expect(search.get('894630')).toBe('61342');
    expect(cart.get('894630')).toBe('61342');
  });

  it('never maps one product to two different skus across every capture', () => {
    const seen = new Map<string, string>();
    for (const f of fs.readdirSync(FIXTURES).filter((n) => n.endsWith('.html'))) {
      for (const [pid, sku] of skusFromSearchPayload(read(f))) {
        const prior = seen.get(pid);
        if (prior) expect(`${f}:${pid}=${sku}`).toBe(`${f}:${pid}=${prior}`);
        else seen.set(pid, sku);
      }
    }
    expect(seen.size).toBeGreaterThan(100);
  });
});
