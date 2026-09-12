import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, cp, lchmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { fixture, policyHash } from './gateway-appliance-fixture.mjs';

const state = path.join(import.meta.dirname, 'gateway-appliance-state.sh');
const release = path.join(import.meta.dirname, 'gateway-appliance-release.sh');
const common = path.join(import.meta.dirname, 'gateway-appliance-common.sh');
const roots = ['factory-trust', 'gateway', 'identity', 'mesh'];
const sha = value => createHash('sha256').update(value).digest('hex');
const ok = result => assert.equal(result.status, 0, result.stderr || String(result.error));
const bad = (result, code = 1) => assert.equal(result.status, code, result.stdout + result.stderr);
const exists = async file => lstat(file).then(() => true, () => false);
const realOpenSSL = spawnSync('/bin/sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).stdout.trim();
const realMktemp = spawnSync('/bin/sh', ['-c', 'command -v mktemp'], { encoding: 'utf8' }).stdout.trim();
const created = '2026-09-12T00:00:00Z';

// Expectations are derived from real lstat/readlink/bytes, not the shell manifest.
async function entries(directory, readBodies = true) {
  const result = [];
  async function walk(relative) {
    const file = path.join(directory, relative), info = await lstat(file);
    const type = info.isSymbolicLink() ? 'l' : info.isDirectory() ? 'd' : 'f';
    result.push({ name: relative, type, mode: (info.mode & 0o7777).toString(8).padStart(4, '0'),
      uid: info.uid, gid: info.gid, size: type === 'f' ? info.size : 0,
      content: type === 'f' && readBodies ? await readFile(file) : Buffer.alloc(0),
      target: type === 'l' ? await readlink(file) : '-' });
    if (type === 'd') for (const name of (await readdir(file)).sort()) await walk(`${relative}/${name}`);
  }
  for (const root of roots) await walk(root);
  return result.sort((a,b) => a.name < b.name ? -1 : 1);
}
function manifest(records, id, timestamp = created) {
  return `led-control-gateway-state/v1|${id}|${timestamp}\n` + records.map(e =>
    `${e.name}|${e.type}|${e.mode}|${e.uid}|${e.gid}|${e.size}|${e.type === 'f' ? e.digest ?? sha(e.content) : '-'}|${e.target}\n`).join('');
}
async function fileSha(file) {const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function snapshot(directory) {
  return Promise.all((await entries(directory,false)).map(async({content,...e})=>({...e,hash:e.type==='f'?await fileSha(path.join(directory,e.name)):sha(content)})));
}
// An independent USTAR writer makes malicious *archive bytes*, including types
// that filesystem tar creation refuses. No plaintext tar file is ever written.
function archiveHeader(e) {
    const header=Buffer.alloc(512), content=e.content || Buffer.alloc(0);
    const field=(at,length,value)=>header.write(value,at,length,'ascii');
    const octal=(at,length,value)=>field(at,length,Number(value).toString(8).padStart(length-1,'0')+'\0');
    field(0,100,e.name); octal(100,8,parseInt(e.mode,8)); octal(108,8,e.uid); octal(116,8,e.gid);
    octal(124,12,e.sizeOverride ?? (e.type==='f'?e.zeroBytes??content.length:0)); octal(136,12,1);
    header.fill(32,148,156); field(156,1,({f:'0',d:'5',l:'2'})[e.type] || e.type);
    if(e.target!=='-')field(157,100,e.target);
    field(257,6,'ustar\0');field(263,2,'00');
    field(148,8,[...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ');
    return header;
}
function* archiveChunks(records, text, trailingBytes = 0) {
  const all = [{name:'manifest.state',type:'f',mode:'0600',uid:process.getuid(),gid:process.getgid(),content:Buffer.from(text),target:'-'}, ...records];
  const zeros=Buffer.alloc(65536);
  for(const e of all) {
    yield archiveHeader(e);
    const length=e.zeroBytes??e.content?.length??0;
    if(e.zeroBytes!==undefined)for(let remaining=length;remaining>0;remaining-=Math.min(remaining,zeros.length))yield zeros.subarray(0,Math.min(remaining,zeros.length));
    else yield e.content||Buffer.alloc(0);
    yield Buffer.alloc((512-length%512)%512);
  }
  yield Buffer.alloc(1024);
  for(let remaining=trailingBytes;remaining>0;remaining-=Math.min(remaining,zeros.length))yield zeros.subarray(0,Math.min(remaining,zeros.length));
}
function archive(records,text) {return Buffer.concat([...archiveChunks(records,text)]);}

async function setup(t, bundleOptions) {
  let workspaceLog;
  // Observe actual mktemp results (not substituted paths), including workspaces
  // outside this fixture once production ignores ambient TMPDIR. Cleanup only
  // the exact directories created by this test's mktemp process.
  t.after(async()=>{
    if(!workspaceLog)return;
    const observed=await readFile(workspaceLog,'utf8').catch(()=>'');
    for(const directory of observed.trim().split('\n').filter(Boolean)) {
      if(!/^\.gateway-state\.[A-Za-z0-9]+$/.test(path.basename(directory)))continue;
      const info=await lstat(directory).catch(()=>null);
      if(info?.isDirectory()&&!info.isSymbolicLink()) {spawnSync('chmod',['-R','u+w',directory]);await rm(directory,{recursive:true});}
    }
  });
  const h=await fixture(t), a=await h.bundle('a',bundleOptions);
  workspaceLog=h.config+'.workspaces';
  await writeFile(path.join(h.bin,'mktemp'),`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');const p=cp.spawnSync(${JSON.stringify(realMktemp)},process.argv.slice(2),{encoding:'utf8'});if(p.status===0&&/^\\.gateway-state\\.[A-Za-z0-9]+$/.test(path.basename(p.stdout.trim())))fs.appendFileSync(${JSON.stringify(workspaceLog)},p.stdout);process.stdout.write(p.stdout);process.stderr.write(p.stderr);process.exit(p.status??1);\n`,{mode:0o755});
  const data=path.join(h.root,'data'), scratch=path.join(h.temp,'scratch'); await mkdir(scratch,{mode:0o700});
  await mkdir(path.join(h.root,'releases')); await cp(a.dir,path.join(h.root,'releases',a.id),{recursive:true});
  await symlink(`releases/${a.id}`,path.join(h.root,'current'));
  await writeFile(h.config+'.active',a.tag);await writeFile(h.config+'.owner','gateway');await writeFile(h.config+'.active.image',a.manifest.image.descriptorDigest??a.manifest.image.configDigest);
  for (const kind of ['device','mqtt']) {
    for (const generation of ['factory','retired']) {
      const dir=path.join(data,'identity',kind,'generations',generation);await mkdir(dir,{recursive:true,mode:0o750});
      const names=kind==='device'?['device.key','device.crt','device-ca.crt','api-ca.crt','mqtt-ca.crt']:['gateway.key','gateway.crt','mqtt-ca.crt'];
      for(const name of names)await writeFile(path.join(dir,name),`private-state-fixture-${kind}-${generation}-${name}\n`,{mode:name.endsWith('.key')?0o600:0o644});
    }
    if(kind==='mqtt')await symlink('generations/factory',path.join(data,'identity',kind,'current'));
  }
  for(const e of await entries(data))if(e.type==='d' && e.name.startsWith('identity'))await chmod(path.join(data,e.name),0o750);
  // Linux symlinks are always 0777. Darwin applies umask, so explicitly model
  // the production filesystem semantics, while still creating actual links.
  if(process.platform==='darwin') {
    for(const e of await entries(data))if(e.type==='l')await lchmod(path.join(data,e.name),0o777);
    await writeFile(path.join(h.bin,'ln'),'#!/bin/bash\n/bin/ln "$@" || exit $?\n/bin/chmod -h 777 "${@: -1}"\n',{mode:0o755});
  }
  for(const name of ['command-journal.json','provisioning-device-journal.json','state-event-outbox.json','state-event-outbox.json.manifest.json','automation-state.json','automation-telemetry.json','automation-telemetry.json.manifest.json','mesh-addresses.json'])
    await writeFile(path.join(data,'gateway',name),`backed-up-${name}\n`,{mode:0o600});
  await writeFile(path.join(data,'mesh','node.json'),'mesh fixture\n',{mode:0o600});
  const cert=path.join(h.temp,'recipient.crt'), key=path.join(h.temp,'recipient.key');
  ok(spawnSync(realOpenSSL,['req','-x509','-newkey','rsa:2048','-noenc','-subj','/CN=ephemeral-state-test','-days','1','-keyout',key,'-out',cert],{encoding:'utf8'}));
  await chmod(key,0o600);
  // GNU dd full-block/count-bytes semantics, using actual pipe reads on macOS.
  // Production uses GNU coreutils; this test-only C boundary never parses tar.
  const code='#include <unistd.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <fcntl.h>\n#include <errno.h>\nint main(int n,char**v){long long bs=512,count=1;int bytes=0,out=1;for(int i=1;i<n;i++){if(!strncmp(v[i],"bs=",3))bs=atoll(v[i]+3);if(!strncmp(v[i],"count=",6))count=atoll(v[i]+6);if(strstr(v[i],"count_bytes"))bytes=1;if(!strncmp(v[i],"of=",3))out=open(v[i]+3,O_WRONLY|O_CREAT|O_TRUNC,0600);}long long left=bytes?count:bs*count;char b[65536];while(left>0){ssize_t x=read(0,b,left<65536?left:65536);if(x<0&&errno==EINTR)continue;if(x<0)return 1;if(!x)break;long y=0;while(y<x){ssize_t z=write(out,b+y,x-y);if(z<=0)return 1;y+=z;}left-=x;}return 0;}\n';
  if(process.platform==='darwin')ok(spawnSync('cc',['-x','c','-o',path.join(h.bin,'dd'),'-'],{input:code,encoding:'utf8'}));
  await writeFile(path.join(h.bin,'openssl'),`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const c=JSON.parse(fs.readFileSync(process.env.RELEASE_SHIM_CONFIG));if(c.failEncrypt&&process.argv.includes('-encrypt'))process.exit(1);if(c.truncateSecondDecrypt&&process.argv.includes('-decrypt')){const f=process.env.RELEASE_SHIM_CONFIG+'.decrypt-count';const n=fs.existsSync(f)?Number(fs.readFileSync(f))+1:1;fs.writeFileSync(f,String(n));if(n===2){const p=cp.spawnSync(${JSON.stringify(realOpenSSL)},process.argv.slice(2));process.stdout.write(p.stdout.subarray(0,1024));process.exit(p.status??1);}}const p=cp.spawnSync(${JSON.stringify(realOpenSSL)},process.argv.slice(2),{stdio:'inherit'});process.exit(p.status??1);\n`,{mode:0o755});
  const env={...h.env,TMPDIR:scratch};
  let testedState=state;
  const args=(command,backup,extra=[])=>[testedState,command,backup,'--recipient',cert,...(command==='backup'?[]:['--key',key]),...(['backup','restore'].includes(command)?['--policy-sha256',policyHash,'--test-root',h.root]:[]),...extra];
  const run=(command,backup,extra=[])=>spawnSync('/bin/bash',args(command,backup,extra),{env,encoding:'utf8',timeout:30000});
  async function useBudgetProfile() {
    // The initial RED used the actual 4097-entry/512MiB boundaries. Keep CI fast
    // by changing literals in an owned disposable copy, never production or its
    // environment. Assert every exact production constant before the same parser
    // runs with smaller equivalent budgets; framing remains real 512-byte USTAR.
    let source=await readFile(state,'utf8');
    for(const [name,production,fixtureValue] of [
      ['ENTRIES',4096,64],['FILE_BYTES',268435456,256*1024],['TOTAL_BYTES',536870912,512*1024],
      ['MANIFEST_BYTES',16777216,16*1024],['TRAILER_BYTES',10240,10240],['CIPHERTEXT_BYTES',570425344,1024*1024],
    ]) {
      const literal=`readonly MAX_STATE_${name}=${production}`;
      assert.equal(source.split(literal+'\n').length,2,`fixed production ${name} budget must remain explicit and unique`);
      source=source.replace(literal,`readonly MAX_STATE_${name}=${fixtureValue}`);
    }
    assert.ok(source.includes('readonly MAX_STATE_FRAMING_BYTES=$((MAX_STATE_ENTRIES * (512 + 511) + 2 * 512 + MAX_STATE_TRAILER_BYTES))'));
    assert.ok(source.includes('readonly MAX_STATE_ARCHIVE_BYTES=$((MAX_STATE_TOTAL_BYTES + MAX_STATE_FRAMING_BYTES))'));
    const directory=await mkdtemp(path.join(h.temp,'budget-parser-'));
    testedState=path.join(directory,'gateway-appliance-state.sh');
    await writeFile(testedState,source,{mode:0o700});await copyFile(common,path.join(directory,'gateway-appliance-common.sh'));
  }
  async function finishArtifact(backup) {
    const cipher=path.join(backup,'state.cms'),digest=await fileSha(cipher),size=(await lstat(cipher)).size;
    const der=spawnSync(realOpenSSL,['x509','-in',cert,'-outform','DER']).stdout;
    const outer=`CIPHERTEXT=state.cms\nCIPHERTEXT_SHA256=${digest}\nCIPHERTEXT_SIZE=${size}\nCREATED_AT=${created}\nENCRYPTION=openssl-cms-aes-256-cbc-rsa/v1\nRECIPIENT_SHA256=${sha(der)}\nRELEASE_ID=${a.id}\nSCHEMA=led-control-gateway-backup/v1\n`;
    await writeFile(path.join(backup,'backup.env'),outer);await writeFile(path.join(backup,'checksums.sha256'),`${sha(outer)}  backup.env\n${digest}  state.cms\n`);
    return backup;
  }
  async function artifact(records,text,bytes) {
    const backup=path.join(h.temp,`crafted-${Math.random().toString(16).slice(2)}`);await mkdir(backup,{mode:0o700});
    const cipher=path.join(backup,'state.cms');
    const encrypted=spawnSync(realOpenSSL,['cms','-encrypt','-binary','-aes-256-cbc','-outform','DER','-stream','-out',cipher,cert],{input:bytes??archive(records,text??manifest(records,a.id))});
    assert.equal(encrypted.status,0,'ephemeral CMS fixture encryption failed');
    return finishArtifact(backup);
  }
  async function streamArtifact(records,text=manifest(records,a.id),trailingBytes=0) {
    const backup=await mkdtemp(path.join(h.temp,'streamed-'));
    const child=spawn(realOpenSSL,['cms','-encrypt','-binary','-aes-256-cbc','-outform','DER','-stream','-out',path.join(backup,'state.cms'),cert],{stdio:['pipe','ignore','ignore']});
    const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    await pipeline(Readable.from(archiveChunks(records,text,trailingBytes)),child.stdin);
    assert.equal(await closed,0,'ephemeral streaming CMS encryption failed');return finishArtifact(backup);
  }
  async function traceArchiveIo() {
    const log=path.join(h.temp,'archive-io.log');
    for(const name of ['dd','mkdir']) {
      let actual=spawnSync('/bin/sh',['-c',`command -v ${name}`],{encoding:'utf8'}).stdout.trim();
      if(await exists(path.join(h.bin,name))) {actual=path.join(h.bin,name+'.actual');await rename(path.join(h.bin,name),actual);}
      await writeFile(path.join(h.bin,name),`#!/bin/bash\nif [ ${name} = mkdir ]; then printf 'mkdir|%s\\n' "\${@: -1}" >> '${log}'; else for arg in "$@"; do case "$arg" in of=*) printf 'dd|%s\\n' "\${arg#of=}" >> '${log}';; esac; done; fi\nexec '${actual}' "$@"\n`,{mode:0o755});
    }
    return async()=>readFile(log,'utf8').then(s=>s.trim().split('\n').filter(Boolean),()=>[]);
  }
  const workspaces=async()=>readFile(workspaceLog,'utf8').then(s=>s.trim().split('\n').filter(Boolean),()=>[]);
  const clean=async()=>{for(const directory of await workspaces())assert.equal(await exists(directory),false,'all disposable plaintext removed');assert.deepEqual(await readdir(scratch),[]);};
  return {...h,a,data,cert,key,env,run,useBudgetProfile,args,artifact,streamArtifact,finishArtifact,traceArchiveIo,clean,workspaces,backup:path.join(h.temp,'backup')};
}

test('common library sourcing does not change shell options, traps, positional args or caller globals',()=>{
  const result=spawnSync('/bin/bash',['-c','library=$1; set -- unchanged; ROOT=caller; before=$(set +o); trap : EXIT; prior=$(trap -p); source "$library" || exit 99; [ "$before" = "$(set +o)" ] && [ "$prior" = "$(trap -p)" ] && [ "$ROOT" = caller ] && [ "$1" = unchanged ]','test',common],{encoding:'utf8'});
  ok(result);
});
const MiB=1024*1024,zeroDigests=new Map();
function zeroRecord(name,size) {
  if(!zeroDigests.has(size)) {const hash=createHash('sha256'),chunk=Buffer.alloc(65536);for(let remaining=size;remaining>0;remaining-=Math.min(remaining,chunk.length))hash.update(chunk.subarray(0,Math.min(remaining,chunk.length)));zeroDigests.set(size,hash.digest('hex'));}
  return {name,type:'f',mode:'0600',uid:process.getuid(),gid:process.getgid(),size,zeroBytes:size,digest:zeroDigests.get(size),content:Buffer.alloc(0),target:'-'};
}
const sortedRecords=records=>records.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
for(const kind of ['unique directories','zero-size files','duplicate final entry'])test(`state budget caps entry+1 ${kind} before excess filesystem work (fixed 4096 production profile)`,async t=>{
  const h=await setup(t),before=await snapshot(h.data),records=await entries(h.data),calls=await h.traceArchiveIo();
  await h.useBudgetProfile();
  for(let index=records.length;index<64;index++)records.push({name:`mesh/zz-quota-${String(index).padStart(5,'0')}`,type:kind==='zero-size files'?'f':'d',mode:kind==='zero-size files'?'0600':'0750',uid:process.getuid(),gid:process.getgid(),size:0,content:Buffer.alloc(0),target:'-'});
  sortedRecords(records);if(kind==='duplicate final entry')records[records.length-1]={...records.at(-2)};
  assert.equal(records.length+1,65,'manifest is one nonzero archive header');
  const result=h.run('verify',await h.artifact(records));
  const io=await calls(),suffix='/first/'+records.at(-1).name;
  if(kind!=='duplicate final entry')assert.equal(io.some(line=>line.endsWith(suffix)),false,'cap+1 must be rejected before mkdir/dd');
  else assert.equal(io.filter(line=>line.endsWith(suffix)).length,1,'duplicate is never created twice');
  bad(result);
  if(kind==='unique directories')ok(h.run('verify',await h.artifact(records.slice(0,-1))));
  await h.clean();assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);
});
test('state budget rejects a per-file+1 header before opening its output (fixed 256MiB production profile)',async t=>{
  const h=await setup(t),before=await snapshot(h.data),records=await entries(h.data),calls=await h.traceArchiveIo();
  await h.useBudgetProfile();
  // No huge plaintext fixture is needed: the advertised size must be rejected
  // before dd even when the encrypted stream is then truncated. The old parser
  // opened the output and only rejected after consuming the remaining stream.
  records.push({...zeroRecord('gateway/zz-oversize',0),sizeOverride:256*1024+1});sortedRecords(records);
  const result=h.run('restore',await h.artifact(records));
  assert.equal((await calls()).some(line=>line.endsWith('/first/gateway/zz-oversize')),false,'oversized header must not reach dd');
  bad(result);await h.clean();assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);
});
for(const excess of [0,1])test(`state budget ${excess?'rejects aggregate+1':'accepts exact aggregate'} including manifest (fixed 512MiB production profile)`,async t=>{
  const h=await setup(t),before=await snapshot(h.data),records=await entries(h.data),calls=await h.traceArchiveIo();
  await h.useBudgetProfile();
  const existing=records.reduce((sum,e)=>sum+(e.type==='f'?e.size:0),0);
  const first=zeroRecord('gateway/zz-budget-a',256*1024),second={...first,name:'gateway/zz-budget-b'};
  records.push(first,second);sortedRecords(records);
  const remainder=512*1024+excess-existing-first.size-Buffer.byteLength(manifest(records,h.a.id));
  Object.assign(second,zeroRecord(second.name,remainder));const text=manifest(records,h.a.id);
  assert.equal(records.reduce((sum,e)=>sum+(e.type==='f'?e.size:0),Buffer.byteLength(text)),512*1024+excess);
  const result=h.run(excess?'restore':'verify',await h.streamArtifact(records,text));
  if(excess) {assert.equal((await calls()).some(line=>line.endsWith('/first/mesh/node.json')),false,'aggregate cap is checked before the crossing payload');bad(result);}else ok(result);
  await h.clean();assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);
});
test('state budget preserves 64MiB automation outbox/reserve and 100MiB state-event outbox operating capacity',async t=>{
  const h=await setup(t),before=await snapshot(h.data),records=await entries(h.data);
  for(const [name,size] of [['automation-telemetry.json',64*MiB],['automation-telemetry.json.reserve',64*MiB],['state-event-outbox.json',100*MiB]]) {
    const replacement=zeroRecord('gateway/'+name,size),at=records.findIndex(e=>e.name===replacement.name);if(at<0)records.push(replacement);else records[at]=replacement;
  }
  const backup=await h.streamArtifact(sortedRecords(records));ok(h.run('verify',backup));ok(h.run('drill',backup));
  await h.clean();assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);
});
for(const trailingBytes of [10240,10241])test(`state budget ${trailingBytes===10240?'accepts':'rejects'} ${trailingBytes} trailing zero bytes after two end blocks`,async t=>{
  const h=await setup(t),before=await snapshot(h.data),records=await entries(h.data),backup=await h.streamArtifact(records,manifest(records,h.a.id),trailingBytes);
  const result=h.run('verify',backup);if(trailingBytes===10240)ok(result);else bad(result);
  await h.clean();assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);
});
test('state budget rejects outer ciphertext+1 before copying or decrypting it (fixed 544MiB production profile)',async t=>{
  const h=await setup(t),before=await snapshot(h.data),backup=await h.artifact(await entries(h.data)),calls=await h.traceArchiveIo();
  await h.useBudgetProfile();
  const file=await open(path.join(backup,'state.cms'),'r+');try{await file.truncate(MiB+1);}finally{await file.close();}await h.finishArtifact(backup);
  bad(h.run('restore',backup));assert.deepEqual(await calls(),[],'outer size is checked before extraction workspace/payload creation');
  await h.clean();assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);
});
for(const boundary of ['entry count','per-file bytes','aggregate bytes'])test(`state budget rejects producer ${boundary} before quiesce without removing state`,async t=>{
  const h=await setup(t);
  await h.useBudgetProfile();
  if(boundary==='entry count')for(let index=(await entries(h.data)).length;index<64;index++)await mkdir(path.join(h.data,'mesh',`zz-quota-${index}`),{mode:0o750});
  else for(const [index,size] of (boundary==='per-file bytes'?[256*1024+1]:[256*1024,256*1024]).entries()) {const file=await open(path.join(h.data,'gateway',`zz-quota-${index}`),'wx',0o600);try{await file.truncate(size);}finally{await file.close();}}
  const before=await snapshot(h.data);await h.set({failStop:true});bad(h.run('backup',h.backup));
  assert.equal((await h.events()).some(e=>e.name==='docker'&&e.args.includes('stop')),false,'budget validation must precede quiesce');
  assert.equal(await exists(h.backup),false);assert.deepEqual(await snapshot(h.data),before);await h.clean();
});
test('the advertised RSA recipient profile rejects a non-RSA certificate before runtime access',async(t)=>{
  const h=await setup(t);
  ok(spawnSync(realOpenSSL,['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-noenc','-subj','/CN=ephemeral-ec','-days','1','-keyout',h.key,'-out',h.cert],{encoding:'utf8'}));
  bad(h.run('backup',h.backup));assert.deepEqual(await h.events(),[]);await h.clean();
});
test('backup is encrypted, binds the exact release and recipient, and round-trips all roots',async(t)=>{
  const h=await setup(t),before=await snapshot(h.data);ok(h.run('backup',h.backup));
  assert.deepEqual((await readdir(h.backup)).sort(),['backup.env','checksums.sha256','state.cms']);
  const outer=await readFile(path.join(h.backup,'backup.env'),'utf8');assert.match(outer,new RegExp(`RELEASE_ID=${h.a.id}`));
  const der=spawnSync(realOpenSSL,['x509','-in',h.cert,'-outform','DER']).stdout;assert.match(outer,new RegExp(`RECIPIENT_SHA256=${sha(der)}`));
  assert.equal(await readFile(h.config+'.active','utf8'),h.a.tag);await h.clean();
  const trace=(await h.events()).length,site=await readFile(path.join(h.root,'.env.appliance'));
  ok(h.run('verify',h.backup));ok(h.run('drill',h.backup));
  assert.equal((await h.events()).length,trace);assert.deepEqual(await snapshot(h.data),before);assert.deepEqual(await readFile(path.join(h.root,'.env.appliance')),site);await h.clean();
  await writeFile(path.join(h.data,'gateway/command-journal.json'),'live-newer\n');ok(h.run('restore',h.backup));
  assert.deepEqual(await snapshot(h.data),before);assert.equal(await exists(path.join(h.root,'.state.journal')),false);
  assert.deepEqual((await readdir(h.data)).sort(),roots);await h.clean();
});
test('Docker 29 state backup and restore use the bound daemon identity without changing config provenance',async(t)=>{
  const h=await setup(t,{descriptor:true}), before=await snapshot(h.data);
  ok(h.run('backup',h.backup));ok(h.run('verify',h.backup));ok(h.run('drill',h.backup));
  await writeFile(path.join(h.data,'gateway/command-journal.json'),'live-newer\n');ok(h.run('restore',h.backup));
  assert.deepEqual(await snapshot(h.data),before);
  assert.equal(await readFile(h.config+'.active.image','utf8'),h.a.manifest.image.descriptorDigest);await h.clean();
});
test('independently encrypted USTAR payload verifies and drill never touches an appliance root',async(t)=>{
  const h=await setup(t),records=await entries(h.data),backup=await h.artifact(records),before=await snapshot(h.data);
  ok(h.run('verify',backup));ok(h.run('drill',backup));assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);await h.clean();
});

for(const mutation of ['cipher','outer','extra','missing','wrong-key','wrong-cert'])test(`verify rejects ${mutation} before Docker or live mutation`,async(t)=>{
  const h=await setup(t),backup=await h.artifact(await entries(h.data)),before=await snapshot(h.data);
  if(mutation==='cipher')await writeFile(path.join(backup,'state.cms'),'tampered');
  if(mutation==='outer')await writeFile(path.join(backup,'backup.env'),'SCHEMA=bad\n');
  if(mutation==='extra')await writeFile(path.join(backup,'extra'),'extra');
  if(mutation==='missing')await rm(path.join(backup,'checksums.sha256'));
  if(mutation.startsWith('wrong')) {
    const key=path.join(h.temp,'wrong.key'),cert=path.join(h.temp,'wrong.crt');
    ok(spawnSync(realOpenSSL,['req','-x509','-newkey','rsa:2048','-noenc','-subj','/CN=wrong-ephemeral','-days','1','-keyout',key,'-out',cert],{encoding:'utf8'}));
    await copyFile(mutation==='wrong-key'?key:cert,mutation==='wrong-key'?h.key:h.cert);
  }
  bad(h.run('restore',backup));assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);await h.clean();
});
const attacks={
  traversal:e=>{e[0].name='../outside';}, absolute:e=>{e[0].name='/outside';},
  hardlink:e=>{e[0].type='1';e[0].target='gateway/command-journal.json';},
  fifo:e=>{e[0].type='6';},device:e=>{e[0].type='3';},socket:e=>{e[0].type='s';},
  external:e=>{e.find(x=>x.type==='l').target='/outside';},escaping:e=>{e.find(x=>x.type==='l').target='../../gateway';},
  duplicate:e=>{e.splice(1,0,{...e[0]});}, extra:e=>{e.push({...e.at(-1),name:'mesh/extra'});},
  missing:e=>{e.pop();},hash:e=>{e.find(x=>x.name==='gateway/command-journal.json').content=Buffer.from('tampered\n');},
  mode:e=>{e.find(x=>x.name==='gateway/command-journal.json').mode='0640';},
  writable:e=>{e.find(x=>x.name==='gateway/command-journal.json').mode='0666';},
  emptykey:e=>{const x=e.find(x=>x.name.endsWith('device.key'));x.content=Buffer.alloc(0);x.size=0;},
  emptycert:e=>{const x=e.find(x=>x.name==='identity/mqtt/generations/factory/gateway.crt');x.content=Buffer.alloc(0);x.size=0;},
  absentkey:e=>{e.splice(e.findIndex(x=>x.name==='identity/device/generations/factory/device.key'),1);},
  absentcert:e=>{e.splice(e.findIndex(x=>x.name==='identity/mqtt/generations/factory/gateway.crt'),1);},
  badkeymode:e=>{e.find(x=>x.name.endsWith('device.key')).mode='0644';},
  identitymode:e=>{e.find(x=>x.name==='identity').mode='0755';},
  generationmode:e=>{e.find(x=>x.name==='identity/device/generations/factory').mode='0700';},
  badcurrent:e=>{e.find(x=>x.name==='identity/device/current').target='generations/missing';}
};
for(const [name,mutate] of Object.entries(attacks))test(`archive ${name} is rejected before live mutation and plaintext is cleaned`,async(t)=>{
  const h=await setup(t),records=await entries(h.data),text=manifest(records,h.a.id),before=await snapshot(h.data);mutate(records);
  // Invalid identity is also rejected when its malicious metadata is self-consistent.
  const selfConsistent=['emptykey','emptycert','absentkey','absentcert','badkeymode','identitymode','generationmode','badcurrent','writable'].includes(name);
  const backup=await h.artifact(records,selfConsistent?manifest(records,h.a.id):text);
  bad(h.run('restore',backup));assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);await h.clean();
});
for(const name of ['duplicate','missing','size'])test(`inner manifest ${name} mismatch is rejected`,async(t)=>{
  const h=await setup(t),records=await entries(h.data);let text=manifest(records,h.a.id);const lines=text.trimEnd().split('\n');
  if(name==='duplicate')lines.push(lines[1]);if(name==='missing')lines.pop();if(name==='size')lines[1]=lines[1].replace('|0|-|','|1|-|');
  bad(h.run('verify',await h.artifact(records,lines.join('\n')+'\n')));await h.clean();
});
for(const command of ['backup','restore'])test(`${command} stop failure preserves state and creates no backup or swap`,async(t)=>{
  const h=await setup(t),before=await snapshot(h.data),backup=command==='restore'?await h.artifact(await entries(h.data)):h.backup;
  await h.set({failStop:true});bad(h.run(command,backup));assert.deepEqual(await snapshot(h.data),before);
  if(command==='backup')assert.equal(await exists(backup),false);await h.clean();
});
test('backup encryption failure restarts the original state and leaves no output or plaintext',async(t)=>{
  const h=await setup(t);await h.set({failEncrypt:true});bad(h.run('backup',h.backup));
  assert.equal(await readFile(h.config+'.active','utf8'),h.a.tag);assert.equal(await exists(h.backup),false);await h.clean();
});
test('backup restart and recovery failure are distinct, retain a journal, and recover before new work',async(t)=>{
  const h=await setup(t);await h.set({failUp:h.a.tag});bad(h.run('backup',h.backup),3);
  assert.equal(await exists(h.backup),false);assert.equal(await exists(path.join(h.root,'.state.journal')),true);await h.clean();
  await h.set({failUp:''});await mkdir(h.backup);bad(h.run('backup',h.backup));
  assert.equal(await exists(path.join(h.root,'.state.journal')),false);assert.equal(await readFile(h.config+'.active','utf8'),h.a.tag);await h.clean();
});
test('drill validates the second real decryption independently and cleans both extractions on truncation',async(t)=>{
  const h=await setup(t),backup=await h.artifact(await entries(h.data)),before=await snapshot(h.data);await h.set({truncateSecondDecrypt:true});
  bad(h.run('drill',backup));assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);await h.clean();
});
test('a pending activation journal blocks backup without Docker or state mutation',async(t)=>{
  const h=await setup(t),before=await snapshot(h.data);await writeFile(path.join(h.root,'.activation.journal'),'pending');
  bad(h.run('backup',h.backup));assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);await h.clean();
});
for(const root of roots)test(`restore rolls back a partial swap at ${root}`,async(t)=>{
  const h=await setup(t),backup=await h.artifact(await entries(h.data));await writeFile(path.join(h.data,'gateway/command-journal.json'),'live-newer\n');const before=await snapshot(h.data);
  await h.set({failSwap:root});bad(h.run('restore',backup));assert.deepEqual(await snapshot(h.data),before);
  assert.equal(await exists(path.join(h.root,'.state.journal')),false);assert.equal(await readFile(h.config+'.active','utf8'),h.a.tag);await h.clean();
});
test('unhealthy restore recovers all old roots and recovery restart failure retains the journal',async(t)=>{
  const h=await setup(t),backup=await h.artifact(await entries(h.data));await writeFile(path.join(h.data,'gateway/command-journal.json'),'live-newer\n');const before=await snapshot(h.data);
  await h.set({unhealthyState:'backed-up',failRecovery:true});bad(h.run('restore',backup),3);assert.deepEqual(await snapshot(h.data),before);assert.equal(await exists(path.join(h.root,'.state.journal')),true);
  await h.set({failRecovery:false});await mkdir(h.backup);bad(h.run('backup',h.backup));
  assert.equal(await exists(path.join(h.root,'.state.journal')),false);assert.deepEqual(await snapshot(h.data),before);
});
for(const phase of ['prepared','old_gateway','new_gateway','old_identity','new_factory-trust','committed'])test(`restore recovers an interrupted ${phase} journal before new work`,async(t)=>{
  const h=await setup(t),backup=await h.artifact(await entries(h.data)),restored=await snapshot(h.data);await writeFile(path.join(h.data,'gateway/command-journal.json'),'live-newer\n');const before=await snapshot(h.data);
  await h.set({stateCrash:phase});const killed=h.run('restore',backup);assert.equal(killed.signal,'SIGKILL',killed.stderr);assert.equal(await exists(path.join(h.root,'.state.journal')),true);
  await mkdir(h.backup);bad(h.run('backup',h.backup));assert.deepEqual(await snapshot(h.data),phase==='committed'?restored:before);assert.equal(await exists(path.join(h.root,'.state.journal')),false);await h.clean();
});
test('activation and state serialize on the same persistent lock inode and pending journal blocks activation',async(t)=>{
  const h=await setup(t),lock=path.join(h.root,'.appliance-operation.lock');await writeFile(lock,'');
  const holder=spawn('/bin/bash',['-c','exec 9>>"$1"; "$2" -n 9; echo locked; read done','test',lock,path.join(h.bin,'flock')],{stdio:['pipe','pipe','pipe']});
  t.after(()=>holder.kill());
  await new Promise(resolve=>holder.stdout.once('data',resolve));const inode=(await lstat(lock)).ino;
  bad(h.run('backup',h.backup),4);bad(h.run('restore',await h.artifact(await entries(h.data))),4);
  holder.stdin.end('done\n');await new Promise(resolve=>holder.once('close',resolve));assert.equal((await lstat(lock)).ino,inode);
  await writeFile(path.join(h.root,'.state.journal'),'unresolved');
  bad(h.run('backup',h.backup),3);
  const result=spawnSync('/bin/bash',[release,'activate',h.a.dir,'--policy-sha256',policyHash,'--test-root',h.root],{env:h.env,encoding:'utf8'});bad(result);assert.deepEqual(await h.events(),[]);
});
test('backup refuses existing output, symlinked data and unsafe identity without modifying them',async(t)=>{
  const h=await setup(t);await mkdir(h.backup);await writeFile(path.join(h.backup,'sentinel'),'keep');bad(h.run('backup',h.backup));assert.equal(await readFile(path.join(h.backup,'sentinel'),'utf8'),'keep');
  await rm(path.join(h.data,'identity/device/current'));await symlink('/outside',path.join(h.data,'identity/device/current'));bad(h.run('backup',path.join(h.temp,'other')));await h.clean();
});
for(const kind of ['outer-symlink','outer-hardlink','data-symlink','root-symlink','live-hardlink','live-fifo'])test(`unsafe ${kind} fails closed without creating a backup or mutating state`,async(t)=>{
  const h=await setup(t),backup=await h.artifact(await entries(h.data));
  if(kind.startsWith('outer')) {
    const file=path.join(backup,'state.cms'),outside=path.join(h.temp,'cipher');await rename(file,outside);
    await (kind==='outer-symlink'?symlink:link)(outside,file);
    if(kind==='outer-hardlink')await link(outside,path.join(h.temp,'cipher-second-link'));
    bad(h.run('restore',backup));assert.deepEqual(await h.events(),[]);
  } else {
    if(kind==='data-symlink') {const moved=path.join(h.temp,'moved-data');await rename(h.data,moved);await symlink(moved,h.data);}
    if(kind==='root-symlink') {const moved=path.join(h.temp,'moved-root');await rename(h.root,moved);await symlink(moved,h.root);}
    if(kind==='live-hardlink')await link(path.join(h.data,'gateway/command-journal.json'),path.join(h.data,'gateway/hardlink'));
    if(kind==='live-fifo')ok(spawnSync('mkfifo',[path.join(h.data,'gateway/fifo')],{encoding:'utf8'}));
    bad(h.run('backup',h.backup));assert.equal(await exists(h.backup),false);
  }
  await h.clean();
});
for(const command of ['verify','drill'])test(`${command} TERM interruption removes decrypted staging and never accesses live runtime`,async(t)=>{
  const h=await setup(t),backup=await h.artifact(await entries(h.data)),before=await snapshot(h.data);
  const child=spawn('/bin/bash',h.args(command,backup),{env:h.env,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.resume();
  const closed=new Promise(resolve=>child.once('close',(status,signal)=>resolve({status,signal})));t.after(()=>child.kill());
  let extracted=false;
  for(let attempt=0;attempt<1000&&!extracted;attempt++) {
    for(const directory of await h.workspaces())if(await exists(path.join(directory,'first/manifest.state')))extracted=true;
    if(!extracted)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(extracted,true,'interruption happens after plaintext extraction starts');child.kill('SIGTERM');
  assert.equal((await closed).status,143,stderr);await h.clean();assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);
});
for(const [kind,length,accepted] of [['directory',99,true],['file',100,true],['directory',100,false],['file',101,false]])test(`USTAR ${kind} path boundary ${length} bytes is ${accepted?'round-trippable':'rejected before quiesce'}`,async(t)=>{
  const h=await setup(t),name=`gateway/${'x'.repeat(length-8)}`,file=path.join(h.data,name);
  if(kind==='directory')await mkdir(file,{mode:0o750});else await writeFile(file,'boundary fixture\n',{mode:0o600});
  const before=await snapshot(h.data),result=h.run('backup',h.backup);
  if(accepted) {ok(result);ok(h.run('verify',h.backup));ok(h.run('drill',h.backup));}
  else {bad(result);assert.equal(await exists(h.backup),false);assert.equal((await h.events()).some(e=>e.name==='docker'&&e.args.includes('stop')),false);}
  assert.deepEqual(await snapshot(h.data),before);await h.clean();
});
test('the parser rejects a 100-byte directory even without a tar prefix',async(t)=>{
  const h=await setup(t),name=`gateway/${'x'.repeat(92)}`;await mkdir(path.join(h.data,name),{mode:0o750});
  bad(h.run('verify',await h.artifact(await entries(h.data))));await h.clean();
});
for(const location of ['gateway','mesh','identity','factory-trust','root','runtime','backup','safe'])test(`hostile TMPDIR at ${location} never places verify/drill plaintext in live data or input`,async(t)=>{
  const h=await setup(t),backup=await h.artifact(await entries(h.data));
  const target=roots.includes(location)?path.join(h.data,location):location==='root'?h.root:location==='backup'?backup:location==='runtime'?path.join(h.root,'runtime'):h.env.TMPDIR;
  await mkdir(target,{recursive:true});const before=await snapshot(h.data),input=await readdir(backup),site=await readFile(path.join(h.root,'.env.appliance'));
  h.env.TMPDIR=target;ok(h.run('verify',backup));ok(h.run('drill',backup));
  for(const workspace of await h.workspaces()) {
    assert.equal(workspace===h.root||workspace.startsWith(h.root+'/'),false,'no workspace beneath appliance root');
    assert.equal(workspace===backup||workspace.startsWith(backup+'/'),false,'no workspace beneath input artifact');
  }
  assert.deepEqual(await snapshot(h.data),before);assert.deepEqual(await readdir(backup),input);assert.deepEqual(await readFile(path.join(h.root,'.env.appliance')),site);assert.deepEqual(await h.events(),[]);await h.clean();
});
test('hostile TMPDIR cannot move the restore workspace with gateway data',async(t)=>{
  const h=await setup(t),backup=await h.artifact(await entries(h.data)),expected=await snapshot(h.data);
  await writeFile(path.join(h.data,'gateway/command-journal.json'),'live-newer\n');h.env.TMPDIR=path.join(h.data,'gateway');
  ok(h.run('restore',backup));assert.deepEqual(await snapshot(h.data),expected);assert.equal(await exists(path.join(h.root,'.state.journal')),false);await h.clean();
});
for(const field of ['WORKSPACE','STAGE'])test(`nested journal ${field} cannot recursively delete an unrelated victim`,async(t)=>{
  const h=await setup(t),backup=await h.artifact(await entries(h.data));ok(h.run('verify',backup));
  const workspace=(await h.workspaces()).at(-1),tempBase=path.dirname(workspace);
  const parent=await mkdtemp(path.join(field==='WORKSPACE'?tempBase:h.data,field==='WORKSPACE'?'.gateway-state.':'.state-restore.'));
  t.after(async()=>{await rm(parent,{recursive:true,force:true});});
  const victim=path.join(parent,'nested',field==='WORKSPACE'?'.gateway-state.VICTIM':'.state-restore.VICTIM');
  await mkdir(victim,{recursive:true,mode:0o700});await writeFile(path.join(victim,'sentinel'),'keep');
  if(field==='STAGE')for(const name of ['old','new','discard'])await mkdir(path.join(victim,name),{mode:0o700});
  const envSha=sha(await readFile(path.join(h.root,'.env.appliance')));
  const journal=`COMPOSE_PROJECT=gateway\nDATA_DIR=${h.data}\nENV_SHA256=${envSha}\nOPERATION=${field==='STAGE'?'restore':'backup'}\nPHASE=committed\nRELEASE_ID=${h.a.id}\nSCHEMA=gateway-state-operation/v1\nSTAGE=${field==='STAGE'?victim:'none'}\nWORKSPACE=${field==='WORKSPACE'?victim:workspace}\n`;
  await writeFile(path.join(h.root,'.state.journal'),journal,{mode:0o600});const events=(await h.events()).length;
  const result=h.run('backup',h.backup);
  assert.equal(await readFile(path.join(victim,'sentinel'),'utf8').catch(()=>'<deleted>'),'keep','unrelated victim survives recovery');
  bad(result,3);assert.equal(await readFile(path.join(h.root,'.state.journal'),'utf8'),journal);assert.equal((await h.events()).length,events);
  await rm(parent,{recursive:true});await h.clean();
});
for(const boundary of ['new_gateway','rollback_gateway','rolled_back','committed_partial_cleanup'])test(`state recovery survives ${boundary} interruption at the persistence boundary`,async(t)=>{
  const h=await setup(t),backup=await h.artifact(await entries(h.data)),restored=await snapshot(h.data);
  await writeFile(path.join(h.data,'gateway/command-journal.json'),'live-newer\n');const before=await snapshot(h.data);
  if(boundary==='committed_partial_cleanup')await h.set({stateCrash:'committed'});
  else if(boundary==='rolled_back')await h.set({failSwap:'identity',stateCrash:'rolled_back'});
  else await h.set({stateCrashRename:boundary,...(boundary==='rollback_gateway'?{failSwap:'identity'}:{})});
  const killed=h.run('restore',backup);assert.equal(killed.signal,'SIGKILL',killed.stderr);
  const journal=await readFile(path.join(h.root,'.state.journal'),'utf8');
  if(boundary==='new_gateway')assert.match(journal,/^PHASE=old_gateway$/m,'rename succeeded before next phase write');
  if(boundary==='committed_partial_cleanup') {
    const stage=journal.match(/^STAGE=(.+)$/m)[1];assert.equal(path.dirname(stage),h.data);
    // Reproduce a durable committed journal with cleanup only partly applied.
    await rm(path.join(stage,'old/gateway'),{recursive:true});
  }
  await mkdir(h.backup);bad(h.run('backup',h.backup));
  assert.deepEqual(await snapshot(h.data),boundary==='committed_partial_cleanup'?restored:before);
  assert.equal(await exists(path.join(h.root,'.state.journal')),false);await h.clean();
});
for(const variant of ['absent','quoted-custom'])test(`shared data resolver uses ${variant} dotenv and ignores ambient overrides`,async(t)=>{
  const h=await setup(t);let site=await readFile(path.join(h.root,'.env.appliance'),'utf8'),actual=h.data;
  if(variant==='absent')site=site.replace(/^GATEWAY_DATA_DIR=.*\n/m,'');
  else {actual=path.join(h.temp,'custom-data');await rename(h.data,actual);site=site.replace(/^GATEWAY_DATA_DIR=.*$/m,`GATEWAY_DATA_DIR='${actual}' # literal`);}
  await writeFile(path.join(h.root,'.env.appliance'),site);h.env.GATEWAY_DATA_DIR='/not-the-site';h.env.GATEWAY_IMAGE_REPOSITORY='ambient';h.env.GATEWAY_IMAGE_TAG='wrong';
  ok(h.run('backup',h.backup));ok(h.run('verify',h.backup));
  for(const event of (await h.events()).filter(x=>x.name==='docker'))assert.equal(event.resolvedData,actual);
  assert.equal(await readFile(path.join(h.root,'.env.appliance'),'utf8'),site);await h.clean();
});
