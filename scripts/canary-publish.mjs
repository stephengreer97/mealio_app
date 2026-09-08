// MEAL-7. Write a canary result where the admin panel can see it.
//
//   node scripts/canary-publish.mjs '<json>'
//
// The JSON is one store's outcome: { storeId, ran, skipReason?, passed?, shape,
// lines?, detail?, automationRunId? }.
//
// `ran: false` is a RIG problem -- device asleep, not signed in, app missing --
// and `passed` means nothing in that case. The panel renders those grey rather
// than red, because an unplugged night showing up as a failing store trains
// everyone to ignore the colour.
import { readFileSync } from 'node:fs';

const raw = process.argv[2];
if (!raw) { console.error('usage: canary-publish.mjs <json>'); process.exit(2); }
const r = JSON.parse(raw);
if (!r.storeId) { console.error('storeId required'); process.exit(2); }

const env = Object.fromEntries(
  readFileSync(process.env.HOME + '/mealio_central/.env.local', 'utf8')
    .split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const K = env.SUPABASE_SERVICE_ROLE_KEY;

const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/canary_runs`, {
  method: 'POST',
  headers: {
    apikey: K, authorization: `Bearer ${K}`,
    'content-type': 'application/json', Prefer: 'return=representation',
  },
  body: JSON.stringify({
    store_id: r.storeId,
    ran: r.ran !== false,
    skip_reason: r.skipReason ?? null,
    // Null, not false, when the rig was the problem. A canary that did not run
    // has no opinion about the store.
    passed: r.ran === false ? null : (r.passed ?? null),
    shape: r.shape ?? 'single',
    lines: r.lines ?? null,
    detail: r.detail ?? null,
    automation_run_id: r.automationRunId ?? null,
  }),
});
const out = await res.json();
if (!res.ok) { console.error('publish failed', res.status, JSON.stringify(out).slice(0, 200)); process.exit(1); }
console.log('published', out[0]?.id ?? '(no id)');
