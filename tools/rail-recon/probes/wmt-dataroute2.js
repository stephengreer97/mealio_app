(async () => {
  const r = await fetch('/search?q=butter', { credentials: 'include' });
  const html = await r.text();
  const s = html.indexOf('<script id="__NEXT_DATA__"');
  const o = html.indexOf('>', s), c = html.indexOf('</script>', o);
  const j = JSON.parse(html.slice(o + 1, c));
  const out = { buildId: j.buildId, tries: [] };
  const one = async (label, url) => {
    const t0 = Date.now();
    try {
      const rr = await fetch(url, { credentials: 'include', headers: { 'x-nextjs-data': '1' } });
      const t = await rr.text();
      let items = null;
      try { const jj = JSON.parse(t);
        const st = jj.pageProps.initialData.searchResult.itemStacks || [];
        items = (st[0] && st[0].items || []).length; } catch (e) {}
      out.tries.push({ label, status: rr.status, ms: Date.now() - t0, bytes: t.length, items,
        peek: items == null ? t.slice(0, 70) : null });
    } catch (e) { out.tries.push({ label, err: String(e && e.message).slice(0, 50) }); }
  };
  const q = '?q=' + encodeURIComponent('butter');
  await one('same-origin', '/_next/data/' + j.buildId + '/search.json' + q);
  await one('assetPrefix', j.assetPrefix + '/_next/data/' + j.buildId + '/search.json' + q);
  await one('locale path', '/_next/data/' + j.buildId + '/en-US/search.json' + q);
  return out;
})()
