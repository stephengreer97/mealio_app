// Interactive fixture-capture tool.
//
// Usage:
//   npx ts-node tests/fixture-runners/capture-fixtures.ts <store> [--all]
//
// What it does:
//   1. Opens a non-headless Chromium pointed at the store's homepage.
//   2. Pauses so YOU can log in (including any 2FA, store selection, etc).
//   3. After you press Enter in the terminal, navigates to each fixture URL
//      in sequence (homepage logged-in, search-results, cart-with-items, etc),
//      pauses briefly for each to render, and dumps page.content() to disk.
//   4. Writes files to tests/fixtures/<store>/.
//
// Stores supported initially: wegmans (extend to others by adding entries
// to the STORES map below).

import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

import { launchPersistentStealthContext, launchStealthBrowser, newStealthContext } from '../_shared/launch-stealth';
import { FIXTURE_CAPTURE_STORES as STORES } from '../../src/lib/fixture-capture-config';


async function prompt(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const storeId = process.argv[2];
  if (!storeId || !STORES[storeId]) {
    console.error(
      `Usage: npx ts-node tests/fixture-runners/capture-fixtures.ts <store>\n` +
        `Available stores: ${Object.keys(STORES).join(', ')}`,
    );
    process.exit(1);
  }

  const cfg = STORES[storeId];
  const outDir = path.resolve(__dirname, '..', 'fixtures', storeId);
  await fs.mkdir(outDir, { recursive: true });

  console.log(`[capture] Output directory: ${outDir}`);
  console.log(`[capture] Launching browser to ${cfg.loginUrl} ...`);

  // Persistent context: cookies + login state preserved between runs in
  // tests/.chrome-profile/<store>/. First run you log in manually; every
  // subsequent run reuses that session.
  const context = await launchPersistentStealthContext({
    profileName: storeId,
    headless: false,
  });
  const existingPages = context.pages();
  const page = existingPages.length > 0 ? existingPages[0] : await context.newPage();
  await page.goto(cfg.loginUrl);

  console.log(
    `\n[capture] *** PLEASE LOG IN TO ${storeId.toUpperCase()} IN THE BROWSER ***\n` +
      `[capture] Complete any 2FA, store-selection prompts, etc.\n` +
      `[capture] This profile is PERSISTENT — your login is saved and reused on subsequent runs.\n` +
      `[capture] When ready, press Enter here.`,
  );
  await prompt('Press Enter when logged in and ready to capture > ');

  // Logged-in fixtures.
  for (const fx of cfg.fixtures) {
    if (fx.instruction) console.log(`[capture] ℹ ${fx.instruction}`);
    console.log(`[capture] Navigating to ${fx.url}`);
    await page.goto(fx.url, { waitUntil: 'domcontentloaded' });
    if (fx.waitFor) {
      try {
        await page.waitForSelector(fx.waitFor, { timeout: 15_000 });
      } catch {
        console.warn(`[capture]   ! waitFor selector "${fx.waitFor}" timed out — capturing anyway`);
      }
    }
    // Small settle for any final lazy renders.
    await page.waitForTimeout(2000);
    const html = await page.content();
    const outPath = path.join(outDir, fx.file);
    await fs.writeFile(outPath, html);
    console.log(`[capture]   ✓ ${fx.file} (${html.length} bytes)`);
  }

  console.log(`\n[capture] Done. Fixtures saved to ${outDir}`);
  console.log(`[capture] You can close the browser window now.`);
  // Close the persistent context — the profile dir (cookies, login state)
  // persists at tests/.chrome-profile/<storeId>/ for the next run.
  await context.close();
}

main().catch((err) => {
  console.error('[capture] Fatal:', err);
  process.exit(1);
});
