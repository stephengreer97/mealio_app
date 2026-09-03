// The two characters that keep breaking the injected scripts.
//
// Every store script is a TEMPLATE LITERAL that gets handed to a WebView, and
// two things inside one are silently fatal:
//
//   a BACKTICK ends the literal early. It has happened four times, always in a
//   COMMENT, where it reads as ordinary prose — `storeId` in a sentence about
//   storeId. The build error points at a line hundreds of characters later.
//
//   a BACKSLASH is consumed before the script ever arrives. A regex written as
//   /^\s+/ reaches the page as /^s+/ and quietly matches the letter s. That one
//   cost three debugging sessions and is why these files use indexOf and trim()
//   where a regex would be natural.
//
// Reviewing for them does not work — they have survived review every time. So
// this reads the built scripts instead of the source, which is the only place
// the damage is visible.

import { getNetworkRail, NETWORK_SESSION_MESSAGE_TYPES } from '../../src/lib/webview-scripts/network-rail';
import { INSTACART_TENANTS } from '../../src/lib/webview-scripts/instacart';
import { ALBERTSONS_FAMILY_IDS } from '../../src/lib/webview-scripts/albertsons';
import * as fs from 'fs';
import * as path from 'path';

const RAIL_STORES = ['heb', 'wegmans', ...ALBERTSONS_FAMILY_IDS, ...Object.keys(INSTACART_TENANTS)];

/** Every script a rail can emit, named so a failure says which one. */
function scriptsFor(storeId: string): Array<[string, string]> {
  const rail = getNetworkRail(storeId)!;
  const sess = { storeId: '1', shoppingContext: 'pickup' };
  const out: Array<[string, string | null]> = [
    ['sessionScript', rail.sessionScript()],
    ['cartRead', rail.cartRead()],
    ['searchBatch', rail.searchBatch(['sour cream', 'tortillas'], sess)],
    ['addBatch', rail.addBatch([
      { idx: 0, productId: 'p1', skuId: 's1', quantity: 2, name: 'Sour Cream' },
    ])],
  ];
  return out.filter((e): e is [string, string] => typeof e[1] === 'string');
}

describe('the injected scripts survive being injected', () => {
  for (const id of RAIL_STORES) {
    it(`${id}: every script is valid JavaScript`, () => {
      for (const [name, src] of scriptsFor(id)) {
        // The real test. A stray backtick truncates the literal, and what is
        // left over is almost never parseable.
        expect(() => new Function(src)).not.toThrow();
        expect(name && src.length).toBeGreaterThan(0);
      }
    });

  }

  // The backslash half has to be checked in the SOURCE, not the output.
  //
  // By the time a script is built, an eaten escape is invisible: /^\s+/ has
  // already become /^s+/ and looks like someone meant to match the letter s.
  // The loss only exists between the source and the string.
  //
  // In a template literal, a backslash before a character JavaScript does not
  // recognise as an escape is simply DROPPED. So \n and \\ are fine and
  // deliberate — H-E-B's GraphQL documents are full of them — while \s, \d,
  // \w and \. are the silent ones, and they are exactly what a regex is made
  // of. That is why these files use indexOf and trim() where a regex would read
  // better.
  it('no rail source hides an escape that will be eaten', () => {
    const VALID = new Set(['n', 'r', 't', 'b', 'f', 'v', '0', 'u', 'x', '\\', '`', "'", '"', '$', '/']);
    const files = [
      'aldi-network.ts', 'wegmans-network.ts', 'heb-network-search.ts', 'albertsons-network.ts',
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../../src/lib/webview-scripts/', f), 'utf8');
      // Only inside the template literals, which is where the loss happens.
      for (const lit of src.match(/`[\s\S]*?`/g) ?? []) {
        for (let i = 0; i < lit.length - 1; i++) {
          if (lit[i] !== '\\') continue;
          const next = lit[i + 1];
          if (VALID.has(next)) { i++; continue; }
          offenders.push(`${f}: \\${next} in ${lit.slice(Math.max(0, i - 40), i + 20).replace(/\n/g, ' ')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every rail with a session type can build a session script', () => {
    // A rail whose type is listed but whose script does not build would fail
    // only at run time, on a store, in front of a user.
    for (const id of RAIL_STORES) {
      const rail = getNetworkRail(id)!;
      expect(NETWORK_SESSION_MESSAGE_TYPES).toContain(rail.sessionMessageType);
      expect(rail.sessionScript().length).toBeGreaterThan(100);
    }
  });
});
