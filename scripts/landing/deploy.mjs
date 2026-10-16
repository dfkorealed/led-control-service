import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTemplate } from './template.mjs';
import { verifyLandingRelease } from './release.mjs';
import { parseDeployMode, assertPublicOutput, brandAssets, artifactName, verifyArtifact } from '../../apps/web/scripts/public-deploy-contract.mjs';
import { landingPageFiles, landingSeoFiles } from '../../apps/web/scripts/static-landing-contract.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const releasePattern=/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const fail=(message)=>{throw new Error(message)};
export function parseArgs(args) {
  const [mode,...rest]=args;
  if(!['provision','check','deploy','rollback'].includes(mode)) fail('Mode must be provision, check, deploy, or rollback');
  const result={mode,deployMode:parseDeployMode(process.env.WEB_DEPLOY_MODE),execute:false,dist:join(root,'apps/web/dist-public')};
  for(let i=0;i<rest.length;i++) {
    const flag=rest[i];
    if(flag==='--execute') {if(result.execute)fail('Duplicate --execute');result.execute=true;continue;}
    const key={'--config':'config','--release':'release','--recover-lock':'recoverLock'}[flag];
    if(!key||!rest[i+1]||rest[i+1].startsWith('--')||(key!=='dist'&&result[key]))fail(`Invalid argument: ${flag}`);
    result[key]=rest[++i];
  }
  if(!result.config)fail('Explicit --config is required');
  if(['deploy','rollback'].includes(mode)&&!releasePattern.test(result.release??''))fail('Explicit safe --release is required');
  return result;
}
export function validateConfig(c,provision=false,deployMode='landing') {
  parseDeployMode(deployMode);
  if (deployMode === 'service' || c.apiOriginDomain) {
    if (!/^(?!.*(?:localhost|example))(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(c.apiOriginDomain ?? '') || /(?:\.internal|\.local|\.test)$/.test(c.apiOriginDomain)) fail('Explicit public HTTPS API origin hostname required (apiOriginDomain); no path, scheme, port or IP');
  }
  if(!/^\d{12}$/.test(c.accountId??''))fail('Explicit 12-digit accountId required');
  if(!/^[a-z]{2}-[a-z]+-\d$/.test(c.region??''))fail('Explicit AWS region required');
  // Keep generated CloudFront function/OAC/policy names below their 64-character limit.
  if(!/^kinda-landing-[a-z0-9-]{1,40}$/.test(c.stackName??''))fail('Dedicated stackName must begin kinda-landing- with a 1–40 character suffix');
  if(!/^kinda-landing-[a-z0-9-]{3,49}$/.test(c.bucket??'')||!c.bucket.includes(c.accountId))fail('Dedicated bucket must begin kinda-landing- and include accountId');
  if(!provision&&!/^[A-Z0-9]{5,32}$/.test(c.distributionId??''))fail('Explicit distributionId required');
  if(c.domainName) {
    if(!/^(?!.*(?:example|localhost))([a-z0-9-]+\.)+[a-z]{2,}$/.test(c.domainName))fail('Use exact owned domainName, not an example');
    if(!new RegExp(`^arn:aws:acm:us-east-1:${c.accountId}:certificate/[a-f0-9-]+$`).test(c.certificateArn??''))fail('Existing ACM certificate in us-east-1 in target account required');
    if(typeof c.hostedZoneId!=='string'||(c.hostedZoneId!==''&&!/^Z[A-Z0-9]{2,31}$/.test(c.hostedZoneId)))fail('hostedZoneId must be empty for external DNS or a valid existing Route 53 hosted zone ID');
  } else if(c.certificateArn||c.hostedZoneId)fail('Domain required with certificate or hostedZoneId');
  return c;
}
export function cacheControl(key) {return key.startsWith('assets/')?'public,max-age=31536000,immutable':'public,max-age=60,must-revalidate';}
function validKey(key, mode) {
  if(['index.html','404.html',artifactName].includes(key))return true;
  if(mode === 'landing' && [...Object.values(landingPageFiles), ...landingSeoFiles].includes(key))return true;
  if(typeof key!=='string'||key.includes('..')||key.includes('//'))return false;
  if(brandAssets.includes(key))return true;
  return /^assets\/[A-Za-z0-9_./-]+-[A-Za-z0-9_-]{8,}\.(js|css|svg|png|webp|jpg|jpeg|avif|woff2?|gif|ico)$/.test(key);
}
export function validateManifest(m,release,deployMode=m.mode) {
  if (m.mode !== parseDeployMode(deployMode)) fail('Release deployment mode mismatch');
  if(m.version!==2||!releasePattern.test(m.release??'')||m.release!==release||!Array.isArray(m.files)||m.files.length<2||m.files.length>10000)fail('Invalid release manifest');
  const keys=new Set();
  for(const f of m.files) {
    if(!validKey(f.key,m.mode)||keys.has(f.key)||!/^([a-f0-9]{64})$/.test(f.sha256??'')||!Number.isSafeInteger(f.size)||f.size<0)fail(`Unsafe manifest entry: ${f.key}`);
    keys.add(f.key);
  }
  if(!keys.has('index.html')||!keys.has('404.html')||!keys.has(artifactName))fail('index.html, 404.html and deployment.json required');
  const seo=['features.html','pricing.html',...landingSeoFiles];
  const seoCount=seo.filter(key=>keys.has(key)).length;
  if(seoCount && seoCount!==seo.length)fail('Incomplete landing SEO archive');
  return m;
}
export function makeManifest(release,files,mode='landing'){return validateManifest({version:2,release,mode,files},release,mode);}
export async function collect(dist,release,mode, {legacyLanding = false} = {}) {
  parseDeployMode(mode);
  const bytesByKey={};
  const files=[];
  const bundle={};
  async function walk(relative='') {
    for(const entry of await readdir(join(dist,relative),{withFileTypes:true})) {
      const key=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())fail(`Symlink rejected: ${key}`);
      if(entry.isDirectory())await walk(key);
      else if(entry.isFile()){const bytes=await readFile(join(dist,key));files.push({key,sha256:hash(bytes),size:bytes.length});if(key!==artifactName)bytesByKey[key]=bytes;bundle[key]=key.endsWith('.js')?{type:'chunk',code:bytes.toString('utf8')}:{type:'asset',source:bytes};}
      else fail(`Non-file rejected: ${key}`);
    }
  }
  if(!(await lstat(dist)).isDirectory()||(await lstat(dist)).isSymbolicLink())fail('dist must be a real directory');
  await walk();
  const metadata=JSON.parse(await readFile(join(dist,artifactName),'utf8'));
  verifyArtifact(metadata,mode,bytesByKey);
  delete bundle[artifactName];
  assertPublicOutput(bundle,mode,{legacyLanding});
  return makeManifest(release,files.sort((a,b)=>a.key.localeCompare(b.key)),mode);
}
export function awsRunner(config) {
  return async(args)=>{
    const out=spawnSync('aws',[...args,...(args.includes('--region')?[]:['--region',config.region]),'--output','json','--no-cli-pager'],{encoding:'utf8',maxBuffer:16*1024*1024,env:{...process.env,AWS_PAGER:''}});
    if(out.error)throw out.error;
    if(out.status!==0)fail(`AWS ${args[0]} ${args[1]} failed: ${out.stderr.trim()}`);
    return out.stdout.trim()?JSON.parse(out.stdout):{};
  };
}
async function identity(c,aws) {if((await aws(['sts','get-caller-identity'])).Account!==c.accountId)fail('AWS account mismatch; no writes performed');}
async function verifyCertificate(c,aws) {
  if(!c.domainName)return;
  const cert=(await aws(['acm','describe-certificate','--certificate-arn',c.certificateArn,'--region','us-east-1'])).Certificate;
  const covers=name=>name===c.domainName||(name?.startsWith('*.')&&c.domainName.split('.').length===name.split('.').length&&c.domainName.endsWith(name.slice(1)));
  if(cert?.Status!=='ISSUED'||!cert.SubjectAlternativeNames?.some(covers))fail('Existing certificate must be ISSUED and cover exact domain');
}
function dnsGuidance(c,distributionDomain=null) {
  if(!c.domainName)return {mode:'default',target:distributionDomain};
  if(c.hostedZoneId)return {mode:'managed',recordType:'A/AAAA alias',name:c.domainName,target:distributionDomain};
  return {mode:'external',recordType:'CNAME',name:c.domainName,target:distributionDomain};
}
export async function verifyTarget(c,aws) {
  validateConfig(c);await identity(c,aws);
  const s=(await aws(['cloudformation','describe-stacks','--stack-name',c.stackName])).Stacks?.[0];
  const outputs=Object.fromEntries((s?.Outputs??[]).map(o=>[o.OutputKey,o.OutputValue]));
  if(!s?.StackId?.startsWith(`arn:aws:cloudformation:${c.region}:${c.accountId}:stack/${c.stackName}/`)||!['CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE'].includes(s.StackStatus)||!s.Tags?.some(t=>t.Key==='Purpose'&&t.Value==='kinda-static-landing')||outputs.BucketName!==c.bucket||outputs.DistributionId!==c.distributionId)fail('Dedicated CloudFormation stack/outputs mismatch');
  const stackParameters=Object.fromEntries((s.Parameters??[]).map(p=>[p.ParameterKey,p.ParameterValue]));
  // Changing DNS ownership through a routine deploy would delete the old
  // CloudFormation Route 53 records. Require a separately reviewed migration.
  if(stackParameters.DomainName!== (c.domainName??'')||stackParameters.HostedZoneId!== (c.hostedZoneId??'')||stackParameters.CertificateArn!== (c.certificateArn??''))fail('Existing stack DNS ownership/domain/certificate differs from config; stop and review migration before deploy');
  await verifyCertificate(c,aws);
  const bucketArgs=['--bucket',c.bucket,'--expected-bucket-owner',c.accountId];
  await aws(['s3api','head-bucket',...bucketArgs]);
  const block=(await aws(['s3api','get-public-access-block',...bucketArgs])).PublicAccessBlockConfiguration;
  if(!['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'].every(k=>block?.[k]===true))fail('Bucket public access block mismatch');
  const ownership=(await aws(['s3api','get-bucket-ownership-controls',...bucketArgs])).OwnershipControls;
  if(ownership?.Rules?.[0]?.ObjectOwnership!=='BucketOwnerEnforced')fail('Bucket ownership controls mismatch');
  const d=(await aws(['cloudfront','get-distribution','--id',c.distributionId])).Distribution;
  const origins=d?.DistributionConfig?.Origins?.Items;
  if(d?.ARN!==`arn:aws:cloudfront::${c.accountId}:distribution/${c.distributionId}`||d.Status!=='Deployed'||!d.DistributionConfig.Enabled||![1,2].includes(origins?.length)||origins[0].DomainName!==`${c.bucket}.s3.${c.region}.amazonaws.com`||origins[0].OriginAccessControlId!==outputs.OacId||origins[0].S3OriginConfig?.OriginAccessIdentity!=='')fail('CloudFront dedicated origin/OAC/account mismatch');
  if(!/^d[a-z0-9]+\.cloudfront\.net$/.test(d.DomainName??'')||outputs.DistributionDomain!==d.DomainName)fail('CloudFront distribution domain/output mismatch');
  if(c.domainName) {
    if(JSON.stringify(d.DistributionConfig.Aliases?.Items??[])!==JSON.stringify([c.domainName])||d.DistributionConfig.ViewerCertificate?.ACMCertificateArn!==c.certificateArn)fail('CloudFront alias/certificate mismatch');
  } else if((d.DistributionConfig.Aliases?.Items??[]).length||d.DistributionConfig.ViewerCertificate?.CloudFrontDefaultCertificate!==true)fail('CloudFront default domain/certificate mismatch');
  if(origins.length===2 && (origins[1].Id!=='service-api'||origins[1].DomainName!==c.apiOriginDomain||origins[1].CustomOriginConfig?.OriginProtocolPolicy!=='https-only'))fail('CloudFront API origin mismatch');
  const oac=(await aws(['cloudfront','get-origin-access-control','--id',outputs.OacId])).OriginAccessControl?.OriginAccessControlConfig;
  if(oac?.OriginAccessControlOriginType!=='s3'||oac.SigningBehavior!=='always'||oac.SigningProtocol!=='sigv4')fail('OAC signing configuration mismatch');
  return outputs;
}
const mime=(key)=>({html:'text/html; charset=utf-8',txt:'text/plain; charset=utf-8',xml:'application/xml; charset=utf-8',js:'application/javascript',css:'text/css',svg:'image/svg+xml',png:'image/png',webp:'image/webp',jpg:'image/jpeg',jpeg:'image/jpeg',avif:'image/avif',woff:'font/woff',woff2:'font/woff2',gif:'image/gif',ico:'image/x-icon'})[key.split('.').at(-1)]??'application/octet-stream';
async function head(c,key,aws) {
  try{return await aws(['s3api','head-object','--bucket',c.bucket,'--expected-bucket-owner',c.accountId,'--key',key]);}
  catch(error){if(/\((404|NoSuchKey|NotFound)\)/.test(error.message))return null;throw error;}
}
async function put(c,key,path,aws,{immutable=false,digest,cache='no-store'}={}) {
  const args=['s3api','put-object','--bucket',c.bucket,'--expected-bucket-owner',c.accountId,'--key',key,'--body',path,'--content-type',mime(key),'--cache-control',cache];
  if(immutable)args.push('--if-none-match','*');
  if(digest)args.push('--metadata',`sha256=${digest}`);
  return aws(args);
}
async function provision(c,aws,dir,deployMode) {
  validateConfig(c,true);await identity(c,aws);
  // Only create a new dedicated stack. Existing stacks/resources are never adopted or updated.
  try {await aws(['cloudformation','describe-stacks','--stack-name',c.stackName]);fail('Stack already exists; provision never updates resources');}
  catch(error){if(!/Stack .* does not exist/.test(error.message))throw error;}
  if(c.domainName) {
    await verifyCertificate(c,aws);
    if(c.hostedZoneId) {
      const zone=(await aws(['route53','get-hosted-zone','--id',c.hostedZoneId])).HostedZone;
      const zoneName=zone?.Name?.replace(/\.$/,'');
      if(!zoneName||zone.Config?.PrivateZone||!(c.domainName===zoneName||c.domainName.endsWith(`.${zoneName}`)))fail('Hosted zone is not the explicit public parent domain');
      const records=(await aws(['route53','list-resource-record-sets','--hosted-zone-id',c.hostedZoneId,'--start-record-name',c.domainName,'--max-items','10'])).ResourceRecordSets??[];
      if(records.some(r=>r.Name.replace(/\.$/,'')===c.domainName&&['A','AAAA','CNAME'].includes(r.Type)))fail('Domain already has a routing record; will not replace it');
    }
  }
  const path=join(dir,'template.json');await writeFile(path,JSON.stringify(createTemplate(deployMode)));
  await aws(['cloudformation','validate-template','--template-body',`file://${path}`]);
  const parameters=Object.entries({BucketName:c.bucket,DomainName:c.domainName??'',CertificateArn:c.certificateArn??'',HostedZoneId:c.hostedZoneId??'',ApiOriginDomain:c.apiOriginDomain??''}).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue}));
  const result=await aws(['cloudformation','create-stack','--stack-name',c.stackName,'--template-body',`file://${path}`,'--parameters',JSON.stringify(parameters),'--tags','Key=Purpose,Value=kinda-static-landing','--enable-termination-protection']);
  return {...result,dns:dnsGuidance(c),next:'Wait for stack-create-complete; copy exact DistributionId and DistributionDomain outputs to config/check before setting DNS and deploying. DNS target is unresolved until stack creation completes.'};
}
const parameters = c => Object.entries({BucketName:c.bucket,DomainName:c.domainName??'',CertificateArn:c.certificateArn??'',HostedZoneId:c.hostedZoneId??'',ApiOriginDomain:c.apiOriginDomain??''}).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue}));
async function activate(c,manifest,aws,dir) {
  const path=join(dir,'template.json');
  const staticSeo=manifest.files.some(file=>file.key==='features.html');
  await writeFile(path,JSON.stringify(createTemplate(manifest.mode,manifest.release,staticSeo)));
  await aws(['cloudformation','validate-template','--template-body',`file://${path}`]);
  try {
    await aws(['cloudformation','update-stack','--stack-name',c.stackName,'--template-body',`file://${path}`,'--parameters',JSON.stringify(parameters(c))]);
    await aws(['cloudformation','wait','stack-update-complete','--stack-name',c.stackName]);
  } catch(error) {
    // An idempotent retry of the exact template still waits for edge propagation.
    if(!/No updates are to be performed/.test(error.message))throw error;
  }
  await aws(['cloudfront','wait','distribution-deployed','--id',c.distributionId]);
  const outputs=await verifyTarget(c,aws);
  if(outputs.DeployMode!==manifest.mode||outputs.ReleaseId!==manifest.release)fail('Activated stack release/mode mismatch');
  const invalidation=await aws(['cloudfront','create-invalidation','--distribution-id',c.distributionId,'--paths','/*']);
  if(!invalidation.Invalidation?.Id)fail('Missing invalidation ID');
  await aws(['cloudfront','wait','invalidation-completed','--distribution-id',c.distributionId,'--id',invalidation.Invalidation.Id]);
  return {invalidationId:invalidation.Invalidation.Id,outputs};
}
export async function runRelease(options,c,aws=awsRunner(c)) {
  const deployMode=parseDeployMode(options.deployMode ?? process.env.WEB_DEPLOY_MODE);
  validateConfig(c,options.mode==='provision',deployMode);
  if(!options.execute)return {mode:options.mode,deployMode,execute:false,target:{accountId:c.accountId,region:c.region,stackName:c.stackName,bucket:c.bucket,distributionId:c.distributionId},release:options.release,dns:dnsGuidance(c),operations:options.mode==='provision'?['verify account/certificate and optional managed Route 53 zone','create dedicated stack']:['rebuild public Web for selected mode (deploy)','verify target and acquire S3 release lock','verify mode and SHA256 archive','publish immutable assets and release HTML','update owned stack routes and API together, wait for propagation','invalidate /* and wait'],note:'Offline plan only; DNS target unresolved until the actual stack output is read. No AWS call or live target verification.'};
  // Fail wrong-mode/stale local artifacts before any AWS call or lock write.
  let candidate=options.mode==='deploy'?await collect(options.dist,options.release,deployMode):undefined;
  const checked=options.mode!=='provision'?await verifyTarget(c,aws):undefined;
  if(options.mode==='check')return {verified:true,deployMode,dns:dnsGuidance(c,checked.DistributionDomain)};
  const dir=await mkdtemp(join(tmpdir(),'kinda-public-'));
  let locked=false,activationStarted=false,completed=false;
  try {
    if(options.mode==='provision')return await provision(c,aws,dir,deployMode);
    if(options.recoverLock) {
      // Recovery is an explicit operator acknowledgement that the previous process
      // stopped. Match both release and ETag; never delete an arbitrary/new lock.
      const old=await head(c,'releases/deployment.lock',aws);
      if(!old?.ETag)fail('No recoverable release lock');
      const oldPath=join(dir,'old-lock.json');
      await aws(['s3api','get-object','--bucket',c.bucket,'--expected-bucket-owner',c.accountId,'--key','releases/deployment.lock',oldPath]);
      if(JSON.parse(await readFile(oldPath,'utf8')).release!==options.recoverLock)fail('Recovery lock release mismatch');
      await aws(['s3api','delete-object','--bucket',c.bucket,'--expected-bucket-owner',c.accountId,'--key','releases/deployment.lock','--if-match',old.ETag]);
    }
    const lock=join(dir,'lock.json');await writeFile(lock,JSON.stringify({release:options.release,mode:options.mode,deployMode,startedAt:new Date().toISOString()}));
    await put(c,'releases/deployment.lock',lock,aws,{immutable:true});locked=true;
    const archive=`releases/${options.release}`;
    let manifest,dist;
    const archived=await head(c,`${archive}/manifest.json`,aws);
    if(options.mode==='deploy'&&!archived) {
      dist=options.dist;manifest=candidate;
      for(const file of manifest.files)await put(c,`${archive}/${file.key}`,join(dist,file.key),aws,{immutable:true,digest:file.sha256});
      const manifestPath=join(dir,'manifest.json');await writeFile(manifestPath,JSON.stringify(manifest,null,2));
      await put(c,`${archive}/manifest.json`,manifestPath,aws,{immutable:true});
    } else {
      dist=join(dir,'restore');await mkdir(dist);
      const manifestPath=join(dir,'manifest.json');
      await aws(['s3api','get-object','--bucket',c.bucket,'--expected-bucket-owner',c.accountId,'--key',`${archive}/manifest.json`,manifestPath]);
      manifest=validateManifest(JSON.parse(await readFile(manifestPath,'utf8')),options.release,deployMode);
      if(candidate&&JSON.stringify(candidate)!==JSON.stringify(manifest))fail('Existing release differs from rebuilt artifact; choose a new release ID or rollback');
      for(const file of manifest.files) {
        const path=join(dist,file.key);await mkdir(dirname(path),{recursive:true});
        await aws(['s3api','get-object','--bucket',c.bucket,'--expected-bucket-owner',c.accountId,'--key',`${archive}/${file.key}`,path]);
      }
    }
    for(const file of manifest.files) {const bytes=await readFile(join(dist,file.key));if(bytes.length!==file.size||hash(bytes)!==file.sha256)fail(`Release integrity mismatch: ${file.key}`);}
    // Verified historical landing archives predate per-route HTML. Only rollback
    // can restore that exact old shape; every new deployment requires all SEO files.
    const legacyLanding=options.mode==='rollback' && deployMode==='landing' && !manifest.files.some(file=>file.key==='features.html');
    await collect(dist,options.release,deployMode,{legacyLanding});
    // Upload all immutable content before opening a route. HTML lives at a release
    // key, so an edge running the old function cannot serve new-mode HTML.
    for(const file of manifest.files) {
      if(file.key===artifactName)continue;
      const key=file.key.startsWith('assets/')?file.key:`published/${options.release}/${file.key}`;
      const existing=await head(c,key,aws);
      if(existing){if(existing.Metadata?.sha256!==file.sha256)fail(`Immutable asset collision: ${key}`);continue;}
      await put(c,key,join(dist,file.key),aws,{immutable:true,digest:file.sha256,cache:file.key.startsWith('assets/')?cacheControl(file.key):'no-store'});
    }
    activationStarted=true;
    const activated=await activate(c,manifest,aws,dir);
    completed=true;
    return {mode:options.mode,deployMode,release:options.release,files:manifest.files.length,invalidationId:activated.invalidationId,dns:dnsGuidance(c,activated.outputs.DistributionDomain)};
  } catch(error) {
    if(activationStarted)error.message+=`; deployment lock retained. After the process has stopped and the stack/distribution are stable, retry or rollback with --recover-lock ${options.release}.`;
    throw error;
  } finally {
    try {
      if(locked&&(!activationStarted||completed))await aws(['s3api','delete-object','--bucket',c.bucket,'--expected-bucket-owner',c.accountId,'--key','releases/deployment.lock']);
    } finally {await rm(dir,{recursive:true,force:true});}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const options=parseArgs(process.argv.slice(2));
    const c=JSON.parse(await readFile(resolve(options.config),'utf8'));
    validateConfig(c,options.mode==='provision',options.deployMode);
    if(options.mode==='deploy'&&options.execute) {
      const build=spawnSync('pnpm',['--filter','@led-control/web','build:public'],{cwd:root,stdio:'inherit',env:{...process.env,WEB_DEPLOY_MODE:options.deployMode}});
      if(build.error)throw build.error;
      if(build.status!==0)fail('Public build failed; no AWS calls performed');
      // The publication CLI always rebuilds. Match that exact fresh artifact to
      // the reviewed landing gate before entering the AWS publication engine.
      if(options.deployMode==='landing') await verifyLandingRelease(root);
    }
    console.log(JSON.stringify(await runRelease(options,c),null,2));
  } catch(error){console.error(error.message);process.exitCode=1;}
}
