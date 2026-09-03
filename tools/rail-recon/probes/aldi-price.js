// Price came back "Not Found". Is that the placeholder postcode, or the zone?
// The real postcode is in the storefront payload, so it is READ rather than
// hard-coded.
(async () => {
  const out = {};
  let postal = null;
  try {
    const html = await (await fetch('/store/aldi/storefront', { credentials: 'include' })).text();
    const at = html.indexOf('%5C%22postalCode%5C%22%3A%5C%22');
    if (at > 0) postal = html.substr(at + 30, 5);
    out.postalFrom = postal ? 'storefront' : 'not found';
  } catch (e) {}
  const gql = async (vars) => {
    const t0 = Date.now();
    const r = await fetch('/graphql', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
      body: JSON.stringify({ operationName: 'Search', variables: vars,
        extensions: { persistedQuery: { version: 1, sha256Hash: '6d77b6fd5b62f6d88999f5a022af16fafcb00de911da6b942990f61a478ed8c1' } } }),
    });
    const j = JSON.parse(await r.text());
    let items = [];
    try { items = j.data.searchResults.primaryItemResultList.items || []; } catch (e) {}
    const first = items[0] || {};
    let price = null;
    try {
      const vs = first.viewSection || {};
      price = vs.priceString || (first.price && first.price.viewSection && first.price.viewSection.priceString) || null;
      if (!price && first.price) price = JSON.stringify(first.price).slice(0, 120);
    } catch (e) {}
    return { ms: Date.now() - t0, errs: (j.errors || []).length, n: items.length,
             name: first.name || null, price: price,
             viewKeys: first.viewSection ? Object.keys(first.viewSection).slice(0, 10) : null };
  };
  out.placeholder = await gql({ query: 'sour cream', shopId: '8583', zoneId: '23898', postalCode: '00000' });
  if (postal) out.realPostcode = await gql({ query: 'sour cream', shopId: '8583', zoneId: '23898', postalCode: postal });
  out.zoneIsShop = await gql({ query: 'sour cream', shopId: '8583', zoneId: '8583', postalCode: postal || '00000' });
  return out;
})()
