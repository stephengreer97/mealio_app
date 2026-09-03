(async () => {
  const r = await fetch('https://www.walmart.com/search?q=sour+cream', { credentials: 'include' });
  const html = await r.text();
  const start = html.indexOf('<script id="__NEXT_DATA__"');
  const open = html.indexOf('>', start), close = html.indexOf('</script>', open);
  const j = JSON.parse(html.slice(open + 1, close));
  const stacks = j.props.pageProps.initialData.searchResult.itemStacks || [];
  const items = (stacks[0] && stacks[0].items) || [];
  const sample = items.slice(0, 6).map((x) => ({
    name: String(x.name || '').slice(0, 26),
    itemPrice: x.priceInfo && x.priceInfo.itemPrice,
    current: x.priceInfo && x.priceInfo.currentPrice ? JSON.stringify(x.priceInfo.currentPrice).slice(0, 60) : null,
    linePrice: x.priceInfo && x.priceInfo.linePrice,
    price: x.price,
  }));
  const it = items.find((x) => x && x.priceInfo) || items[0] || {};
  return { sample,
    priceInfo: it.priceInfo ? JSON.stringify(it.priceInfo).slice(0, 400) : null,
    price: it.price, priceString: it.priceString,
    limits: { orderLimit: it.orderLimit, orderMinLimit: it.orderMinLimit,
              quantity: it.quantity, salesUnit: it.salesUnitType, weightInc: it.weightIncrement },
    imageKeys: it.imageInfo ? Object.keys(it.imageInfo).slice(0, 8) : null,
    image: it.image ? String(it.image).slice(0, 60) : null,
  };
})()
