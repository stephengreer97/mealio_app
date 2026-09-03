// READ ONLY. MSAL caches the authority's OpenID metadata. Find the token
// endpoint and the scopes, rather than guessing a B2C URL.
(async () => {
  const out = { metaKeys: [], tokenEndpoint: null, scopes: null, clientIds: [], plainKeys: [] };
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    const v = localStorage.getItem(k) || '';
    if (/authority|metadata|openid|endpoint/i.test(k)) {
      out.metaKeys.push({ key: k.slice(0, 90), bytes: v.length });
      const m = v.match(/"token_endpoint"\s*:\s*"([^"]+)"/);
      if (m) out.tokenEndpoint = m[1];
    }
    // Unencrypted msal entries name the client and the policy.
    if (/^msal\./.test(k) && v && v[0] !== '{') out.plainKeys.push({ key: k.slice(0, 80), peek: v.slice(0, 60) });
    else if (/^msal\./.test(k) && !/"data"/.test(v)) out.plainKeys.push({ key: k.slice(0, 80), peek: v.slice(0, 80) });
  }
  out.plainKeys = out.plainKeys.slice(0, 12);
  try {
    const m = window.msal && window.msal.clientIds;
    out.clientIds = m ? (Array.isArray(m) ? m : Object.values(m).map(String)) : [];
  } catch (e) {}
  // Any key naming the policy, which a B2C token URL needs.
  const policies = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) || '';
    const m = k.match(/b2c_1a_[a-z0-9_]+/i);
    if (m) policies.add(m[0]);
  }
  out.policies = Array.from(policies);
  return out;
})()
