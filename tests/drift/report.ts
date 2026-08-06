// `npm run drift` — the drift check as a command (MEAL-30).
//
// This is the seam a scheduled recapture plugs into. The intended sequence, whether
// a human or MEAL-7's self-hosted runner is driving it:
//
//     npm run capture -- heb            # residential IP required — see README
//     npm run drift   -- heb            # exits 1 and prints what moved
//     git diff tests/fixtures/heb       # the markup change, for triage
//     npm run drift   -- heb --update   # accept the new shape
//
// Usage:
//   npm run drift                       every store, compare against the baseline
//   npm run drift -- heb walmart        just these stores
//   npm run drift -- --update           rewrite the baseline from the fixtures
//   npm run drift -- --json             machine-readable findings on stdout
//   npm run drift -- --fixtures <dir>   census a fixture tree somewhere else
//   npm run drift -- --standing         also list selectors dead in every fixture
//
// Exit code is 1 when there are `warn` findings, so a scheduled caller needs no
// output parsing to know whether to raise an alert.

import { Census, diffCensus, formatFindings, standingDeadTargets } from './census';
import { DEFAULT_FIXTURE_ROOT, computeCensus } from './capture';
import { BASELINE_PATH, baselineExists, readBaseline, writeBaseline } from './baseline';
import { STORE_SURFACES } from './selector-surface';

interface Args {
  stores: string[];
  update: boolean;
  json: boolean;
  standing: boolean;
  fixtureRoot: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { stores: [], update: false, json: false, standing: false, fixtureRoot: DEFAULT_FIXTURE_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') args.update = true;
    else if (a === '--json') args.json = true;
    else if (a === '--standing') args.standing = true;
    else if (a === '--fixtures') args.fixtureRoot = argv[++i];
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else args.stores.push(a);
  }
  const known = new Set(STORE_SURFACES.map((s) => s.fixtureDir));
  for (const s of args.stores) {
    if (!known.has(s)) {
      throw new Error(`unknown store "${s}" — known: ${[...known].sort().join(', ')}`);
    }
  }
  return args;
}

/**
 * When only some stores were censused, compare against only those stores'
 * baselines. Diffing a one-store census against the whole baseline would report
 * every other store as removed — a wall of findings for having passed an argument.
 */
function scopeBaseline(baseline: Census, stores: string[]): Census {
  if (stores.length === 0) return baseline;
  const scoped: Census = { version: baseline.version, stores: {} };
  for (const s of stores) if (baseline.stores[s]) scoped.stores[s] = baseline.stores[s];
  return scoped;
}

/** Merge a partial census into the baseline so `--update heb` touches only HEB. */
function mergeIntoBaseline(baseline: Census, census: Census, stores: string[]): Census {
  if (stores.length === 0) return census;
  const merged: Census = { version: census.version, stores: { ...baseline.stores } };
  for (const s of stores) {
    if (census.stores[s]) merged.stores[s] = census.stores[s];
    else delete merged.stores[s];
  }
  return merged;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const census = await computeCensus({ fixtureRoot: args.fixtureRoot, stores: args.stores });

  if (!baselineExists()) {
    writeBaseline(census);
    console.log(`No baseline found — wrote one from the current fixtures: ${BASELINE_PATH}`);
    console.log('Commit it. From here on, a change to any of these shapes is drift.');
    return 0;
  }

  const baseline = readBaseline();
  const findings = diffCensus(scopeBaseline(baseline, args.stores), census);
  const warns = findings.filter((f) => f.level === 'warn');

  if (args.json) {
    console.log(JSON.stringify({ findings, standing: standingDeadTargets(census) }, null, 2));
  } else {
    const scope = args.stores.length > 0 ? args.stores.join(', ') : 'all stores';
    console.log(`Fixture selector drift — ${scope} (fixtures: ${args.fixtureRoot})\n`);
    console.log(formatFindings(findings));
    if (args.standing) {
      const dead = standingDeadTargets(census);
      console.log(
        `\nStanding dead selectors — matched nothing in ANY fixture, unchanged from the baseline ` +
          `so not drift, but not doing any work either (${dead.length}):`,
      );
      for (const d of dead) console.log(`  ${d.store}  ${d.target}  (${d.fixtures} fixture(s))`);
    }
  }

  if (args.update) {
    writeBaseline(mergeIntoBaseline(baseline, census, args.stores));
    if (!args.json) console.log(`\nBaseline updated: ${BASELINE_PATH}\n  Review \`git diff\` on it — that diff IS the drift.`);
    return 0;
  }

  if (warns.length > 0 && !args.json) {
    console.log(
      '\nIf the new shape is correct, accept it with:\n' +
        `  npm run drift -- ${args.stores.join(' ')}${args.stores.length > 0 ? ' ' : ''}--update`,
    );
  }
  return warns.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
