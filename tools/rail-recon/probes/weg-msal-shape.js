// READ ONLY. What is window.msal, and can it mint a token for us?
// Reports shapes and names. Never a token value.
(async () => {
  const out = {};
  const m = window.msal;
  out.type = typeof m;
  if (!m) return out;
  out.ownKeys = Object.keys(m).slice(0, 30);
  out.protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(m) || {}).slice(0, 40);
  out.ctor = m.constructor && m.constructor.name;
  // A PublicClientApplication exposes these.
  for (const fn of ['getAllAccounts', 'getActiveAccount', 'acquireTokenSilent', 'initialize',
                    'getConfiguration', 'getTokenCache']) {
    out[fn] = typeof m[fn];
  }
  try {
    const accts = typeof m.getAllAccounts === 'function' ? m.getAllAccounts() : null;
    out.accounts = Array.isArray(accts)
      ? accts.map((a) => ({ hasHomeId: !!a.homeAccountId, env: a.environment, keys: Object.keys(a).slice(0, 12) }))
      : null;
  } catch (e) { out.accountsErr = String(e && e.message).slice(0, 120); }
  try {
    const cfg = typeof m.getConfiguration === 'function' ? m.getConfiguration() : null;
    out.config = cfg ? {
      clientId: cfg.auth && cfg.auth.clientId ? 'present(' + String(cfg.auth.clientId).length + ')' : null,
      authority: cfg.auth && cfg.auth.authority ? String(cfg.auth.authority).slice(0, 90) : null,
      knownAuthorities: cfg.auth && cfg.auth.knownAuthorities,
      cacheLocation: cfg.cache && cfg.cache.cacheLocation,
    } : null;
  } catch (e) { out.configErr = String(e && e.message).slice(0, 120); }
  return out;
})()
