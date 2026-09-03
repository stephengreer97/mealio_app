// Can a rail find a store's persisted-query hashes in its own JS at runtime?
//
// This is the Albertsons APIM-key pattern applied to GraphQL: the page already
// ships what we need, so harvest it, cache it, and re-harvest when the store
// says the hash is unknown. Run with tools/rail-recon/probe.ts on a page of the
// store that has loaded its app bundle.
(async () => {
  const out = { scripts: 0, scanned: 0, bytes: 0, byPattern: {}, interesting: {}, samples: [] };
  const urls = performance.getEntriesByType('resource')
    .filter((e) => /\.js(\?|$)/.test(e.name)).map((e) => e.name);
  out.scripts = urls.length;
  const WANT = /(cart|Cart|search|Search|item|Item|add|Add)/;
  const hits = {};
  for (const u of urls.slice(0, 80)) {
    let txt = '';
    try { const r = await fetch(u); txt = await r.text(); } catch (e) { continue; }
    out.scanned++; out.bytes += txt.length;
    const pats = {
      slashHash: /["'`]([A-Za-z][A-Za-z0-9_]{2,40})\/([0-9a-f]{64})["'`]/g,
      mapHash: /["']([A-Za-z][A-Za-z0-9_]{2,40})["']\s*:\s*["']([0-9a-f]{64})["']/g,
      shaField: /sha256Hash["']?\s*:\s*["']([0-9a-f]{64})["']/g,
    };
    for (const name of Object.keys(pats)) {
      const re = pats[name];
      let m;
      while ((m = re.exec(txt)) !== null) {
        out.byPattern[name] = (out.byPattern[name] || 0) + 1;
        if (name === 'shaField') {
          const back = txt.slice(Math.max(0, m.index - 400), m.index);
          const ops = back.match(/operationName["']?\s*:\s*["']([A-Za-z0-9_]+)["']/g);
          const op = ops && ops.length ? ops[ops.length - 1].split(/["']/).filter(Boolean).pop() : null;
          hits[op || ('anon@' + m[1].slice(0, 8))] = m[1];
        } else {
          hits[m[1]] = m[2];
        }
      }
    }
    if (out.samples.length < 4 && /persistedQuery|sha256Hash/.test(txt)) {
      const i = txt.search(/persistedQuery|sha256Hash/);
      out.samples.push(u.split('/').pop().slice(0, 46) + ' :: ' +
        txt.slice(Math.max(0, i - 120), i + 200).replace(/\s+/g, ' '));
    }
  }
  out.totalHashes = Object.keys(hits).length;
  for (const k of Object.keys(hits)) if (WANT.test(k)) out.interesting[k] = hits[k];
  out.interestingCount = Object.keys(out.interesting).length;
  return out;
})()
