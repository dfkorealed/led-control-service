import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert(calls.indexOf("identity-check")<calls.indexOf("old-stop"));
  assert.equal(calls.filter(x=>x==="usb-check").length,2);
  assert(calls.lastIndexOf("usb-check")<calls.indexOf("old-stop"));
  assert(calls.indexOf("old-stop")<calls.indexOf("start"));assert(calls.includes("pid-check"));
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

function withHostFixture(callback){
 const dir=mkdtempSync(resolve(tmpdir(),"bio-host-contract-"));
 mkdirSync(resolve(dir,"scripts"));mkdirSync(resolve(dir,"apps/gateway"),{recursive:true});mkdirSync(resolve(dir,"bin"));
 writeFileSync(resolve(dir,"scripts/gateway-bio-runtime.sh"),readFileSync(script));
 writeFileSync(resolve(dir,"apps/gateway/compose.bio-runtime.yml"),"services: {}\n");
 const log=resolve(dir,"calls"), failure=resolve(dir,"failure");writeFileSync(log,"");writeFileSync(failure,"");
 const helper=`#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);const log=${JSON.stringify(log)};const failure=fs.readFileSync(${JSON.stringify(failure)},'utf8');const add=x=>fs.appendFileSync(log,x+'\\n');`;
 writeFileSync(resolve(dir,"bin/sudo"),helper+`
 if(a[1]==='realpath')console.log(a.at(-1));else if(a[1]==='stat')console.log('directory|755|0');else if(a[1]==='install')add('prepare');
 `,{mode:0o755});
 writeFileSync(resolve(dir,"bin/docker"),helper+`
 if(a[0]==='image')console.log('sha256:'+'a'.repeat(64)+' linux/arm64');
 else if(a[0]==='inspect') {if(a[1]==='led-control-gateway-bio')process.exit(1);console.log(a.includes('--format')?'b'.repeat(64):'{}');}
 else if(a[0]==='run'){add('identity-check');if(failure==='identity')process.exit(1);console.log('BIO_RUNTIME_IDENTITY_VALID');}
 else if(a[0]==='stop'){if(a[1]!=='b'.repeat(64))process.exit(90);add('old-stop');}
 else if(a[0]==='compose'){if(a.includes('config'))console.log('{}');else {if(!a.includes('--pull')||!a.includes('never')||a.includes('-f')&&a.filter(x=>x==='-f').length!==1)process.exit(91);add('start');}}
 else if(a[0]==='exec'){add('pid-check');console.log('BIO_RUNTIME_PROCESS_ISOLATED');}
 else process.exit(99);
 `,{mode:0o755});
 writeFileSync(resolve(dir,"scripts/gateway-bio-usb-preflight.sh"),helper+`
 const count=fs.readFileSync(log,'utf8').split('usb-check').length-1;add('usb-check');console.log('GATEWAY_BIO_USB_DEVICE=/dev/bus/usb/002/'+(failure==='usb-change'&&count?'008':'007'));console.log('GATEWAY_BIO_USB_GID=812');
 `,{mode:0o755});
 // Host script invokes Bash explicitly: fake only the external sysfs inspection boundary.
 const nodeStub=readFileSync(resolve(dir,"scripts/gateway-bio-usb-preflight.sh"),'utf8');
 writeFileSync(resolve(dir,"scripts/gateway-bio-usb-preflight-node"),nodeStub,{mode:0o755});
 writeFileSync(resolve(dir,"scripts/gateway-bio-usb-preflight.sh"),`#!/bin/bash\nexec ${JSON.stringify(resolve(dir,"scripts/gateway-bio-usb-preflight-node"))}\n`);
 const fixture={calls:()=>readFileSync(log,'utf8').trim().split('\n'),run:(mode='')=>{
  writeFileSync(failure,mode);
  return spawnSync('bash',[resolve(dir,'scripts/gateway-bio-runtime.sh'),'start'],{encoding:'utf8',env:{PATH:`${dir}/bin:${process.env.PATH}`,GATEWAY_BIO_DATA_ROOT:'/opt/led-control/gateway/data-admin4',GATEWAY_BIO_IMAGE:'led-control-gateway:verified',GATEWAY_BIO_IMAGE_ID:`sha256:${'a'.repeat(64)}`,GATEWAY_BIO_OLD_CONTAINER_ID:'b'.repeat(64),GATEWAY_SERIAL:'NEW-SERIAL',GATEWAY_EXPECTED_SITE_ID:'11111111-1111-4111-8111-111111111111',GATEWAY_EXPECTED_GATEWAY_ID:'22222222-2222-4222-8222-222222222222',GATEWAY_BOOTSTRAP_URL:'https://192.168.45.148:4000/gateway-bootstrap'}});
 }};
 try{callback(fixture);}finally{rmSync(dir,{recursive:true,force:true});}
}
