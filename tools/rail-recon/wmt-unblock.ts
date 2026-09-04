// Let the page run PerimeterX's own JS, which is what issues a fresh decision
// cookie. A fetch never does that, which is why probing alone cannot recover.
import { chromium } from 'playwright';
(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const page = b.contexts()[0].pages().find((p) => /walmart\.com/.test(p.url()));
  if (!page) { console.log('no page'); process.exit(1); }
  for (const url of ['https://www.walmart.com/', 'https://www.walmart.com/']) {
    try { await page.goto(url, { waitUntil: 'load', timeout: 60000 }); }
    catch (e) { console.log('nav:', String(e).slice(0, 60)); }
    await page.waitForTimeout(15000);
    const state = await page.evaluate(`(function () {
      return { title: document.title.slice(0, 40),
               hasPayload: !!document.getElementById('__NEXT_DATA__'),
               px: document.cookie.indexOf('_px3') >= 0 };
    })()`) as any;
    console.log(JSON.stringify(state));
    if (state.hasPayload) break;
  }
  await b.close();
})();
