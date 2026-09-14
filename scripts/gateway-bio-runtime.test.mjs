import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
const script=resolve(import.meta.dirname,"gateway-bio-runtime.sh");
test("host launcher rejects missing/old/traversal roots and arbitrary Compose overrides before Docker or sudo",()=>{
 assert(existsSync(script),"explicit standalone host launcher is required");
 for(const env of [ {}, {GATEWAY_BIO_DATA_ROOT:"/opt/led-control/gateway/data"}, {GATEWAY_BIO_DATA_ROOT:"/opt/led-control/gateway/data-admin4/../data"}, {COMPOSE_FILE:"evil.yml"}, {GATEWAY_DATA_DIR:"/old"} ]) {
  const r=spawnSync("bash",[script,"start"],{encoding:"utf8",env:{PATH:process.env.PATH,...env}});
  assert.equal(r.status,2);assert.match(r.stderr,/BIO_RUNTIME_INPUT_INVALID/);assert.equal(r.stdout,"");
 }
});
test("host launcher refuses unknown commands/arguments without a root fallback",()=>{
 assert(existsSync(script));
 for(const args of [[],["start","--file","evil.yml"],["up"],["restart"]]){
  const r=spawnSync("bash",[script,...args],{encoding:"utf8"});assert.equal(r.status,2);assert.equal(r.stdout,"");
 }
});

test("host start validates identities and fresh USB before stopping only the expected old container",()=>{
 withHostFixture((fixture)=>{
  const result=fixture.run();assert.equal(result.status,0,result.stderr);
  const calls=fixture.calls();
  assert(calls.indexOf("lock-acquired")<calls.indexOf("name-gate"));
  assert(calls.indexOf("identity-check")<calls.indexOf("old-stop"));
  assert.equal(calls.filter(x=>x==="usb-check").length,2);
  assert(calls.lastIndexOf("usb-check")<calls.indexOf("old-stop"));
  assert(calls.indexOf("old-stop")<calls.indexOf("start"));assert(calls.includes("pid-check"));
  assert(calls.indexOf("lock-released")>calls.indexOf("pid-check"));
  assert(!calls.some(x=>/delete|recreate|restart/.test(x)));
  assert(!result.stdout.includes("SECRET"));
  const evidence=result.stdout.match(/evidence=(\S+)/)?.[1];if(evidence)rmSync(evidence,{recursive:true,force:true});
 });
});
test("identity failure or changed USB never stops the old container",()=>{
 for(const failure of ["identity","usb-change"]){withHostFixture(f=>{
  const result=f.run(failure);assert.notEqual(result.status,0);assert(!f.calls().includes("old-stop"));assert(!f.calls().includes("start"));
 });}
});
test("authenticated deployment UID1000 may own a non-writable ancestor but never runtime leaves",()=>{
 withHostFixture(f=>{const r=f.run();assert.equal(r.status,0,JSON.stringify({stderr:r.stderr,calls:f.calls()}));});
 for(const mode of ["ancestor-writable","ancestor-symlink","ancestor-owner","leaf-deployment-owner","leaf-root-owner","leaf-wide-mode","mapping-deployment-owner"]){withHostFixture(f=>{
  const result=f.run(mode);assert.notEqual(result.status,0,mode);assert(!f.calls().includes("old-stop"));assert(!f.calls().includes("prepare"));
 });}
});
test("deployment UID input rejects missing, ambiguous, injection and unauthenticated values",()=>{
 for(const uid of ["","0","999","65534","01000","4294967295","1000;echo SECRET","1001"]){withHostFixture(f=>{
  const result=f.run("",{GATEWAY_BIO_DEPLOYMENT_UID:uid});assert.equal(result.status,2,uid);assert.match(result.stderr,/BIO_RUNTIME_INPUT_INVALID/);assert(!f.calls().includes("lock-acquired"));
 });}
});
test("changed ancestor ownership even to another trusted UID and changed leaf owner fail before old stop",()=>{
 for(const mode of ["ancestor-owner-change","leaf-owner-change"]){withHostFixture(f=>{
  const result=f.run(mode);assert.notEqual(result.status,0,mode);assert(f.calls().includes("identity-check"));assert(!f.calls().includes("old-stop"));assert(!f.calls().includes("create"));
 });}
});
test("runtime files cannot inherit deployment UID and only an absent mesh is prepared",()=>{
 withHostFixture(f=>{const result=f.run('runtime-file-owner');assert.notEqual(result.status,0);assert(!f.calls().includes('old-stop'));});
 withHostFixture(f=>{const result=f.run('missing-mesh');assert.equal(result.status,0,result.stderr);assert(f.calls().includes('mesh-created'));assert(f.calls().includes('mesh-owned-999'));});
});
test("only Docker's exact empty root-owned nested identity mountpoint is tolerated",()=>{
 withHostFixture(f=>{
  const result=f.run('docker-identity-mountpoint');
  assert.equal(result.status,0,JSON.stringify({stderr:result.stderr,calls:f.calls()}));
 });
 for(const mode of [
  'docker-identity-mountpoint-not-empty',
  'docker-identity-mountpoint-wide-mode',
  'docker-identity-mountpoint-wrong-owner',
  'docker-identity-mountpoint-file',
  'docker-identity-mountpoint-symlink',
 ])withHostFixture(f=>{
  const result=f.run(mode);
  assert.notEqual(result.status,0,mode);
  assert(!f.calls().includes('old-stop'));
 });
});

test("name collision at the second gate never stops the old container",()=>withHostFixture(f=>{
 const result=f.run("name-collision");assert.notEqual(result.status,0);assert(!f.calls().includes("old-stop"));
}));
test("partial Compose create/API failure cleans only this invocation's immutable candidate",()=>withHostFixture(f=>{
 const result=f.run("partial-create");assert.notEqual(result.status,0);assert(f.calls().includes("candidate-stop:"+'c'.repeat(64)));assert(!f.calls().includes("start"));
}));
test("partial Docker start failure and replacement race never clean the replacement name",()=>{
 for(const failure of ["partial-start","replace-name"]){withHostFixture(f=>{
  const result=f.run(failure);assert.notEqual(result.status,0);
  assert(f.calls().includes("candidate-stop:"+'c'.repeat(64)));assert(!f.calls().some(c=>c.includes('d'.repeat(64))));
 });}
});
test("cleanup stop failure is surfaced and retains the lock for manual recovery",()=>withHostFixture(f=>{
 const result=f.run("cleanup-failure");assert.notEqual(result.status,0);assert.match(result.stderr,/BIO_RUNTIME_CLEANUP_FAILED/);assert(f.lockExists());
}));
test("stale lock is never automatically removed",()=>withHostFixture(f=>{
 f.seedLock();const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/BIO_RUNTIME_LOCKED/);assert(f.lockExists());assert(!f.calls().includes("old-stop"));
}));
test("final lock release failure stops the candidate rather than reporting a failed running deployment",()=>withHostFixture(f=>{
 const result=f.run("lock-release-failure");assert.notEqual(result.status,0);assert.match(result.stderr,/BIO_RUNTIME_LOCK_RELEASE_FAILED/);assert.doesNotMatch(result.stdout,/BIO_RUNTIME_STARTED/);assert(f.calls().includes("candidate-stop:"+'c'.repeat(64)));assert(f.lockExists());
}));
test("concurrent launcher fails closed and TERM/INT clean the exact owned candidate",async()=>{
 for(const signal of ["SIGTERM","SIGINT"]){await withHostFixture(async f=>{
  const first=f.spawn("pause-start");
  await f.waitFor("start");
  const second=f.runCurrent();assert.notEqual(second.status,0);assert.match(second.stderr,/BIO_RUNTIME_LOCKED/);
  first.kill(signal);
  const result=await f.result(first);assert.notEqual(result.code,0);
  assert(f.calls().includes("candidate-stop:"+'c'.repeat(64)));assert(!f.lockExists());
 });}
});

function withHostFixture(callback){
 const dir=mkdtempSync(resolve(tmpdir(),"bio-host-contract-"));
 mkdirSync(resolve(dir,"scripts"));mkdirSync(resolve(dir,"apps/gateway"),{recursive:true});mkdirSync(resolve(dir,"bin"));
 writeFileSync(resolve(dir,"scripts/gateway-bio-runtime.sh"),readFileSync(script));
 writeFileSync(resolve(dir,"apps/gateway/compose.bio-runtime.yml"),"services: {}\n");
 const log=resolve(dir,"calls"), failure=resolve(dir,"failure");writeFileSync(log,"");writeFileSync(failure,"");
 const lock=resolve(dir,'lock'),state=resolve(dir,'candidate'),mesh=resolve(dir,'mesh');
 const helper=`#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);const log=${JSON.stringify(log)};const failure=fs.readFileSync(${JSON.stringify(failure)},'utf8');const add=x=>fs.appendFileSync(log,x+'\\n');const lock=${JSON.stringify(lock)},state=${JSON.stringify(state)},mesh=${JSON.stringify(mesh)};`;
 writeFileSync(resolve(dir,"bin/sudo"),helper+`
 if(a[1]==='mkdir'){try{if(a.at(-1).endsWith('/mesh')){fs.mkdirSync(mesh);add('mesh-created');}else{fs.mkdirSync(lock);add('lock-acquired');}}catch{process.exit(1);}}
 else if(a[1]==='chown'){if(a[2]!=='999:999'||!a.at(-1).endsWith('/mesh'))process.exit(1);add('mesh-owned-999');}
 else if(a[1]==='find'){
  const target=a[2],nested='/opt/led-control/gateway/data-admin4/gateway/identity';
  if(target===nested&&a.includes('-mindepth')){
   if(failure==='docker-identity-mountpoint-not-empty')console.log(nested+'/unexpected-file');
  }else if(failure==='runtime-file-owner')console.log('/redacted-owned-file');
  else if(target.endsWith('/gateway')&&failure.startsWith('docker-identity-mountpoint')&&!a.includes('-prune'))console.log(nested);
 }
 else if(a[1]==='rmdir'){if(failure==='lock-release-failure')process.exit(1);fs.rmdirSync(lock);add('lock-released');}
 else if(a[1]==='realpath'){
  const p=a.at(-1),nested='/opt/led-control/gateway/data-admin4/gateway/identity';
  console.log(p===nested&&failure==='docker-identity-mountpoint-symlink'?'/different':p==='/opt/led-control/gateway'&&failure==='ancestor-symlink'?'/different':p);
 }
 else if(a[1]==='test'){
  const p=a.at(-1),nested='/opt/led-control/gateway/data-admin4/gateway/identity';
  if(p===nested){
   if(!failure.startsWith('docker-identity-mountpoint'))process.exit(1);
   if(a.includes('-L')&&failure!=='docker-identity-mountpoint-symlink')process.exit(1);
  }else if(p.endsWith('/mesh')&&failure==='missing-mesh'&&!fs.existsSync(mesh))process.exit(1);
  else if(p.endsWith('.json')&&failure!=='mapping-deployment-owner')process.exit(1);
 }
 else if(a[1]==='stat'){
  if(a.includes('%d:%i'))console.log('1:1234');else{
   const p=a.at(-1),nested=p==='/opt/led-control/gateway/data-admin4/gateway/identity',leaf=!nested&&['/identity','/gateway','/mesh'].some(suffix=>p.endsWith(suffix))&&p.includes('data-admin4/'),mapping=p.endsWith('.json');
   let owner=leaf?999:p==='/opt/led-control/gateway'?1000:0,mode=leaf?(p.endsWith('/identity')?'750':'700'):'755';
   if(p==='/opt/led-control/gateway'){
    mode=failure==='ancestor-writable'?'770':'750';
    if(failure==='ancestor-owner')owner=2000;
    if(failure==='ancestor-owner-change'&&fs.readFileSync(log,'utf8').includes('identity-check'))owner=0;
   }
   if(leaf){if(failure==='leaf-deployment-owner'||failure==='leaf-owner-change'&&fs.readFileSync(log,'utf8').includes('identity-check'))owner=1000;if(failure==='leaf-root-owner')owner=0;if(failure==='leaf-wide-mode')mode='755';}
   if(nested){if(failure==='docker-identity-mountpoint-wide-mode')mode='777';if(failure==='docker-identity-mountpoint-wrong-owner')owner=999;}
   if(mapping){owner=1000;mode='600';}
   const kind=mapping||nested&&failure==='docker-identity-mountpoint-file'?'regular file':'directory',metadata=kind+'|'+mode+'|'+owner;
   console.log(a.some(x=>x.includes('%g'))?metadata+'|'+(leaf?999:0)+'|1:42':metadata);
  }
 }else if(a[1]==='install')add('prepare');
 `,{mode:0o755});
 writeFileSync(resolve(dir,"bin/id"),helper+`if(a[0]!=='-u')process.exit(1);console.log('1000');`,{mode:0o755});
 writeFileSync(resolve(dir,"bin/docker"),helper+`
 if(a[0]==='image')console.log('sha256:'+'a'.repeat(64)+' linux/arm64');
 else if(a[0]==='container'&&a[1]==='ls'){
  const filter=a[a.indexOf('--filter')+1]||'';
  if(filter.startsWith('name=')){add('name-gate');if(failure==='name-collision'&&fs.readFileSync(log,'utf8').split('name-gate').length>2)console.log('d'.repeat(64));}
  else if(fs.existsSync(state))console.log('c'.repeat(64));
 }
 else if(a[0]==='inspect') {
  if(a[1]==='led-control-gateway-bio'){add('MUTABLE-NAME-INSPECT');if(failure==='replace-name')console.log('d'.repeat(64));else process.exit(1);}
  if(a[1]==='c'.repeat(64)){
   const info=JSON.parse(fs.readFileSync(state));const format=a[a.indexOf('--format')+1]||'';
   if(format.includes('Labels'))console.log('c'.repeat(64)+' '+info.token+' sha256:'+'a'.repeat(64));
   else if(format.includes('State.Running'))console.log(info.running?'true 0':'false 0');else console.log('{}');
  }else console.log(a.includes('--format')?'b'.repeat(64):'{}');
 }
 else if(a[0]==='run'){add('identity-check');if(failure==='identity')process.exit(1);console.log('BIO_RUNTIME_IDENTITY_VALID');}
 else if(a[0]==='stop'){
  const id=a.at(-1);if(id==='b'.repeat(64))add('old-stop');else if(id==='c'.repeat(64)){add('candidate-stop:'+id);if(failure==='cleanup-failure')process.exit(1);const info=JSON.parse(fs.readFileSync(state));info.running=false;fs.writeFileSync(state,JSON.stringify(info));}else {add('FORBIDDEN-STOP:'+id);process.exit(90);}
 }
 else if(a[0]==='start'){
  if(a[1]!=='c'.repeat(64))process.exit(93);add('start');const info=JSON.parse(fs.readFileSync(state));info.running=true;fs.writeFileSync(state,JSON.stringify(info));
  if(failure==='partial-start')process.exit(1);if(failure==='pause-start')setTimeout(()=>{},2000);
 }
 else if(a[0]==='compose'){
  if(a.includes('config'))console.log('{}');else {
   if(!a.includes('--pull')||!a.includes('never')||a.filter(x=>x==='-f').length!==1)process.exit(91);
   add('create');fs.writeFileSync(state,JSON.stringify({running:false,token:process.env.GATEWAY_BIO_DEPLOYMENT_ID}));
   if(failure==='partial-create')process.exit(1);
  }
 }
 else if(a[0]==='exec'){if(a[1]!=='c'.repeat(64)){add('MUTABLE-NAME-EXEC');process.exit(94);}add('pid-check');if(failure==='replace-name'||failure==='cleanup-failure')process.exit(1);console.log('BIO_RUNTIME_PROCESS_ISOLATED');}
 else process.exit(99);
 `,{mode:0o755});
 writeFileSync(resolve(dir,"bin/mktemp"),helper+`console.log(fs.mkdtempSync(${JSON.stringify(resolve(dir,'evidence-'))}));`,{mode:0o755});
 writeFileSync(resolve(dir,"scripts/gateway-bio-usb-preflight.sh"),helper+`
 const count=fs.readFileSync(log,'utf8').split('usb-check').length-1;add('usb-check');console.log('GATEWAY_BIO_USB_DEVICE=/dev/bus/usb/002/'+(failure==='usb-change'&&count?'008':'007'));console.log('GATEWAY_BIO_USB_GID=812');
 `,{mode:0o755});
 // Host script invokes Bash explicitly: fake only the external sysfs inspection boundary.
 const nodeStub=readFileSync(resolve(dir,"scripts/gateway-bio-usb-preflight.sh"),'utf8');
 writeFileSync(resolve(dir,"scripts/gateway-bio-usb-preflight-node"),nodeStub,{mode:0o755});
 writeFileSync(resolve(dir,"scripts/gateway-bio-usb-preflight.sh"),`#!/bin/bash\nexec ${JSON.stringify(resolve(dir,"scripts/gateway-bio-usb-preflight-node"))}\n`);
 const options={encoding:'utf8',env:{PATH:`${dir}/bin:${process.env.PATH}`,GATEWAY_BIO_DEPLOYMENT_UID:'1000',GATEWAY_BIO_DATA_ROOT:'/opt/led-control/gateway/data-admin4',GATEWAY_BIO_IMAGE:'led-control-gateway:verified',GATEWAY_BIO_IMAGE_ID:`sha256:${'a'.repeat(64)}`,GATEWAY_BIO_OLD_CONTAINER_ID:'b'.repeat(64),GATEWAY_SERIAL:'NEW-SERIAL',GATEWAY_EXPECTED_SITE_ID:'11111111-1111-4111-8111-111111111111',GATEWAY_EXPECTED_GATEWAY_ID:'22222222-2222-4222-8222-222222222222',GATEWAY_BOOTSTRAP_URL:'https://192.168.45.148:4000/gateway-bootstrap'}};
 const args=[resolve(dir,'scripts/gateway-bio-runtime.sh'),'start'];
 const fixture={calls:()=>readFileSync(log,'utf8').trim().split('\n'),seedLock:()=>mkdirSync(lock),lockExists:()=>existsSync(lock),run:(mode='',extra={})=>{writeFileSync(failure,mode);return spawnSync('bash',args,{...options,env:{...options.env,...extra}});},runCurrent:()=>spawnSync('bash',args,options),spawn:(mode)=>{
  writeFileSync(failure,mode);const child=spawn('bash',args,options);
  child.result=new Promise(resolve=>{let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('close',code=>resolve({code,stdout,stderr}));});return child;
 },
 waitFor:async(message)=>{for(let i=0;i<1000;i++){if(readFileSync(log,'utf8').split('\n').includes(message))return;await new Promise(r=>setTimeout(r,20));}throw new Error('fixture wait timeout');},
 result:child=>child.result};
 let result;try{result=callback(fixture);}catch(error){rmSync(dir,{recursive:true,force:true});throw error;}
 if(result?.then)return result.finally(()=>rmSync(dir,{recursive:true,force:true}));
 rmSync(dir,{recursive:true,force:true});
}
