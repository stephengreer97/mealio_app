// Capture Walmart's client-side search operation: the SPA does a GraphQL call
// when you search from within the app, rather than re-fetching the whole page.
import { chromium } from 'playwright';

const REC = `(function () {
  window.__req = [];
  var of = window.fetch;
  window.fetch = function () {
    var a = arguments, url = String((a[0] && a[0].url) || a[0] || '');
    var init = a[1] || {};
    if (url.indexOf('/orchestra/') >= 0) {
      var b = null; try { b = init.body ? String(init.body).slice(0, 700) : null; } catch (e) {}
      window.__req.push({ url: url.slice(0, 200), method: init.method || 'GET', body: b });
    }
    return of.apply(this, a);
  };
})()`;

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const page = b.contexts()[0].pages().find((p) => /walmart\.com/.test(p.url()));
  if (!page) { console.log('no page'); process.exit(1); }
  await page.addInitScript(REC);
  // Start from the HOMEPAGE, which is not challenged, then search from inside.
  await page.goto('https://www.walmart.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000);
  const typed = await page.evaluate(`(function () {
    var i = document.querySelector('input[name=q], input[type=search], #global-search-input');
    if (!i) return { found: false };
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, 'sour cream');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    var f = i.form;
    if (f) { f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    return { found: true, hasForm: !!f };
  })()`) as any;
  console.log('typed:', JSON.stringify(typed));
  await page.waitForTimeout(12000);
  const reqs = await page.evaluate('(window.__req || []).slice(0, 20)') as any[];
  const seen = new Set<string>();
  for (const r of reqs) {
    const op = (r.url.match(/graphql\/([A-Za-z0-9_]+)\//) || [])[1] || '(inline)';
    if (seen.has(op)) continue;
    seen.add(op);
    console.log('\n', r.method, op, r.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 110));
    if (r.body && /query|search/i.test(r.body)) console.log('   body:', r.body.slice(0, 300));
  }
  console.log('\nurl now:', page.url().slice(0, 80));
  await b.close();
})();
