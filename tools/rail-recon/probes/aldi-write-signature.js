// SIGNATURE ONLY. Sending no variables makes the server reject on validation
// BEFORE the mutation executes, so the error names the argument types and
// nothing is written. Do not put real values in here without the account
// owner awake and asking for it.
(async () => {
  const out = {};
  const sig = async (name, hash) => {
    const t0 = Date.now();
    const r = await fetch('/graphql', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
      body: JSON.stringify({ operationName: name, variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
    });
    const t = await r.text();
    const vars = [...t.matchAll(/Variable \$(\w+) of type ([^ ]+) was/g)].map((m) => `$${m[1]}: ${m[2]}`);
    out[name] = { status: r.status, ms: Date.now() - t0, vars: vars.length ? vars : undefined, peek: vars.length ? undefined : t.slice(0, 300) };
  };
  await sig('UpdateCartItemsMutation', 'a88cb16f9d30ef225e487baf6eda6851786440e74ffe73d66908ac2ab8b227a7');
  await sig('AddAllCta', '090cc7d6789cb73eed94ca011eb5e23c5ec450fc5fbdab6d495b4b0a694acf01');
  await sig('SearchResultsView', '455228c99365fcb944c689e4fd9be69c3dbe6c2343546acb3f5458988f88462f');
  await sig('ItemDetailsRetailerProduct', '5ac2d820f689a151c7dbaccefbbcb4b59d1c84db56a667a6b90d0137d5e72cca');
  return out;
})()
