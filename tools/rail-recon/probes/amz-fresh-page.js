// READ ONLY. What does an Amazon Fresh search page actually offer?
(async () => {
  const out = { url: location.href.slice(0, 80) };
  const btns = [];
  const all = document.querySelectorAll('button, input[type=submit], [role=button], a[href*="add"]');
  for (let i = 0; i < all.length && btns.length < 25; i++) {
    const r = all[i].getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    btns.push(((all[i].getAttribute('aria-label') || '') + ' | ' + (all[i].textContent || '').trim()).slice(0, 52));
  }
  out.buttons = btns;
  const html = document.documentElement.innerHTML;
  out.markers = {
    dataAsin: (html.match(/data-asin="[A-Z0-9]{10}"/g) || []).length,
    addToCartForms: (html.match(/name="ASIN"|add-to-cart-button|submit\.add-to-cart/g) || []).length,
    offerListingId: (html.match(/offerListingID|offer-listing-id/gi) || []).length,
    almStorefront: /almBrandId|amazonfresh|Amazon Fresh/i.test(html),
    signIn: /nav-link-accountList[^>]*signin/i.test(html),
  };
  out.cartCount = (function () { const n = document.querySelector('#nav-cart-count'); return n ? n.textContent.trim() : null; })();
  out.title = document.title.slice(0, 60);
  return out;
})()
