// The store number is not on robots.txt. Fetch a real page as TEXT and look for
// the markers the site itself uses.
(async () => {
  const out = {};
  const grab = (hay, needle, len) => {
    const at = hay.indexOf(needle);
    if (at < 0) return null;
    let v = '';
    for (let i = at + needle.length; i < at + needle.length + (len || 5); i++) {
      const ch = hay.charAt(i);
      if (ch < '0' || ch > '9') break;
      v += ch;
    }
    return v || null;
  };
  for (const path of ['/shop', '/']) {
    const t0 = Date.now();
    let html = '';
    try {
      const r = await fetch(path, { credentials: 'include' });
      html = await r.text();
      out[path] = { status: r.status, ms: Date.now() - t0, bytes: html.length };
    } catch (e) { out[path] = { err: String(e).slice(0, 90) }; continue; }
    out[path].markers = {
      storeNumberJson: grab(html, '"storeNumber":"', 5) || grab(html, '"storeNumber":', 5),
      storeNumberEsc: grab(html, '%22storeNumber%22%3A%22', 5) || grab(html, '\\"storeNumber\\":\\"', 5),
      apiPath: grab(html, '/api/stores/store-number/', 5),
      categoriesPath: grab(html, '/api/categories/v3/pickup/', 5) || grab(html, '/api/categories/v3/instore/', 5),
      selectedStore: grab(html, '"selectedStore":', 5) || grab(html, '"storeId":', 5),
    };
  }
  return out;
})()
