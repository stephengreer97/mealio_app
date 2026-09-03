// READ ONLY. Watch the Wegmans shop app boot and find the FIRST response that
// carries the current store number.
//
// Bodies are searched, never reported: the output is a URL, a JSON path and the
// store number itself, which names a shop and not a person.
import { chromium } from 'playwright';

const STORE = process.env.WEG_STORE || '140';

// As a STRING, deliberately: tsx compiles named functions with an esbuild
// `__name` helper that does not exist in the page, and evaluate() throws.
const ANALYSE = `(function (store) {
  var log = window.__log || [];
  var out = [];
  var paths = function (obj, want) {
    var found = [];
    var walk = function (n, p, d) {
      if (n == null || d > 7 || found.length > 4) return;
      if (Object.prototype.toString.call(n) === '[object Array]') {
        for (var i = 0; i < n.length && i < 30; i++) walk(n[i], p + '[' + i + ']', d + 1);
        return;
      }
      if (typeof n === 'object') {
        var ks = Object.keys(n);
        for (var q = 0; q < ks.length; q++) walk(n[ks[q]], p ? p + '.' + ks[q] : ks[q], d + 1);
        return;
      }
      if (String(n) === want) found.push(p);
    };
    walk(obj, '', 0);
    return found;
  };
  for (var i = 0; i < log.length; i++) {
    var e = log[i];
    if (!e.body || e.body.indexOf(store) < 0) continue;
    var j = null;
    try { j = JSON.parse(e.body); } catch (err) {}
    var row = { url: e.url, t: e.t, kind: j ? 'json' : 'text', bytes: e.body.length, paths: [], context: null };
    if (j) row.paths = paths(j, store);
    else {
      var ix = e.body.indexOf(store);
      row.context = e.body.slice(Math.max(0, ix - 80), ix + 50);
    }
    out.push(row);
  }
  out.sort(function (a, b) { return a.t - b.t; });
  return { total: log.length, hits: out.slice(0, 10) };
})`;

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /wegmans\.com/.test(p.url()));
  if (!page) { console.log('no wegmans page — open the cart sheet'); process.exit(1); }

  // Runs before any page script, and survives navigation.
  await page.addInitScript(`(function () {
    window.__log = [];
    var rec = function (url, body, started) {
      try { window.__log.push({ url: String(url).slice(0, 200), body: String(body).slice(0, 200000), t: started }); } catch (e) {}
    };
    var of = window.fetch;
    window.fetch = function () {
      var args = arguments, t0 = Date.now();
      var u = (args[0] && args[0].url) || args[0];
      return of.apply(this, args).then(function (r) {
        try { r.clone().text().then(function (t) { rec(u, t, t0); }); } catch (e) {}
        return r;
      });
    };
    var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__u = u; this.__t = Date.now();
      return oo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      this.addEventListener('load', function () {
        try { rec(self.__u, self.responseText || '', self.__t); } catch (e) {}
      });
      return os.apply(this, arguments);
    };
  })()`);

  console.log('loading the shop app…');
  try { await page.goto('https://www.wegmans.com/shop/', { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { console.log('nav:', String(e).slice(0, 80)); }
  await page.waitForTimeout(15000);
  console.log('settled at', page.url().slice(0, 70));

  const res = await page.evaluate(`${ANALYSE}(${JSON.stringify(STORE)})`) as any;
  console.log('recorded', res.total, 'responses;', res.hits.length, 'mention', STORE);
  for (const h of res.hits) {
    console.log('\n ', String(h.url).replace(/^https?:\/\//, '').slice(0, 110));
    console.log('    kind=' + h.kind, 'bytes=' + h.bytes);
    if (h.paths && h.paths.length) console.log('    paths:', h.paths.join(' | '));
    if (h.context) console.log('    ctx:', String(h.context).replace(/\s+/g, ' ').slice(0, 130));
  }
  await b.close();
})();
