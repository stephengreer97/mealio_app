// MEAL-7. Read what a canary run actually did, and score it against the plan.
//
// OBSERVATIONS COME FROM TELEMETRY, NOT FROM THE SCREEN OR THE LOG. The device
// log names an item three different ways depending on which line you catch it
// on -- ingredient here, product there -- and the screen shows a summary. The
// step rows are structured, server-side, and already carry the vocabulary
// MEAL-219 rebuilt: outcome, code, phase, item_index.
//
//   node scripts/canary-score.mjs <storeId> <sinceISO> [plansFile]
//
// Exits 0 when every line landed where the plan predicted, 1 when it did not,
// 2 when the run could not be found at all -- which is a rig problem and must
// never be reported as a store failure.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [storeId, sinceISO, plansFile = 'tests/live/device/canary-plans.json'] = process.argv.slice(2);
if (!storeId || !sinceISO) {
  console.error('usage: canary-score.mjs <storeId> <sinceISO> [plansFile]');
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(process.env.HOME + '/mealio_central/.env.local', 'utf8')
    .split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
const U = env.NEXT_PUBLIC_SUPABASE_URL;

// The run is found by store and time rather than by an id the device would have
// to hand us. The app never logs its runId, and asking it to would be a change
// to production code for the benefit of a test rig.
const runs = await (await fetch(
  `${U}/rest/v1/automation_runs?select=id,store_id,started_at,outcome,items_added,items_requested`
  + `&store_id=eq.${encodeURIComponent(storeId)}&started_at=gte.${encodeURIComponent(sinceISO)}`
  + `&order=started_at.desc&limit=1`, { headers: H })).json();

if (!Array.isArray(runs) || runs.length === 0) {
  console.log(JSON.stringify({ ran: false, reason: 'run_not_found', storeId, since: sinceISO }, null, 2));
  process.exit(2);
}
const run = runs[0];

const steps = await (await fetch(
  `${U}/rest/v1/automation_steps?select=step,outcome,code,item_index,detail,phase`
  + `&run_id=eq.${run.id}&order=seq.asc`, { headers: H })).json();

// One terminal row per item, emitted at reconcile. Anything else is a step on
// the way there and is not what the expectation table is about.
// A RUN THAT NEVER FINISHED HAS NOT MEASURED ANYTHING.
//
// Scored naively, an unfinished run reads as "every line silently dropped" --
// the loudest possible failure for causes that are usually the most boring:
// a canary meal whose products have never been chosen sends every line to the
// review screen and stops there, and so does a run someone closed.
//
// run_summary is the terminal row: exactly one per finished run. Its ABSENCE is
// the signal, and it is a better one than looking for kind 'choose', because it
// also catches an abandoned run, a crash, and a device that went to sleep
// mid-run. Reported like not_signed_in: the rig is not ready, and the store has
// not been measured either way.
const finished = steps.some((s) => s.step === 'run_summary');
if (!finished) {
  console.log(JSON.stringify({
    ran: false, reason: 'run_incomplete', storeId, runId: run.id, steps: steps.length,
    detail: 'the run never reached a terminal row. The usual cause is a canary meal '
      + 'with no chosen products: every line goes to the review screen and stops '
      + 'there. Choose products once for this meal and the canary can run.',
  }, null, 2));
  process.exit(2);
}

const observations = steps
  .filter((s) => s.detail && (s.detail.terminal === 'added' || s.detail.terminal === 'review'))
  .map((s) => ({
    item: String(s.detail.item ?? ''),
    outcome: s.detail.terminal === 'added' ? 'added' : 'review',
    code: s.code ?? null,
  }))
  .filter((o) => o.item);

// THE PLAN COMES FROM THE DATABASE, not a file. The two curated lines are typed
// into the admin panel, so a file would be a second source of truth that goes
// stale the moment someone edits a text box -- which is exactly what happened
// the first time this ran.
const planRows = await (await fetch(
  `${U}/rest/v1/canary_plans?store_id=eq.${encodeURIComponent(storeId)}&select=*`,
  { headers: H })).json();

const cfg = Array.isArray(planRows) && planRows[0] ? planRows[0] : null;

/** Built by the same library the panel and the tests use, never re-implemented. */
function planFrom(row, lines) {
  const arg = JSON.stringify({
    storeId: row.store_id,
    mealName: row.meal_name,
    lines,
  });
  const out = execFileSync('npx', ['tsx', 'scripts/_canary-plan.ts', arg], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

// THE MEAL IS THE PLAN. The admin item boxes are gone: a canary's branches are
// curated by editing the saved meal, so the expectations have to be read from
// the meal's own ingredients. Keyed on the chosen product, because that is the
// name a run reports -- keying on the ingredient scored every line as "never
// reported" while listing the same items again as unplanned.
async function mealLines(row) {
  if (!row?.meal_name) return [];
  const rows = await (await fetch(
    `${U}/rest/v1/meals?name=eq.${encodeURIComponent(row.meal_name)}&select=ingredients`,
    { headers: H })).json();
  const ing = Array.isArray(rows) && rows[0] ? rows[0].ingredients : null;
  return Array.isArray(ing) ? ing.map((i) => ({
    ingredientName: i.ingredientName ?? i.name ?? '',
    searchTerm: i.searchTerm ?? null,
    unit: i.unit ?? null,
  })) : [];
}

const plan = cfg && cfg.enabled !== false ? planFrom(cfg, await mealLines(cfg)) : null;

if (!plan) {
  console.log(JSON.stringify({
    ran: true, scored: false, reason: 'no_plan_for_store', storeId,
    runId: run.id, observations,
  }, null, 2));
  process.exit(2);
}

// Score with the same library the unit tests exercise, rather than a second
// implementation that could disagree with them.
const scored = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/_canary-score.ts',
    JSON.stringify(plan), JSON.stringify(observations)],
    { encoding: 'utf8' }).trim().split('\n').pop());

console.log(`canary ${storeId} — run ${run.id}`);
for (const l of scored.lines) {
  const mark = l.status === 'as_predicted' ? 'ok   ' : l.status === 'unexpected_success' ? 'SURPRISE' : 'FAIL ';
  console.log(`  ${mark} ${l.item.padEnd(34)} expected ${String(l.expected).padEnd(22)} got ${l.actual}`);
  if (l.why) console.log(`         ${l.why}`);
}
if (scored.unplanned.length) console.log('  unplanned lines:', scored.unplanned.join(', '));
console.log(scored.passed ? '\nPASS' : '\nFAIL');
process.exit(scored.passed ? 0 : 1);
