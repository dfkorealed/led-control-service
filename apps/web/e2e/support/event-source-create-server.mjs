import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';

// The browser owns every fixture response. Any unhandled API call stops here;
// neither Vite's default proxy nor a developer .env may contact a live service.
const api = createServer((_request, response) => {
  response.writeHead(501, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ message: 'unhandled isolated fixture request' }));
});
await new Promise((resolve, reject) => { api.once('error', reject); api.listen(15447, '127.0.0.1', resolve); });
process.env.DEV_LOCAL_APP_ONLY = '0';
const vite = await createViteServer({ envDir: false, cacheDir: 'node_modules/.vite-event-source-create',
  server: { host: '127.0.0.1', port: 15446, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:15447', changeOrigin: true } } } });
await vite.listen();
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await vite.close(); await new Promise(resolve => api.close(resolve));
}
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
