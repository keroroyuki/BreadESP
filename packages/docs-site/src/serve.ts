// PRD: §F-DOC-5 — loopback static preview server for the built docs site (P5.4).
//
// Deliberately minimal and defensive: GET/HEAD only, loopback bind by default,
// URL-decoded segment normalization with explicit '..' rejection plus a final
// resolved-path containment check, extension-keyed MIME table, no-store
// responses (preview must never serve stale pages).
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { RunningServer, ServeOptions } from './types.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function respond(res: import('node:http').ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message);
}

/**
 * Serve a built docs directory on the loopback interface. Returns the bound
 * URL (port 0 resolves to the ephemeral port actually bound, for tests).
 */
export function serveDocs(outDir: string, options: ServeOptions = {}): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 4173;
  const root = resolve(outDir);

  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respond(res, 405, 'Method Not Allowed');
      return;
    }
    const rawPath = (req.url ?? '/').split('?')[0].split('#')[0];
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      respond(res, 400, 'Bad Request');
      return;
    }
    const segments = decoded.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.');
    if (segments.some((segment) => segment === '..')) {
      respond(res, 403, 'Forbidden');
      return;
    }
    let rel = segments.join('/');
    if (rawPath.endsWith('/')) rel = rel === '' ? 'index.html' : `${rel}/index.html`;
    let filePath = join(root, rel);
    if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
    const resolvedPath = resolve(filePath);
    if (resolvedPath !== root && !resolvedPath.startsWith(root + sep)) {
      respond(res, 403, 'Forbidden');
      return;
    }
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
      respond(res, 404, 'Not Found');
      return;
    }
    const contentType = MIME_TYPES[extname(resolvedPath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': statSync(resolvedPath).size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(resolvedPath).pipe(res);
  });

  return new Promise<RunningServer>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(requestedPort, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : requestedPort;
      resolvePromise({
        url: `http://${host}:${port}/`,
        port,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.closeAllConnections(); // keep-alive sockets must not hang close
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}
