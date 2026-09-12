import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const source = path.resolve(import.meta.dirname, "..");
const flow = "backup is encrypted, binds the exact release and recipient, and round-trips all roots";

// Only Docker/build/contract subprocesses are doubles. The real CI CLI owns
// ordering, environment, rejection decisions, interruption and filesystem cleanup.
async function fixture(t, fail = "") {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "release-ci-contract-")));
  const root = path.join(temp, "repo"), bin = path.join(temp, "bin"), trace = path.join(temp, "trace.jsonl");
  t.after(async () => {
    if (fail === "descendant") await new Promise(resolve => setTimeout(resolve, 2500));
    for (const event of (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse)) {
      if (event.plaintext && path.dirname(event.plaintext) === await realpath("/tmp") && /^\.gateway-state\.[A-Za-z0-9]{6}$/.test(path.basename(event.plaintext))) await rm(event.plaintext, { recursive: true, force: true });
    }
    await rm(temp, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "scripts"), { recursive: true }); await mkdir(bin);
  await copyFile(path.join(source, "scripts/gateway-release-ci.mjs"), path.join(root, "scripts/gateway-release-ci.mjs"));
  await copyFile(path.join(source, "scripts/gateway-appliance-common.sh"), path.join(root, "scripts/gateway-appliance-common.sh"));
  const boundary = `const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');
const args=process.argv.slice(2),name=path.basename(process.argv[1]);
const log=x=>fs.appendFileSync(process.env.CI_FIXTURE_TRACE,JSON.stringify(x)+'\\n');
log({name,args,tmp:process.env.TMPDIR,output:process.env.GATEWAY_APPLIANCE_OUTPUT_DIR,platform:process.env.GATEWAY_RELEASE_PLATFORM,testMode:process.env.GATEWAY_RELEASE_TEST_MODE,repository:process.env.GATEWAY_IMAGE_REPOSITORY,tag:process.env.GATEWAY_IMAGE_TAG});
const fail=process.env.CI_FIXTURE_FAIL;
if(name==='openssl')process.exit(fail==='openssl'?1:0);
if(name==='docker'){
 if(args[0]==='buildx')process.exit(fail==='buildx'?1:0);
 if(args[0]==='version')process.exit(fail==='docker'?1:0);
 if(args[0]==='run'){if(fail==='smoke')process.exit(1);console.log(JSON.stringify({node:'22.20.0',platform:'linux/x64',inventorySha256:'1'.repeat(64),osPackages:1,nodePackages:1}));}
 if(args[0]==='image'&&args[1]==='load')process.exit(fail==='load'?1:0);
 if(args[0]==='image'&&args[1]==='inspect')console.log(['sha256:'+(fail==='identity'?'0':'3').repeat(64),cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),'0.1.0','4'.repeat(64),'true'].join('|'));
 if(args[0]==='container'&&args[1]==='inspect')console.log('sha256:'+'3'.repeat(64));
 if(args[0]==='image'&&args[1]==='ls'){if(fail==='cleanup')process.exit(1);if(fs.existsSync(process.env.CI_FIXTURE_TRACE+'.image'))console.log('sha256:'+'2'.repeat(64));}
 if(args[0]==='image'&&args[1]==='rm')fs.rmSync(process.env.CI_FIXTURE_TRACE+'.image',{force:true});
 if(args[0]==='ps'&&args.some(x=>x.startsWith('ancestor='))&&fail==='foreign')console.log('aaaaaaaaaaaa');
 if(args[0]==='rm'&&args.includes('aaaaaaaaaaaa'))fs.rmSync(process.env.CI_FIXTURE_TRACE+'.foreign',{force:true});
 process.exit(0);
}
if(name==='fixture-build.cjs'){
 const output=process.env.GATEWAY_APPLIANCE_OUTPUT_DIR;fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(process.env.CI_FIXTURE_TRACE+'.image','owned');if(fail==='build')process.exit(1);
 if(fail==='interrupt'){log({ready:true});setInterval(()=>{},1000);return;}
 if(fail==='descendant'){cp.spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync(process.env.CI_FIXTURE_TRACE+'.descendant','finished'),2000)"],{stdio:'ignore'}).unref();process.exit(1);}
 const dir=path.join(output,'fixture-test');fs.mkdirSync(dir);fs.mkdirSync(path.join(dir,'docker'));
 const manifest={releaseId:'fixture-test',gitCommit:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),gatewayVersion:'0.1.0',policySha256:'4'.repeat(64),testMode:true,platform:'linux/amd64',inventorySha256:'1'.repeat(64),image:{repository:process.env.GATEWAY_IMAGE_REPOSITORY,tag:process.env.GATEWAY_IMAGE_TAG+'-test',configDigest:'sha256:'+'2'.repeat(64),descriptorDigest:'sha256:'+'3'.repeat(64)}};
 for(const name of ['appliance.env','checksums.sha256','compose.yml','docker/seccomp-bluez-mesh.json','gateway-image-linux-amd64.tar','sbom.spdx.json'])fs.writeFileSync(path.join(dir,name),'fixture');
 fs.writeFileSync(path.join(dir,'release-manifest.json'),JSON.stringify(manifest));process.exit(0);
}
if(name==='gateway-release-bundle.mjs'){
 if(args.includes('--allow-test-mode'))process.exit(fail==='verify'?1:0);
 if(fail==='accept-production')process.exit(0);
 console.error(fail==='wrong-rejection'?'unrelated failure':'test-mode bundle is forbidden for production activation');process.exit(1);
}
`;
  for (const name of ["docker", "openssl"]) {
    await writeFile(path.join(bin, name), `#!${process.execPath}\n${boundary}`, { mode: 0o755 });
  }
  await writeFile(path.join(root, "scripts/fixture-build.cjs"), boundary);
  await writeFile(path.join(root, "scripts/gateway-appliance-build.sh"), `#!/bin/bash\nexec '${process.execPath}' scripts/fixture-build.cjs\n`, { mode: 0o755 });
  await writeFile(path.join(root, "scripts/gateway-release-bundle.mjs"), `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);\n${boundary.replace("return;", "process.exit(1);")}`);
  for (const name of ["gateway-release-bundle.test.mjs", "gateway-appliance-release.test.mjs", "gateway-appliance-scripts.test.mjs", "gateway-appliance-state.test.mjs"]) {
    await writeFile(path.join(root, "scripts", name), `import test from 'node:test';import fs from 'node:fs';import cp from 'node:child_process';test(${JSON.stringify(name.includes("state") ? flow : name)},()=>{fs.appendFileSync(process.env.CI_FIXTURE_TRACE,JSON.stringify({contract:${JSON.stringify(name)}})+'\\n');if(process.env.CI_FIXTURE_FAIL==='contracts')throw Error('contract rejected');${name.includes("state") ? `const p=cp.spawnSync('mktemp',['-d',fs.realpathSync('/tmp')+'/.gateway-state.XXXXXX'],{encoding:'utf8'});if(p.status!==0)throw Error('mktemp failed');const plaintext=fs.realpathSync(p.stdout.trim());fs.writeFileSync(plaintext+'/fixture','disposable');fs.appendFileSync(process.env.CI_FIXTURE_TRACE,JSON.stringify({plaintext})+'\\n');if(process.env.CI_FIXTURE_FAIL==='state')throw Error('state flow rejected');` : ""}});\n`);
  }
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: root, encoding: "utf8" }).status, 0);
  git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI_FIXTURE_TRACE: trace, CI_FIXTURE_FAIL: fail };
  // A subprocess CLI is not itself a node:test worker. Otherwise Node silently
  // suppresses its child --test invocation and the fixture never runs contracts.
  delete env.NODE_TEST_CONTEXT;
  return { root, trace, env, run: () => spawnSync(process.execPath, [path.join(root, "scripts/gateway-release-ci.mjs")], { cwd: root, env, encoding: "utf8", timeout: 30000 }),
    events: async () => (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse) };
}
async function assertClean(h) {
  for (const event of await h.events()) if (event.output) {
    await assert.rejects(readFile(path.join(event.output, "fixture-test/release-manifest.json")), { code: "ENOENT" });
    await assert.rejects(readdir(path.dirname(event.output)), { code: "ENOENT" });
  }
  for (const event of await h.events()) if (event.plaintext) await assert.rejects(readdir(event.plaintext), { code: "ENOENT" });
  await assert.rejects(readFile(h.trace + ".image"), { code: "ENOENT" });
}

test("release CI executes contracts, marked amd64 build, default rejection, smoke and exact encrypted flow then cleans", async (t) => {
  const h = await fixture(t), result = h.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const events = await h.events(), build = events.find((e) => e.name === "fixture-build.cjs");
  assert.equal(build.platform, "linux/amd64"); assert.equal(build.testMode, "1");
  const stage = (predicate) => events.findIndex(predicate);
  assert.ok(stage(e => e.contract) < stage(e => e.name === "fixture-build.cjs"));
  assert.ok(stage(e => e.name === "gateway-release-bundle.mjs" && !e.args.includes("--allow-test-mode")) < stage(e => e.args?.[0] === "run"));
  assert.ok(stage(e => e.args?.[0] === "run") < stage(e => e.contract?.includes("state")));
  const loaded = stage(e => e.args?.[0] === "image" && e.args[1] === "load");
  assert.ok(loaded >= 0 && loaded < stage(e => e.args?.[0] === "run"), "real image load must precede smoke");
  assert.ok(stage(e => e.args?.[0] === "container" && e.args[1] === "inspect") > stage(e => e.args?.[0] === "run"), "running daemon identity must be compared");
  const smoke = events.find(e => e.args?.[0] === "run");
  for (const flag of ["--name", "--read-only", "--network", "none", "--entrypoint", "node"]) assert.ok(smoke.args.includes(flag));
  assert.match(result.stdout, /cleanup complete/); await assertClean(h);
});
for (const fail of ["contracts", "build", "verify", "accept-production", "wrong-rejection", "load", "identity", "smoke", "state", "docker", "buildx", "openssl"]) {
  test(`release CI fails closed at ${fail} and removes owned output/images`, async (t) => {
    const h = await fixture(t, fail), result = h.run(); assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /release CI passed/);
    if (["docker", "buildx", "openssl", "contracts"].includes(fail)) assert.equal((await h.events()).some(e => e.name === "fixture-build.cjs"), false);
    await assertClean(h);
  });
}
test("release CI rejects dirty source before external boundaries", async (t) => {
  const h = await fixture(t); await writeFile(path.join(h.root, "dirty"), "uncommitted");
  const result = h.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /clean/); assert.deepEqual(await h.events(), []);
});
test("release CI never removes a foreign container sharing its image digest", async (t) => {
  const h = await fixture(t, "foreign"); await writeFile(h.trace + ".foreign", "unrelated service");
  const result = h.run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(h.trace + ".foreign", "utf8"), "unrelated service"); await assertClean(h);
});
test("release CI drains an owned descendant after its launcher exits before removing staging", async (t) => {
  const h = await fixture(t, "descendant"), result = h.run(); assert.equal(result.status, 1);
  assert.equal(await readFile(h.trace + ".descendant", "utf8"), "finished"); await assertClean(h);
});

for (const fail of [false, true]) test(`production audit invokes the Gateway gate once and ${fail ? "stops at rejection" : "continues to existing downstream gates"}`, async (t) => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "release-audit-contract-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const trace = path.join(temp, "events"), bin = path.join(temp, "bin"); await mkdir(bin);
  for (const name of ["docker", "node", "pnpm"]) await writeFile(path.join(bin, name), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({name:${JSON.stringify(name)},args})+'\\n');process.exit(${fail ? "true" : "false"}&&${JSON.stringify(name)}==='pnpm'&&args[0]==='gateway:release:ci'?17:0);\n`, { mode: 0o755 });
  const result = spawnSync("/bin/bash", [path.join(source, "scripts/ci-production-audit.sh")], { cwd: temp, env: { PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  assert.equal(result.status, fail ? 17 : 0, result.stderr);
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.name === "pnpm" && e.args[0] === "gateway:release:ci").length, 1);
  assert.equal(events.some(e => e.args.includes("test:bundle-audit")), !fail);
  assert.equal(events.some(e => e.args.includes("audit:production")), !fail);
});
test("release CI treats cleanup failure as a failed gate", async (t) => {
  const h = await fixture(t, "cleanup"), result = h.run(); assert.equal(result.status, 3); assert.match(result.stderr, /cleanup failed/);
  // The fixture image sentinel is not a Docker image; only the failing test owns it.
});
test("release CI TERM interrupts the owned build and removes its image and staging", async (t) => {
  const h = await fixture(t, "interrupt"), child = spawn(process.execPath, [path.join(h.root, "scripts/gateway-release-ci.mjs")], { cwd: h.root, env: h.env, stdio: "ignore" });
  const done = new Promise(resolve => child.on("exit", resolve));
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const deadline = Date.now() + 15000;
  while (!(await h.events()).some(e => e.ready)) { assert.ok(Date.now() < deadline, "build readiness deadline"); await new Promise(resolve => setTimeout(resolve, 20)); }
  child.kill("SIGTERM"); assert.equal(await done, 143); await assertClean(h);
});
