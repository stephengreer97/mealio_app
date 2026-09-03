import { chromium } from 'playwright';
(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /wegmans\.com/.test(p.url()));
  if (!page) { console.log('no wegmans page'); process.exit(1); }
  const seen: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/digitaldevelopment|\/api\//.test(u) && !/\.(png|jpg|svg|woff|css|js)/.test(u)) {
      const line = r.method() + ' ' + u.replace(/^https?:\/\//, '').slice(0, 110);
      if (!seen.includes(line)) seen.push(line);
    }
  });
  console.log('navigating to the cart…');
  try { await page.goto('https://www.wegmans.com/shop/cart', { waitUntil: 'domcontentloaded', timeout: 45000 }); }
  catch (e) { console.log('nav:', String(e).slice(0, 90)); }
  await page.waitForTimeout(9000);
  console.log('url:', page.url().slice(0, 90));
  console.log('--- requests ---');
  for (const s of seen.slice(0, 40)) console.log(' ', s);
  await b.close();
})();
