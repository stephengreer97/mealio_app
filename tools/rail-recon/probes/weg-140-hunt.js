// READ ONLY. Where does 140 appear in this document, and in the shop route's HTML?
(async () => {
  const out = { inDoc: [], inShopHtml: [], cookieNames: [] };
  const grab = (html, bag) => {
    const re = /.{60}\b140\b.{60}/g;
    let m, n = 0;
    while ((m = re.exec(html)) && n < 6) { bag.push(m[0].replace(/\s+/g, ' ')); n += 1; }
  };
  grab(document.documentElement.innerHTML, out.inDoc);
  try {
    const r = await fetch('/shop', { headers: { accept: 'text/html' } });
    const t = await r.text();
    out.shopStatus = r.status; out.shopBytes = t.length;
    grab(t, out.inShopHtml);
  } catch (e) { out.shopErr = String(e && e.message).slice(0, 80); }
  out.cookieNames = document.cookie.split(';').map((c) => c.split('=')[0].trim());
  return out;
})()
