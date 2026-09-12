import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applianceEnv } from "./gateway-release-bundle.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const manager = path.join(repository, "scripts/gateway-appliance-release.sh");
const sha = (value) => createHash("sha256").update(value).digest("hex");
export const policyHash = sha(await readFile(path.join(repository, "apps/gateway/release-policy.json")));

export async function fixture(t) {
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
  let statePhase; try { statePhase=fs.readFileSync(path.join(c.root,'.state.journal'),'utf8').match(/^PHASE=(.*)$/m)?.[1]; } catch {}
  if(c.stateCrash && statePhase===c.stateCrash && args[1]===c.root && !fs.existsSync(process.env.RELEASE_SHIM_CONFIG+'.state-crashed')) {
    fs.writeFileSync(process.env.RELEASE_SHIM_CONFIG+'.state-crashed','1'); process.kill(process.ppid,'SIGKILL');
  }
  process.exit(0);
}
if(name==='mv') {
  const paths=args.filter(x=>!x.startsWith('-'));
  if(c.failSwap && paths[0].endsWith('/new/'+c.failSwap) && !fs.existsSync(process.env.RELEASE_SHIM_CONFIG+'.swap-failed')) {
    fs.writeFileSync(process.env.RELEASE_SHIM_CONFIG+'.swap-failed','1'); process.exit(1);
  }
  fs.renameSync(paths[0],paths[1]);
  if(c.stateCrashRename && !fs.existsSync(process.env.RELEASE_SHIM_CONFIG+'.rename-crashed')) {
    const root=path.basename(paths[1]);
    const boundary=paths[0].endsWith('/new/'+root)?'new_'+root:paths[0].endsWith('/old/'+root)?'rollback_'+root:null;
    if(boundary===c.stateCrashRename) {fs.writeFileSync(process.env.RELEASE_SHIM_CONFIG+'.rename-crashed','1');process.kill(process.ppid,'SIGKILL');}
  }
  process.exit(0);
}
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
  if(args.includes('stop')) {
    if(c.failStop)process.exit(1); fs.writeFileSync(activeFile,''); process.exit(0);
  }
  if(args.includes('up')) {
    if(c.failRecovery && fs.readFileSync(path.join(resolvedData,'gateway/command-journal.json'),'utf8').includes('live-newer'))process.exit(1);
    fs.writeFileSync(activeFile,resolvedTag); fs.writeFileSync(ownerFile,project);
    fs.writeFileSync(activeFile+'.image',c.wrongRunningTag===resolvedTag?'sha256:'+'0'.repeat(64):c.images[resolvedImage]||'missing');
    process.exit(c.failUp===resolvedTag?1:0);
  }
  if(args.includes('down')) { fs.writeFileSync(activeFile,''); process.exit(c.failDown?1:0); }
}
if(args[0]==='inspect') {
  const active=fs.existsSync(activeFile)?fs.readFileSync(activeFile,'utf8'):'';
  let stateUnhealthy=false;
  if(c.unhealthyState)try { stateUnhealthy=fs.readFileSync(path.join(resolvedData,'gateway/command-journal.json'),'utf8').includes(c.unhealthyState); } catch {}
  const health=c.unhealthy.includes(active)||stateUnhealthy?'unhealthy':active?'healthy':'starting';
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
