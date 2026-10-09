import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { template } from './template.mjs';
import { parseArgs, validateConfig, validateManifest, makeManifest, cacheControl, verifyTarget, runRelease } from './deploy.mjs';
const source = readFileSync(new URL('../../infra/landing/viewer-request.js', import.meta.url), 'utf8');
const handler = vm.runInNewContext(`${source}; handler`);
const config = { accountId: '123456789012', region: 'ap-northeast-2', stackName: 'kinda-landing-test', bucket: 'kinda-landing-test-123456789012', distributionId: 'EXAMPLE123', domainName: '', certificateArn: '', hostedZoneId: '' };
test('only three exact page routes rewrite; internal paths cannot become SPA pages', () => {
  for (const uri of ['/', '/features', '/pricing']) assert.equal(handler({ request: { uri } }).uri, '/index.html');
  for (const uri of ['/login', '/features/', '/index.html', '/releases/old/index.html', '/api', '/unknown', '/brand/../index.html', '/assets/%2e%2e/index.html']) assert.equal(handler({ request: { uri } }).uri, '/__not-found__');
  for (const uri of ['/assets/app-abcd1234.js', '/brand/kinda.svg', '/404.html']) assert.equal(handler({ request: { uri } }).uri, uri);
});
test('private retained S3, OAC signing, TLS, 404 and zero minimum cache TTL', () => {
  const r = template.Resources;
  assert.equal(r.LandingBucket.DeletionPolicy, 'Retain');
  assert.equal(r.LandingBucket.Properties.VersioningConfiguration.Status, 'Enabled');
  assert.ok(Object.values(r.LandingBucket.Properties.PublicAccessBlockConfiguration).every(Boolean));
  assert.equal(r.LandingOac.Properties.OriginAccessControlConfig.SigningBehavior, 'always');
  const d = r.LandingDistribution.Properties.DistributionConfig;
  assert.equal(d.DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https');
  assert.equal(d.Origins[0].S3OriginConfig.OriginAccessIdentity, '');
  assert.deepEqual(d.CustomErrorResponses.map(x => [x.ErrorCode,x.ResponseCode,x.ResponsePagePath]), [[403,404,'/404.html'],[404,404,'/404.html']]);
  assert.equal(r.HtmlCachePolicy.Properties.CachePolicyConfig.MinTTL, 0);
  assert.equal(r.AssetCachePolicy.Properties.CachePolicyConfig.MinTTL, 0);
  assert.equal(r.ViewerRequest.Properties.FunctionCode, source);
  const read = r.LandingBucketPolicy.Properties.PolicyDocument.Statement.find(s => s.Sid === 'CloudFrontRead');
  assert.equal(read.Principal.Service, 'cloudfront.amazonaws.com');
  assert.ok(read.Condition.StringEquals['AWS:SourceArn']);
  assert.equal(read.Resource.length, 4);
});
test('CLI fails closed and requires explicit config, release, mode', () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['deploy','--config','a','--release','x','--delete']));
  assert.throws(() => parseArgs(['rollback','--config','a']));
  assert.throws(() => parseArgs(['deploy','--config','a','--release','../bad']));
  assert.equal(parseArgs(['deploy','--config','a','--release','r1']).execute,false);
  assert.throws(() => validateConfig({...config, accountId: ''}));
  assert.throws(() => validateConfig({...config, domainName:'www.example.com'}));
  assert.throws(() => validateConfig({...config, domainName:'www.example.com',certificateArn:'arn:aws:acm:ap-northeast-2:123456789012:certificate/abc',hostedZoneId:'ZABC'}));
  validateConfig(config);
});
test('manifest rejects arbitrary paths, malformed hashes and mutable assets', () => {
  const m = makeManifest('r1', [{key:'index.html',sha256:'a'.repeat(64),size:1},{key:'404.html',sha256:'b'.repeat(64),size:1},{key:'assets/app-abcd1234.js',sha256:'c'.repeat(64),size:1}]);
  validateManifest(m,'r1');
  assert.throws(() => validateManifest({...m,files:[...m.files,{key:'../secret',sha256:'a'.repeat(64),size:1}]},'r1'));
  assert.throws(() => validateManifest({...m,files:m.files.map(f=>({...f,sha256:'bad'}))},'r1'));
  assert.throws(() => validateManifest(m,'other'));
  assert.equal(cacheControl('assets/app-abcd1234.js'),'public,max-age=31536000,immutable');
  assert.equal(cacheControl('brand/kinda.svg'),'public,max-age=60,must-revalidate');
  assert.throws(() => makeManifest('r1',[...m.files,{key:'assets/app.js',sha256:'d'.repeat(64),size:1}]));
});
function fakeAws(overrides={}) {
  const calls=[];
  const run=async(args)=>{
    calls.push(args);
    const key=args.slice(0,2).join(' ');
    const values={
      'sts get-caller-identity':{Account:config.accountId},
      'cloudformation describe-stacks':{Stacks:[{StackId:`arn:aws:cloudformation:${config.region}:${config.accountId}:stack/${config.stackName}/abc`,StackStatus:'CREATE_COMPLETE',Tags:[{Key:'Purpose',Value:'kinda-static-landing'}],Outputs:[{OutputKey:'BucketName',OutputValue:config.bucket},{OutputKey:'DistributionId',OutputValue:config.distributionId},{OutputKey:'OacId',OutputValue:'OAC123'}]}]},
      's3api head-bucket':{},
      's3api get-public-access-block':{PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}},
      's3api get-bucket-ownership-controls':{OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]}},
      'cloudfront get-distribution':{Distribution:{ARN:`arn:aws:cloudfront::${config.accountId}:distribution/${config.distributionId}`,Status:'Deployed',DistributionConfig:{Enabled:true,Origins:{Items:[{DomainName:`${config.bucket}.s3.${config.region}.amazonaws.com`,OriginAccessControlId:'OAC123',S3OriginConfig:{OriginAccessIdentity:''}}]}}}},
      'cloudfront get-origin-access-control':{OriginAccessControl:{OriginAccessControlConfig:{OriginAccessControlOriginType:'s3',SigningBehavior:'always',SigningProtocol:'sigv4'}}}
    };
    return overrides[key] ?? values[key] ?? {};
  };return {run,calls};
}
test('target identity guards run before writes, including rollback', async()=>{
  const good=fakeAws();await verifyTarget(config,good.run);
  assert.ok(good.calls.find(a=>a[0]==='s3api'&&a.includes('--expected-bucket-owner')&&a.includes(config.accountId)));
  for(const mode of ['deploy','rollback']) {
    const bad=fakeAws({'sts get-caller-identity':{Account:'999999999999'}});
    await assert.rejects(runRelease({mode,execute:true,release:'r1'},config,bad.run),/account/i);
    assert.equal(bad.calls.length,1);
  }
  const badOac=fakeAws({'cloudfront get-origin-access-control':{OriginAccessControl:{OriginAccessControlConfig:{SigningBehavior:'never'}}}});
  await assert.rejects(verifyTarget(config,badOac.run),/OAC/);
});
test('dry-run deploy and rollback never invoke AWS',async()=>{
  for(const mode of ['deploy','rollback']) {
    let calls=0;
    const plan=await runRelease({mode,execute:false,release:'r1'},config,()=>{calls++;throw Error('AWS forbidden')});
    assert.equal(calls,0);assert.equal(plan.execute,false);assert.equal(plan.mode,mode);
  }
});

test('public route contract stays aligned with standalone Web', async()=>{
  const {publicRoutes}=await import('../../apps/web/scripts/static-landing-contract.mjs');
  assert.deepEqual(publicRoutes,['/','/features','/pricing']);
  for(const uri of publicRoutes)assert.equal(handler({request:{uri}}).uri,'/index.html');
});

test('real release procedure archives bytes, retains old assets, and restores old HTML safely', async()=>{
  const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'landing-test-'));
  const objects=new Map();const actions=[];const guard=fakeAws();
  const aws=async(args)=>{
    actions.push(args);const service=args[0],operation=args[1];const value=flag=>args[args.indexOf(flag)+1];
    if(service==='s3api'&&operation==='head-object') {
      const existing=objects.get(value('--key'));
      if(!existing)throw Error('AWS HeadObject failed (404)');
      return {Metadata:existing.metadata};
    }
    if(service==='s3api'&&operation==='put-object') {
      const key=value('--key');
      if(args.includes('--if-none-match')&&objects.has(key))throw Error('PreconditionFailed');
      objects.set(key,{bytes:await readFile(value('--body')),metadata:{sha256:args.includes('--metadata')?value('--metadata').split('=')[1]:undefined},cache:value('--cache-control')});return {};
    }
    if(service==='s3api'&&operation==='get-object') {const key=value('--key');if(!objects.has(key))throw Error('NoSuchKey');await writeFile(args.at(-1),objects.get(key).bytes);return {};}
    if(service==='s3api'&&operation==='delete-object') {assert.equal(value('--key'),'releases/deployment.lock');objects.delete(value('--key'));return {};}
    if(service==='cloudfront'&&operation==='create-invalidation')return {Invalidation:{Id:'INVALIDATION'}};
    if(service==='cloudfront'&&operation==='wait')return {};
    return guard.run(args);
  };
  try {
    await mkdir(join(dir,'assets'));await writeFile(join(dir,'index.html'),'<html>old</html>');await writeFile(join(dir,'404.html'),'<html>킨다 404</html>');await writeFile(join(dir,'assets/app-abcd1234.js'),'console.log("old");');
    await runRelease({mode:'deploy',execute:true,release:'r1',dist:dir},config,aws);
    const publicWrites=actions.filter(a=>a[1]==='put-object'&&!a[a.indexOf('--key')+1].startsWith('releases/'));
    assert.equal(publicWrites.at(-1)[publicWrites.at(-1).indexOf('--key')+1],'index.html');
    assert.equal(objects.get('assets/app-abcd1234.js').cache,'public,max-age=31536000,immutable');
    await rm(join(dir,'assets/app-abcd1234.js'));await writeFile(join(dir,'assets/app-efgh5678.js'),'console.log("new");');await writeFile(join(dir,'index.html'),'<html>new</html>');
    await runRelease({mode:'deploy',execute:true,release:'r2',dist:dir},config,aws);
    assert.equal(objects.get('index.html').bytes.toString(),'<html>new</html>');
    assert.ok(objects.has('assets/app-abcd1234.js'));assert.ok(objects.has('assets/app-efgh5678.js'));
    await runRelease({mode:'rollback',execute:true,release:'r1'},config,aws);
    assert.equal(objects.get('index.html').bytes.toString(),'<html>old</html>');
    assert.ok(objects.has('assets/app-efgh5678.js'));
    const before=actions.length;objects.get('releases/r1/index.html').bytes=Buffer.from('tampered');
    await assert.rejects(runRelease({mode:'rollback',execute:true,release:'r1'},config,aws),/integrity/);
    assert.equal(actions.slice(before).filter(a=>a[1]==='put-object'&&!a[a.indexOf('--key')+1].startsWith('releases/')).length,0);
    assert.equal(objects.has('releases/deployment.lock'),false);
    assert.equal(actions.filter(a=>a[1]==='create-invalidation').length,3);
    assert.ok(actions.filter(a=>a[0]==='s3api').every(a=>a.includes('--expected-bucket-owner')));
  } finally {await rm(dir,{recursive:true,force:true});}
});
