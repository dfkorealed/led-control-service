import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, validateConfig, validateManifest, cacheControl, verifyTarget, runRelease } from './deploy.mjs';
import { createArtifact } from '../../apps/web/scripts/public-deploy-contract.mjs';
import { createTemplate } from './template.mjs';
const config = {accountId:'123456789012',region:'ap-northeast-2',stackName:'kinda-landing-test',bucket:'kinda-landing-test-123456789012',distributionId:'DIST12345',apiOriginDomain:'api.kinda-lighting.com'};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fakeAws() {
  const calls = [], objects = new Map();
  let active = {mode:'landing',release:'unpublished'}, pending, failActivation = false, account = config.accountId;
  const run = async args => {
    calls.push(args);
    const value = flag => args[args.indexOf(flag)+1];
    const command = args.slice(0,2).join(' ');
    if (command === 'sts get-caller-identity') return {Account:account};
    if (command === 'cloudformation describe-stacks') return {Stacks:[{StackId:`arn:aws:cloudformation:${config.region}:${config.accountId}:stack/${config.stackName}/id`,StackStatus:'UPDATE_COMPLETE',Tags:[{Key:'Purpose',Value:'kinda-static-landing'}],Outputs:Object.entries({BucketName:config.bucket,DistributionId:config.distributionId,OacId:'OAC123',DeployMode:active.mode,ReleaseId:active.release}).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]};
    if (command === 's3api head-bucket') return {};
    if (command === 's3api get-public-access-block') return {PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
    if (command === 's3api get-bucket-ownership-controls') return {OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]}};
    if (command === 'cloudfront get-origin-access-control') return {OriginAccessControl:{OriginAccessControlConfig:{OriginAccessControlOriginType:'s3',SigningBehavior:'always',SigningProtocol:'sigv4'}}};
    if (command === 'cloudfront get-distribution') return {Distribution:{ARN:`arn:aws:cloudfront::${config.accountId}:distribution/${config.distributionId}`,Status:'Deployed',DistributionConfig:{Enabled:true,Origins:{Items:[{DomainName:`${config.bucket}.s3.${config.region}.amazonaws.com`,OriginAccessControlId:'OAC123',S3OriginConfig:{OriginAccessIdentity:''}},...(active.mode==='service'?[{Id:'service-api',DomainName:config.apiOriginDomain,CustomOriginConfig:{OriginProtocolPolicy:'https-only'}}]:[])]}}}};
    if (command === 's3api head-object') {
      const obj=objects.get(value('--key')); if(!obj)throw Error('HeadObject (404)');
      return {Metadata:obj.metadata,ETag:digest(obj.bytes)};
    }
    if (command === 's3api put-object') {
      const key=value('--key');
      if(args.includes('--if-none-match')&&objects.has(key))throw Error('PreconditionFailed');
      objects.set(key,{bytes:await readFile(value('--body')),metadata:{sha256:args.includes('--metadata')?value('--metadata').split('=')[1]:undefined},cache:value('--cache-control')});return {};
    }
    if(command==='s3api get-object') {const obj=objects.get(value('--key'));if(!obj)throw Error('NoSuchKey');await writeFile(args.at(-1),obj.bytes);return {};}
    if(command==='s3api delete-object') {
      assert.equal(value('--key'),'releases/deployment.lock');
      if(args.includes('--if-match'))assert.equal(digest(objects.get(value('--key')).bytes),value('--if-match'));
      objects.delete(value('--key'));return {};
    }
    if(command==='cloudformation validate-template')return {};
    if(command==='cloudformation update-stack') {
      const t=JSON.parse(await readFile(value('--template-body').slice(7),'utf8'));
      pending={mode:t.Outputs.DeployMode.Value,release:t.Outputs.ReleaseId.Value};
      // The selected HTML and every asset already exist before activation.
      assert.ok(objects.has(`published/${pending.release}/index.html`));
      const artifact=JSON.parse(objects.get(`releases/${pending.release}/deployment.json`).bytes);
      for(const f of artifact.files)if(f.key.startsWith('assets/'))assert.ok(objects.has(f.key));
      if(failActivation)throw Error('Simulated stack update failure');
      active=pending;return {};
    }
    if(command==='cloudformation wait'||command==='cloudfront wait')return {};
    if(command==='cloudfront create-invalidation')return {Invalidation:{Id:'INVALIDATION'}};
    throw Error(`Unmodelled AWS command: ${command}`);
  };
  return {run,calls,objects,get active(){return active;},failActivation(value){failActivation=value;},setAccount(value){account=value;}};
}
async function fixture(directory,mode,label) {
  await rm(directory,{recursive:true,force:true}); await mkdir(join(directory,`assets/${mode}`),{recursive:true});
  const files = {'index.html':Buffer.from(`<html>${label}</html>`),'404.html':Buffer.from('<html>킨다 404</html>'),[`assets/${mode}/app-${label}12345678.js`]:Buffer.from(`console.log('${label}')`)};
  for(const [key,bytes] of Object.entries(files))await writeFile(join(directory,key),bytes);
  await writeFile(join(directory,'deployment.json'),JSON.stringify(createArtifact(mode,files)));
}
const publicWrites = calls => calls.filter(a=>a[0]==='s3api'&&a[1]==='put-object'&&!a[a.indexOf('--key')+1].startsWith('releases/'));

test('CLI/config fail closed and offline plans never call AWS',async()=>{
  for(const args of [[],['deploy','--config','a'],['deploy','--config','a','--release','../bad'],['deploy','--config','a','--release','r1','--dist','old']])assert.throws(()=>parseArgs(args));
  assert.equal(parseArgs(['deploy','--config','a','--release','r1']).execute,false);
  for(const c of [{...config,accountId:''},{...config,domainName:'www.example.com'},{...config,apiOriginDomain:'https://api.kinda-lighting.com'},{...config,apiOriginDomain:'127.0.0.1'}])assert.throws(()=>validateConfig(c));
  for(const mode of ['deploy','rollback']) {
    const result=await runRelease({mode,deployMode:'landing',execute:false,release:'r1'},config,()=>assert.fail('AWS forbidden'));
    assert.equal(result.execute,false);
  }
  const aws=fakeAws();aws.setAccount('999999999999');
  await assert.rejects(verifyTarget(config,aws.run),/account/);assert.equal(aws.calls.length,1);
});
test('private retained S3 and scoped OAC read policy survive mode templates',()=>{
  for(const mode of ['landing','service']) {
    const r=createTemplate(mode,'r1').Resources;
    assert.equal(r.LandingBucket.DeletionPolicy,'Retain');
    assert.equal(r.LandingBucket.Properties.VersioningConfiguration.Status,'Enabled');
    assert.ok(Object.values(r.LandingBucket.Properties.PublicAccessBlockConfiguration).every(Boolean));
    assert.equal(r.LandingOac.Properties.OriginAccessControlConfig.SigningBehavior,'always');
    const statement=r.LandingBucketPolicy.Properties.PolicyDocument.Statement[0];
    assert.ok(statement.Condition.StringEquals['AWS:SourceArn']);
    assert.ok(statement.Resource.every(ref=>!JSON.stringify(ref).includes('/releases/')));
  }
  assert.equal(cacheControl('assets/service/app-12345678.js'),'public,max-age=31536000,immutable');
});
test('landing to service to landing and cross-mode rollback publish matching archives and retain old assets',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'public-deploy-test-'));const aws=fakeAws();
  try {
    for(const [mode,release] of [['landing','r1'],['service','r2'],['landing','r3']]) {
      await fixture(dir,mode,release);
      await runRelease({mode:'deploy',deployMode:mode,execute:true,release,dist:dir},config,aws.run);
      assert.deepEqual(aws.active,{mode,release});
      assert.equal(JSON.parse(aws.objects.get(`releases/${release}/manifest.json`).bytes).mode,mode);
      assert.equal(aws.objects.has('releases/deployment.lock'),false);
    }
    await runRelease({mode:'rollback',deployMode:'service',execute:true,release:'r2'},config,aws.run);
    assert.deepEqual(aws.active,{mode:'service',release:'r2'});
    assert.equal(aws.objects.get('published/r2/index.html').bytes.toString(),'<html>r2</html>');
    assert.ok(aws.objects.has('assets/landing/app-r112345678.js'));
    assert.ok(aws.objects.has('assets/service/app-r212345678.js'));
    assert.equal(aws.calls.filter(a=>a[1]==='create-invalidation').length,4);
    assert.ok(aws.calls.filter(a=>a[0]==='s3api').every(a=>a.includes('--expected-bucket-owner')));
    const before=aws.calls.length;
    await assert.rejects(runRelease({mode:'rollback',deployMode:'landing',execute:true,release:'r2'},config,aws.run),/mode/);
    assert.equal(publicWrites(aws.calls.slice(before)).length,0);
    const manifest=JSON.parse(aws.objects.get('releases/r2/manifest.json').bytes);
    assert.throws(()=>validateManifest({...manifest,version:1},'r2','service'),/manifest/);
    assert.throws(()=>validateManifest({...manifest,files:[...manifest.files,{key:'../secret',sha256:'a'.repeat(64),size:1}]},'r2','service'),/Unsafe/);
    aws.objects.get('releases/r2/index.html').bytes=Buffer.from('tampered');
    await assert.rejects(runRelease({mode:'rollback',deployMode:'service',execute:true,release:'r2'},config,aws.run),/integrity/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('wrong mode or stale bytes fail before all remote calls',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'public-stale-'));const aws=fakeAws();
  try {
    await fixture(dir,'landing','r1');
    await assert.rejects(runRelease({mode:'deploy',deployMode:'service',execute:true,release:'r1',dist:dir},config,aws.run),/mode/);
    await writeFile(join(dir,'index.html'),'changed');
    await assert.rejects(runRelease({mode:'deploy',deployMode:'landing',execute:true,release:'r1',dist:dir},config,aws.run),/integrity/);
    assert.equal(aws.calls.length,0);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('activation failure retains lock and exact conditional recovery can roll back to prior mode',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'public-recovery-'));const aws=fakeAws();
  try {
    await fixture(dir,'landing','r1');await runRelease({mode:'deploy',deployMode:'landing',execute:true,release:'r1',dist:dir},config,aws.run);
    await fixture(dir,'service','r2');aws.failActivation(true);
    await assert.rejects(runRelease({mode:'deploy',deployMode:'service',execute:true,release:'r2',dist:dir},config,aws.run),/lock retained/);
    assert.ok(aws.objects.has('releases/deployment.lock'));
    assert.deepEqual(aws.active,{mode:'landing',release:'r1'});
    aws.failActivation(false);
    await assert.rejects(runRelease({mode:'rollback',deployMode:'landing',execute:true,release:'r1',recoverLock:'wrong'},config,aws.run),/lock release mismatch/);
    await runRelease({mode:'rollback',deployMode:'landing',execute:true,release:'r1',recoverLock:'r2'},config,aws.run);
    assert.deepEqual(aws.active,{mode:'landing',release:'r1'});
    assert.equal(aws.objects.has('releases/deployment.lock'),false);
    assert.ok(aws.calls.find(a=>a[1]==='delete-object'&&a.includes('--if-match')));
  } finally {await rm(dir,{recursive:true,force:true});}
});
