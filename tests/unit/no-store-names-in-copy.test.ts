// No retailer is named in the app's help or pitch copy.
//
// The twin of `tests/lib/no-store-names-in-copy.test.ts` in mealio_central.
// Stephen, 2026-09-09: "I don't want specific stores named anywhere. Keep it
// generic."
//
// The reason it is a standing check rather than a sweep: the roster is data. A
// store arrives or leaves with one row in the catalog, while a string in this
// binary changes only with a release, so any list here is wrong from the moment
// the two disagree. It had already happened: Help's FAQ was still offering
// Amazon Fresh five days after the product dropped it, and no test noticed
// because the string was internally consistent.
//
// SCOPE. Copy, not the product. `src/constants/stores.ts`, the store pickers,
// `WEBVIEW_STORE_IDS` and every rail in `src/lib/webview-scripts` name stores
// and must: you cannot pick, or drive, a store you cannot name. Only the files
// below are read, and only what they SAY: comments are stripped first, because
// the engineering note explaining why a rail exists is not a promise to a user.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

const COPY_FILES = [
  'src/constants/pitch.ts',
  'src/screens/help/HelpScreen.tsx',
  'src/components/WelcomeSheet.tsx',
  'src/components/HowMealioWorks.tsx',
  'src/screens/creator/CreatorApplyScreen.tsx',
];

/**
 * Unambiguous brand names only. `Acme`, `Kings`, `United`, `Star Market` and
 * `Carrs` are left out on purpose: they are ordinary words, and a check that
 * fires on prose gets switched off rather than obeyed. Each of them belongs to
 * a chain that IS on this list, so a reintroduced list cannot pass whole.
 */
const BRANDS = [
  'Kroger', 'Ralphs', 'Fred Meyer', 'King Soopers', "Smith's Food",
  "Fry's Food", 'QFC', 'City Market', 'Dillons', "Mariano's", "Pick 'n Save",
  'Metro Market', 'Harris Teeter',
  'H-E-B', 'HEB', 'Walmart', 'ALDI', 'Wegmans', 'Publix', 'Sprouts',
  'Albertsons', 'Safeway', 'Vons', 'Jewel-Osco', "Shaw's", 'Tom Thumb',
  'Randalls', 'Pavilions', 'Haggen', "Balducci's",
  'Instacart', 'Amazon Fresh', 'Price Chopper', 'Fresh Market',
];

/** The file with `//` and block comments removed, so only copy is read. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
}

describe('help and pitch copy', () => {
  for (const file of COPY_FILES) {
    it(`names no retailer: ${file}`, () => {
      const path = join(ROOT, file);
      if (!existsSync(path)) return;
      const copy = withoutComments(readFileSync(path, 'utf8'));
      const found = BRANDS.filter((b) =>
        new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(copy));
      expect(found).toEqual([]);
    });
  }
});
