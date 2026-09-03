// Watch the Wegmans shop app ADD AN ITEM, and record the exact request.
// Authorised by Stephen, 2026-09-03: development, writes to his basket allowed.
import { chromium } from 'playwright';

const RECORDER = `(function () {
  window.__req = [];
  var note = function (o) { try { window.__req.push(o); } catch (e) {} };
  var of = window.fetch;
  window.fetch = function () {
    var a = arguments;
    var url = (a[0] && a[0].url) || a[0];
    var init = a[1] || (a[0] && a[0].method ? a[0] : {});
    var m = (init && init.method) || 'GET';
    var body = null;
    try { body = init && init.body ? String(init.body).slice(0, 9000) : null; } catch (e) {}
    var t0 = Date.now();
    return of.apply(this, a).then(function (r) {
      note({ url: String(url).slice(0, 200), method: m, body: body, status: r.status, ms: Date.now() - t0 });
      return r;
    }, function (e) {
      note({ url: String(url).slice(0, 200), method: m, body: body, err: String(e), ms: Date.now() - t0 });
      throw e;
    });
  };
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; this.__t = Date.now(); return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    var self = this;
    try { self.__b = b ? String(b).slice(0, 1200) : null; } catch (e) {}
    this.addEventListener('load', function () {
      note({ url: String(self.__u).slice(0, 200), method: self.__m, body: self.__b, status: self.status, ms: Date.now() - self.__t });
    });
    return os.apply(this, arguments);
  };
})()`;

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /wegmans\.com/.test(p.url()));
  if (!page) { console.log('no wegmans page'); process.exit(1); }
  await page.addInitScript(RECORDER);

  const term = process.env.WEG_TERM || 'sour cream';
  console.log('loading search for', term);
  await page.goto('https://www.wegmans.com/shop/search?query=' + encodeURIComponent(term),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000);
  const cartBefore = await page.evaluate('document.body.innerText.length');
  void cartBefore;

  // The add control, however it is labelled.
  const INCREMENT = process.env.WEG_INC === '1';
  const clicked = await page.evaluate(`(function () {
    var INCREMENT = ${process.env.WEG_INC === '1'};
    var pick = null;
    var all = document.querySelectorAll('button, [role=button]');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var t = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
      if (t.indexOf('add') >= 0 && t.indexOf('list') < 0 && t.indexOf('address') < 0) {
        var r = el.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) { pick = el; break; }
      }
    }
    if (!pick) return { found: false, buttons: all.length };
    var label = (pick.getAttribute('aria-label') || pick.textContent || '').trim().slice(0, 60);
    pick.click();
    return { found: true, label: label };
  })()`) as any;
  console.log('click:', JSON.stringify(clicked));
  if (!clicked.found) {
    const labels = await page.evaluate(`(function () {
      var out = [];
      var all = document.querySelectorAll('button, [role=button]');
      for (var i = 0; i < all.length && out.length < 25; i++) {
        var t = ((all[i].getAttribute('aria-label') || '') + ' | ' + (all[i].textContent || '')).trim().slice(0, 50);
        if (t.replace(/\\s|\\|/g, '')) out.push(t);
      }
      return out;
    })()`) as string[];
    console.log('buttons on the page:', JSON.stringify(labels, null, 1).slice(0, 900));
  }
  await page.waitForTimeout(9000);

  const reqs = await page.evaluate(`(function () {
    return (window.__req || []).filter(function (r) {
      return r.method && r.method.toUpperCase() !== 'GET'
        && /wegmans\.cloud/.test(r.url) && !/cooklist|signalr|coupons|feedback/.test(r.url);
    }).slice(0, 40);
  })()`) as any[];
  console.log('\n--- non-GET requests to wegmans ---');
  for (const r of reqs) {
    console.log('\n', r.method, r.url.replace(/^https?:\/\//, '').slice(0, 120));
    console.log('   status=', r.status ?? r.err, 'ms=', r.ms);
    if (r.body) console.log('   body:', String(r.body).slice(0, 4000));
  }
  if (!reqs.length) {
    const any = await page.evaluate('(window.__req || []).length');
    console.log('none. total recorded:', any);
  }
  await b.close();
})();
