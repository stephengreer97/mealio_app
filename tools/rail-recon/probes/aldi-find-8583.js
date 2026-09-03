// The site sends shopId 8583. Find where it keeps it, by looking for the value
// rather than guessing at the key.
(async () => {
  const out = { href: location.href, where: [] };
  const NEEDLE = '8583';
  const note = (from, ctx) => { if (out.where.length < 14) out.where.push({ from, ctx: String(ctx).slice(0, 180) }); };
  try {
    const html = document.documentElement.outerHTML;
    out.htmlLen = html.length;
    let at = -1;
    let n = 0;
    while ((at = html.indexOf(NEEDLE, at + 1)) >= 0 && n < 8) {
      note('html@' + at, html.slice(Math.max(0, at - 90), at + 40));
      n++;
    }
    out.htmlCount = n;
  } catch (e) { out.htmlErr = String(e).slice(0, 90); }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) || '';
      const at = v.indexOf(NEEDLE);
      if (at >= 0) note('ls:' + k.slice(0, 50), v.slice(Math.max(0, at - 70), at + 40));
    }
  } catch (e) {}
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      const v = sessionStorage.getItem(k) || '';
      const at = v.indexOf(NEEDLE);
      if (at >= 0) note('ss:' + k.slice(0, 50), v.slice(Math.max(0, at - 70), at + 40));
    }
  } catch (e) {}
  try { if (document.cookie.indexOf(NEEDLE) >= 0) note('cookie', document.cookie.slice(0, 300)); } catch (e) {}
  // Globals a storefront serialises into.
  try {
    for (const g of ['__NEXT_DATA__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__NUXT__', '__remixContext']) {
      if (!window[g]) continue;
      const j = JSON.stringify(window[g]);
      const at = j.indexOf(NEEDLE);
      out.where.push({ from: 'global:' + g, ctx: at >= 0 ? j.slice(Math.max(0, at - 80), at + 40) : '(present, no 8583)' });
    }
  } catch (e) {}
  return out;
})()
