// Every operation name in the storefront bundles, so the right one can be
// chosen rather than guessed at. Names only — the values are fetched later for
// whichever ones matter.
(async () => {
  const out = { scanned: 0, total: 0, names: [] };
  const urls = performance.getEntriesByType('resource')
    .filter((e) => /\.js(\?|$)/.test(e.name)).map((e) => e.name);
  const seen = {};
  for (const u of urls.slice(0, 90)) {
    let txt = '';
    try { const r = await fetch(u); txt = await r.text(); } catch (e) { continue; }
    out.scanned++;
    const re = /["']([A-Za-z][A-Za-z0-9_]{2,50})["']\s*:\s*["']([0-9a-f]{64})["']/g;
    let m;
    while ((m = re.exec(txt)) !== null) seen[m[1]] = m[2];
  }
  const all = Object.keys(seen);
  out.total = all.length;
  // The ones that could plausibly turn a list of item ids into products.
  const WANT = /(^Items|ItemsBy|^Item[A-Z]|Products?$|^Products|RetailerProducts|ItemList|Hydrat|Batch|Cards?$|^Get.*Items)/;
  out.names = all.filter((n) => WANT.test(n)).map((n) => n + ' ' + seen[n].slice(0, 10));
  return out;
})()
