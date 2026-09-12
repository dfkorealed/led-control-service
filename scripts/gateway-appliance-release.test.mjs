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
  const shim = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const c = JSON.parse(fs.readFileSync(process.env.RELEASE_SHIM_CONFIG));
const args = process.argv.slice(2), name = path.basename(process.argv[1]);
const file = path.join(c.root, '.env.appliance');
const env = fs.readFileSync(file, 'utf8');
const tag = env.match(/^GATEWAY_IMAGE_TAG=(.*)$/m)?.[1];
const pointer = (name) => { try { return fs.readlinkSync(path.join(c.root,name)); } catch { return null; } };
fs.appendFileSync(process.env.RELEASE_SHIM_TRACE, JSON.stringify({name,args,tag,current:pointer('current'),previous:pointer('previous')})+'\\n');
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
if(args[0]==='version' || (args[0]==='compose' && args[1]==='version')) process.exit(c.noDocker?1:0);
if(args[0]==='image' && args[1]==='load') process.exit(c.failLoad?1:0);
if(args[0]==='image' && args[1]==='inspect') { console.log(c.wrongDigest ? 'sha256:'+ '0'.repeat(64) : c.images[args.at(-1)] || 'missing'); process.exit(0); }
if(args[0]==='compose') {
  if(args.includes('config')) process.exit(c.badCompose?1:0);
  if(args.includes('up')) { fs.writeFileSync(process.env.RELEASE_SHIM_CONFIG+'.active', tag); process.exit(c.failUp===tag?1:0); }
  if(args.includes('down')) { fs.writeFileSync(process.env.RELEASE_SHIM_CONFIG+'.active',''); process.exit(c.failDown?1:0); }
}
if(args[0]==='inspect') {
  const active=fs.existsSync(process.env.RELEASE_SHIM_CONFIG+'.active') ? fs.readFileSync(process.env.RELEASE_SHIM_CONFIG+'.active','utf8') : '';
  console.log(c.unhealthy.includes(active)?'unhealthy':active?'healthy':'starting'); process.exit(0);
}
process.exit(9);
`;
  for (const name of ["docker", "sync", "mv", "node", "ssh", "scp"]) {
    await writeFile(path.join(bin, name), shim, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_SHIM_CONFIG: config, RELEASE_SHIM_TRACE: trace };
  const set = async (values) => writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(config)), ...values }));
  const run = (command, bundle, extra = []) => spawnSync("/bin/bash", [manager, command, ...(bundle ? [bundle.dir] : []), "--policy-sha256", policyHash, "--test-root", root, ...extra], { env, encoding: "utf8", timeout: 15000 });
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
  return { root, bin, temp, env, siteEnv, bundle, checksums, run, set, events, pointer, config };
}
const ok = (result) => assert.equal(result.status, 0, result.stderr || String(result.error));
const fail = (result, status = 1) => assert.equal(result.status, status, result.stdout + result.stderr);
const site = (h) => readFile(path.join(h.root, ".env.appliance"), "utf8");
const exists = async (file) => lstat(file).then(() => true, () => false);

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
