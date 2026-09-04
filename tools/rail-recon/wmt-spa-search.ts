// Force a CLIENT-SIDE search and record what it calls. The page uses
// getInitialProps, so a client transition runs that in the browser rather than
// fetching a data route — whatever it calls is the fast path.
import { chromium } from 'playwright';

const REC = `(function () {
  window.__req = [];
  var of = window.fetch;
  window.fetch = function () {
    var a = arguments, url = String((a[0] && a[0].url) || a[0] || '');
    var init = a[1] || {};
    var b = null; try { b = init.body ? String(init.body).slice(0, 400) : null; } catch (e) {}
    var t0 = Date.now();
    return of.apply(this, a).then(function (r) {
      window.__req.push({ url: url.slice(0, 12000), method: init.method || 'GET',
                          status: r.status, ms: Date.now() - t0, body: b });
      return r;
    });
  };
})()`;

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const page = b.contexts()[0].pages().find((p) => /walmart\.com/.test(p.url()));
  if (!page) { console.log('no page'); process.exit(1); }
  await page.addInitScript(REC);
  await page.goto('https://www.walmart.com/search?q=butter', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(13000);
  await page.evaluate('window.__req = []');

  const pushed = await page.evaluate(`(function () {
    try {
      if (window.next && window.next.router) {
        window.next.router.push('/search?q=' + encodeURIComponent('sour cream'));
        return { ok: true, via: 'next.router' };
      }
    } catch (e) { return { ok: false, err: String(e).slice(0, 60) }; }
    return { ok: false, why: 'no next.router' };
  })()`) as any;
  console.log('push:', JSON.stringify(pushed));
  await page.waitForTimeout(12000);

  const reqs = await page.evaluate(`(function () {
    return (window.__req || []).filter(function (r) {
      return r.url.indexOf('/orchestra/snb/graphql/Search') >= 0;
    }).slice(0, 3);
  })()`) as any[];
  for (const r of reqs) {
    const op = (String(r.url).match(/graphql\/([A-Za-z0-9_]+)\//) || [])[1] || '';
    console.log('');
    console.log(r.method, r.status, String(r.ms) + 'ms');
    const u = String(r.url);
    console.log('PATH:', u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]);
    const q = u.indexOf('variables=');
    if (q >= 0) {
      const enc = u.slice(q + 10).split('&')[0];
      let raw = enc;
      try { raw = decodeURIComponent(enc); } catch (e) { raw = enc; }
      require('fs').writeFileSync('/tmp/claude-1000/wmt-vars.json', raw);
      console.log('VARS bytes:', raw.length, '-> /tmp/claude-1000/wmt-vars.json');
    }

  }
  if (!reqs.length) console.log('nothing recorded; total', await page.evaluate('(window.__req||[]).length'));
  console.log('\nurl now:', page.url().slice(0, 70));
  await b.close();
})();
