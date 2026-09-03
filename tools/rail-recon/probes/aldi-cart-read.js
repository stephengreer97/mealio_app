// Read-only. Calls the harvested cart operations with no variables so the
// server's own error names what they require — a safe way to learn a signature
// on a platform that refuses introspection.
(async () => {
  const out = {};
  const call = async (name, hash, variables) => {
    const t0 = Date.now();
    try {
      const r = await fetch('/graphql', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
        body: JSON.stringify({ operationName: name, variables: variables || {},
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
      });
      const t = await r.text();
      out[name] = { status: r.status, ms: Date.now() - t0, peek: t.slice(0, 700) };
    } catch (e) { out[name] = { err: String(e).slice(0, 120) }; }
  };
  await call('ActiveCartId', '6803f97683d706ab6faa3c658a0d6766299dbe1ff55f78b720ca2ef77de7c5c7');
  await call('ActiveCarts', '839c3658a57f86c543ba367a16d0eaa648f167a1eaf20f6d80aa14165f1ee10d');
  await call('CartItems', '60fa63eb1afba0204993af2a7ea12e057f0ae2677e71753fc05d5a9c5b4adb6c');
  return out;
})()
