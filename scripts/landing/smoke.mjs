// Read-only checks against an explicit URL after the CloudFront invalidation completes.
const [base]=process.argv.slice(2);
const url=new URL(base??'invalid:');
if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Usage: node scripts/landing/smoke.mjs https://EXACT_HOST');
for(const path of ['/','/features','/pricing','/login','/features/','/api','/unknown-landing-path','/releases/missing/manifest.json']) {
  const expected=['/','/features','/pricing'].includes(path)?200:404;
  const response=await fetch(new URL(path,url),{redirect:'manual'});
  if(response.status!==expected)throw Error(`${path}: expected ${expected}, got ${response.status}`);
  if(!response.headers.get('content-type')?.includes('text/html'))throw Error(`${path}: missing HTML response`);
  if(response.headers.get('x-content-type-options')!=='nosniff')throw Error(`${path}: missing security headers`);
  const html=await response.text();
  if(expected===404&&!/404/.test(html))throw Error(`${path}: missing branded error page`);
  console.log(`${response.status} ${path}`);
}
const insecure=new URL(url);insecure.protocol='http:';
const redirect=await fetch(insecure,{redirect:'manual'});
if(![301,302,307,308].includes(redirect.status)||!redirect.headers.get('location')?.startsWith(url.origin))throw Error('HTTP must redirect to the exact HTTPS origin');
console.log('HTTPS redirect verified');
