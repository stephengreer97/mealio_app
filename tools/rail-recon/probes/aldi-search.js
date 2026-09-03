(async () => {
  const gql = async (name, hash, variables) => {
    const t0 = Date.now();
    const r = await fetch('/graphql', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
      body: JSON.stringify({ operationName: name, variables, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
    });
    const t = await r.text();
    return { status: r.status, ms: Date.now() - t0, bytes: t.length, json: t.slice(0, 1600) };
  };
  const H = '19889f981af1f9c5c70543f3d7555bf0d435e026fc96329984fc3414e3b56d8e';
  const out = {};
  out.a = await gql('AsyncItemSearch', H, { query: 'sour cream', shopId: '8583', postalCode: '00000', searchSource: 'search' });
  return out;
})()
