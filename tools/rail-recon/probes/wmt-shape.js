// READ ONLY. Walmart: is the user identifiable without a network call, and are
// search results in the SSR payload? Names and shapes only.
(async () => {
  const out = {};
  out.cookies = document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
  // Auth-ish cookie NAMES and whether they have a value (never the value).
  out.authish = document.cookie.split(';').map((c) => c.trim()).filter((c) =>
    /cid|auth|login|customer|hasCID|ACID|token|sess/i.test(c.split('=')[0]))
    .map((c) => ({ name: c.split('=')[0], len: c.slice(c.indexOf('=') + 1).length }));
  try {
    const cm = localStorage.getItem('glassCartIdMap');
    out.glassCartIdMap = cm ? { bytes: cm.length, keys: Object.keys(JSON.parse(cm)).slice(0, 6) } : null;
  } catch (e) { out.glassCartIdMap = 'unparseable'; }
  const nd = document.getElementById('__NEXT_DATA__');
  if (nd) {
    const txt = nd.textContent || '';
    out.nextData = { bytes: txt.length };
    try {
      const j = JSON.parse(txt);
      out.nextData.topKeys = Object.keys(j).slice(0, 10);
      const props = (j.props && j.props.pageProps) || {};
      out.nextData.pagePropsKeys = Object.keys(props).slice(0, 24);
      // Is the user in there?
      const s = txt;
      out.nextData.mentions = {
        isLoggedIn: /"isLoggedIn"\s*:\s*(true|false)/.exec(s)?.[0] || null,
        customerId: /"customerId"\s*:\s*"[^"]{4}/.test(s),
        itemsInSSR: (s.match(/"usItemId"/g) || []).length,
        priceInSSR: (s.match(/"priceInfo"/g) || []).length,
        cartCount: /"cartItemCount"\s*:\s*\d+/.exec(s)?.[0] || null,
      };
    } catch (e) { out.nextData.parse = 'failed'; }
  }
  return out;
})()
