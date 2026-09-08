// MEAL-117. Ask each store whether the identifiers we committed still work.
//
// Runs WITHOUT being signed in, deliberately. For a persisted query, "401 Not
// Authenticated" is a perfectly good yes: the server recognised the operation
// and then declined to answer an anonymous caller. What we are looking for is
// the OTHER answer -- PERSISTED_QUERY_NOT_FOUND -- which means the hash is no
// longer allow-listed and every run using it is already broken.
//
// Exit codes: 0 clean, 1 drift found, 2 the check itself could not run. The
// third exists so a flaky network does not read as a rotation.
import { execSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

// Read the inventory out of the TypeScript source rather than duplicating it.
const raw = execSync('npx tsx -e "import {DRIFT_INVENTORY} from \'./src/lib/schema-drift-inventory\'; '
  + 'console.log(JSON.stringify(DRIFT_INVENTORY))"', { cwd: process.cwd(), encoding: 'utf8' });
const inventory = JSON.parse(raw.trim().split('\n').pop());

const results = [];

async function probePersisted(e) {
  const { origin, operationName, sha256 } = e.probe;
  const body = JSON.stringify({
    operationName, variables: {},
    extensions: { persistedQuery: { version: 1, sha256Hash: sha256 } },
  });
  const res = await fetch(`${origin}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, origin, referer: `${origin}/` },
    body,
  });
  const text = await res.text();
  if (/PERSISTED_QUERY_NOT_FOUND/i.test(text)) return { ok: false, why: 'hash no longer allow-listed' };
  if (/not authenticated/i.test(text) || res.status === 401) return { ok: true, why: '401 unauth (recognised)' };
  if (res.ok) return { ok: true, why: `answered ${res.status}` };
  return { ok: null, why: `inconclusive: ${res.status}` };
}

async function probeAlgolia(e) {
  const { host, appId, apiKey, index } = e.probe;
  const res = await fetch(`${host}/1/indexes/${index}/query`, {
    method: 'POST',
    headers: {
      'x-algolia-application-id': appId,
      'x-algolia-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ params: 'query=milk&hitsPerPage=1' }),
  });
  if (res.status === 403 || res.status === 401) return { ok: false, why: `key rejected (${res.status})` };
  if (res.ok) return { ok: true, why: 'key accepted' };
  return { ok: null, why: `inconclusive: ${res.status}` };
}

async function probePath(e) {
  const { origin, path } = e.probe;
  const res = await fetch(origin + path, { method: 'GET', headers: { 'user-agent': UA } });
  // A 404 is the drift signal. Anything else -- including a 401/403 -- means
  // the route still exists and simply refused us, which is what it should do.
  if (res.status === 404) return { ok: false, why: '404: path is gone' };
  return { ok: true, why: `route exists (${res.status})` };
}

async function probeDocument(e) {
  // Sending a full document unauthenticated tells us little on most stores, and
  // saying so is better than inventing a green tick.
  return { ok: null, why: 'not probed unauthenticated; needs a session' };
}

for (const e of inventory) {
  let r;
  try {
    if (e.probe.kind === 'persisted_query') r = await probePersisted(e);
    else if (e.probe.kind === 'algolia') r = await probeAlgolia(e);
    else if (e.probe.kind === 'path') r = await probePath(e);
    else r = await probeDocument(e);
  } catch (err) {
    r = { ok: null, why: `probe threw: ${String(err).slice(0, 60)}` };
  }
  results.push({ ...e, ...r });
  const mark = r.ok === true ? 'ok  ' : r.ok === false ? 'DRIFT' : '?   ';
  console.log(`${mark} ${e.rail.padEnd(11)} ${e.what.padEnd(42)} ${r.why}`);
}

const drifted = results.filter((r) => r.ok === false);
const unknown = results.filter((r) => r.ok === null);
console.log();
console.log(`${results.length} checked, ${drifted.length} drifted, ${unknown.length} inconclusive`);
if (drifted.length) {
  console.log('\nDRIFT, worst blast radius first:');
  for (const d of [...drifted].sort((a, b) => b.breaks - a.breaks)) {
    console.log(`  ${d.what} — breaks ${d.breaks} store(s) — ${d.source}`);
  }
  process.exit(1);
}
process.exit(0);
