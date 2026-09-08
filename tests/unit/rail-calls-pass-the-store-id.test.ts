/**
 * NO RAIL CALL MAY DROP THE STORE ID.
 *
 * The multi-tenant rail refuses an absent store id rather than guessing ALDI,
 * which is the right shape: Instacart's cart query is account-level, so a
 * dropped id means operating on the wrong banner's basket, and a run that does
 * not start beats a run in the wrong cart.
 *
 * But a refusal only converts a silent wrong answer into a LOUD one, and loud
 * lands on the user. Stephen tapped the ALDI chip and got:
 *
 *   ERROR [Error: instacart-network: the Instacart rail was invoked with no store
 *   id. ...]
 *   LOG   [Prewarm] probe aldi finishing: ERROR
 *
 * Two call sites in the silent probes still called sessionScript() bare. The
 * guard was right and my sweep for call sites was not: I grepped src for
 * cartRead and never for sessionScript, so the four sites in the cart sheet got
 * fixed and the two in the probes did not.
 *
 * A grep I have to remember to run is not a guarantee. This is the same grep,
 * run by the suite, every time.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Rail methods that identify a tenant. Adding one here is how a new
 * store-scoped rail method gets the same protection for free.
 */
const MUST_TAKE_A_STORE_ID = ['sessionScript', 'cartRead'];

describe('every rail call names the store it is for', () => {
  const files = walk(SRC);

  it('scans a real number of files, so a broken walk cannot pass', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(MUST_TAKE_A_STORE_ID)('no call to %s() drops its argument', (method) => {
    // `.method()` with nothing between the parens.
    const bare = new RegExp('\\.' + method + '\\(\\s*\\)', 'g');
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (bare.test(line)) offenders.push(path.relative(SRC, f) + ':' + (i + 1) + '  ' + line.trim());
        bare.lastIndex = 0;
      });
    }
    expect(offenders).toEqual([]);
  });

  it('would actually catch a bare call, rather than passing vacuously', () => {
    // The assertion above passes on an empty list, and an empty list is also
    // what a regex that matches nothing produces. So prove the regex fires.
    const bare = new RegExp('\\.sessionScript\\(\\s*\\)');
    expect(bare.test('injectJavaScript(rail.sessionScript());')).toBe(true);
    expect(bare.test('injectJavaScript(rail.sessionScript(storeId));')).toBe(false);
  });
});
