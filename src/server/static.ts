import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { sendError } from './http.ts';

// Serves Vite's build output. Mirrors serveStatic in the CLI's boardServer.ts.
// Radar routes by URL hash, so there is no SPA fallback: `/` is the only page.

function contentType(path: string): string {
  switch (extname(path)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  webDir: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === '/' ? '/index.html' : pathname;
  const root = resolve(webDir);
  const target = resolve(root, `.${relative}`);

  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  let content: Buffer;
  try {
    content = await readFile(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      if (relative === '/index.html') {
        sendError(
          res,
          503,
          'The web app is not built. Run `pnpm start` (which builds first) or `pnpm dev`.',
        );
      } else {
        sendError(res, 404, 'Not found');
      }
      return;
    }
    throw error;
  }

  res.writeHead(200, { 'content-type': contentType(target) });
  if (req.method === 'HEAD') res.end();
  else res.end(content);
}
