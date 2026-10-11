// Read-only checks against an explicit HTTPS URL, after deploy propagation completes.
import { parseDeployMode, isPublicPage } from '../../apps/web/scripts/public-deploy-contract.mjs';
const mode = parseDeployMode(process.env.WEB_DEPLOY_MODE);
const [base] = process.argv.slice(2);
const url = new URL(base ?? 'invalid:');
if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Usage: node scripts/landing/smoke.mjs https://EXACT_HOST');
for (const path of ['/', '/features', '/pricing', '/login', '/settings/floor-plans/smoke/edit', '/features/', '/unknown-public-path', '/concepts/field-day.html', '/releases/missing/manifest.json']) {
  const expected = isPublicPage(path, mode) ? 200 : 404;
  const response = await fetch(new URL(path, url), { redirect: 'manual' });
  if (response.status !== expected) throw Error(`${path}: expected ${expected}, got ${response.status}`);
  if (!response.headers.get('content-type')?.includes('text/html')) throw Error(`${path}: missing HTML response`);
  if (response.headers.get('x-content-type-options') !== 'nosniff') throw Error(`${path}: missing security headers`);
  const html = await response.text();
  if (expected === 404 && !/404/.test(html)) throw Error(`${path}: missing branded error page`);
  console.log(`${response.status} ${path}`);
}
const auth = await fetch(new URL('/api/auth/me', url), { redirect: 'manual' });
if (mode === 'landing') {
  if (auth.status !== 404) throw Error('Landing must not expose API');
} else {
  if (auth.status !== 401 || !auth.headers.get('content-type')?.includes('application/json')) throw Error('Unauthenticated service API must retain JSON 401');
  if (Number(auth.headers.get('age') ?? 0) > 0 || /Hit from cloudfront/i.test(auth.headers.get('x-cache') ?? '')) throw Error('API response was cached');
}
const insecure = new URL(url); insecure.protocol = 'http:';
const redirect = await fetch(insecure, { redirect: 'manual' });
if (![301, 302, 307, 308].includes(redirect.status) || !redirect.headers.get('location')?.startsWith(url.origin)) throw Error('HTTP must redirect to the exact HTTPS origin');
console.log(`HTTPS and ${mode} API contract verified`);
