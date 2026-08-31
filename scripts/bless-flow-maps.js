#!/usr/bin/env node
// Record that the flow maps have been re-read at the current commit.
//
// Sets `readAt` on every map (or just the ones named) to HEAD, so
// check-flow-maps.js stops reporting them. Run it only after actually looking:
// the value of the check is entirely in that being true.
//
// Usage:  node scripts/bless-flow-maps.js [map.html …]

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MANIFEST = path.join(REPO, 'docs/flow-maps/sources.json');
const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();

const only = process.argv.slice(2);
const raw = fs.readFileSync(MANIFEST, 'utf8');
const manifest = JSON.parse(raw);

let n = 0;
for (const [file, entry] of Object.entries(manifest.maps)) {
  if (only.length && !only.includes(file) && !only.includes('docs/flow-maps/' + file)) continue;
  if (!entry.sources || entry.sources.length === 0) continue;
  entry.readAt = head;
  n++;
}
// Every map now carries its own readAt, so the shared default would only ever be
// a stale second answer to the same question.
if (!only.length) delete manifest.defaultReadAt;

fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`blessed ${n} map${n === 1 ? '' : 's'} at ${head}`);
