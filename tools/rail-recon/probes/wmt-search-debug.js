(async () => {
  const r = await fetch('https://www.walmart.com/search?q=' + encodeURIComponent('sour cream'), { credentials: 'include' });
  const html = await r.text();
  const out = { status: r.status, bytes: html.length, title: (html.match(/<title>([^<]*)/) || [])[1] };
  const start = html.indexOf('__NEXT_DATA__');
  out.firstIdx = start;
  if (start >= 0) {
    out.around = html.slice(Math.max(0, start - 80), start + 60).replace(/\s+/g, ' ');
    const open = html.indexOf('>', start);
    const close = html.indexOf('</script>', open);
    out.open = open; out.close = close;
    out.slicePeek = html.slice(open + 1, open + 60);
  }
  // The regex the earlier probe used
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  out.regexFound = !!m;
  if (m) { out.regexLen = m[1].length; out.regexPeek = m[1].slice(0, 50); }
  out.blockish = /Access Denied|Robot or human|captcha|px-captcha/i.test(html);
  return out;
})()
