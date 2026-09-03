// Which operation turns item ids into products? Signatures first — sending no
// arguments makes the server name what it wants, and nothing executes.
(async () => {
  const out = {};
  const sig = async (name, hash, vars) => {
    try {
      const r = await fetch('/graphql', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
        body: JSON.stringify({ operationName: name, variables: vars || {},
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
      });
      const t = await r.text();
      const v = (t.match(/Variable \$(\w+) of type ([^ ]+) was/g) || []).map((x) => x.replace(' was', ''));
      out[name] = v.length ? { vars: v } : { peek: t.slice(0, 260) };
    } catch (e) { out[name] = { err: String(e).slice(0, 90) }; }
  };
  const OPS = JSON.parse(document.getElementById('__ops').textContent);
  for (const [n, h] of Object.entries(OPS)) await sig(n, h);
  return out;
})()
