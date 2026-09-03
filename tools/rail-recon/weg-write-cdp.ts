// The cart write, captured at the NETWORK layer.
//
// An in-page fetch/XHR hook missed it: the shop app has a Web Worker, and a
// hook installed on `window` does not exist in a worker's scope. CDP sees every
// request the renderer makes, whichever scope issued it.
import { chromium } from 'playwright';

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /wegmans\.com/.test(p.url()));
  if (!page) { console.log('no wegmans page'); process.exit(1); }

  const client = await ctx.newCDPSession(page);
  const seen: any[] = [];
  await client.send('Network.enable');
  client.on('Network.requestWillBeSent' as any, (e: any) => {
    const r = e.request || {};
    if (!r.method || r.method === 'GET') return;
    if (/google|riskified|adobe|doubleclick|astute|pinimg|facebook|bing|launchdarkly/.test(r.url || '')) return;
    seen.push({ method: r.method, url: r.url, body: r.postData ? String(r.postData).slice(0, 900) : null });
  });
  // Workers issue their own requests; attach to them too.
  try {
    await client.send('Target.setAutoAttach' as any, { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  } catch (e) { console.log('autoAttach:', String(e).slice(0, 60)); }

  const term = process.env.WEG_TERM || 'sour cream';
  await page.goto('https://www.wegmans.com/shop/search?query=' + encodeURIComponent(term),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000);
  seen.length = 0; // only what the CLICK causes

  const clicked = await page.evaluate(`(function () {
    var all = document.querySelectorAll('button, [role=button]');
    for (var i = 0; i < all.length; i++) {
      var t = ((all[i].getAttribute('aria-label') || '') + ' ' + (all[i].textContent || '')).toLowerCase();
      if (t.indexOf('add') >= 0 && t.indexOf(' to cart') >= 0) {
        var r = all[i].getBoundingClientRect();
        if (r.width > 4 && r.height > 4) {
          var label = (all[i].getAttribute('aria-label') || '').trim().slice(0, 70);
          all[i].click();
          return { found: true, label: label };
        }
      }
    }
    return { found: false };
  })()`) as any;
  console.log('click:', JSON.stringify(clicked));
  // The app QUEUES cart operations (its bundle names CART_API_QUEUE_EVENT and
  // checkCartApiQueue), so the write may not leave with the click.
  for (let i = 0; i < 6; i += 1) {
    await page.waitForTimeout(5000);
    if (seen.length) break;
  }

  console.log('\n--- writes the click caused ---');
  for (const r of seen.slice(0, 12)) {
    console.log('\n', r.method, r.url.replace(/^https?:\/\//, '').slice(0, 130));
    if (r.body) console.log('   body:', r.body.slice(0, 600));
  }
  if (!seen.length) console.log('nothing captured');
  await b.close();
})();
