(async () => {
  const r = await fetch('/search?q=butter', { credentials: 'include' });
  const html = await r.text();
  const s = html.indexOf('<script id="__NEXT_DATA__"');
  if (s < 0) return { why: 'challenged', bytes: html.length };
  const o = html.indexOf('>', s), c = html.indexOf('</script>', o);
  const j = JSON.parse(html.slice(o + 1, c));
  return {
    page: j.page, buildId: j.buildId, query: j.query,
    assetPrefix: j.assetPrefix || null,
    // What the client would actually request for a client-side nav.
    guess: '/_next/data/' + j.buildId + j.page + '.json',
    nextExport: j.nextExport, gip: j.gip, appGip: j.appGip, isFallback: j.isFallback,
  };
})()
