import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** The file a URL path names inside `root`, or null: never outside it, never a dotfile. */
function fileFor(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.'))) return null;
  const file = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

async function send(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const stat = fs.statSync(file);
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=0');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return;
  }
  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') {
    res.writeHead(200).end();
    return;
  }
  res.writeHead(200);
  await pipeline(fs.createReadStream(file), res);
}

/**
 * The built client: files from `dir`, and index.html for any other page so the single-page app
 * can route it. Only GET and HEAD; returns false for anything else.
 */
export function staticFiles(dir: string): (req: IncomingMessage, res: ServerResponse, urlPath: string) => Promise<boolean> {
  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');
  return async (req, res, urlPath) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const file = fileFor(root, urlPath) ?? (fs.existsSync(index) ? index : null);
    if (!file) return false;
    await send(req, res, file);
    return true;
  };
}
