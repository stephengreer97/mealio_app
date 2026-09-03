// The cart write, captured from the WORKER.
//
// The shop app runs a blob: Web Worker, and a fetch hook installed on `window`
// does not exist in a worker's scope — which is why an in-page recorder saw the
// cart go 13 -> 14 without ever seeing the request that did it.
// @ts-ignore -- a recon tool; ws ships no types and is not worth a devDependency
import WebSocket from 'ws';
import { chromium } from 'playwright';

async function targets() {
  const r = await fetch('http://localhost:9333/json/list');
  return (await r.json()) as any[];
}

(async () => {
  const seen: any[] = [];
  const sockets: WebSocket[] = [];
  let id = 1;
  const attach = async () => {
    // AFTER the shop app is up. The worker is created by that app, so a listing
    // taken on robots.txt finds none — which is how this first reported
    // "workers: 0" while the cart was demonstrably being written.
    const list = await targets();
    const workers = list.filter((t) => t.type === 'worker' && t.webSocketDebuggerUrl);
    console.log('workers:', workers.length);
    for (const w of workers) {
      const ws = new WebSocket(w.webSocketDebuggerUrl);
      sockets.push(ws);
      await new Promise<void>((res) => { ws.on('open', () => res()); ws.on('error', () => res()); });
      ws.send(JSON.stringify({ id: id++, method: 'Network.enable' }));
      ws.on('message', (raw: any) => {
      let m: any; try { m = JSON.parse(String(raw)); } catch (e) { return; }
      if (m.method !== 'Network.requestWillBeSent') return;
      const rq = m.params && m.params.request;
      if (!rq || !rq.method || rq.method === 'GET') return;
      seen.push({ method: rq.method, url: rq.url, body: rq.postData ? String(rq.postData).slice(0, 900) : null });
    });
      console.log('  attached:', String(w.url).slice(0, 60));
    }
  };

  const b = await chromium.connectOverCDP('http://localhost:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /wegmans\.com/.test(p.url()));
  if (!page) { console.log('no wegmans page'); process.exit(1); }
  if (!/\/shop\/search/.test(page.url())) {
    await page.goto('https://www.wegmans.com/shop/search?query=' + encodeURIComponent(process.env.WEG_TERM || 'sour cream'),
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);
  }
  await attach();
  seen.length = 0;

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
  await page.waitForTimeout(12000);

  console.log('\n--- worker writes ---');
  for (const r of seen.slice(0, 10)) {
    if (/google|riskified|adobe|doubleclick|astute|pinimg|bing|launchdarkly/.test(r.url)) continue;
    console.log('\n', r.method, r.url.replace(/^https?:\/\//, '').slice(0, 130));
    if (r.body) console.log('   body:', r.body.slice(0, 700));
  }
  if (!seen.length) console.log('nothing from workers');
  for (const s of sockets) s.close();
  await b.close();
})();
