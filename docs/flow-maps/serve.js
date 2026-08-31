// Tiny dependency-free static server for the Mealio flow maps.
// Started by serve.cmd, which is what the Desktop shortcut points at.
//
// Binds 127.0.0.1 only — these pages are notes about how the app works, and are
// nobody else's business on a shared network.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PREFERRED_PORT = 8777;
const MAX_TRIES = 20;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  // Resolve, then confirm the result is still inside ROOT. A `..` in the URL is
  // the one way a static server hands out the rest of the disk.
  const filePath = path.resolve(ROOT, '.' + rel);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, body) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<body style="background:#0b1120;color:#e2e8f0;font:15px system-ui;padding:40px">'
        + '<h1>404</h1><p><a style="color:#60a5fa" href="/">Back to the flow maps</a></p></body>');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      // The mermaid bundle never changes and is 3.5 MB, so it is worth caching.
      // A cached PAGE is how you read yesterday's diagram and think it is today's.
      'Cache-Control': ext === '.js' ? 'public, max-age=3600' : 'no-cache',
    });
    res.end(body);
  });
});

function openBrowser(url) {
  // A browser that will not open is a nuisance, not a reason to take the server
  // down with it — the URL is printed either way. `start` is a cmd builtin, and
  // the empty "" is its window-title argument: without it, start treats a quoted
  // URL as the title and opens nothing.
  try {
    spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true })
      .on('error', function () {})
      .unref();
  } catch (e) { /* open it yourself */ }
}

function listen(port, triesLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      listen(port + 1, triesLeft - 1);
      return;
    }
    console.error('Could not start the server: ' + err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = 'http://localhost:' + port + '/';
    console.log('');
    console.log('  Mealio flow maps  ->  ' + url);
    console.log('');
    console.log('  Leave this window open while you read.');
    console.log('  Close it, or press Ctrl+C, to stop the server.');
    console.log('');
    if (process.env.MEALIO_NO_OPEN !== '1') openBrowser(url);
  });
}

listen(PREFERRED_PORT, MAX_TRIES);
