// Capture the exact headers Walmart's own orchestra calls carry, plus the shape
// of a search item in the SSR payload and the cart id map.
import { chromium } from 'playwright';

const RECORDER = `(function () {
  window.__cap = [];
  var of = window.fetch;
  window.fetch = function () {
    var a = arguments, url = String((a[0] && a[0].url) || a[0] || '');
    var init = a[1] || {};
    if (url.indexOf('/orchestra/') >= 0) {
      var hdrs = {};
      try {
        var h = init.headers || (a[0] && a[0].headers);
        if (h && typeof h.forEach === 'function') h.forEach(function (v, k) { hdrs[k] = String(v).slice(0, 60); });
        else if (h) for (var k in h) hdrs[k] = String(h[k]).slice(0, 60);
      } catch (e) {}
      window.__cap.push({ url: url.slice(0, 150), method: (init.method || 'GET'), headers: hdrs });
    }
    return of.apply(this, a);
  };
})()`;

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const page = b.contexts()[0].pages().find((p) => /walmart\.com/.test(p.url()));
  if (!page) { console.log('no walmart page'); process.exit(1); }
  await page.addInitScript(RECORDER);
  await page.goto('https://www.walmart.com/search?q=' + encodeURIComponent(process.env.WMT_TERM || 'sour cream'),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(14000);

  const shape = await page.evaluate(`(function () {
    var out = {};
    try { out.cartIdMap = JSON.parse(localStorage.getItem('glassCartIdMap') || 'null'); } catch (e) {}
    var nd = document.getElementById('__NEXT_DATA__');
    if (nd) {
      var j = JSON.parse(nd.textContent || '{}');
      var pp = (j.props && j.props.pageProps) || {};
      var sr = pp.initialData && pp.initialData.searchResult;
      var stacks = (sr && sr.itemStacks) || [];
      var items = (stacks[0] && stacks[0].items) || [];
      out.stackCount = stacks.length;
      out.itemCount = items.length;
      var it = items.find(function (x) { return x && x.usItemId; }) || items[0] || {};
      out.itemKeys = Object.keys(it).slice(0, 40);
      out.sample = {
        usItemId: it.usItemId, name: String(it.name || '').slice(0, 40),
        offerId: it.offerId || (it.offer && it.offer.offerId) || null,
        availability: it.availabilityStatusDisplayValue || it.availabilityStatus || null,
        price: it.price || (it.priceInfo && it.priceInfo.currentPrice && it.priceInfo.currentPrice.price) || null,
        image: it.image ? 'yes' : null,
        weight: it.weightIncrement || it.isVariantTypeSwatch || null,
        canAdd: it.canAddToCart, quantity: it.quantity,
      };
      var s = nd.textContent;
      out.signedIn = { customerIdPresent: s.indexOf('"customerId":"') >= 0 };
    }
    return out;
  })()`) as any;
  console.log('SHAPE', JSON.stringify(shape, null, 1).slice(0, 2200));

  const caps = await page.evaluate('(window.__cap || []).slice(0, 4)') as any[];
  console.log('');
  console.log('ORCHESTRA CALLS');
  for (const c of caps) {
    console.log(' ', c.method, String(c.url).replace(/^https?:../, '').slice(0, 120));
    console.log('   headers:', JSON.stringify(c.headers));
  }
  await b.close();
})();
