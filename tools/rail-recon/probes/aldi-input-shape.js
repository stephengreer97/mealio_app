// SIGNATURE ONLY, again. An empty object in the array fails input-type
// validation and the error names the required fields. Nothing executes.
(async () => {
  const out = {};
  const probe = async (label, variables) => {
    const t0 = Date.now();
    const r = await fetch('/graphql', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
      body: JSON.stringify({ operationName: 'UpdateCartItemsMutation', variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: 'a88cb16f9d30ef225e487baf6eda6851786440e74ffe73d66908ac2ab8b227a7' } } }),
    });
    out[label] = { status: r.status, ms: Date.now() - t0, peek: (await r.text()).slice(0, 900) };
  };
  await probe('emptyObject', { cartItemUpdates: [{}] });
  return out;
})()
