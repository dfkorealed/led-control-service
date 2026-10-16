import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPublicPage, isPublicAsset, publicFileForPath, parseDeployMode } from './public-deploy-contract.mjs';
// This preview intentionally has no API proxy. Browser tests supply explicit API mocks.
export function createPublicServer(directory, mode) {
  parseDeployMode(mode);
  return createServer(async (request, response) => {
    const path = (request.url ?? '').split('?')[0];
    const page = isPublicPage(path, mode);
    const publicFile = publicFileForPath(path, mode);
    const key = publicFile ?? path.slice(1);
    const allowed = publicFile !== null || isPublicAsset(key, mode);
    if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405); response.end(); return; }
    let status = allowed ? 200 : 404;
    let body;
    try { body = await readFile(resolve(directory, allowed ? key : '404.html')); }
    catch { status = 404; body = await readFile(resolve(directory, '404.html')); }
    const type = status === 404 || page ? 'text/html; charset=utf-8' : ({js:'application/javascript',css:'text/css',svg:'image/svg+xml',png:'image/png',txt:'text/plain; charset=utf-8',xml:'application/xml; charset=utf-8'})[key.split('.').at(-1)] ?? 'application/octet-stream';
    response.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    response.end(request.method === 'HEAD' ? undefined : body);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = fileURLToPath(new URL('../dist-public', import.meta.url));
  const artifact = JSON.parse(await readFile(resolve(directory, 'deployment.json'), 'utf8'));
  const server = createPublicServer(directory, parseDeployMode(artifact.mode));
  server.listen(Number(process.env.PUBLIC_PORT ?? 5187), '127.0.0.1', () => console.log(`Public ${artifact.mode}: http://127.0.0.1:${process.env.PUBLIC_PORT ?? 5187}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close());
}
