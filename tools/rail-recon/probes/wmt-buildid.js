(async () => {
  const h = await fetch('/', { credentials: 'include' });
  const html = await h.text();
  const out = { status: h.status, bytes: html.length };
  const start = html.indexOf('<script id="__NEXT_DATA__"');
  out.tagFound = start >= 0;
  if (start >= 0) {
    const open = html.indexOf('>', start), close = html.indexOf('</script>', open);
    const raw = html.slice(open + 1, close);
    out.payloadBytes = raw.length;
    try { const j = JSON.parse(raw); out.topKeys = Object.keys(j).slice(0, 12); out.buildId = j.buildId; }
    catch (e) { out.parse = String(e && e.message).slice(0, 60); out.peek = raw.slice(0, 80); }
  }
  // Fallback: the build id also appears in asset URLs.
  const m = html.match(/\/_next\/static\/([^/"]+)\/_buildManifest/);
  out.fromAssets = m ? m[1] : null;
  return out;
})()
