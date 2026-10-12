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
function fakeAws({target=config,existingStack=true,certificateStatus='ISSUED',certificateNames=[target.domainName]}={}) {
  const calls = [], objects = new Map();
  let active = {mode:'landing',release:'unpublished'}, pending, failActivation = false, account = config.accountId;
  const run = async args => {
    calls.push(args);
    const value = flag => args[args.indexOf(flag)+1];
    const command = args.slice(0,2).join(' ');
    if (command === 'sts get-caller-identity') return {Account:account};
    if (command === 'cloudformation describe-stacks') {
      if (!existingStack) throw Error(`Stack ${target.stackName} does not exist`);
      return {Stacks:[{StackId:`arn:aws:cloudformation:${target.region}:${target.accountId}:stack/${target.stackName}/id`,StackStatus:'UPDATE_COMPLETE',Tags:[{Key:'Purpose',Value:'kinda-static-landing'}],Parameters:Object.entries({BucketName:target.bucket,DomainName:target.domainName??'',CertificateArn:target.certificateArn??'',HostedZoneId:target.hostedZoneId??'',ApiOriginDomain:target.apiOriginDomain??''}).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})),Outputs:Object.entries({BucketName:target.bucket,DistributionId:target.distributionId,OacId:'OAC123',DistributionDomain:'d123.cloudfront.net',DeployMode:active.mode,ReleaseId:active.release}).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]};
    }
    if (command === 'acm describe-certificate') return {Certificate:{Status:certificateStatus,SubjectAlternativeNames:certificateNames}};
    if (command === 'route53 get-hosted-zone') return {HostedZone:{Name:'dfkorealed.com.',Config:{PrivateZone:false}}};
    if (command === 'route53 list-resource-record-sets') return {ResourceRecordSets:[]};
    if (command === 's3api head-bucket') return {};
    if (command === 's3api get-public-access-block') return {PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
    if (command === 's3api get-bucket-ownership-controls') return {OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]}};
    if (command === 'cloudfront get-origin-access-control') return {OriginAccessControl:{OriginAccessControlConfig:{OriginAccessControlOriginType:'s3',SigningBehavior:'always',SigningProtocol:'sigv4'}}};
    if (command === 'cloudfront get-distribution') return {Distribution:{ARN:`arn:aws:cloudfront::${target.accountId}:distribution/${target.distributionId}`,DomainName:'d123.cloudfront.net',Status:'Deployed',DistributionConfig:{Enabled:true,Aliases:{Items:target.domainName?[target.domainName]:[]},ViewerCertificate:target.domainName?{ACMCertificateArn:target.certificateArn}:{CloudFrontDefaultCertificate:true},Origins:{Items:[{DomainName:`${target.bucket}.s3.${target.region}.amazonaws.com`,OriginAccessControlId:'OAC123',S3OriginConfig:{OriginAccessIdentity:''}},...(active.mode==='service'?[{Id:'service-api',DomainName:target.apiOriginDomain,CustomOriginConfig:{OriginProtocolPolicy:'https-only'}}]:[])]}}}};
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
    if(command==='cloudformation create-stack')return {StackId:`arn:aws:cloudformation:${target.region}:${target.accountId}:stack/${target.stackName}/new`};
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

const external = {...config,domainName:'kinda.dfkorealed.com',certificateArn:'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555',hostedZoneId:''};
const managed = {...external,hostedZoneId:'Z1234567890ABC'};
test('custom domain template keeps aliases and certificate while external DNS creates no Route 53 records',()=>{
  for(const mode of ['landing','service']) {
    const t=createTemplate(mode,'r1');
    assert.deepEqual(t.Resources.LandingDistribution.Properties.DistributionConfig.Aliases,{'Fn::If':['CustomDomain',[{Ref:'DomainName'}],{Ref:'AWS::NoValue'}]});
    assert.equal(t.Resources.DomainRecord.Condition,'ManagedDns');
    assert.equal(t.Resources.DomainIpv6Record.Condition,'ManagedDns');
    assert.deepEqual(t.Conditions.ManagedDns,{'Fn::And':[{'Fn::Not':[{'Fn::Equals':[{Ref:'DomainName'},'']}]},{'Fn::Not':[{'Fn::Equals':[{Ref:'HostedZoneId'},'']}]}]});
  }
});
test('config accepts empty external zone and rejects malformed zone or orphan certificate',()=>{
  assert.equal(validateConfig(external),external);
  assert.equal(validateConfig(managed),managed);
  assert.throws(()=>validateConfig({...external,hostedZoneId:undefined}),/hostedZoneId/);
  for(const hostedZoneId of ['Z','abc','Zbad-id',' Z123','Z123 '])assert.throws(()=>validateConfig({...external,hostedZoneId}),/hostedZoneId/);
  assert.throws(()=>validateConfig({...config,certificateArn:external.certificateArn}),/Domain/);
  assert.throws(()=>validateConfig({...config,hostedZoneId:managed.hostedZoneId}),/Domain/);
});
test('offline external plan has unresolved target and makes no AWS calls',async()=>{
  const result=await runRelease({mode:'provision',deployMode:'landing',execute:false},external,()=>assert.fail('AWS forbidden'));
  assert.deepEqual(result.dns,{mode:'external',recordType:'CNAME',name:'kinda.dfkorealed.com',target:null});
  assert.match(result.note,/unresolved|unknown|stack/i);
});
test('external provision validates issued matching certificate but never queries Route 53',async()=>{
  for(const deployMode of ['landing','service']) {
    const aws=fakeAws({target:external,existingStack:false});
    const result=await runRelease({mode:'provision',deployMode,execute:true},external,aws.run);
    assert.match(result.StackId,/\/new$/);
    assert.deepEqual(result.dns,{mode:'external',recordType:'CNAME',name:'kinda.dfkorealed.com',target:null});
    assert.ok(aws.calls.some(a=>a[0]==='acm'&&a[1]==='describe-certificate'));
    assert.ok(aws.calls.some(a=>a[0]==='cloudformation'&&a[1]==='create-stack'));
    assert.equal(aws.calls.filter(a=>a[0]==='route53').length,0);
  }
  for(const [certificateStatus,certificateNames] of [['PENDING_VALIDATION',['kinda.dfkorealed.com']],['ISSUED',['other.dfkorealed.com']]]) {
    const aws=fakeAws({target:external,existingStack:false,certificateStatus,certificateNames});
    await assert.rejects(runRelease({mode:'provision',deployMode:'landing',execute:true},external,aws.run),/ISSUED.*cover/);
    assert.equal(aws.calls.some(a=>a[0]==='cloudformation'&&['validate-template','create-stack'].includes(a[1])),false);
    assert.equal(aws.calls.some(a=>a[0]==='route53'),false);
  }
});
test('check, deploy and rollback report actual external CNAME target in both modes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'external-dns-test-'));const aws=fakeAws({target:external});
  try {
    const checked=await runRelease({mode:'check',deployMode:'landing',execute:true},external,aws.run);
    assert.deepEqual(checked.dns,{mode:'external',recordType:'CNAME',name:'kinda.dfkorealed.com',target:'d123.cloudfront.net'});
    for(const [deployMode,release] of [['landing','r1'],['service','r2']]) {
      await fixture(dir,deployMode,release);
      const deployed=await runRelease({mode:'deploy',deployMode,execute:true,release,dist:dir},external,aws.run);
      assert.deepEqual(deployed.dns,checked.dns);
    }
    const rolled=await runRelease({mode:'rollback',deployMode:'landing',execute:true,release:'r1'},external,aws.run);
    assert.deepEqual(rolled.dns,checked.dns);
    assert.equal(aws.calls.filter(a=>a[0]==='route53').length,0);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('managed DNS ownership cannot silently switch to external before any write',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'managed-dns-guard-'));const aws=fakeAws({target:managed});
  try {
    await fixture(dir,'landing','r1');
    await assert.rejects(runRelease({mode:'deploy',deployMode:'landing',execute:true,release:'r1',dist:dir},external,aws.run),/DNS ownership|hostedZoneId/i);
    assert.equal(aws.calls.some(a=>a[0]==='s3api'&&a[1]==='put-object'),false);
    assert.equal(aws.calls.some(a=>a[0]==='cloudformation'&&a[1]==='update-stack'),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('existing external distribution rejects unissued or mismatching certificate before release writes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'external-certificate-'));
  try {
    await fixture(dir,'landing','r1');
    for(const [certificateStatus,certificateNames] of [['PENDING_VALIDATION',['kinda.dfkorealed.com']],['ISSUED',['other.dfkorealed.com']]]) {
      const aws=fakeAws({target:external,certificateStatus,certificateNames});
      await assert.rejects(runRelease({mode:'deploy',deployMode:'landing',execute:true,release:'r1',dist:dir},external,aws.run),/ISSUED.*cover/);
      assert.equal(aws.calls.some(a=>a[0]==='s3api'&&a[1]==='put-object'),false);
      assert.equal(aws.calls.some(a=>a[0]==='cloudformation'&&a[1]==='update-stack'),false);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('default stack cannot gain a custom domain through an ordinary deploy',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'default-dns-guard-'));const aws=fakeAws({target:config});
  try {
    await fixture(dir,'landing','r1');
    await assert.rejects(runRelease({mode:'deploy',deployMode:'landing',execute:true,release:'r1',dist:dir},external,aws.run),/DNS ownership/);
    assert.equal(aws.calls.some(a=>a[0]==='s3api'&&a[1]==='put-object'),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('managed and default modes report their real distribution host',async()=>{
  for(const [target,mode] of [[managed,'managed'],[config,'default']]) {
    const aws=fakeAws({target});
    const result=await runRelease({mode:'check',deployMode:'landing',execute:true},target,aws.run);
    assert.equal(result.dns.mode,mode);
    assert.equal(result.dns.target,'d123.cloudfront.net');
  }
});
test('managed provision still checks the public Route 53 zone and existing records',async()=>{
  const aws=fakeAws({target:managed,existingStack:false});
  const result=await runRelease({mode:'provision',deployMode:'landing',execute:true},managed,aws.run);
  assert.equal(result.dns.mode,'managed');
  assert.deepEqual(aws.calls.filter(a=>a[0]==='route53').map(a=>a[1]),['get-hosted-zone','list-resource-record-sets']);
  assert.ok(aws.calls.some(a=>a[0]==='cloudformation'&&a[1]==='create-stack'));
});
