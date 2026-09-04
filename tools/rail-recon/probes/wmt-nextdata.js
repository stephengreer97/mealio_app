// Is there a JSON search route that is not the challenged HTML one?
(async () => {
  const out = {};
  // buildId from the homepage, which is not challenged.
  const h = await fetch('/', { credentials: 'include' });
  const html = await h.text();
  const start = html.indexOf('<script id="__NEXT_DATA__"');
  let buildId = null;
  if (start >= 0) {
    const open = html.indexOf('>', start), close = html.indexOf('</script>', open);
    try { buildId = JSON.parse(html.slice(open + 1, close)).buildId; } catch (e) {}
  }
  out.buildId = buildId;
  out.homeStatus = h.status;
  if (!buildId) return out;
  const tryUrl = async (label, url) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { credentials: 'include', headers: { 'x-nextjs-data': '1' } });
      const t = await r.text();
      let items = null, ok = false;
      try {
        const j = JSON.parse(t);
        const stacks = j.pageProps.initialData.searchResult.itemStacks || [];
        items = (stacks[0] && stacks[0].items || []).length;
        ok = true;
      } catch (e) {}
      return { label, status: r.status, ms: Date.now() - t0, bytes: t.length, ok, items,
        challenge: /Robot or human|px-captcha/i.test(t.slice(0, 3000)),
        peek: ok ? null : t.slice(0, 90) };
    } catch (e) { return { label, err: String(e && e.message).slice(0, 50) }; }
  };
  out.tries = [];
  out.tries.push(await tryUrl('search.json', '/_next/data/' + buildId + '/search.json?q=sour+cream'));
  out.tries.push(await tryUrl('search.json+query', '/_next/data/' + buildId + '/search.json?query=sour+cream&q=sour+cream'));
  return out;
})()
