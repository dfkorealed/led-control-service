import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { template } from './template.mjs';
import { assertLandingOutput, brandAssets } from '../../apps/web/scripts/static-landing-contract.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const releasePattern=/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const fail=(message)=>{throw new Error(message)};
export function parseArgs(args) {
  const [mode,...rest]=args;
  if(!['provision','check','deploy','rollback'].includes(mode)) fail('Mode must be provision, check, deploy, or rollback');
  const result={mode,execute:false,dist:join(root,'apps/web/dist-landing')};
  for(let i=0;i<rest.length;i++) {
    const flag=rest[i];
    if(flag==='--execute') {if(result.execute)fail('Duplicate --execute');result.execute=true;continue;}
    const key={'--config':'config','--release':'release','--dist':'dist'}[flag];
    if(!key||!rest[i+1]||rest[i+1].startsWith('--')||(key!=='dist'&&result[key]))fail(`Invalid argument: ${flag}`);
    result[key]=rest[++i];
  }
  if(!result.config)fail('Explicit --config is required');
  if(['deploy','rollback'].includes(mode)&&!releasePattern.test(result.release??''))fail('Explicit safe --release is required');
  return result;
}
export function validateConfig(c,provision=false) {
  if(!/^\d{12}$/.test(c.accountId??''))fail('Explicit 12-digit accountId required');
  if(!/^[a-z]{2}-[a-z]+-\d$/.test(c.region??''))fail('Explicit AWS region required');
  // Keep generated CloudFront function/OAC/policy names below their 64-character limit.
  if(!/^kinda-landing-[a-z0-9-]{1,40}$/.test(c.stackName??''))fail('Dedicated stackName must begin kinda-landing- with a 1–40 character suffix');
  if(!/^kinda-landing-[a-z0-9-]{3,49}$/.test(c.bucket??'')||!c.bucket.includes(c.accountId))fail('Dedicated bucket must begin kinda-landing- and include accountId');
  if(!provision&&!/^[A-Z0-9]{5,32}$/.test(c.distributionId??''))fail('Explicit distributionId required');
  if(c.domainName) {
    if(!/^(?!.*(?:example|localhost))([a-z0-9-]+\.)+[a-z]{2,}$/.test(c.domainName))fail('Use exact owned domainName, not an example');
    if(!new RegExp(`^arn:aws:acm:us-east-1:${c.accountId}:certificate/[a-f0-9-]+$`).test(c.certificateArn??''))fail('Existing ACM certificate in us-east-1 in target account required');
    if(!/^Z[A-Z0-9]+$/.test(c.hostedZoneId??''))fail('Explicit existing hostedZoneId required');
  } else if(c.certificateArn||c.hostedZoneId)fail('Domain, certificate and hosted zone must be set together');
  return c;
}
export function cacheControl(key) {return key.startsWith('assets/')?'public,max-age=31536000,immutable':'public,max-age=60,must-revalidate';}
function validKey(key) {
  if(['index.html','404.html'].includes(key))return true;
  if(typeof key!=='string'||key.includes('..')||key.includes('//'))return false;
  if(brandAssets.includes(key))return true;
  return /^assets\/[A-Za-z0-9_./-]+-[A-Za-z0-9_-]{8,}\.(js|css|svg|png|webp|jpg|jpeg|avif|woff2?|gif|ico)$/.test(key);
}
export function validateManifest(m,release) {
  if(m.version!==1||!releasePattern.test(m.release??'')||m.release!==release||!Array.isArray(m.files)||m.files.length<2||m.files.length>10000)fail('Invalid release manifest');
  const keys=new Set();
  for(const f of m.files) {
    if(!validKey(f.key)||keys.has(f.key)||!/^([a-f0-9]{64})$/.test(f.sha256??'')||!Number.isSafeInteger(f.size)||f.size<0)fail(`Unsafe manifest entry: ${f.key}`);
    keys.add(f.key);
  }
  if(!keys.has('index.html')||!keys.has('404.html'))fail('index.html and 404.html required');
  return m;
}
export function makeManifest(release,files){return validateManifest({version:1,release,files},release);}
async function collect(dist,release) {
  const files=[];
  const bundle={};
  async function walk(relative='') {
    for(const entry of await readdir(join(dist,relative),{withFileTypes:true})) {
      const key=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())fail(`Symlink rejected: ${key}`);
      if(entry.isDirectory())await walk(key);
      else if(entry.isFile()){const bytes=await readFile(join(dist,key));files.push({key,sha256:hash(bytes),size:bytes.length});bundle[key]=key.endsWith('.js')?{type:'chunk',code:bytes.toString('utf8')}:{type:'asset',source:bytes};}
      else fail(`Non-file rejected: ${key}`);
    }
  }
  if(!(await lstat(dist)).isDirectory()||(await lstat(dist)).isSymbolicLink())fail('dist must be a real directory');
  await walk();assertLandingOutput(bundle);return makeManifest(release,files.sort((a,b)=>a.key.localeCompare(b.key)));
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
export async function verifyTarget(c,aws) {
  validateConfig(c);await identity(c,aws);
  const s=(await aws(['cloudformation','describe-stacks','--stack-name',c.stackName])).Stacks?.[0];
  const outputs=Object.fromEntries((s?.Outputs??[]).map(o=>[o.OutputKey,o.OutputValue]));
  if(!s?.StackId?.startsWith(`arn:aws:cloudformation:${c.region}:${c.accountId}:stack/${c.stackName}/`)||!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(s.StackStatus)||!s.Tags?.some(t=>t.Key==='Purpose'&&t.Value==='kinda-static-landing')||outputs.BucketName!==c.bucket||outputs.DistributionId!==c.distributionId)fail('Dedicated CloudFormation stack/outputs mismatch');
  const bucketArgs=['--bucket',c.bucket,'--expected-bucket-owner',c.accountId];
  await aws(['s3api','head-bucket',...bucketArgs]);
  const block=(await aws(['s3api','get-public-access-block',...bucketArgs])).PublicAccessBlockConfiguration;
  if(!['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'].every(k=>block?.[k]===true))fail('Bucket public access block mismatch');
  const ownership=(await aws(['s3api','get-bucket-ownership-controls',...bucketArgs])).OwnershipControls;
  if(ownership?.Rules?.[0]?.ObjectOwnership!=='BucketOwnerEnforced')fail('Bucket ownership controls mismatch');
  const d=(await aws(['cloudfront','get-distribution','--id',c.distributionId])).Distribution;
  const origins=d?.DistributionConfig?.Origins?.Items;
  if(d?.ARN!==`arn:aws:cloudfront::${c.accountId}:distribution/${c.distributionId}`||d.Status!=='Deployed'||!d.DistributionConfig.Enabled||origins?.length!==1||origins[0].DomainName!==`${c.bucket}.s3.${c.region}.amazonaws.com`||origins[0].OriginAccessControlId!==outputs.OacId||origins[0].S3OriginConfig?.OriginAccessIdentity!=='')fail('CloudFront dedicated origin/OAC/account mismatch');
  const oac=(await aws(['cloudfront','get-origin-access-control','--id',outputs.OacId])).OriginAccessControl?.OriginAccessControlConfig;
  if(oac?.OriginAccessControlOriginType!=='s3'||oac.SigningBehavior!=='always'||oac.SigningProtocol!=='sigv4')fail('OAC signing configuration mismatch');
  return outputs;
}
const mime=(key)=>({html:'text/html; charset=utf-8',js:'application/javascript',css:'text/css',svg:'image/svg+xml',png:'image/png',webp:'image/webp',jpg:'image/jpeg',jpeg:'image/jpeg',avif:'image/avif',woff:'font/woff',woff2:'font/woff2',gif:'image/gif',ico:'image/x-icon'})[key.split('.').at(-1)]??'application/octet-stream';
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
async function provision(c,aws,dir) {
  validateConfig(c,true);await identity(c,aws);
  // Only create a new dedicated stack. Existing stacks/resources are never adopted or updated.
  try {await aws(['cloudformation','describe-stacks','--stack-name',c.stackName]);fail('Stack already exists; provision never updates resources');}
  catch(error){if(!/Stack .* does not exist/.test(error.message))throw error;}
  if(c.domainName) {
    const cert=(await aws(['acm','describe-certificate','--certificate-arn',c.certificateArn,'--region','us-east-1'])).Certificate;
    const covers=(name)=>name===c.domainName||(name.startsWith('*.')&&c.domainName.split('.').length===name.split('.').length&&c.domainName.endsWith(name.slice(1)));
    if(cert?.Status!=='ISSUED'||!cert.SubjectAlternativeNames?.some(covers))fail('Existing certificate must be ISSUED and cover exact domain');
    const zone=(await aws(['route53','get-hosted-zone','--id',c.hostedZoneId])).HostedZone;
    const zoneName=zone?.Name?.replace(/\.$/,'');
    if(!zoneName||zone.Config?.PrivateZone||!(c.domainName===zoneName||c.domainName.endsWith(`.${zoneName}`)))fail('Hosted zone is not the explicit public parent domain');
    const records=(await aws(['route53','list-resource-record-sets','--hosted-zone-id',c.hostedZoneId,'--start-record-name',c.domainName,'--max-items','10'])).ResourceRecordSets??[];
    if(records.some(r=>r.Name.replace(/\.$/,'')===c.domainName&&['A','AAAA','CNAME'].includes(r.Type)))fail('Domain already has a routing record; will not replace it');
  }
  const path=join(dir,'template.json');await writeFile(path,JSON.stringify(template));
  await aws(['cloudformation','validate-template','--template-body',`file://${path}`]);
  const parameters=Object.entries({BucketName:c.bucket,DomainName:c.domainName??'',CertificateArn:c.certificateArn??'',HostedZoneId:c.hostedZoneId??''}).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue}));
  const result=await aws(['cloudformation','create-stack','--stack-name',c.stackName,'--template-body',`file://${path}`,'--parameters',JSON.stringify(parameters),'--tags','Key=Purpose,Value=kinda-static-landing','--enable-termination-protection']);
  return {...result,next:'Wait for stack-create-complete; copy exact outputs to config before deploying.'};
}
export async function runRelease(options,c,aws=awsRunner(c)) {
  validateConfig(c,options.mode==='provision');
  if(!options.execute)return {mode:options.mode,execute:false,target:{accountId:c.accountId,region:c.region,stackName:c.stackName,bucket:c.bucket,distributionId:c.distributionId},release:options.release,operations:options.mode==='provision'?['verify account/certificate/zone','create dedicated stack']:['verify account/stack/bucket ownership/private access/OAC','acquire exclusive S3 release lock','validate SHA256 archive','upload assets before HTML','invalidate /* and wait'],note:'Offline plan only: no AWS call; live target and build validity are not verified.'};
  if(options.mode!=='provision')await verifyTarget(c,aws);
  if(options.mode==='check')return {verified:true};
  const dir=await mkdtemp(join(tmpdir(),'kinda-landing-'));
  let locked=false;
  try {
    if(options.mode==='provision')return await provision(c,aws,dir);
    const lock=join(dir,'lock.json');await writeFile(lock,JSON.stringify({release:options.release,mode:options.mode,startedAt:new Date().toISOString()}));
    await put(c,'releases/deployment.lock',lock,aws,{immutable:true});locked=true;
    const archive=`releases/${options.release}`;
    let manifest,dist;
    if(options.mode==='deploy') {
      dist=options.dist;manifest=await collect(dist,options.release);
      if(await head(c,`${archive}/manifest.json`,aws))fail('Release already exists; use rollback or a new release ID');
      for(const file of manifest.files)await put(c,`${archive}/${file.key}`,join(dist,file.key),aws,{immutable:true,digest:file.sha256});
      const manifestPath=join(dir,'manifest.json');await writeFile(manifestPath,JSON.stringify(manifest,null,2));
      // Publish the archive manifest only after every file exists; incomplete releases cannot roll back.
      await put(c,`${archive}/manifest.json`,manifestPath,aws,{immutable:true});
    } else {
      dist=join(dir,'restore');await mkdir(dist);
      const manifestPath=join(dir,'manifest.json');
      await aws(['s3api','get-object','--bucket',c.bucket,'--expected-bucket-owner',c.accountId,'--key',`${archive}/manifest.json`,manifestPath]);
      manifest=validateManifest(JSON.parse(await readFile(manifestPath,'utf8')),options.release);
      for(const file of manifest.files) {
        const path=join(dist,file.key);await mkdir(dirname(path),{recursive:true});
        await aws(['s3api','get-object','--bucket',c.bucket,'--expected-bucket-owner',c.accountId,'--key',`${archive}/${file.key}`,path]);
      }
    }
    // Recheck all bytes before the first public write, including locally rebuilt/mutated files.
    for(const file of manifest.files) {const bytes=await readFile(join(dist,file.key));if(bytes.length!==file.size||hash(bytes)!==file.sha256)fail(`Release integrity mismatch: ${file.key}`);}
    // Apply the Web public artifact gate to both new builds and restored archives.
    await collect(dist,options.release);
    const ordered=[...manifest.files].sort((a,b)=>Number(a.key.endsWith('.html'))-Number(b.key.endsWith('.html'))||Number(a.key==='index.html')-Number(b.key==='index.html'));
    for(const file of ordered) {
      const immutable=file.key.startsWith('assets/');
      const existing=immutable?await head(c,file.key,aws):null;
      if(existing){if(existing.Metadata?.sha256!==file.sha256)fail(`Immutable asset collision: ${file.key}`);continue;}
      await put(c,file.key,join(dist,file.key),aws,{immutable,digest:file.sha256,cache:cacheControl(file.key)});
    }
    // A wildcard also evicts cached missing-asset errors and both original and rewritten page keys.
    const invalidation=await aws(['cloudfront','create-invalidation','--distribution-id',c.distributionId,'--paths','/*']);
    if(!invalidation.Invalidation?.Id)fail('Missing invalidation ID');
    await aws(['cloudfront','wait','invalidation-completed','--distribution-id',c.distributionId,'--id',invalidation.Invalidation.Id]);
    return {mode:options.mode,release:options.release,files:manifest.files.length,invalidationId:invalidation.Invalidation.Id};
  } finally {
    // Only the process that acquired the conditional lock may release it. Crash recovery is manual.
    try {
      if(locked)await aws(['s3api','delete-object','--bucket',c.bucket,'--expected-bucket-owner',c.accountId,'--key','releases/deployment.lock']);
    } finally {await rm(dir,{recursive:true,force:true});}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {const options=parseArgs(process.argv.slice(2));const c=JSON.parse(await readFile(resolve(options.config),'utf8'));console.log(JSON.stringify(await runRelease(options,c),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
