// READ ONLY. Did the page's OWN calls to the commerce host actually complete?
(async () => {
  const rows = [];
  for (const e of performance.getEntriesByType('resource')) {
    if (!/digitaldevelopment/.test(e.name)) continue;
    rows.push({
      path: e.name.replace(/^https?:\/\/[^/]+/, '').slice(0, 60),
      duration: Math.round(e.duration),
      transferSize: e.transferSize,
      responseStatus: e.responseStatus != null ? e.responseStatus : null,
      initiator: e.initiatorType,
    });
    if (rows.length >= 8) break;
  }
  // Control: a cross-origin host the page also used.
  const control = [];
  for (const u of ['https://myaccount.wegmans.com/robots.txt', 'https://www.wegmans.com/robots.txt']) {
    const t0 = Date.now();
    try { const r = await fetch(u, { mode: 'no-cors' }); control.push({ u: u.slice(8, 40), type: r.type, ms: Date.now() - t0 }); }
    catch (e) { control.push({ u: u.slice(8, 40), err: String(e && e.message).slice(0, 60), ms: Date.now() - t0 }); }
  }
  // And the commerce host with no-cors — does the request leave the device?
  const t1 = Date.now();
  let nocors;
  try { const r = await fetch('https://api.digitaldevelopment.wegmans.cloud/commerce/account/customer', { mode: 'no-cors' });
    nocors = { type: r.type, ms: Date.now() - t1 }; }
  catch (e) { nocors = { err: String(e && e.message).slice(0, 80), ms: Date.now() - t1 }; }
  return { pageCalls: rows, control, commerceNoCors: nocors };
})()
