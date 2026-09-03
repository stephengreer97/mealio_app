// READ ONLY. Which hosts and paths has THIS page actually called?
(async () => {
  const hosts = {};
  const apiPaths = [];
  for (const e of performance.getEntriesByType('resource')) {
    let u; try { u = new URL(e.name); } catch (err) { continue; }
    hosts[u.host] = (hosts[u.host] || 0) + 1;
    if (/wegmans/.test(u.host) && /api|commerce|graphql|search|product|store/i.test(u.pathname)) {
      if (apiPaths.length < 30) apiPaths.push(u.host + u.pathname.slice(0, 70));
    }
  }
  return {
    hosts: Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 18),
    apiPaths: Array.from(new Set(apiPaths)).slice(0, 20),
  };
})()
