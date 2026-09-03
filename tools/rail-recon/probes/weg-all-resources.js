(async () => {
  const rows = [];
  for (const e of performance.getEntriesByType('resource')) {
    let u; try { u = new URL(e.name); } catch (err) { continue; }
    if (!/wegmans/.test(u.host)) continue;
    if (/\.(png|jpg|jpeg|svg|woff2?|css|gif|webp)(\?|$)/.test(u.pathname)) continue;
    rows.push(u.host + u.pathname + (u.search ? u.search.slice(0, 40) : ''));
  }
  return { url: location.href.slice(0, 70), count: rows.length, paths: Array.from(new Set(rows)).slice(0, 30) };
})()
