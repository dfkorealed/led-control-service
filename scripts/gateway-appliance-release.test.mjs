import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applianceEnv } from "./gateway-release-bundle.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const manager = path.join(repository, "scripts/gateway-appliance-release.sh");
const deploy = path.join(repository, "scripts/gateway-appliance-deploy.sh");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const policyHash = sha(await readFile(path.join(repository, "apps/gateway/release-policy.json")));
const phases = ["prepared", "env_switched", "service_started", "healthy", "previous_switched", "current_switched"];

async function fixture(t) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "gateway-activation-")));
  t.after(async () => { spawnSync("chmod", ["-R", "u+w", temp]); await rm(temp, { recursive: true, force: true }); });
  const root = path.join(temp, "appliance");
  const bin = path.join(temp, "bin");
  await mkdir(root); await mkdir(bin);
  await writeFile(path.join(root, ".gateway-release-disposable-root"), "gateway-release-test/v1\n");
  const data = path.join(root, "data");
  for (const directory of ["gateway", "mesh", "identity/device/generations/factory", "factory-trust"]) {
    await mkdir(path.join(data, directory), { recursive: true, mode: 0o750 });
  }
  await symlink("generations/factory", path.join(data, "identity/device/current"));
  for (const name of ["device.crt", "device.key", "api-ca.crt", "mqtt-ca.crt"]) {
    await writeFile(path.join(data, "identity/device/generations/factory", name), "disposable identity fixture\n", { mode: name.endsWith(".key") ? 0o600 : 0o644 });
  }
  await writeFile(path.join(data, "factory-trust/api-ca.crt"), "disposable trust fixture\n");
  const siteEnv = `# site settings remain byte-for-byte\nGATEWAY_IMAGE_REPOSITORY=old-repository\nGATEWAY_IMAGE_TAG=initial\nGATEWAY_DATA_DIR=${data}\nTOKEN=literal-$(touch ${temp}/injected)\nGATEWAY_SERIAL=fixture-site\n`;
  await writeFile(path.join(root, ".env.appliance"), siteEnv, { mode: 0o640 });
  const config = path.join(temp, "shim.json");
  const trace = path.join(temp, "trace.jsonl");
  await writeFile(config, JSON.stringify({ root, images: {}, unhealthy: [] }));
  // macOS has no util-linux flock. This shim uses the real flock syscall on
  // the inherited shell FD, so concurrent managers still exercise kernel locks.
  const compile = spawnSync("cc", ["-x", "c", "-o", path.join(bin, "flock"), "-"], {
    input: '#include <sys/file.h>\n#include <stdlib.h>\nint main(int argc,char **argv){return argc==3 && flock(atoi(argv[2]),LOCK_EX|LOCK_NB)==0 ? 0 : 1;}\n', encoding: "utf8"
  });
  assert.equal(compile.status, 0, compile.stderr);
  const timeoutCompile = spawnSync("cc", ["-x", "c", "-o", path.join(bin, "timeout"), "-"], {
    input: '#include <unistd.h>\n#include <stdlib.h>\n#include <signal.h>\n#include <sys/wait.h>\n#include <time.h>\nint main(int n,char **v){int i=1,status,expired=0;double seconds=1,grace=1;while(i<n && v[i][0]==\'-\'){if(v[i][2]==\'k\')grace=atof(v[i]+13);i++;}if(i>=n)return 2;seconds=atof(v[i++]);pid_t p=fork();if(!p){setpgid(0,0);execvp(v[i],v+i);_exit(127);}setpgid(p,p);struct timespec start,now;clock_gettime(CLOCK_MONOTONIC,&start);while(waitpid(p,&status,WNOHANG)==0){clock_gettime(CLOCK_MONOTONIC,&now);double elapsed=now.tv_sec-start.tv_sec+(now.tv_nsec-start.tv_nsec)/1e9;if(elapsed>=seconds&&!expired){kill(-p,SIGTERM);expired=1;}if(elapsed>=seconds+grace)kill(-p,SIGKILL);usleep(10000);}return expired?124:WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);}\n', encoding: "utf8"
  });
  assert.equal(timeoutCompile.status, 0, timeoutCompile.stderr);
  const shim = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const c = JSON.parse(fs.readFileSync(process.env.RELEASE_SHIM_CONFIG));
const args = process.argv.slice(2), name = path.basename(process.argv[1]);
const file = path.join(c.root, '.env.appliance');
// Independent quote-aware dotenv parser: do not repeat the production line matcher.
const site = require('node:util').parseEnv(fs.readFileSync(file, 'utf8'));
const tag = site.GATEWAY_IMAGE_TAG;
const resolvedRepository=process.env.GATEWAY_IMAGE_REPOSITORY || site.GATEWAY_IMAGE_REPOSITORY || 'led-control-gateway';
const resolvedTag=process.env.GATEWAY_IMAGE_TAG || site.GATEWAY_IMAGE_TAG || 'local';
const resolvedImage=resolvedRepository+':'+resolvedTag;
const resolvedData=process.env.GATEWAY_DATA_DIR || site.GATEWAY_DATA_DIR || c.root+'/data';
const project=args.includes('--project-name')?args[args.indexOf('--project-name')+1]:null;
const activeFile=process.env.RELEASE_SHIM_CONFIG+'.active';
const ownerFile=process.env.RELEASE_SHIM_CONFIG+'.owner';
const hasContainer=fs.existsSync(activeFile)?!!fs.readFileSync(activeFile,'utf8'):Object.hasOwn(c,'existingProject');
const owner=fs.existsSync(ownerFile)?fs.readFileSync(ownerFile,'utf8'):c.existingProject;
const pointer = (name) => { try { return fs.readlinkSync(path.join(c.root,name)); } catch { return null; } };
fs.appendFileSync(process.env.RELEASE_SHIM_TRACE, JSON.stringify({name,args,tag,resolvedImage,resolvedData,project,current:pointer('current'),previous:pointer('previous')})+'\\n');
if(name==='sync') {
  const fd=fs.openSync(args[1],'r'); try { fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
  let phase; try { phase=fs.readFileSync(path.join(c.root,'.activation.journal'),'utf8').match(/^PHASE=(.*)$/m)?.[1]; } catch {}
  if(args[1]===c.root && c.crashPhase && c.crashPhase===phase && !fs.existsSync(process.env.RELEASE_SHIM_CONFIG+'.crashed')) {
    fs.writeFileSync(process.env.RELEASE_SHIM_CONFIG+'.crashed','1'); process.kill(process.ppid,'SIGKILL');
  }
  process.exit(0);
}
if(name==='mv') { const paths=args.filter(x=>!x.startsWith('-')); fs.renameSync(paths[0],paths[1]); process.exit(0); }
if(name==='node') process.exit(99);
if(name==='ssh') { if(args.some(x=>x.includes('mktemp'))) console.log('/tmp/led-control-gateway-upload.ABC123'); process.exit(0); }
if(name==='scp') process.exit(0);
if(name==='docker' && c.hang && args.join(' ').includes(c.hang) && (!c.hangTag || resolvedTag===c.hangTag)) {
  process.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(0),6000); return;
}
if(args[0]==='version' || (args[0]==='compose' && args[1]==='version')) process.exit(c.noDocker?1:0);
if(args[0]==='image' && args[1]==='load') process.exit(c.failLoad?1:0);
if(args[0]==='image' && args[1]==='inspect') { console.log(c.wrongDigest ? 'sha256:'+ '0'.repeat(64) : c.images[args.at(-1)] || 'missing'); process.exit(0); }
if(args[0]==='container' && args[1]==='ls') { if(hasContainer)console.log('a'.repeat(12)); process.exit(0); }
if(args[0]==='container' && args[1]==='inspect') { if(!hasContainer)process.exit(1); console.log([owner,c.existingService||'gateway-appliance',c.existingWorkingDir||c.root].join('|')); process.exit(0); }
if(args[0]==='compose') {
  if(args.includes('config')) { if(args.includes('--images'))console.log(c.resolvedImages||resolvedImage); process.exit(c.badCompose?1:0); }
  if(args.includes('up') || args.includes('down')) { if(hasContainer && owner!==project)process.exit(8); }
  if(args.includes('up')) {
    fs.writeFileSync(activeFile,resolvedTag); fs.writeFileSync(ownerFile,project);
    fs.writeFileSync(activeFile+'.image',c.wrongRunningTag===resolvedTag?'sha256:'+'0'.repeat(64):c.images[resolvedImage]||'missing');
    process.exit(c.failUp===resolvedTag?1:0);
  }
  if(args.includes('down')) { fs.writeFileSync(activeFile,''); process.exit(c.failDown?1:0); }
}
if(args[0]==='inspect') {
  const active=fs.existsSync(activeFile)?fs.readFileSync(activeFile,'utf8'):'';
  const health=c.unhealthy.includes(active)?'unhealthy':active?'healthy':'starting';
  if(args.some(x=>x.includes('.Image')))process.stdout.write((fs.existsSync(activeFile+'.image')?fs.readFileSync(activeFile+'.image','utf8'):'missing')+' ');
  console.log(health); process.exit(0);
}
process.exit(9);
`;
  for (const name of ["docker", "sync", "mv", "node", "ssh", "scp"]) {
    await writeFile(path.join(bin, name), shim, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_SHIM_CONFIG: config, RELEASE_SHIM_TRACE: trace };
  const set = async (values) => writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(config)), ...values }));
  const args = (command,bundle,extra=[]) => [manager,command,...(bundle?[bundle.dir]:[]),"--policy-sha256",policyHash,"--test-root",root,...extra];
  const run = (command, bundle, extra = []) => spawnSync("/bin/bash", args(command,bundle,extra), { env, encoding: "utf8", timeout: 20000 });
  const runDeadline = (command,bundle) => new Promise((resolve,reject) => {
    const start=Date.now(), child=spawn("/bin/bash",args(command,bundle),{env,detached:true,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr=""; child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
    const guard=setTimeout(()=>{try{process.kill(-child.pid,"SIGKILL");}catch{}},10000);
    child.once("error",reject);child.once("close",(status,signal)=>{clearTimeout(guard);resolve({status,signal,stdout,stderr,elapsed:Date.now()-start});});
  });
  async function bundle(letter) {
    const digest = sha(`config-${letter}`);
    const manifest = {
      schema: "led-control-gateway-release/v1", gatewayVersion: "0.1.0", gitCommit: letter.repeat(40),
      gitCommitTimestamp: "2026-09-12T00:00:00.000Z", platform: "linux/arm64", testMode: false,
      policySha256: policyHash, lockSha256: "c".repeat(64),
      image: { repository: "fixture-gateway", tag: `release-${letter}`, configDigest: `sha256:${digest}`, archive: "gateway-image-linux-arm64.tar" }
    };
    manifest.releaseId = `0.1.0-${manifest.gitCommit}-${digest.slice(0,16)}`;
    const dir = path.join(temp, `bundle-${letter}`);
    await mkdir(path.join(dir, "docker"), { recursive: true });
    await writeFile(path.join(dir, "appliance.env"), applianceEnv(manifest));
    await writeFile(path.join(dir, "release-manifest.json"), JSON.stringify(manifest));
    await writeFile(path.join(dir, "sbom.spdx.json"), '{"spdxVersion":"SPDX-2.3"}\n');
    await writeFile(path.join(dir, manifest.image.archive), `synthetic docker boundary archive ${letter}`);
    await copyFile(path.join(repository, "apps/gateway/compose.raspberry-pi.yml"), path.join(dir, "compose.yml"));
    await copyFile(path.join(repository, "apps/gateway/docker/seccomp-bluez-mesh.json"), path.join(dir, "docker/seccomp-bluez-mesh.json"));
    const result = { dir, id: manifest.releaseId, manifest, tag: manifest.image.tag };
    await checksums(result);
    const existing = JSON.parse(await readFile(config));
    await set({ images: { ...existing.images, [`fixture-gateway:${manifest.image.tag}`]: manifest.image.configDigest } });
    return result;
  }
  async function checksums(bundle) {
    const files = ["appliance.env", "compose.yml", "docker/seccomp-bluez-mesh.json", bundle.manifest.image.archive, "release-manifest.json", "sbom.spdx.json"].sort();
    await writeFile(path.join(bundle.dir, "checksums.sha256"), (await Promise.all(files.map(async (name) => `${sha(await readFile(path.join(bundle.dir,name)))}  ${name}\n`))).join(""));
  }
  const events = async () => { try { return (await readFile(trace,"utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
  const pointer = async (name) => { try { return await readlink(path.join(root,name)); } catch (e) { if(e.code==='ENOENT') return null; throw e; } };
  return { root, bin, temp, env, siteEnv, bundle, checksums, run, runDeadline, set, events, pointer, config };
}
const ok = (result) => assert.equal(result.status, 0, result.stderr || String(result.error));
const fail = (result, status = 1) => assert.equal(result.status, status, result.stdout + result.stderr);
const site = (h) => readFile(path.join(h.root, ".env.appliance"), "utf8");
const exists = async (file) => lstat(file).then(() => true, () => false);

test("review dotenv multiline rejects before mutation and preserves bytes/mode", async (t) => {
  const h=await fixture(t), a=await h.bundle("a");
  const original=h.siteEnv.replace(/^GATEWAY_IMAGE_.*\n/gm, "")+"SECRET='first\nGATEWAY_IMAGE_TAG=hidden\nGATEWAY_IMAGE_REPOSITORY=hidden\nlast'\n";
  await writeFile(path.join(h.root,".env.appliance"),original);
  fail(h.run("activate",a)); assert.equal(await site(h),original);
  assert.equal((await lstat(path.join(h.root,".env.appliance"))).mode&0o777,0o640);
  assert.equal((await h.events()).some(e=>e.args.includes("up")),false);
  assert.equal(await exists(path.join(h.root,".activation.journal")),false);
});
for(const variant of ["missing","duplicate"]) test(`review dotenv ${variant} image keys normalize exactly once`,async(t)=>{
  const h=await fixture(t),a=await h.bundle("a");
  const original=(variant==="missing"?h.siteEnv.replace(/^GATEWAY_IMAGE_.*\n/gm,""):h.siteEnv+"GATEWAY_IMAGE_TAG=duplicate\nGATEWAY_IMAGE_REPOSITORY=duplicate\n")+"LABEL='한글 # unchanged'\n";
  await writeFile(path.join(h.root,".env.appliance"),original);ok(h.run("activate",a));
  const after=await site(h);
  assert.equal(after.match(/^GATEWAY_IMAGE_TAG=/gm).length,1);assert.equal(after.match(/^GATEWAY_IMAGE_REPOSITORY=/gm).length,1);
  assert.equal(after.replace(/^GATEWAY_IMAGE_.*\n/gm,""),original.replace(/^GATEWAY_IMAGE_.*\n/gm,""));
  assert.equal((await h.events()).find(e=>e.args.includes("up")).resolvedImage,`fixture-gateway:${a.tag}`);
});
test("review compose resolved image must equal candidate before mutation",async(t)=>{
  const h=await fixture(t),a=await h.bundle("a");await h.set({resolvedImages:"led-control-gateway:local"});
  fail(h.run("activate",a));assert.equal(await site(h),h.siteEnv);assert.equal(await h.pointer("current"),null);
});
test("review running image digest gates commit and safely recovers",async(t)=>{
  const h=await fixture(t),a=await h.bundle("a"),b=await h.bundle("b");ok(h.run("activate",a));const before=await site(h);
  await h.set({wrongRunningTag:b.tag});fail(h.run("activate",b));assert.equal(await site(h),before);assert.equal(await h.pointer("current"),`releases/${a.id}`);
});
for(const absent of [false,true]) test(`review authoritative env defeats ambient overrides, data absent=${absent}`,async(t)=>{
  const h=await fixture(t),a=await h.bundle("a"),b=await h.bundle("b");
  if(absent)await writeFile(path.join(h.root,".env.appliance"),h.siteEnv.replace(/^GATEWAY_DATA_DIR=.*\n/m,""));
  Object.assign(h.env,{GATEWAY_DATA_DIR:"/malicious",GATEWAY_IMAGE_TAG:"ambient",GATEWAY_IMAGE_REPOSITORY:"ambient",COMPOSE_PROJECT_NAME:"foreign"});
  ok(h.run("activate",a));await h.set({unhealthy:[b.tag]});fail(h.run("activate",b));
  for(const event of (await h.events()).filter(e=>e.args[0]==="compose"&&e.project)){
    assert.equal(event.resolvedData,path.join(h.root,"data"));assert.match(event.resolvedImage,/^fixture-gateway:release-[ab]$/);
  }
});
test("review legacy gateway project is inherited consistently",async(t)=>{
  const h=await fixture(t),a=await h.bundle("a");await h.set({existingProject:"gateway"});ok(h.run("activate",a));
  for(const event of (await h.events()).filter(e=>e.args[0]==="compose"&&e.project))assert.equal(event.project,"gateway");
});
for(const foreign of [{existingProject:"foreign"},{existingProject:"gateway",existingService:"other"},{existingProject:"gateway",existingWorkingDir:"/foreign"}])test(`review foreign ownership rejects before mutation ${JSON.stringify(foreign)}`,async(t)=>{
  const h=await fixture(t),a=await h.bundle("a");await h.set(foreign);fail(h.run("activate",a));assert.equal(await site(h),h.siteEnv);
  assert.equal((await h.events()).some(e=>e.args.includes("up")||e.args.includes("down")),false);
});
for(const hang of ["image load","config --images"])test(`review hanging ${hang} has wall-clock deadline before mutation`,async(t)=>{
  const h=await fixture(t),a=await h.bundle("a");await h.set({hang});const result=await h.runDeadline("activate",a);
  fail(result);assert.ok(result.elapsed<8000,`elapsed ${result.elapsed}`);assert.equal(await site(h),h.siteEnv);
});
test("review hanging candidate up rolls back within bounded time",async(t)=>{
  const h=await fixture(t),a=await h.bundle("a"),b=await h.bundle("b");ok(h.run("activate",a));const before=await site(h);
  await h.set({hang:"up -d",hangTag:b.tag});const result=await h.runDeadline("activate",b);fail(result);assert.ok(result.elapsed<9500);
  assert.equal(await site(h),before);assert.equal(await h.pointer("current"),`releases/${a.id}`);assert.equal(await exists(path.join(h.root,".activation.journal")),false);
});
test("review hanging recovery down retains journal with distinct bounded failure",async(t)=>{
  const h=await fixture(t),a=await h.bundle("a");await h.set({unhealthy:[a.tag],hang:"down"});const result=await h.runDeadline("activate",a);
  fail(result,3);assert.ok(result.elapsed<8000);assert.equal(await exists(path.join(h.root,".activation.journal")),true);assert.equal(await h.pointer("current"),null);
});
for(const hang of ["container ls","container inspect","image inspect","{{.Image}}"])test(`review hanging metadata ${hang} fails bounded`,async(t)=>{
  const h=await fixture(t),a=await h.bundle("a");await h.set({existingProject:"gateway",hang});
  const result=await h.runDeadline("activate",a);fail(result);assert.ok(result.elapsed<9000,`elapsed ${result.elapsed}`);assert.equal(await site(h),h.siteEnv);
  assert.equal(await h.pointer("current"),null);
});
test("review unsupported timeout fails before service or env mutation",async(t)=>{
  const h=await fixture(t),a=await h.bundle("a");await writeFile(path.join(h.bin,"timeout"),"#!/bin/sh\nexit 127\n",{mode:0o755});
  fail(h.run("activate",a));assert.equal(await site(h),h.siteEnv);assert.equal((await h.events()).length,0);
});
test("review first-install recovery uses authoritative candidate coordinates and site data",async(t)=>{
  const h=await fixture(t),a=await h.bundle("a");Object.assign(h.env,{GATEWAY_DATA_DIR:"/malicious",GATEWAY_IMAGE_TAG:"ambient",GATEWAY_IMAGE_REPOSITORY:"ambient"});
  await h.set({unhealthy:[a.tag]});fail(h.run("activate",a));
  const down=(await h.events()).find(e=>e.args.includes("down"));assert.equal(down.resolvedImage,`fixture-gateway:${a.tag}`);assert.equal(down.resolvedData,path.join(h.root,"data"));assert.equal(down.project,"gateway");
});

test("activate health-gates pointers, preserves site env/mode and never calls host Node", async (t) => {
  const h = await fixture(t), a = await h.bundle("a"), b = await h.bundle("b");
  ok(h.run("activate", a)); ok(h.run("activate", b));
  assert.equal(await h.pointer("current"), `releases/${b.id}`);
  assert.equal(await h.pointer("previous"), `releases/${a.id}`);
  assert.equal(await site(h), h.siteEnv.replace("old-repository", "fixture-gateway").replace("TAG=initial", "TAG=release-b"));
  assert.equal((await lstat(path.join(h.root,".env.appliance"))).mode & 0o777, 0o640);
  assert.equal(await exists(path.join(h.temp,"injected")), false);
  const events = await h.events();
  assert.equal(events.some((e) => e.name === "node"), false);
  assert.equal(events.filter((e) => e.args.includes("up")).at(-1).current, `releases/${a.id}`);
  assert.equal(events.filter((e) => e.args[0] === "inspect").at(-1).current, `releases/${a.id}`);
  assert.equal(await exists(path.join(h.root,".activation.journal")), false);
  assert.equal(await exists(path.join(h.root,"releases",b.id,".env.appliance")), false);
});

test("unhealthy activation restores exact env/pointers and requires previous service health", async (t) => {
  const h = await fixture(t), a = await h.bundle("a"), b = await h.bundle("b");
  ok(h.run("activate", a)); const before = await site(h);
  await h.set({ unhealthy: [b.tag] }); fail(h.run("activate", b));
  assert.equal(await site(h), before); assert.equal(await h.pointer("current"), `releases/${a.id}`);
  assert.equal(await h.pointer("previous"), null);
  assert.equal((await h.events()).filter((e) => e.args.includes("up")).at(-1).tag, a.tag);
  assert.equal(await exists(path.join(h.root,".activation.journal")), false);
});

test("first-install failure brings candidate down and keeps current absent", async (t) => {
  const h = await fixture(t), a = await h.bundle("a"); await h.set({ unhealthy: [a.tag] });
  fail(h.run("activate", a)); assert.equal(await site(h), h.siteEnv);
  assert.equal(await h.pointer("current"), null);
  assert.equal((await h.events()).filter((e) => e.args.includes("down")).length, 1);
  assert.equal(await exists(path.join(h.root,".activation.journal")), false);
});

test("rollback selects only previous and swaps the former current into previous", async (t) => {
  const h = await fixture(t), a = await h.bundle("a"), b = await h.bundle("b");
  ok(h.run("activate", a)); ok(h.run("activate", b));
  fail(h.run("rollback", a), 2); ok(h.run("rollback"));
  assert.equal(await h.pointer("current"), `releases/${a.id}`);
  assert.equal(await h.pointer("previous"), `releases/${b.id}`);
});

for (const phase of phases) test(`interrupted ${phase} journal restores old state before considering new input`, async (t) => {
  const h = await fixture(t), a = await h.bundle("a"), b = await h.bundle("b");
  ok(h.run("activate", a)); const before = await site(h);
  await h.set({ crashPhase: phase }); const crash = h.run("activate", b);
  assert.equal(crash.signal, "SIGKILL", crash.stderr);
  assert.equal(await exists(path.join(h.root,".activation.journal")), true);
  await h.set({ crashPhase: null });
  fail(h.run("activate", { dir: path.join(h.temp,"missing-bundle") }));
  assert.equal(await h.pointer("current"), `releases/${a.id}`);
  assert.equal(await h.pointer("previous"), null); assert.equal(await site(h), before);
  assert.equal(await exists(path.join(h.root,".activation.journal")), false);
});

test("failed recovery retains journal and exits distinctly until old health recovers", async (t) => {
  const h = await fixture(t), a = await h.bundle("a"), b = await h.bundle("b");
  ok(h.run("activate", a)); await h.set({ unhealthy: [a.tag,b.tag] });
  fail(h.run("activate", b), 3);
  assert.equal(await exists(path.join(h.root,".activation.journal")), true);
  await h.set({ unhealthy: [] }); ok(h.run("activate", a));
  assert.equal(await h.pointer("current"), `releases/${a.id}`);
  assert.equal(await exists(path.join(h.root,".activation.journal")), false);
});

for (const option of ["badCompose", "wrongDigest", "noDocker", "failLoad"]) test(`preflight ${option} fails before site mutation`, async (t) => {
  const h = await fixture(t), a = await h.bundle("a"); await h.set({ [option]: true });
  fail(h.run("activate", a)); assert.equal(await site(h), h.siteEnv);
  assert.equal(await h.pointer("current"), null);
  assert.equal(await exists(path.join(h.root,".activation.journal")), false);
  assert.equal((await h.events()).some((e) => e.args.includes("up") || e.args.includes("down")), false);
});

const corruptions = {
  nulEnv: async (h,b) => { const f=path.join(b.dir,"appliance.env"); await writeFile(f,(await readFile(f,"utf8")).replace("GATEWAY_IMAGE_TAG=","GATEWAY_IMAGE_TAG=\0")); await h.checksums(b); },
  tampered: async (h,b) => writeFile(path.join(b.dir,"compose.yml"),"tampered"),
  extra: async (h,b) => writeFile(path.join(b.dir,"extra"),"extra"),
  symlink: async (h,b) => { await rm(path.join(b.dir,"sbom.spdx.json")); await symlink("release-manifest.json",path.join(b.dir,"sbom.spdx.json")); },
  hardlink: async (h,b) => { await rm(path.join(b.dir,"sbom.spdx.json")); await link(path.join(b.dir,"release-manifest.json"),path.join(b.dir,"sbom.spdx.json")); },
  checksumPath: async (h,b) => writeFile(path.join(b.dir,"checksums.sha256"),`${"a".repeat(64)}  ../outside\n`),
  duplicateChecksum: async (h,b) => { const f=path.join(b.dir,"checksums.sha256"); await writeFile(f,(await readFile(f,"utf8"))+(await readFile(f,"utf8")).split("\n")[0]+"\n"); },
  duplicateEnv: async (h,b) => { const f=path.join(b.dir,"appliance.env"); await writeFile(f,(await readFile(f,"utf8"))+"GATEWAY_IMAGE_TAG=another\n"); await h.checksums(b); },
  missingEnv: async (h,b) => { const f=path.join(b.dir,"appliance.env"); await writeFile(f,(await readFile(f,"utf8")).replace(/^GATEWAY_LOCK_SHA256=.*\n/m,"")); await h.checksums(b); },
  injection: async (h,b) => { const f=path.join(b.dir,"appliance.env"); await writeFile(f,(await readFile(f,"utf8")).replace(/^GATEWAY_IMAGE_TAG=.*$/m,`GATEWAY_IMAGE_TAG=$(touch ${h.temp}/injected)`)); await h.checksums(b); },
  testMode: async (h,b) => { const f=path.join(b.dir,"appliance.env"); await writeFile(f,(await readFile(f,"utf8")).replace("GATEWAY_RELEASE_TEST_MODE=0","GATEWAY_RELEASE_TEST_MODE=1")); await h.checksums(b); },
  falseTestMode: async (h,b) => { const f=path.join(b.dir,"appliance.env"); await writeFile(f,(await readFile(f,"utf8")).replace("GATEWAY_RELEASE_TEST_MODE=0","GATEWAY_RELEASE_TEST_MODE=false")); await h.checksums(b); },
  platform: async (h,b) => { const f=path.join(b.dir,"appliance.env"); await writeFile(f,(await readFile(f,"utf8")).replace("GATEWAY_RELEASE_PLATFORM=linux/arm64","GATEWAY_RELEASE_PLATFORM=linux/amd64")); await h.checksums(b); },
  policy: async (h,b) => { const f=path.join(b.dir,"appliance.env"); await writeFile(f,(await readFile(f,"utf8")).replace(policyHash,"0".repeat(64))); await h.checksums(b); },
  releaseId: async (h,b) => { const f=path.join(b.dir,"appliance.env"); await writeFile(f,(await readFile(f,"utf8")).replace(/^GATEWAY_RELEASE_ID=.*$/m,"GATEWAY_RELEASE_ID=other")); await h.checksums(b); },
  archive: async (h,b) => { const f=path.join(b.dir,"appliance.env"); await writeFile(f,(await readFile(f,"utf8")).replace("gateway-image-linux-arm64.tar","../image.tar")); await h.checksums(b); }
};
for (const [name, corrupt] of Object.entries(corruptions)) test(`verify rejects ${name} without mutation or shell evaluation`, async (t) => {
  const h = await fixture(t), a = await h.bundle("a"); await corrupt(h,a);
  fail(h.run("verify",a)); assert.equal(await exists(path.join(h.temp,"injected")),false);
  assert.equal(await site(h),h.siteEnv); assert.equal((await h.events()).length,0);
});

test("missing or escaping identity and unsafe release root fail before service mutation", async (t) => {
  const h = await fixture(t), a=await h.bundle("a");
  await rm(path.join(h.root,"data/identity/device/current"));
  await symlink(h.temp,path.join(h.root,"data/identity/device/current"));
  fail(h.run("activate",a)); assert.equal(await site(h),h.siteEnv);
  assert.equal((await h.events()).some(e=>e.args.includes("up")),false);
});

test("an immutable release ID conflict is refused without overwriting either directory", async (t) => {
  const h = await fixture(t), a=await h.bundle("a");
  await mkdir(path.join(h.root,"releases",a.id),{recursive:true});
  await writeFile(path.join(h.root,"releases",a.id,"sentinel"),"keep");
  fail(h.run("activate",a));
  assert.equal(await readFile(path.join(h.root,"releases",a.id,"sentinel"),"utf8"),"keep");
  assert.equal(await site(h),h.siteEnv);
});

test("symlinked releases and missing disposable sentinel fail closed", async (t) => {
  const h=await fixture(t), a=await h.bundle("a");
  await symlink(h.temp,path.join(h.root,"releases"));
  fail(h.run("activate",a)); assert.equal(await site(h),h.siteEnv);
  await rm(path.join(h.root,"releases"));
  await rm(path.join(h.root,".gateway-release-disposable-root"));
  fail(h.run("activate",a)); assert.equal(await site(h),h.siteEnv);
  assert.equal((await h.events()).some(e=>e.args.includes("up")),false);
});

test("corrupt interrupted journal/snapshot is retained without evaluating text or applying a service", async (t) => {
  const h=await fixture(t), a=await h.bundle("a"), b=await h.bundle("b");
  ok(h.run("activate",a)); await h.set({crashPhase:"prepared"});
  assert.equal(h.run("activate",b).signal,"SIGKILL"); await h.set({crashPhase:null});
  const before=await site(h), upCount=(await h.events()).filter(e=>e.args.includes("up")).length;
  await writeFile(path.join(h.root,".activation-env.snapshot"),"tampered snapshot\n",{mode:0o600});
  fail(h.run("activate",b),3); assert.equal(await site(h),before);
  assert.equal((await h.events()).filter(e=>e.args.includes("up")).length,upCount);
  const journal=path.join(h.root,".activation.journal");
  await writeFile(journal,`SCHEMA=$(touch ${h.temp}/injected)\n`,{mode:0o600});
  fail(h.run("activate",b),3);
  assert.equal(await exists(path.join(h.temp,"injected")),false);
  assert.equal(await exists(journal),true);
});

test("explicit rollback failure with unhealthy original retains recovery journal", async (t) => {
  const h=await fixture(t), a=await h.bundle("a"), b=await h.bundle("b");
  ok(h.run("activate",a)); ok(h.run("activate",b)); const before=await site(h);
  await h.set({unhealthy:[a.tag,b.tag]}); fail(h.run("rollback"),3);
  assert.equal(await site(h),before);
  assert.equal(await h.pointer("current"),`releases/${b.id}`);
  assert.equal(await h.pointer("previous"),`releases/${a.id}`);
  assert.equal(await exists(path.join(h.root,".activation.journal")),true);
});

test("shared flock excludes a concurrent appliance operation", async (t) => {
  const h=await fixture(t), a=await h.bundle("a");
  const holder=spawn("/bin/bash",["-c",'exec 9>"$1/.appliance-operation.lock"; flock -n 9 || exit 1; printf ready; read -r unused',"holder",h.root],{env:h.env,stdio:["pipe","pipe","pipe"]});
  try {
    await new Promise((resolve,reject)=>{holder.stdout.once("data",resolve);holder.once("error",reject);holder.once("exit",code=>reject(new Error(`lock holder exited ${code}`)));});
    fail(h.run("activate",a),4); assert.equal(await site(h),h.siteEnv);
  } finally { holder.stdin.end("done\n"); await new Promise(resolve=>holder.once("close",resolve)); }
});

test("deploy transfers only bundle and trusted manager into one unique remote staging directory", async (t) => {
  const h=await fixture(t), a=await h.bundle("a");
  const result=spawnSync("/bin/bash",[deploy,"fixture@example.invalid",a.dir],{env:h.env,encoding:"utf8",timeout:15000});
  ok(result);
  const events=await h.events(), transfers=events.filter(e=>e.name==='scp');
  assert.equal(transfers.length,1);
  assert.deepEqual(transfers[0].args,["-r",a.dir,manager,"fixture@example.invalid:/tmp/led-control-gateway-upload.ABC123/"]);
  const activation=events.filter(e=>e.name==='ssh').find(e=>e.args.some(arg=>arg.includes('activate')));
  assert.ok(activation); assert.ok(activation.args.some(arg=>arg.includes(policyHash)));
});
