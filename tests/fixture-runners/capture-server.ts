// Tiny HTTP server that receives captured HTML from the mobile app's
// admin Fixture Capture sheet and writes it to tests/fixtures/<store>/.
//
// Usage:
//   npm run capture:server
//
// The mobile app on your phone POSTs to:
//   POST http://<dev-machine-ip>:8080/save-fixture
//   Content-Type: application/json
//   Body: { "store": "wegmans", "name": "logged-in-home.html", "html": "<!doctype html>..." }
//
// On success: 200 { "ok": true, "path": "tests/fixtures/wegmans/logged-in-home.html", "bytes": 145632 }
// On failure: 400 { "ok": false, "error": "..." }
//
// The server also exposes:
//   GET  /ping            — quick reachability check from the admin screen
//   GET  /list/<store>    — list of fixtures captured so far for a store
//
// Binds to 0.0.0.0 so a phone on the same Wi-Fi can reach it. Do not run
// on untrusted networks (anyone on your LAN could write fixtures otherwise).

import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { FIXTURE_CAPTURE_STORES } from '../../src/lib/fixture-capture-config';

const PORT = Number(process.env.MEALIO_CAPTURE_PORT) || 8080;
const FIXTURES_ROOT = path.resolve(__dirname, '..', 'fixtures');
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB cap per fixture (Wegmans is ~150KB; Walmart could be ~5MB)

function jsonResponse(res: ServerResponse, status: number, body: any) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error(`Body too large (>${MAX_BODY_BYTES} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function localAddresses(): string[] {
  const nets = os.networkInterfaces();
  const addrs: string[] = [];
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  return addrs;
}

function isValidStore(store: unknown): store is string {
  return typeof store === 'string' && store in FIXTURE_CAPTURE_STORES;
}

function isValidFilename(name: unknown): name is string {
  // Allow alphanumeric, dash, underscore, dot. Reject path traversal.
  if (typeof name !== 'string') return false;
  if (!/^[a-z0-9_.-]+$/i.test(name)) return false;
  if (name.includes('..')) return false;
  if (!name.endsWith('.html')) return false;
  return true;
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      jsonResponse(res, 204, {});
      return;
    }

    if (method === 'GET' && url === '/ping') {
      jsonResponse(res, 200, { ok: true, server: 'mealio-capture', port: PORT });
      return;
    }

    if (method === 'GET' && url.startsWith('/list/')) {
      const store = url.slice('/list/'.length);
      if (!isValidStore(store)) {
        jsonResponse(res, 400, { ok: false, error: `Unknown store "${store}"` });
        return;
      }
      const dir = path.join(FIXTURES_ROOT, store);
      try {
        const files = await fs.readdir(dir);
        jsonResponse(res, 200, { ok: true, store, files: files.filter((f) => f.endsWith('.html')) });
      } catch {
        jsonResponse(res, 200, { ok: true, store, files: [] });
      }
      return;
    }

    if (method === 'POST' && url === '/save-fixture') {
      const raw = await readBody(req);
      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch {
        jsonResponse(res, 400, { ok: false, error: 'Body is not valid JSON' });
        return;
      }
      const { store, name, html } = payload;
      if (!isValidStore(store)) {
        jsonResponse(res, 400, { ok: false, error: `Unknown store "${store}"` });
        return;
      }
      if (!isValidFilename(name)) {
        jsonResponse(res, 400, {
          ok: false,
          error: `Invalid filename "${name}" — must be [a-z0-9_.-] and end with .html`,
        });
        return;
      }
      if (typeof html !== 'string' || html.length === 0) {
        jsonResponse(res, 400, { ok: false, error: 'Field "html" must be a non-empty string' });
        return;
      }

      const outDir = path.join(FIXTURES_ROOT, store);
      await fs.mkdir(outDir, { recursive: true });
      const outPath = path.join(outDir, name);
      await fs.writeFile(outPath, html, 'utf8');
      const rel = path.relative(path.resolve(__dirname, '..', '..'), outPath);
      // eslint-disable-next-line no-console
      console.log(`[capture-server] ✓ ${rel} (${html.length} bytes)`);
      jsonResponse(res, 200, { ok: true, path: rel, bytes: html.length });
      return;
    }

    jsonResponse(res, 404, { ok: false, error: `Not found: ${method} ${url}` });
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('[capture-server] error:', err);
    jsonResponse(res, 500, { ok: false, error: String(err.message ?? err) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = localAddresses();
  // eslint-disable-next-line no-console
  console.log(`[capture-server] Listening on port ${PORT}`);
  console.log(`[capture-server] Fixtures will be written under: ${FIXTURES_ROOT}`);
  console.log(`[capture-server] Set the dev server URL on your phone's admin screen to ONE of:`);
  for (const addr of addrs) {
    console.log(`[capture-server]   http://${addr}:${PORT}`);
  }
  if (addrs.length === 0) {
    console.log(`[capture-server]   http://<your-LAN-IP>:${PORT}   (could not auto-detect a LAN IP)`);
  }
  console.log(`[capture-server] Ctrl-C to stop.`);
});
