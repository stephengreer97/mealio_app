#!/usr/bin/env node
// Are the flow maps still true?
//
// Each map in docs/flow-maps/sources.json names the source files it was read
// from and the commit it was read at. This asks git which of those files have
// moved since, and reports the maps that may now be describing code that no
// longer exists.
//
// It CANNOT know whether a change actually invalidates a map — a renamed local
// or a new test does not. So it reports, it does not judge: the output is a list
// of maps to look at, with the commits that touched their sources, and the
// verdict is the reader's.
//
// Exit 0 = nothing to look at. Exit 1 = at least one map's sources moved.
// Usage:  node scripts/check-flow-maps.js [--quiet] [--since <ref>]

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MANIFEST = path.join(REPO, 'docs/flow-maps/sources.json');

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const sinceIdx = args.indexOf('--since');
const sinceOverride = sinceIdx >= 0 ? args[sinceIdx + 1] : null;

function git(cmdArgs) {
  return execFileSync('git', cmdArgs, { cwd: REPO, encoding: 'utf8' }).trim();
}

if (!fs.existsSync(MANIFEST)) {
  // Not an error: a branch cut before the maps existed simply has none to check.
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (e) {
  console.error('check-flow-maps: sources.json is not valid JSON — ' + e.message);
  process.exit(1);
}

const stale = [];
for (const [file, entry] of Object.entries(manifest.maps || {})) {
  const sources = entry.sources || [];
  if (sources.length === 0) continue;
  const base = sinceOverride || entry.readAt || manifest.defaultReadAt;
  if (!base) continue;

  // Only ask about paths that still exist — a deleted source is its own signal
  // and `git log` on a vanished path is silent, which would read as "unchanged".
  const present = [], missing = [];
  for (const s of sources) {
    (fs.existsSync(path.join(REPO, s)) ? present : missing).push(s);
  }

  let commits = '';
  try {
    commits = present.length
      ? git(['log', '--oneline', '--no-merges', `${base}..HEAD`, '--'].concat(present))
      : '';
  } catch (e) {
    // An unknown base (someone rewrote history, or a fresh clone without that
    // commit) is not a reason to fail a push. Say so and move on.
    if (!quiet) console.error(`check-flow-maps: ${file}: cannot resolve ${base} — skipped`);
    continue;
  }

  if (commits || missing.length) {
    const touched = commits
      ? git(['log', '--name-only', '--pretty=format:', `${base}..HEAD`, '--'].concat(present))
          .split('\n').map(s => s.trim()).filter(Boolean)
      : [];
    stale.push({
      file,
      title: entry.title || file,
      commits: commits ? commits.split('\n') : [],
      files: [...new Set(touched)],
      missing,
    });
  }
}

if (stale.length === 0) {
  if (!quiet) console.log('check-flow-maps: all maps current.');
  process.exit(0);
}

const lines = [];
lines.push('');
lines.push(`${stale.length} flow map${stale.length === 1 ? '' : 's'} may be out of date — their sources changed:`);
lines.push('');
for (const s of stale) {
  lines.push(`  docs/flow-maps/${s.file}  (${s.title})`);
  for (const f of s.files.slice(0, 8)) lines.push(`      changed: ${f}`);
  if (s.files.length > 8) lines.push(`      … and ${s.files.length - 8} more files`);
  for (const m of s.missing) lines.push(`      GONE:    ${m}`);
  for (const c of s.commits.slice(0, 4)) lines.push(`      ${c}`);
  if (s.commits.length > 4) lines.push(`      … and ${s.commits.length - 4} more commits`);
  lines.push('');
}
lines.push('Read the diffs and update any map whose described behaviour actually moved,');
lines.push('then run `npm run flow-maps:bless` to record that they were re-read.');
lines.push('A change that does not affect a map (a rename, a test, a comment) still needs');
lines.push('the bless — it is what records that someone LOOKED.');
lines.push('');
console.log(lines.join('\n'));
process.exit(1);
