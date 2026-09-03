// READ ONLY. Walmart: what bootstrapData knows about the account and cart, and
// what the persisted-query config exposes.
(async () => {
  const out = {};
  const nd = document.getElementById('__NEXT_DATA__');
  if (!nd) return { why: 'no __NEXT_DATA__' };
  const j = JSON.parse(nd.textContent || '{}');
  const props = (j.props && j.props.pageProps) || {};
  const bd = props.bootstrapData || {};
  out.bootstrapKeys = Object.keys(bd).slice(0, 20);
  // Walk for account/cart facts, reporting PATHS and only boolean/number values.
  const facts = [];
  const walk = (n, p, d) => {
    if (n == null || d > 6 || facts.length > 40) return;
    if (Array.isArray(n)) { if (n[0]) walk(n[0], p + '[]', d + 1); return; }
    if (typeof n === 'object') { for (const k of Object.keys(n)) walk(n[k], p ? p + '.' + k : k, d + 1); return; }
    if (/loggedin|signedin|isguest|cartcount|itemcount|numitems|quantity|storeid|postal|fulfil/i.test(p)) {
      facts.push(p + ' = ' + (typeof n === 'string' ? String(n).slice(0, 14) : String(n)));
    }
  };
  walk(bd, '', 0);
  out.accountAndCart = facts.slice(0, 30);
  out.persistedQueries = props.persistedQueriesConfig
    ? { keys: Object.keys(props.persistedQueriesConfig).slice(0, 10),
        peek: JSON.stringify(props.persistedQueriesConfig).slice(0, 240) }
    : null;
  // Where do the search results live?
  const id = props.initialData || {};
  out.initialDataKeys = Object.keys(id).slice(0, 12);
  try {
    const sr = id.searchResult || (id.data && id.data.search);
    out.searchResultKeys = sr ? Object.keys(sr).slice(0, 14) : null;
  } catch (e) {}
  return out;
})()
