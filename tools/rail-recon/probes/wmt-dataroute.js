// Is the Next.js data route smaller and faster than the HTML page, and does it
// carry the same results? Six requests, no writes.
(async () => {
  const out = {};
  // buildId from a page. It changes with every deploy, so it is cached, not pinned.
  const h = await fetch('/', { credentials: 'include' });
  const html = await h.text();
  out.homeStatus = h.status;
  out.homeBytes = html.length;
  const start = html.indexOf('<script id="__NEXT_DATA__"');
  if (start < 0) return Object.assign(out, { why: 'still challenged' });
  const open = html.indexOf('>', start), close = html.indexOf('</script>', open);
  const nd = JSON.parse(html.slice(open + 1, close));
  out.buildId = nd.buildId || null;
  if (!out.buildId) return Object.assign(out, { why: 'no buildId', topKeys: Object.keys(nd).slice(0, 10) });

  const parseItems = (payloadRoot) => {
    try {
      const stacks = payloadRoot.initialData.searchResult.itemStacks || [];
      const all = [];
      for (const s of stacks) for (const i of (s.items || [])) all.push(i);
      return all;
    } catch (e) { return null; }
  };

  const term = 'sour cream';
  // A: the HTML route the rail uses today.
  let t0 = Date.now();
  const a = await fetch('/search?q=' + encodeURIComponent(term), { credentials: 'include' });
  const aTxt = await a.text();
  const aMs = Date.now() - t0;
  let aItems = null;
  try {
    const s2 = aTxt.indexOf('<script id="__NEXT_DATA__"');
    const o2 = aTxt.indexOf('>', s2), c2 = aTxt.indexOf('</script>', o2);
    aItems = parseItems(JSON.parse(aTxt.slice(o2 + 1, c2)).props.pageProps);
  } catch (e) {}
  out.htmlRoute = { status: a.status, ms: aMs, bytes: aTxt.length, items: aItems ? aItems.length : null };

  // B: the data route.
  t0 = Date.now();
  const b = await fetch('/_next/data/' + out.buildId + '/search.json?q=' + encodeURIComponent(term),
    { credentials: 'include', headers: { 'x-nextjs-data': '1' } });
  const bTxt = await b.text();
  const bMs = Date.now() - t0;
  let bItems = null, bShape = null;
  try {
    const j = JSON.parse(bTxt);
    bShape = Object.keys(j).slice(0, 6);
    bItems = parseItems(j.pageProps);
  } catch (e) {}
  out.dataRoute = { status: b.status, ms: bMs, bytes: bTxt.length, items: bItems ? bItems.length : null,
    shape: bShape, peek: bItems ? null : bTxt.slice(0, 110) };
  if (aItems && bItems) {
    out.sameFirst = aItems[0] && bItems[0] && aItems[0].offerId === bItems[0].offerId;
    out.savedPercent = Math.round((1 - bTxt.length / aTxt.length) * 100);
  }
  return out;
})()
