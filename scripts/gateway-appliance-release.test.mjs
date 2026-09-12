import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { link, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture, policyHash } from "./gateway-appliance-fixture.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const manager = path.join(repository, "scripts/gateway-appliance-release.sh");
const deploy = path.join(repository, "scripts/gateway-appliance-deploy.sh");
const phases = ["prepared", "env_switched", "service_started", "healthy", "previous_switched", "current_switched"];

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
test("review legacy gateway project with verified current is inherited consistently",async(t)=>{
  const h=await fixture(t),a=await h.bundle("a"),b=await h.bundle("b");ok(h.run("activate",a));await h.set({existingProject:"gateway"});ok(h.run("activate",b));
  for(const event of (await h.events()).filter(e=>e.args[0]==="compose"&&e.project))assert.equal(event.project,"gateway");
});
for (const project of ["gateway", "led-control-gateway"]) test(`legacy service without verified current requires baseline registration: ${project}`, async (t) => {
  const h = await fixture(t), candidate = await h.bundle("a");
  await h.set({ existingProject: project });
  const serviceFiles = [h.config + ".active", h.config + ".owner", h.config + ".active.image"];
  for (const [index, value] of ["legacy-site-image", project, "sha256:" + "f".repeat(64)].entries()) await writeFile(serviceFiles[index], value);
  const files = [path.join(h.root, ".env.appliance"), ...serviceFiles];
  const before = await Promise.all(files.map(async (file) => ({ bytes: await readFile(file), mode: (await lstat(file)).mode })));
  const result = h.run("activate", candidate);
  fail(result);
  assert.match(result.stderr, /verified baseline.*(?:migration|registration)/i);
  for (const [index, file] of files.entries()) {
    assert.deepEqual(await readFile(file), before[index].bytes);
    assert.equal((await lstat(file)).mode, before[index].mode);
  }
  assert.equal(await h.pointer("current"), null); assert.equal(await h.pointer("previous"), null);
  assert.equal(await exists(path.join(h.root, ".activation.journal")), false);
  assert.equal(await exists(path.join(h.root, ".activation-env.snapshot")), false);
  assert.equal(await exists(path.join(h.root, "releases", candidate.id)), false);
  assert.equal((await h.events()).some(e => e.args.includes("up") || e.args.includes("down") || e.args.includes("load") || e.args.includes("config")), false);
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
  const h=await fixture(t),a=await h.bundle("a"),b=await h.bundle("b");ok(h.run("activate",a));const before=await site(h);await h.set({existingProject:"gateway",hang,hangTag:b.tag});
  const result=await h.runDeadline("activate",b);fail(result);assert.ok(result.elapsed<9000,`elapsed ${result.elapsed}`);assert.equal(await site(h),before);
  assert.equal(await h.pointer("current"),`releases/${a.id}`);
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
  assert.deepEqual(transfers[0].args,["-r",a.dir,manager,path.join(repository,"scripts/gateway-appliance-common.sh"),"fixture@example.invalid:/tmp/led-control-gateway-upload.ABC123/"]);
  const activation=events.filter(e=>e.name==='ssh').find(e=>e.args.some(arg=>arg.includes('activate')));
  assert.ok(activation); assert.ok(activation.args.some(arg=>arg.includes(policyHash)));
});
