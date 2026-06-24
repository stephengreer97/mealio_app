#!/usr/bin/env node
/*
 * Mock grocery store — a deterministic fake storefront the WebView cart engine
 * can drive end-to-end, so Maestro can exercise the WHOLE add-to-cart flow
 * (login → search → choose → add → cart-count confirm → snapshot → reconcile →
 * skip → parallel) without a real store's login / WAF / anti-bot / flakiness.
 *
 * Zero dependencies (Node http only). State is an in-memory cart, reset via
 * GET /reset. Pair it with the `mockstore` adapter in src/lib/webview-scripts.
 *
 *   node tests/mock-store/server.js          # listens on :8788
 *   MOCK_STORE_PORT=9000 node ...            # custom port
 *
 * Scenario control rides in the SEARCH TERM (case-insensitive substring), so a
 * Maestro flow just saves a meal whose ingredient names encode the scenario:
 *   default        → 3 candidates, first is an exact match → auto-adds
 *   "multi"        → 5 candidates, none exact → forces the Choose-Product UI
 *   "oos"          → candidates present but out of stock → review/skip
 *   "noresults"    → 0 candidates → no-results review → skip
 *   "failadd"      → first add silently doesn't persist (badge bumps optimistically)
 *                    → worker reports success but cart is short → reconcile re-adds
 */
'use strict';
const http = require('http');

const PORT = parseInt(process.env.MOCK_STORE_PORT || '8788', 10);

// ── State ────────────────────────────────────────────────────────────────────
// cart: name -> qty.  failDropped: names whose first /add we already dropped.
let cart = Object.create(null);
let failDropped = Object.create(null);

function cartTotal() {
  return Object.keys(cart).reduce((n, k) => n + cart[k], 0);
}

// ── Catalog ──────────────────────────────────────────────────────────────────
// Deterministic candidates for a term. The first is an EXACT match (so the
// engine auto-adds it) unless the scenario says otherwise.
function candidatesFor(term) {
  const t = (term || '').trim();
  const lower = t.toLowerCase();
  if (lower.includes('noresults')) return [];
  const oos = lower.includes('oos');
  const failadd = lower.includes('failadd');
  const multi = lower.includes('multi');
  const n = multi ? 5 : 3;
  const out = [];
  for (let i = 0; i < n; i++) {
    // For "multi", NONE is an exact match (forces Choose Product). Otherwise the
    // first candidate's name === the search term (engine treats it as exact).
    const name = !multi && i === 0 ? t : `${t} option ${i + 1}`;
    out.push({
      name,
      price: `$${(2 + i).toFixed(2)}`,
      oos,
      failadd: failadd && i === 0,
    });
  }
  return out;
}

// ── HTML ─────────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(body, extraHead = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock Store</title><style>body{font-family:-apple-system,sans-serif;margin:0;padding:0}
header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#0a7d4b;color:#fff}
.product{border:1px solid #e3e3e3;border-radius:8px;padding:12px;margin:10px 16px}
.mock-add{background:#0a7d4b;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:14px}
.mock-add[disabled]{opacity:.4}.cart-line{padding:10px 16px;border-bottom:1px solid #eee}</style>${extraHead}</head>
<body data-mock-store="1" data-logged-in="true">
<header><a href="/" style="color:#fff;text-decoration:none;font-weight:700">Mock Store</a>
<a id="mock-cart" href="/cart" aria-label="Cart: ${cartTotal()} items" style="color:#fff;text-decoration:none">🛒 <span id="mock-cart-count">${cartTotal()}</span></a></header>
${body}
<script>
async function mockAdd(btn){
  var name=btn.getAttribute('data-name');
  var fail=btn.getAttribute('data-failadd')==='true';
  var cur=parseInt(btn.getAttribute('data-added')||'0',10)+1;
  btn.setAttribute('data-added',cur);
  btn.textContent=cur+' added';
  try{
    var res=await fetch('/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,fail:fail})});
    var data=await res.json();
    document.getElementById('mock-cart-count').textContent=data.total;
    document.getElementById('mock-cart').setAttribute('aria-label','Cart: '+data.total+' items');
  }catch(e){}
}
</script>
</body></html>`;
}

function homePage() {
  return page(`<p style="margin:16px">You are signed in to the Mock Store.</p>`);
}

function searchPage(term) {
  const cands = candidatesFor(term);
  if (cands.length === 0) {
    return page(`<div id="mock-results" data-count="0"><p style="margin:16px" class="mock-no-results">No results for "${esc(term)}".</p></div>`,
      `<meta name="mock-search-term" content="${esc(term)}">`);
  }
  const cards = cands.map((c) => `
  <div class="product mock-product" data-name="${esc(c.name)}" data-price="${esc(c.price)}" data-oos="${c.oos}">
    <div class="mock-name" data-qe="name">${esc(c.name)}</div>
    <div class="mock-price" data-qe="price">${esc(c.price)}</div>
    ${c.oos
      ? `<button class="mock-add" disabled data-qe="oos">Out of stock</button>`
      : `<button class="mock-add" data-qe="add" data-name="${esc(c.name)}" data-failadd="${c.failadd}" onclick="mockAdd(this)">Add to cart</button>`}
  </div>`).join('');
  return page(`<div id="mock-results" data-count="${cands.length}">${cards}</div>`,
    `<meta name="mock-search-term" content="${esc(term)}">`);
}

function cartPage() {
  const names = Object.keys(cart);
  const lines = names.map((n) => `
  <div class="cart-line mock-cart-line" data-name="${esc(n)}">
    <span class="mock-cart-name" data-qe="cart-name">${esc(n)}</span>
    <span class="mock-cart-qty" data-qe="cart-qty">${cart[n]}</span>
  </div>`).join('');
  return page(`<h2 style="margin:16px">Your Cart</h2><div id="mock-cart-lines" data-count="${names.length}">${lines || '<p style="margin:16px">Your cart is empty.</p>'}</div>`);
}

// ── Server ───────────────────────────────────────────────────────────────────
function send(res, status, body, type = 'text/html') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/') return send(res, 200, homePage());
  if (req.method === 'GET' && path === '/search') return send(res, 200, searchPage(url.searchParams.get('q') || ''));
  if (req.method === 'GET' && path === '/cart') return send(res, 200, cartPage());
  if (req.method === 'GET' && path === '/reset') {
    cart = Object.create(null); failDropped = Object.create(null);
    return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
  }
  if (req.method === 'GET' && path === '/state') {
    return send(res, 200, JSON.stringify({ cart, total: cartTotal() }), 'application/json');
  }
  if (req.method === 'POST' && path === '/add') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let name = '', fail = false;
      try { const b = JSON.parse(raw || '{}'); name = b.name || ''; fail = !!b.fail; } catch (e) {}
      if (!name) return send(res, 400, JSON.stringify({ error: 'name required' }), 'application/json');
      // FAILADD: drop the FIRST add for this name (don't persist) so the cart is
      // short and reconcile re-adds it; subsequent adds persist normally.
      if (fail && !failDropped[name]) {
        failDropped[name] = true;
        return send(res, 200, JSON.stringify({ ok: true, dropped: true, qty: cart[name] || 0, total: cartTotal() }), 'application/json');
      }
      cart[name] = (cart[name] || 0) + 1;
      return send(res, 200, JSON.stringify({ ok: true, qty: cart[name], total: cartTotal() }), 'application/json');
    });
    return;
  }
  send(res, 404, 'not found');
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-store] listening on http://localhost:${PORT}`);
});
