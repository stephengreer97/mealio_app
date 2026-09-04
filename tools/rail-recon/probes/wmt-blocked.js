// READ ONLY. Is this session being challenged, and does it recover?
(async () => {
  const out = { tries: [] };
  const one = async (label, url) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { credentials: 'include' });
      const t = await r.text();
      return { label, status: r.status, ms: Date.now() - t0, bytes: t.length,
        hasPayload: t.indexOf('<script id="__NEXT_DATA__"') >= 0,
        title: (t.match(/<title>([^<]{0,60})/) || [])[1] || null,
        challenge: /px-captcha|Robot or human|blocked|Access Denied|verify you are|challenge/i.test(t.slice(0, 4000)) };
    } catch (e) { return { label, err: String(e && e.message).slice(0, 50) }; }
  };
  out.tries.push(await one('search', '/search?q=butter'));
  out.tries.push(await one('homepage', '/'));
  // Cookie names only — is there a PX/Akamai marker?
  out.cookies = document.cookie.split(';').map((c) => c.split('=')[0].trim())
    .filter((n) => /^_px|^_abck|^bm_|^ak_|akav|reese/i.test(n));
  return out;
})()
