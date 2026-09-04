// Test credentials loader.
//
// Decrypts creds.json.gpg using a passphrase from MEALIO_TEST_CREDS_KEY,
// returns the parsed JSON, and registers a process-exit handler that
// wipes the plaintext temp file. The plaintext NEVER persists between
// test runs.

import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface StoreCreds {
  email: string;
  password: string;
  cartUrl?: string;
  /** Optional override for which family member to log into (e.g. 'safeway') */
  storeId?: string;
}

export interface AllCreds {
  wegmans?: StoreCreds;
  heb?: StoreCreds;
  walmart?: StoreCreds;
  albertsons?: StoreCreds;
  aldi?: StoreCreds;
  kroger?: StoreCreds & { refreshToken?: string };
}

let cached: AllCreds | null = null;
let cleanupRegistered = false;
const tempPaths: string[] = [];

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const wipe = () => {
    for (const p of tempPaths.splice(0)) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  };
  process.on('exit', wipe);
  process.on('SIGINT', () => { wipe(); process.exit(130); });
  process.on('SIGTERM', () => { wipe(); process.exit(143); });
}

/**
 * Load test credentials. Caches in memory after first call; the plaintext
 * temp file is written, read, and deleted within milliseconds.
 *
 * Throws with a useful error message if:
 *   - MEALIO_TEST_CREDS_KEY env var is unset
 *   - creds.json.gpg doesn't exist
 *   - GPG decryption fails (wrong passphrase, corrupted file)
 *   - decrypted content isn't valid JSON
 */
export function loadCreds(): AllCreds {
  if (cached) return cached;

  const passphrase = process.env.MEALIO_TEST_CREDS_KEY;
  if (!passphrase) {
    throw new Error(
      'MEALIO_TEST_CREDS_KEY env var is required to run live tests.\n' +
        'Set it to the passphrase used to encrypt tests/live/creds.json.gpg.',
    );
  }

  const encryptedPath = path.resolve(__dirname, '..', 'creds.json.gpg');
  registerCleanup();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'mealio-creds-'));
  tempPaths.push(tmpDir);
  const plainPath = path.join(tmpDir, 'creds.json');

  try {
    execFileSync(
      'gpg',
      [
        '--batch',
        '--yes',
        '--passphrase', passphrase,
        '--decrypt',
        '--output', plainPath,
        encryptedPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch (err: any) {
    throw new Error(
      `Failed to decrypt ${encryptedPath}. Check MEALIO_TEST_CREDS_KEY is correct.\n` +
        `gpg stderr: ${err.stderr?.toString?.() ?? err.message}`,
    );
  }

  const raw = readFileSync(plainPath, 'utf8');
  // Immediately wipe plaintext after read.
  try { rmSync(plainPath); } catch {}

  let parsed: AllCreds;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Decrypted creds.json is not valid JSON: ${e.message}`);
  }

  cached = parsed;
  return parsed;
}

/**
 * Convenience: get credentials for one store, with a clear error if the
 * store isn't configured.
 */
export function credsFor<K extends keyof AllCreds>(store: K): NonNullable<AllCreds[K]> {
  const all = loadCreds();
  const c = all[store];
  if (!c) {
    throw new Error(
      `No credentials for store "${String(store)}" in creds.json. ` +
        `Add an entry or skip this test.`,
    );
  }
  return c as NonNullable<AllCreds[K]>;
}
