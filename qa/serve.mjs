// A static file server for public/, used only by the Playwright UI suite.
//
// The suite deliberately exercises the REAL index.html, app.js and styles.css;
// only the data layer is swapped out (see fake-data.js), by intercepting the
// request for /data.js in the browser. So this server has one job: serve
// public/ exactly as Netlify would.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const PORT = Number(process.env.QA_PORT || 4321);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path === '/' || path.endsWith('/')) path = '/index.html';

  // Never serve outside public/, however the path is spelled.
  const target = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('no');
    return;
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    // Hash routing means a deep link is still index.html.
    if (!extname(path)) {
      try {
        const body = await readFile(join(ROOT, 'index.html'));
        res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
        res.end(body);
        return;
      } catch { /* fall through */ }
    }
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`[qa] serving public/ on http://localhost:${PORT}`));
