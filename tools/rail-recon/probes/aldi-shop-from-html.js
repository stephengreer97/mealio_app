// Fetch the storefront HTML as TEXT and pull the shop id out of it.
//
// Same-origin GET, no page load, no rendering, no JS of theirs running. The
// value is in the URL-ENCODED server payload, which is why looking for the
// plain string "shopId":" found nothing.
(async () => {
  const out = {};
  const t0 = Date.now();
  let html = '';
  try {
    const r = await fetch('/store/aldi/storefront', { credentials: 'include' });
    html = await r.text();
    out.status = r.status;
  } catch (e) { return { err: String(e).slice(0, 140) }; }
  out.ms = Date.now() - t0;
  out.bytes = html.length;
  var grab = function (needle, len) {
    var at = html.indexOf(needle);
    if (at < 0) return null;
    var from = at + needle.length;
    var v = '';
    for (var i = from; i < from + len; i++) {
      var ch = html.charAt(i);
      if (ch < '0' || ch > '9') break;
      v += ch;
    }
    return v || null;
  };
  out.encoded = grab('%22shopId%22%3A%22', 8);
  out.escaped = grab('%5C%22shopId%5C%22%3A%5C%22', 8);
  out.plain = grab('"shopId":"', 8);
  out.shopsArray = grab('%22shops%22%3A%5B%7B%22id%22%3A%22', 8);
  return out;
})()
