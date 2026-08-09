// Pure validation + merge of a remote store catalog over the bundled list.
//
// This is the trust boundary. The input arrives over the network as untyped JSON
// and its values become (a) the ids written onto a user's saved meals and (b)
// `backgroundColor` on a React Native view, where a string RN cannot parse is a
// render-time throw, not a cosmetic problem. So this module's job is not "merge
// two lists" — it is "decide which remote entries are safe to believe".
//
// Design rules, and the reasoning behind each:
//
//   • ADDITIVE AND OVERRIDING, NEVER SUBTRACTIVE. A bundled store missing from
//     the remote list stays. A truncated body, a half-written table, or a
//     hostile empty array therefore cannot empty the picker or strand a user's
//     saved meals behind a store that vanished. The cost is that removing a
//     store still needs a release — see the note at the bottom.
//
//   • A BAD ENTRY IS DROPPED, NOT THE PAYLOAD. One malformed row must not cost
//     the good rows beside it. The two exceptions are structural: a payload that
//     is not a list at all, and one longer than MAX_CATALOG_STORES, are refused
//     whole, because in both cases we have no reason to trust any of it.
//
//   • IDENTITY IS REQUIRED, DECORATION DEGRADES. `id` and `name` are what make
//     an entry usable — an entry without them is dropped. `color` is a dot next
//     to the name, so an absent or malformed one costs us the colour rather than
//     the store: the entry keeps whatever colour is already on file, and only an
//     entry with no history at all falls back to a neutral. That asymmetry is the
//     whole reason this file validates field by field instead of accepting or
//     rejecting whole rows.
//
//   • THE ID SHAPE IS NARROW ON PURPOSE. Ids are compared, persisted on meals,
//     and used as React keys. `^[a-z0-9][a-z0-9_]{0,39}$` is exactly the shape
//     every bundled id already has, so nothing that arrives can be confused with
//     an existing one by case, whitespace, or a lookalike character.
//
// Every rejection lands in `warnings`, so a catalog row that did not take effect
// is visible rather than silently missing.
//
// WHAT WE READ, AND WHAT WE THROW AWAY
// This build keeps exactly three fields — id, name, color — and drops every
// other one GET /api/stores sends, whether or not this file has heard of it.
// Descriptive columns are dropped because nothing renders them and inventing a
// use for them here would be inventing product; unknown columns are dropped by
// the same rule, so the server can grow without a client release. Deliberately
// stated without a field count: the response has already gained and lost columns
// once, and a number here would only ever be a comment that goes stale quietly.
//
// `platform` deserves its own paragraph even though it no longer ships, because
// what it nearly caused is the trap this whole file is guarding. It partitioned
// the catalog exactly like the capability sets — platform 'kroger' was precisely
// KROGER_BRAND_IDS — which makes such a field look like a remote source of truth
// for what the app can drive. It is not, and no successor may be gated on:
// capability is whether the automation scripts are in THIS BINARY
// (isSupportedStore), and a server field that currently happens to agree is the
// most convincing possible way to get that wrong later. The server author
// reached the same conclusion independently and withdrew `bannerGroup` for the
// identical reason. If a column like this reappears, it is still data.

import { BUNDLED_STORES, Store } from '../../constants/stores';

export interface CatalogMergeResult {
  stores: Store[];
  warnings: string[];
}

// Room for several times the current catalog. A body past this is malformed or
// hostile, and refusing it whole beats emitting a warning per junk row.
const MAX_CATALOG_STORES = 200;
const MAX_NAME_LENGTH = 60;

const STORE_ID = /^[a-z0-9][a-z0-9_]{0,39}$/;
// #rgb and #rrggbb only. RN accepts named colours and rgba() too, but a closed
// set is one fewer thing a remote value can surprise a style with.
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// Control characters, and the separators that would let a name span lines in a
// <Text> or misrender in a picker row.
const UNSAFE_NAME = /[\u0000-\u001F\u007F\u2028\u2029]/;

/** Stands in for a colour we could not use. Deliberately neutral: it reads as
 *  "no brand colour on file", never as another store's brand. */
export const FALLBACK_STORE_COLOR = '#A1A1AA';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Pull the entry list out of whatever the endpoint returned.
 *
 * Accepts the bare array and the `{ stores: [...] }` envelope. Written while the
 * server half of MEAL-23 was still being built, so that neither half had to wait
 * on the other to agree; the shipped endpoint serves the envelope. Kept rather
 * than narrowed — it costs four lines, and it is what makes the loader's raw
 * cache readable by a build whose endpoint has been reshaped under it.
 */
function entryList(remote: unknown): unknown[] | null {
  if (Array.isArray(remote)) return remote;
  if (isPlainObject(remote) && Array.isArray(remote.stores)) return remote.stores;
  return null;
}

function takeName(id: string, value: unknown, warnings: string[]): string | null {
  if (typeof value !== 'string') {
    warnings.push(`stores.${id}.name: expected a string, got ${typeof value} — entry dropped`);
    return null;
  }
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || UNSAFE_NAME.test(name)) {
    warnings.push(`stores.${id}.name: empty, oversized, or contains control characters — entry dropped`);
    return null;
  }
  return name;
}

/**
 * The row's colour, or null when there is nothing usable in it.
 *
 * Returns null rather than substituting, because the right substitute depends on
 * what the caller already has: a bundled entry's own colour beats the neutral,
 * and only an entry with no history at all should get the neutral. Deciding that
 * here would mean throwing away the better answer before anyone could ask for it.
 *
 * Either way the entry is NOT dropped: a store with the wrong dot colour is
 * still a store the user can pick, and failing the whole row over decoration
 * would make a typo in one column of one database row look like the feature not
 * working.
 */
function takeColor(id: string, value: unknown, warnings: string[]): string | null {
  if (typeof value === 'string' && HEX_COLOR.test(value)) return value;
  warnings.push(`stores.${id}.color: not a #rgb/#rrggbb hex colour — keeping the colour already on file`);
  return null;
}

/**
 * Merge a remote catalog over the bundled list.
 *
 * Always returns a usable catalog: on any input problem the bundled list stands,
 * whole or in part, and the reason lands in `warnings`. Never throws, and never
 * mutates BUNDLED_STORES.
 *
 * NOTE this returns every accepted entry, INCLUDING stores this build has no
 * automation for. Filtering those out is the reader's job (getStores()), not
 * this one's — the cache holds what the server said, so a later build that gains
 * the code for a store surfaces it from a payload fetched before that build
 * existed.
 */
export function mergeStoreCatalog(
  remote: unknown,
  base: readonly Store[] = BUNDLED_STORES,
): CatalogMergeResult {
  const warnings: string[] = [];
  const stores: Store[] = base.map((s) => ({ ...s }));
  const indexById = new Map(stores.map((s, i) => [s.id, i]));

  const list = entryList(remote);
  if (list === null) {
    warnings.push('stores: expected a list of entries — keeping the bundled catalog');
    return { stores, warnings };
  }
  if (list.length > MAX_CATALOG_STORES) {
    warnings.push(`stores: ${list.length} entries exceeds ${MAX_CATALOG_STORES} — keeping the bundled catalog`);
    return { stores, warnings };
  }

  const seen = new Set<string>();
  for (const raw of list) {
    if (!isPlainObject(raw)) {
      warnings.push(`stores: expected an object entry, got ${Array.isArray(raw) ? 'array' : typeof raw} — ignored`);
      continue;
    }

    const id = raw.id;
    if (typeof id !== 'string' || !STORE_ID.test(id)) {
      warnings.push(`stores: ${JSON.stringify(id)} is not a valid store id — entry dropped`);
      continue;
    }
    // FIRST wins. Deterministic, and it means a duplicate appended later cannot
    // quietly restyle or rename the entry the payload already established.
    if (seen.has(id)) {
      warnings.push(`stores.${id}: duplicate id in the payload — first occurrence wins`);
      continue;
    }
    seen.add(id);

    const name = takeName(id, raw.name, warnings);
    if (name === null) continue;
    const color = takeColor(id, raw.color, warnings);

    const existing = indexById.get(id);
    if (existing !== undefined) {
      // Colliding with a bundled id UPDATES it in place, keeping its position.
      // That is the rebrand path — a store changing its name or brand colour
      // stops needing a release. It can never remove the entry, so the worst a
      // bad row can do to a shipped store is mislabel it.
      //
      // An unusable colour keeps the one ALREADY ON FILE rather than taking the
      // neutral. The bundled value is strictly better information than grey, and
      // the failure this avoids is not hypothetical: if colour is ever absent
      // for a subset of rows, substituting here would make the first full
      // catalog publish grey out exactly those stores, right across the picker,
      // with no client release to blame it on.
      stores[existing] = { id, name, color: color ?? stores[existing].color };
    } else {
      // Nothing on file, so the neutral is the best available. It reads as "no
      // brand colour", never as another store's brand.
      indexById.set(id, stores.length);
      stores.push({ id, name, color: color ?? FALLBACK_STORE_COLOR });
    }
  }

  return { stores, warnings };
}

// STEPHEN'S DECISION, deliberately not taken here: there is no way to REMOVE a
// store remotely. Doing it by omission would mean a partial or empty response
// wipes the picker, which is the failure this whole design refuses. If removal
// is wanted, the safe shape is an explicit per-entry flag the merge honours —
// an instruction, not an absence — and it is a small addition to this file.
