// Where does the storefront keep the SHOP id?
//
// Not the retailer (ALDI the chain, 12) — the branch the user shops (8583 on
// this device), which every search and cart operation takes. ActiveCarts does
// not return it, and it was not on robots.txt, so this looks everywhere a page
// can keep something.
(async () => {
  const out = { href: location.href, cookies: [], ls: [], hits: [] };
  const NEEDLE = /(shop|retailer_location|zone|warehouse|location)/i;
  try {
    out.cookies = document.cookie.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean);
    for (const c of document.cookie.split(';')) {
      const eq = c.indexOf('=');
      const k = c.slice(0, eq).trim();
      const v = c.slice(eq + 1).trim();
      if (NEEDLE.test(k) || /^[0-9]{3,6}$/.test(v)) out.hits.push({ from: 'cookie:' + k, v: v.slice(0, 120) });
    }
  } catch (e) { out.cookieErr = String(e).slice(0, 80); }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) || '';
      out.ls.push({ k: k.slice(0, 60), len: v.length });
      if (NEEDLE.test(k) || NEEDLE.test(v.slice(0, 2000))) {
        out.hits.push({ from: 'ls:' + k.slice(0, 50), v: v.slice(0, 200) });
      }
    }
  } catch (e) { out.lsErr = String(e).slice(0, 80); }
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      const v = sessionStorage.getItem(k) || '';
      if (NEEDLE.test(k) || NEEDLE.test(v.slice(0, 2000))) {
        out.hits.push({ from: 'ss:' + k.slice(0, 50), v: v.slice(0, 200) });
      }
    }
  } catch (e) {}
  // And the page itself, which is where a storefront usually serialises it.
  try {
    const html = document.documentElement.innerHTML;
    for (const pat of ['"shopId":"', '"shop_id":', 'shopId=', '"retailerLocationId":"', '"zoneId":"']) {
      const at = html.indexOf(pat);
      if (at > 0) out.hits.push({ from: 'html:' + pat, v: html.substr(at, 60) });
    }
  } catch (e) {}
  return out;
})()
