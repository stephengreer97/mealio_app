import { chromium } from 'playwright';
(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const page = b.contexts()[0].pages().find((p) => /wegmans\.com/.test(p.url()));
  if (!page) { console.log('no page'); process.exit(1); }
  await page.goto('https://www.wegmans.com/shop/search?query=' + encodeURIComponent(process.env.WEG_TERM || 'Wegmans Sour Cream'),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(13000);
  const labels = await page.evaluate(`(function () {
    var out = [];
    var all = document.querySelectorAll('button, [role=button]');
    for (var i = 0; i < all.length && out.length < 40; i++) {
      var r = all[i].getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      var al = all[i].getAttribute('aria-label') || '';
      var tx = (all[i].textContent || '').trim();
      out.push({ i: i, aria: al.slice(0, 60), text: tx.slice(0, 24) });
    }
    return out;
  })()`) as any[];
  for (const l of labels) console.log(String(l.i).padStart(3), '|', l.aria, '|', l.text);
  await b.close();
})();
