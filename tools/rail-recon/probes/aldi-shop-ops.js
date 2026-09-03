// Can any operation hand back the SHOP the user is shopping, so the rail does
// not need a storefront page load to learn it? Read-only.
(async () => {
  const out = {};
  const gql = async (name, hash, variables) => {
    const t0 = Date.now();
    try {
      const r = await fetch('/graphql', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
        body: JSON.stringify({ operationName: name, variables: variables || {},
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
      });
      const t = await r.text();
      const vars = (t.match(/Variable \$(\w+) of type ([^ ]+) was/g) || []);
      out[name] = { status: r.status, ms: Date.now() - t0,
                    vars: vars.length ? vars : undefined,
                    peek: vars.length ? undefined : t.slice(0, 700) };
    } catch (e) { out[name] = { err: String(e).slice(0, 120) }; }
  };
  await gql('ContinueShoppingUserCarts', 'c1713d77cee78b917308b38427add0abf59bb9d65691ca39d03d09e828a130be');
  await gql('AssociatedCarts', '718fce7212401b161fdb9f3e747758ada0ff6b894629864c2d10878c0a8dbeda');
  await gql('GetDefaultShopAddress', '3319fcc1d3c1059c63bdfb758463a42191efe31425a0e1980051bb6a564fd66b');
  await gql('ActiveCartId', '6803f97683d706ab6faa3c658a0d6766299dbe1ff55f78b720ca2ef77de7c5c7');
  return out;
})()
