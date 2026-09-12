import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lchmod, link, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
const created = '2026-09-12T00:00:00Z';

// Expectations are derived from real lstat/readlink/bytes, not the shell manifest.
async function entries(directory) {
  const result = [];
  async function walk(relative) {
    const file = path.join(directory, relative), info = await lstat(file);
    const type = info.isSymbolicLink() ? 'l' : info.isDirectory() ? 'd' : 'f';
    result.push({ name: relative, type, mode: (info.mode & 0o7777).toString(8).padStart(4, '0'),
      uid: info.uid, gid: info.gid, size: type === 'f' ? info.size : 0,
      content: type === 'f' ? await readFile(file) : Buffer.alloc(0),
      target: type === 'l' ? await readlink(file) : '-' });
    if (type === 'd') for (const name of (await readdir(file)).sort()) await walk(`${relative}/${name}`);
  }
  for (const root of roots) await walk(root);
  return result.sort((a,b) => a.name < b.name ? -1 : 1);
}
function manifest(records, id, timestamp = created) {
  return `led-control-gateway-state/v1|${id}|${timestamp}\n` + records.map(e =>
    `${e.name}|${e.type}|${e.mode}|${e.uid}|${e.gid}|${e.size}|${e.type === 'f' ? sha(e.content) : '-'}|${e.target}\n`).join('');
}
async function snapshot(directory) {
  return (await entries(directory)).map(({content, ...e}) => ({...e, hash: sha(content)}));
}
// An independent USTAR writer makes malicious *archive bytes*, including types
// that filesystem tar creation refuses. No plaintext tar file is ever written.
function archive(records, text) {
  const all = [{name:'manifest.state',type:'f',mode:'0600',uid:process.getuid(),gid:process.getgid(),content:Buffer.from(text),target:'-'}, ...records];
  const chunks=[];
  for (const e of all) {
    const header=Buffer.alloc(512), content=e.content || Buffer.alloc(0);
    const field=(at,length,value)=>header.write(value,at,length,'ascii');
    const octal=(at,length,value)=>field(at,length,Number(value).toString(8).padStart(length-1,'0')+'\0');
    field(0,100,e.name); octal(100,8,parseInt(e.mode,8)); octal(108,8,e.uid); octal(116,8,e.gid);
    octal(124,12,e.sizeOverride ?? (e.type==='f'?content.length:0)); octal(136,12,1);
    header.fill(32,148,156); field(156,1,({f:'0',d:'5',l:'2'})[e.type] || e.type);
    if(e.target!=='-')field(157,100,e.target);
    field(257,6,'ustar\0');field(263,2,'00');
    field(148,8,[...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ');
    chunks.push(header,content,Buffer.alloc((512-content.length%512)%512));
  }
  return Buffer.concat([...chunks,Buffer.alloc(1024)]);
}

async function setup(t) {
  const h=await fixture(t), a=await h.bundle('a');
  const data=path.join(h.root,'data'), scratch=path.join(h.temp,'scratch'); await mkdir(scratch,{mode:0o700});
  await mkdir(path.join(h.root,'releases')); await cp(a.dir,path.join(h.root,'releases',a.id),{recursive:true});
  await symlink(`releases/${a.id}`,path.join(h.root,'current'));
  await writeFile(h.config+'.active',a.tag);await writeFile(h.config+'.owner','gateway');await writeFile(h.config+'.active.image',a.manifest.image.configDigest);
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
  const args=(command,backup,extra=[])=>[state,command,backup,'--recipient',cert,...(command==='backup'?[]:['--key',key]),...(['backup','restore'].includes(command)?['--policy-sha256',policyHash,'--test-root',h.root]:[]),...extra];
  const run=(command,backup,extra=[])=>spawnSync('/bin/bash',args(command,backup,extra),{env,encoding:'utf8',timeout:30000});
  async function artifact(records,text,bytes) {
    const backup=path.join(h.temp,`crafted-${Math.random().toString(16).slice(2)}`);await mkdir(backup,{mode:0o700});
    const cipher=path.join(backup,'state.cms');
    const encrypted=spawnSync(realOpenSSL,['cms','-encrypt','-binary','-aes-256-cbc','-outform','DER','-stream','-out',cipher,cert],{input:bytes??archive(records,text??manifest(records,a.id))});
    assert.equal(encrypted.status,0,'ephemeral CMS fixture encryption failed');
    const der=spawnSync(realOpenSSL,['x509','-in',cert,'-outform','DER']).stdout;
    const content=await readFile(cipher);
    const outer=`CIPHERTEXT=state.cms\nCIPHERTEXT_SHA256=${sha(content)}\nCIPHERTEXT_SIZE=${content.length}\nCREATED_AT=${created}\nENCRYPTION=openssl-cms-aes-256-cbc-rsa/v1\nRECIPIENT_SHA256=${sha(der)}\nRELEASE_ID=${a.id}\nSCHEMA=led-control-gateway-backup/v1\n`;
    await writeFile(path.join(backup,'backup.env'),outer);await writeFile(path.join(backup,'checksums.sha256'),`${sha(outer)}  backup.env\n${sha(content)}  state.cms\n`);
    return backup;
  }
  const clean=async()=>assert.deepEqual(await readdir(scratch),[],'all disposable plaintext removed');
  return {...h,a,data,cert,key,env,run,args,artifact,clean,backup:path.join(h.temp,'backup')};
}

test('common library sourcing does not change shell options, traps, positional args or caller globals',()=>{
  const result=spawnSync('/bin/bash',['-c','library=$1; set -- unchanged; ROOT=caller; before=$(set +o); trap : EXIT; prior=$(trap -p); source "$library" || exit 99; [ "$before" = "$(set +o)" ] && [ "$prior" = "$(trap -p)" ] && [ "$ROOT" = caller ] && [ "$1" = unchanged ]','test',common],{encoding:'utf8'});
  ok(result);
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
    for(const directory of await readdir(h.env.TMPDIR))if(await exists(path.join(h.env.TMPDIR,directory,'first/manifest.state')))extracted=true;
    if(!extracted)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(extracted,true,'interruption happens after plaintext extraction starts');child.kill('SIGTERM');
  assert.equal((await closed).status,143,stderr);await h.clean();assert.deepEqual(await h.events(),[]);assert.deepEqual(await snapshot(h.data),before);
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
