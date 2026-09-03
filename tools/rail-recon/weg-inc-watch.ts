// Click the add control on an item the cart ALREADY HOLDS, and record what the
// site sends. Authorised: development, writes allowed.
import { chromium } from 'playwright';

const RECORDER = `(function () {
  window.__req = [];
  var note = function (o) { try { window.__req.push(o); } catch (e) {} };
  var of = window.fetch;
  window.fetch = function () {
    var a = arguments, url = (a[0] && a[0].url) || a[0];
    var init = a[1] || {}, m = (init && init.method) || 'GET', body = null;
    try { body = init && init.body ? String(init.body).slice(0, 4000) : null; } catch (e) {}
    return of.apply(this, a).then(function (r) {
      note({ url: String(url).slice(0, 200), method: m, body: body, status: r.status });
      return r;
    });
  };
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    var self = this;
    try { self.__b = b ? String(b).slice(0, 4000) : null; } catch (e) {}
    this.addEventListener('load', function () {
      note({ url: String(self.__u).slice(0, 200), method: self.__m, body: self.__b, status: self.status });
    });
    return os.apply(this, arguments);
  };
})()`;

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const page = b.contexts()[0].pages().find((p) => /wegmans\.com/.test(p.url()));
  if (!page) { console.log('no page'); process.exit(1); }
  await page.addInitScript(RECORDER);
  await page.goto('https://www.wegmans.com/shop/search?query=' + encodeURIComponent(process.env.WEG_TERM || 'Wegmans Sour Cream'),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(13000);

  // The control whose LABEL names the exact product and whose TEXT is a number:
  // that number is the quantity already in the cart.
  const clicked = await page.evaluate(`(function () {
    var want = ${JSON.stringify(process.env.WEG_NAME || 'Wegmans Sour Cream')};
    var all = document.querySelectorAll('button, [role=button]');
    for (var i = 0; i < all.length; i++) {
      var al = all[i].getAttribute('aria-label') || '';
      var tx = (all[i].textContent || '').trim();
      if (al.indexOf('Add 1 ea of ' + want + ' to cart') === 0 && /^[0-9]+$/.test(tx)) {
        all[i].click();
        return { found: true, aria: al.slice(0, 60), heldBefore: tx };
      }
    }
    return { found: false };
  })()`) as any;
  console.log('click:', JSON.stringify(clicked));
  await page.waitForTimeout(10000);

  const reqs = await page.evaluate(`(function () {
    return (window.__req || []).filter(function (r) {
      return r.method && r.method.toUpperCase() !== 'GET' && /wegmans\\.cloud/.test(r.url)
        && !/cooklist|signalr|coupons|feedback|instacart/.test(r.url);
    }).slice(0, 6);
  })()`) as any[];
  for (const r of reqs) {
    console.log('\n', r.method, r.url.replace(/^https?:\/\//, '').slice(0, 120), '->', r.status);
    if (r.body) console.log('  body:', String(r.body).slice(0, 1500));
  }
  if (!reqs.length) console.log('nothing captured');
  await b.close();
})();
