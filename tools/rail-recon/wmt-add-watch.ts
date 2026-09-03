// Watch Walmart add an item, and record the request. Authorised: development.
import { chromium } from 'playwright';

const RECORDER = `(function () {
  window.__req = [];
  var note = function (o) { try { window.__req.push(o); } catch (e) {} };
  var of = window.fetch;
  window.fetch = function () {
    var a = arguments, url = (a[0] && a[0].url) || a[0];
    var init = a[1] || {}, m = (init && init.method) || (a[0] && a[0].method) || 'GET', body = null;
    try { body = init && init.body ? String(init.body).slice(0, 3000) : null; } catch (e) {}
    return of.apply(this, a).then(function (r) {
      note({ url: String(url).slice(0, 220), method: m, body: body, status: r.status });
      return r;
    });
  };
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    var self = this;
    try { self.__b = b ? String(b).slice(0, 3000) : null; } catch (e) {}
    this.addEventListener('load', function () {
      note({ url: String(self.__u).slice(0, 220), method: self.__m, body: self.__b, status: self.status });
    });
    return os.apply(this, arguments);
  };
})()`;

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const page = b.contexts()[0].pages().find((p) => /walmart\.com/.test(p.url()));
  if (!page) { console.log('no walmart page'); process.exit(1); }
  await page.addInitScript(RECORDER);
  const term = process.env.WMT_TERM || 'sour cream';
  await page.goto('https://www.walmart.com/search?q=' + encodeURIComponent(term),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(14000);

  const clicked = await page.evaluate(`(function () {
    var all = document.querySelectorAll('button, [role=button], [data-automation-id]');
    for (var i = 0; i < all.length; i++) {
      var al = (all[i].getAttribute('aria-label') || '') + ' ' + (all[i].getAttribute('data-automation-id') || '');
      var tx = (all[i].textContent || '').trim();
      if (/add to cart/i.test(al) || /^Add$/i.test(tx) || /add-to-cart/i.test(al)) {
        var r = all[i].getBoundingClientRect();
        if (r.width > 4 && r.height > 4) { all[i].click(); return { found: true, label: (al + ' | ' + tx).slice(0, 70) }; }
      }
    }
    return { found: false, n: all.length };
  })()`) as any;
  console.log('click:', JSON.stringify(clicked));
  await page.waitForTimeout(11000);
  const workers = page.workers().map((w) => w.url().slice(0, 70));
  console.log('workers on page:', JSON.stringify(workers));

  const reqs = await page.evaluate(`(function () {
    return (window.__req || []).filter(function (r) {
      return /orchestra/.test(r.url);
    }).slice(0, 14);
  })()`) as any[];
  for (const r of reqs) {
    console.log('');
    console.log(' ', r.method, String(r.url).replace(/^https?:../, '').slice(0, 130), '->', r.status);
    if (r.body) console.log('   body:', String(r.body).slice(0, 900));
  }
  if (!reqs.length) console.log('nothing captured; total', await page.evaluate('(window.__req||[]).length'));
  await b.close();
})();
