// READ ONLY. Amazon: login signal, cart signal, and what a search page holds.
// Names and shapes only.
(async () => {
  const out = { url: location.href.slice(0, 70) };
  out.cookies = document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean).slice(0, 40);
  // Amazon's own markers, by NAME only.
  out.authish = document.cookie.split(';').map((c) => c.trim())
    .filter((c) => /session-id|ubid|x-main|at-main|sess-at|sst-main|lc-main|i18n/i.test(c.split('=')[0]))
    .map((c) => ({ name: c.split('=')[0], len: c.length }));
  // The header usually renders the account name and the cart count.
  const el = (sel) => { try { const n = document.querySelector(sel); return n ? (n.textContent || '').trim().slice(0, 40) : null; } catch (e) { return null; } };
  out.dom = {
    navCartCount: el('#nav-cart-count'),
    accountGreeting: el('#nav-link-accountList-nav-line-1'),
    signInPresent: !!document.querySelector('#nav-link-accountList[href*="signin"]'),
    freshSubnav: !!document.querySelector('[data-csa-c-slot-id*="fresh"], #nav-subnav'),
  };
  // Search results: are they in JSON anywhere, or only markup?
  const html = document.documentElement.innerHTML;
  out.ssr = {
    asinAttrs: (html.match(/data-asin="[A-Z0-9]{10}"/g) || []).length,
    hasStateCache: /P\.when\(|window\.__|state-cache/i.test(html),
    jsonBlobs: (html.match(/<script[^>]*type="application\/json"/g) || []).length,
  };
  // What has this page called?
  const seen = new Set();
  out.api = [];
  for (const e of performance.getEntriesByType('resource')) {
    let u; try { u = new URL(e.name); } catch (err) { continue; }
    if (!/amazon\.com/.test(u.host)) continue;
    if (/\.(png|jpg|jpeg|svg|webp|woff2?|css|gif)(\?|$)/.test(u.pathname)) continue;
    const key = u.pathname.slice(0, 62);
    if (!seen.has(key)) { seen.add(key); out.api.push(key); }
    if (out.api.length > 22) break;
  }
  return out;
})()
