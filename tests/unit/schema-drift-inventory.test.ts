/**
 * MEAL-117. The inventory has one job that a live probe cannot do: notice when
 * somebody commits a new rotatable identifier and does not register it.
 *
 * A drift checker that only knows about the identifiers it was told about is
 * exactly as good as whoever last remembered to tell it, and this project has
 * already added one hash in a hurry -- CurrentUser, on 2026-09-07 -- without
 * anything anywhere noticing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DRIFT_INVENTORY, railsAtRisk, byBlastRadius } from '../../src/lib/schema-drift-inventory';

const RAILS = path.join(__dirname, '..', '..', 'src', 'lib', 'webview-scripts');
const read = (f: string) => fs.readFileSync(path.join(RAILS, f), 'utf8');

/** Every 64-hex constant in a rail file: a persisted-query hash, on any store. */
function hashesIn(file: string): string[] {
  return [...read(file).matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1]);
}

describe('the inventory covers what is actually committed', () => {
  it('registers every Instacart operation hash', () => {
    // The one that matters most: these are shared by ten banners, so an
    // unregistered rotation takes all ten out at once.
    const committed = new Set(hashesIn('instacart-network.ts'));
    const registered = new Set(
      DRIFT_INVENTORY
        .filter((e) => e.probe.kind === 'persisted_query')
        .map((e) => (e.probe as { sha256: string }).sha256),
    );
    const unregistered = [...committed].filter((h) => !registered.has(h));
    expect(unregistered).toEqual([]);
  });

  it('finds a real number of hashes, so a broken scan cannot pass everything', () => {
    expect(hashesIn('instacart-network.ts').length).toBeGreaterThanOrEqual(5);
  });

  it('would catch a hash added without registering it', () => {
    // Proves the check above is load-bearing rather than vacuously true.
    const committed = new Set([...hashesIn('instacart-network.ts'), 'f'.repeat(64)]);
    const registered = new Set(
      DRIFT_INVENTORY
        .filter((e) => e.probe.kind === 'persisted_query')
        .map((e) => (e.probe as { sha256: string }).sha256),
    );
    expect([...committed].filter((h) => !registered.has(h))).toEqual(['f'.repeat(64)]);
  });

  it("registers Wegmans' Algolia credentials as they appear in the rail", () => {
    const src = read('wegmans-network.ts');
    const entry = DRIFT_INVENTORY.find((e) => e.probe.kind === 'algolia');
    expect(entry).toBeTruthy();
    const p = entry!.probe as { appId: string; apiKey: string; index: string };
    // If someone rotates these in the rail and not here, the probe would keep
    // checking a credential nothing uses and report a cheerful green.
    expect(src).toContain(p.appId);
    expect(src).toContain(p.apiKey);
    expect(src).toContain(p.index);
  });

  it('names a source file for every entry, so an alert points somewhere', () => {
    for (const e of DRIFT_INVENTORY) {
      expect(`${e.what}: ${e.source.endsWith('.ts') || e.source.includes('.ts ')}`)
        .toBe(`${e.what}: true`);
    }
  });
});

describe('blast radius is recorded, not guessed', () => {
  it('puts the shared Instacart hashes above the single-store ones', () => {
    // Ten banners share one operation map. That is what makes adding a banner
    // a config entry, and it is also what makes one rotation a ten-store
    // outage -- so the ordering that decides the morning has to say so.
    const first = byBlastRadius()[0];
    expect(first.breaks).toBeGreaterThanOrEqual(10);
  });

  it('covers every rail that has something rotatable', () => {
    expect(railsAtRisk()).toEqual(['albertsons', 'heb', 'instacart', 'wegmans']);
  });
});
