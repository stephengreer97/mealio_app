// What is actually in the MSAL index, and do the keys it names exist?
// Names and lengths only — no secrets.
(async () => {
  const out = { index: null, named: [], allMsalKeys: [] };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^msal\./.test(k)) out.allMsalKeys.push({ k, len: (localStorage.getItem(k) || '').length });
    }
    const idxKey = out.allMsalKeys.map((e) => e.k).find((k) => /token\.keys\./.test(k));
    const idx = JSON.parse(localStorage.getItem(idxKey) || '{}');
    out.index = { fields: Object.keys(idx), counts: {} };
    for (const f of Object.keys(idx)) out.index.counts[f] = Array.isArray(idx[f]) ? idx[f].length : typeof idx[f];
    for (const name of (idx.accessToken || [])) {
      const raw = localStorage.getItem(name);
      let fields = null;
      if (raw) { try { fields = Object.keys(JSON.parse(raw)); } catch (e) { fields = 'unparseable'; } }
      out.named.push({ nameTail: name.slice(-70), present: !!raw, len: raw ? raw.length : 0, fields });
    }
  } catch (e) { out.err = String(e).slice(0, 160); }
  return out;
})()
