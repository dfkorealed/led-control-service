import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const stateFlow = "backup is encrypted, binds the exact release and recipient, and round-trips all roots";
let active, forwardedSignal = false, interrupted = 0, workspace, tempBase, image, dockerReady = false;
const nonce = randomUUID().replaceAll("-", "");
const smokeName = `gateway-release-ci-${nonce}`;
const inventoryName = `${smokeName}-inventory`;
const childEnv = { ...process.env, FORCE_COLOR: "0" };

// Each subprocess has a private process group. Drain it before cleanup so a
// terminated builder/test cannot keep writing into directories being removed.
for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(signal, () => {
  interrupted ||= status;
  // Never signal a process-group identifier after its launcher has exited: it
  // may be reused. Existing descendants are drained before resource cleanup.
  if (!forwardedSignal && active?.pid && active.exitCode === null && active.signalCode === null) {
    forwardedSignal = true;
    try { process.kill(-active.pid, signal); } catch (error) { if (error.code !== "ESRCH") process.stderr.write("could not interrupt owned child\n"); }
  }
});
async function drainProcessGroup(pid) {
  for (;;) {
    try { process.kill(-pid, 0); } catch (error) {
      if (error.code === "ESRCH") return;
      if (error.code !== "EPERM") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function run(command, args, { quiet = false, allowFailure = false, cleanup = false, env = childEnv } = {}) {
  if (interrupted && !cleanup) throw Error("release CI interrupted");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    active = child;
    forwardedSignal = false;
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout = (stdout + bytes).slice(-4 * 1024 * 1024); if (!quiet) process.stdout.write(bytes); });
    child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-4 * 1024 * 1024); if (!quiet) process.stderr.write(bytes); });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status: status ?? 1, signal, stdout, stderr, pid: child.pid }));
  });
  active = undefined;
  await drainProcessGroup(result.pid);
  if (interrupted && !cleanup) throw Error("release CI interrupted");
  if (result.status !== 0 && !allowFailure) throw Error(`${command} failed (${result.status})`);
  return result;
}
async function removeOwned(directory, parent, pattern) {
  assert.equal(path.dirname(directory), parent, "cleanup parent mismatch");
  assert.match(path.basename(directory), pattern, "cleanup basename mismatch");
  const info = await lstat(directory).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (!info) return;
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), "cleanup target must remain a real directory");
  assert.equal(await realpath(parent), parent, "cleanup parent must remain physical");
  async function writable(current) {
    await chmod(current, 0o700);
    for (const entry of await readdir(current, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(current, entry.name));
  }
  await writable(directory);
  await rm(directory, { recursive: true });
  await assert.rejects(lstat(directory), { code: "ENOENT" });
}
async function cleanup() {
  const failures = [];
  const attempt = async action => { try { await action(); } catch { failures.push("owned resource cleanup failed"); } };
  if (dockerReady && image) await attempt(async () => {
    // Image digests can be shared by unrelated containers. Only these exact
    // invocation-owned names are eligible, never an ancestor/image-wide prune.
    for (const name of [inventoryName, smokeName]) {
      const named = await run("docker", ["ps", "-aq", "--filter", `name=^/${name}$`], { quiet: true, cleanup: true });
      for (const id of named.stdout.trim().split(/\s+/).filter(Boolean)) {
        assert.match(id, /^[a-f0-9]{12,64}$/);
        await run("docker", ["rm", "-f", id], { quiet: true, cleanup: true });
      }
      assert.equal((await run("docker", ["ps", "-aq", "--filter", `name=^/${name}$`], { quiet: true, cleanup: true })).stdout.trim(), "", "test container remains");
    }
    const images = await run("docker", ["image", "ls", "--quiet", "--filter", `reference=${image}`], { quiet: true, cleanup: true });
    if (images.stdout.trim()) await run("docker", ["image", "rm", "-f", image], { quiet: true, cleanup: true });
    assert.equal((await run("docker", ["image", "ls", "--quiet", "--filter", `reference=${image}`], { quiet: true, cleanup: true })).stdout.trim(), "", "test image remains");
  });
  if (workspace) {
    // State deliberately ignores TMPDIR. The forwarding observer records only
    // actual mktemp allocations for this invocation, not a global /tmp glob.
    await attempt(async () => {
      const observed = await readFile(path.join(workspace, "state-workspaces"), "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return ""; });
      for (const directory of new Set(observed.trim().split("\n").filter(Boolean))) await removeOwned(directory, tempBase, /^\.gateway-state\.[A-Za-z0-9]{6}$/);
    });
    await attempt(() => removeOwned(workspace, tempBase, /^gateway-release-ci-[A-Za-z0-9]{6}$/));
  }
  if (failures.length) throw Error("release CI cleanup failed; inspect owned resource evidence");
  process.stdout.write("Gateway release CI cleanup complete: owned images, containers, artifacts, keys and plaintext removed\n");
}

let status = 0;
try {
  assert.equal(process.platform === "win32", false, "release CI requires POSIX process groups");
  assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "build/CI requires Node 22+");
  assert.equal((await run("git", ["status", "--porcelain", "--untracked-files=all"], { quiet: true })).stdout.trim(), "", "release CI requires a clean checkout");
  const commit = (await run("git", ["rev-parse", "HEAD"], { quiet: true })).stdout.trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  await run("docker", ["version"], { quiet: true });
  await run("docker", ["info"], { quiet: true });
  await run("docker", ["buildx", "version"]);
  await run("openssl", ["version"]);
  dockerReady = true;
  tempBase = await realpath("/tmp");
  workspace = await mkdtemp(path.join(tempBase, "gateway-release-ci-"));
  await chmod(workspace, 0o700);
  childEnv.TMPDIR = path.join(workspace, "fixtures");
  await mkdir(childEnv.TMPDIR, { mode: 0o700 });
  const observerBin = path.join(workspace, "bin"); await mkdir(observerBin, { mode: 0o700 });
  const mktemp = (await run("/bin/sh", ["-c", "command -v mktemp"], { quiet: true })).stdout.trim();
  await writeFile(path.join(observerBin, "mktemp"), `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');const r=cp.spawnSync(${JSON.stringify(mktemp)},process.argv.slice(2),{encoding:'utf8'});if(r.status===0&&/^\\.gateway-state\\.[A-Za-z0-9]{6}$/.test(path.basename(r.stdout.trim())))fs.appendFileSync(${JSON.stringify(path.join(workspace, "state-workspaces"))},r.stdout);process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);\n`, { mode: 0o700 });
  childEnv.PATH = `${observerBin}:${childEnv.PATH}`;
  process.stdout.write("Gateway release CI: artifact/activation contracts (serial)\n");
  await run(process.execPath, ["--test", "--test-concurrency=1", "scripts/gateway-release-bundle.test.mjs", "scripts/gateway-appliance-release.test.mjs", "scripts/gateway-appliance-scripts.test.mjs"]);
  const repository = "led-control-gateway-ci", tag = nonce;
  image = `${repository}:${tag}-test`;
  const output = path.join(workspace, "bundles");
  const docker = (await run("/bin/sh", ["-c", "command -v docker"], { quiet: true })).stdout.trim();
  const builderBin = path.join(workspace, "builder-bin"); await mkdir(builderBin, { mode: 0o700 });
  // Forward to the real Docker CLI, adding only an owned container name to the
  // builder's inventory read. This is not a Docker/image-content test double.
  await writeFile(path.join(builderBin, "docker"), `#!${process.execPath}\nconst cp=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='run'&&!args.includes('--name'))args.splice(1,0,'--name',${JSON.stringify(inventoryName)});const r=cp.spawnSync(${JSON.stringify(docker)},args,{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o700 });
  process.stdout.write("Gateway release CI: real linux/amd64 test-only image/bundle\n");
  await run("/bin/bash", ["scripts/gateway-appliance-build.sh"], { env: { ...childEnv, PATH: `${builderBin}:${childEnv.PATH}`, GATEWAY_RELEASE_TEST_MODE: "1", GATEWAY_RELEASE_PLATFORM: "linux/amd64", GATEWAY_IMAGE_REPOSITORY: repository, GATEWAY_IMAGE_TAG: tag, GATEWAY_APPLIANCE_OUTPUT_DIR: output } });
  const directories = await readdir(output); assert.equal(directories.length, 1, "builder must leave exactly one bundle");
  const bundle = path.join(output, directories[0]);
  const manifest = JSON.parse(await readFile(path.join(bundle, "release-manifest.json"), "utf8"));
  assert.equal(manifest.gitCommit, commit); assert.equal(manifest.testMode, true); assert.equal(manifest.platform, "linux/amd64");
  assert.equal(`${manifest.image.repository}:${manifest.image.tag}`, image);
  const verify = ["scripts/gateway-release-bundle.mjs", "verify", "--bundle", bundle, "--policy", path.join(root, "apps/gateway/release-policy.json"), "--expected-commit", commit];
  await run(process.execPath, [...verify, "--allow-test-mode"]);
  const rejected = await run(process.execPath, verify, { quiet: true, allowFailure: true });
  assert.equal(rejected.status, 1, "default production verify must reject the test bundle");
  assert.match(rejected.stderr, /test-mode bundle is forbidden for production activation/);
  process.stdout.write("Default production verification rejected the test-only bundle (exit 1)\n");
  const smokeCode = `const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');const bytes=fs.readFileSync('/usr/local/share/gateway-release-inventory.json');const i=JSON.parse(bytes);assert.equal(process.versions.node.split('.')[0],'22');assert.equal(i.node.version,process.versions.node);assert.equal(i.schema,'led-control-gateway-inventory/v1');assert.ok(i.os.packages.length>0&&i.node.packages.length>0);console.log(JSON.stringify({node:process.versions.node,platform:process.platform+'/'+process.arch,inventorySha256:crypto.createHash('sha256').update(bytes).digest('hex'),osPackages:i.os.packages.length,nodePackages:i.node.packages.length}));`;
  const smoke = await run("docker", ["run", "--rm", "--name", smokeName, "--platform", "linux/amd64", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node", image, "-e", smokeCode]);
  const facts = JSON.parse(smoke.stdout);
  assert.match(facts.node, /^22\./); assert.equal(facts.platform, "linux/x64");
  assert.equal(facts.inventorySha256, manifest.inventorySha256); assert.ok(facts.osPackages > 0 && facts.nodePackages > 0);
  process.stdout.write(`Gateway release artifact evidence ${JSON.stringify({ ...manifest, smoke: facts, files: ["appliance.env", "checksums.sha256", "compose.yml", "docker/seccomp-bluez-mesh.json", "gateway-image-linux-amd64.tar", "release-manifest.json", "sbom.spdx.json"] })}\n`);
  process.stdout.write(`Gateway release CI: actual ephemeral RSA/OpenSSL CMS backup → verify → drill → disposable restore: ${stateFlow}\n`);
  const drill = await run(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", `--test-name-pattern=^${stateFlow}$`, "scripts/gateway-appliance-state.test.mjs"]);
  // A renamed test must not silently turn this required real CLI flow into a
  // green zero-test command. The selected test asserts exact closure/cleanup.
  assert.match(drill.stdout, /(?:ℹ|#) tests 1(?:\r?\n|$)/);
  assert.match(drill.stdout, /(?:ℹ|#) pass 1(?:\r?\n|$)/);
  assert.match(drill.stdout, /(?:ℹ|#) skipped 0(?:\r?\n|$)/);
} catch (error) {
  status = interrupted || 1;
  process.stderr.write(`Gateway release CI failed: ${error.message}\n`);
} finally {
  try { await cleanup(); } catch (error) { status = 3; process.stderr.write(`${error.message}\n`); }
}
status ||= interrupted;
if (!status) process.stdout.write("Gateway release CI passed (software only; no Pi/HIL)\n");
process.exitCode = status;
