import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
const root=resolve(import.meta.dirname,"../..");
const env={...process.env,GATEWAY_BIO_DEPLOYMENT_ID:"12345678901234567890123456789012",GATEWAY_BIO_IMAGE:"led-control-gateway:verified",GATEWAY_BIO_DATA_ROOT:"/opt/led-control/gateway/data-admin4",GATEWAY_BIO_USB_DEVICE:"/dev/bus/usb/002/007",GATEWAY_BIO_USB_GID:"812",GATEWAY_SERIAL:"GW-NEW-01",GATEWAY_BOOTSTRAP_URL:"https://192.168.45.148:4000/gateway-bootstrap"};
function rendered(file){return JSON.parse(execFileSync("docker",["compose","--env-file","/dev/null","-f",file,"config","--format","json"],{env,encoding:"utf8"})).services;}
function isolated(s){
 assert.equal(s.user,"999:999");assert.deepEqual(s.cap_drop,["ALL"]);assert.deepEqual(s.cap_add??[],[]);
 assert.equal(s.privileged??false,false);assert.equal(s.read_only,true);assert.equal(s.network_mode,"host");
 assert.deepEqual(s.security_opt,["no-new-privileges:true"]);assert.deepEqual(s.group_add,["812"]);
 assert.deepEqual(s.devices,[{source:"/dev/bus/usb/002/007",target:"/dev/bus/usb/002/007",permissions:"rw"}]);
 assert.equal(s.container_name,"led-control-gateway-bio");assert.equal(s.restart,"no");
 assert.equal(s.labels["io.led-control.bio.deployment"],"12345678901234567890123456789012");
 assert.deepEqual(s.entrypoint,["/bin/sh","-ec","umask 077; exec node /opt/led-control/gateway.mjs"]);
 assert.equal(s.environment.GATEWAY_ADAPTER,"bio-usb");assert.equal(s.environment.DEVICE_ADAPTER_TYPE,"bio-usb");
 assert.deepEqual(s.volumes.map(v=>[v.source,v.target]),[["/opt/led-control/gateway/data-admin4/gateway","/var/lib/led-control"],["/opt/led-control/gateway/data-admin4/identity","/var/lib/led-control/identity"],["/opt/led-control/gateway/data-admin4/mesh","/data/mesh"]]);
 for(const v of s.volumes)assert.equal(v.bind.create_host_path,false);
 assert.equal(s.environment.GATEWAY_BIO_MAPPING_PATH,"/data/mesh/bio-device-mappings.json");
 assert(!Object.keys(s.environment).some(k=>/BLUEZ|DBUS|HCI/.test(k)));
}
test("legacy base+BIO merge retains HCI capabilities and fails the isolation gate",()=>{
 const dir=mkdtempSync(join(tmpdir(),"bio-merge-"));try{
  for(const f of ["compose.raspberry-pi.yml","compose.bio-usb.yml"])writeFileSync(join(dir,f),readFileSync(join(root,"gateway",f)));
  writeFileSync(join(dir,".env.appliance"),"");
  const s=JSON.parse(execFileSync("docker",["compose","-f",join(dir,"compose.raspberry-pi.yml"),"-f",join(dir,"compose.bio-usb.yml"),"config","--format","json"],{env,encoding:"utf8"})).services["gateway-appliance"];
  assert(s.cap_add.includes("NET_ADMIN")&&s.cap_add.includes("NET_RAW"));assert.throws(()=>isolated(s));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("standalone BIO rendered configuration has no inherited hardware privilege or old mount",()=>{
 const file=join(root,"gateway/compose.bio-runtime.yml");assert(existsSync(file),"standalone isolation configuration is required");
 const services=rendered(file);assert.deepEqual(Object.keys(services),["gateway-bio"]);isolated(services["gateway-bio"]);
});
test("legacy BIO deployment fails before attempting remote work",()=>{
 const r=spawnSync(join(root,"../scripts/gateway-appliance-deploy.sh"),["--adapter","bio-usb","forbidden@example.test","not-an-archive"],{encoding:"utf8"});
 assert.equal(r.status,2);assert.match(r.stderr,/GATEWAY_BIO_STANDALONE_REQUIRED/);assert.doesNotMatch(r.stderr,/ssh|scp/);
});
