import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const port = Number(process.env.PORT ?? 3001);

createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.writeHead(405, { Allow: 'GET, HEAD' }).end();
  }
  const pathname = req.url?.split('?')[0];
  const path = pathname === '/' ? '/index.html' : pathname;
  if (!path || (path !== '/index.html' && !/^\/assets\/[a-zA-Z0-9][\w.-]*$/.test(path))) return res.writeHead(404).end();
  const type = mime[extname(path)];
  if (!type) return res.writeHead(404).end();
  try {
    const body = await readFile(new URL(`./dist${path}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`Website: http://127.0.0.1:${port}`));
