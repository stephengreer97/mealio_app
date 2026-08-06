// The committed drift baseline (MEAL-30).
//
// WHY THE BASELINE RECORDS SHAPES AND NOT COUNTS
// This file is checked in, so it is also a diff. Recording raw match counts would
// make `git diff` after a recapture show a few hundred changed numbers — the same
// unreadable noise as diffing the HTML, one level up. Recording only the bucket
// means a recapture that changed nothing structural produces an EMPTY diff, and a
// recapture that did produces a diff containing exactly the drift and nothing else.
// That property is the artifact worth attaching to an alert.
//
// The cost of the choice, stated plainly: the baseline cannot tell you a selector
// used to match 38 elements and now matches 3. The live side of the comparison
// still knows, so the report says it; the file does not.

import * as fs from 'fs';
import * as path from 'path';

import { CENSUS_VERSION, Census } from './census';

export const BASELINE_PATH = path.resolve(__dirname, 'selector-baseline.json');

/** Recursively sort object keys so the committed file has a stable diff. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sorted((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function writeBaseline(census: Census, file: string = BASELINE_PATH): void {
  fs.writeFileSync(file, `${JSON.stringify(sorted(census), null, 2)}\n`, 'utf8');
}

export function baselineExists(file: string = BASELINE_PATH): boolean {
  return fs.existsSync(file);
}

/**
 * Read the baseline.
 *
 * A version mismatch throws rather than being coerced: the version is bumped when
 * the MEANING of a recorded bucket changes, and comparing across that boundary
 * would produce findings that describe our own refactor as store drift — precisely
 * the false alarm this whole check is built to avoid.
 */
export function readBaseline(file: string = BASELINE_PATH): Census {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Census;
  if (parsed.version !== CENSUS_VERSION) {
    throw new Error(
      `drift baseline is version ${parsed.version}, this code writes version ${CENSUS_VERSION}. ` +
        'The recorded buckets no longer mean the same thing — re-baseline with `npm run drift -- --update` ' +
        'and review the resulting diff as a whole rather than trusting a cross-version comparison.',
    );
  }
  return parsed;
}
