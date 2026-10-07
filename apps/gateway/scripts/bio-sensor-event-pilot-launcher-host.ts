import { createHash, randomBytes } from "node:crypto";
import { open, readFile, lstat, realpath, mkdir, mkdtemp, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { validateApproval, runLauncher, type Approval, type LauncherPort, type DiagnosticState } from "./bio-sensor-event-pilot-launcher";

const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export interface CommandResult { code: number; stdout: string; stderr: string }
export type Command = (command: string, args: string[]) => Promise<CommandResult>;
async function command(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code: signal ? 128 : code ?? 1, stdout, stderr }));
  });
}
async function privatePath(path: string, directory: boolean) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid?.() || (info.mode & 0o777) !== (directory ? 0o700 : 0o600) || await realpath(path) !== path) throw Error("PILOT_PROTECTED_PATH_REQUIRED");
}
async function durableNew(path: string, content: string | Buffer, mode = 0o600) {
  const file = await open(path, "wx", mode);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string) { const dir = await open(path, "r"); try { await dir.sync(); } finally { await dir.close(); } }
interface Manifest { version: 1; runRoot: string; phase: string; tokenSha256: string; approval: Approval; artifactSha256: string; ownerUid: number }
export async function prepareRun(approvalPath: string) {
  await privatePath(approvalPath, false);
  const approval = validateApproval(JSON.parse(await readFile(approvalPath, "utf8")), Date.now());
  // Preparation only copies verified local files. It never creates a Docker/USB client.
  const artifact = await readFile(approval.artifact.path);
  if (digest(artifact) !== approval.artifact.sha256) throw Error("PILOT_ARTIFACT_HASH");
  for (const source of [...approval.sources, approval.usbPreflight]) if (digest(await readFile(source.path)) !== source.sha256) throw Error("PILOT_SOURCE_HASH");
  const phase = randomBytes(16).toString("hex"), token = randomBytes(32).toString("hex");
  const root = await realpath(await mkdtemp("/tmp/bio-event-pilot-")); await chmod(root, 0o700);
  await mkdir(join(root, "evidence"), { mode: 0o700 });
  await durableNew(join(root, "pilot.mjs"), artifact, 0o444);
  const manifest: Manifest = { version: 1, runRoot: root, phase, tokenSha256: digest(token), approval, artifactSha256: digest(artifact), ownerUid: process.getuid!() };
  await durableNew(join(root, "manifest.json"), JSON.stringify(manifest));
  await durableNew(join(root, "bootstrap.json"), JSON.stringify({ root, start: token }));
  await syncDirectory(root);
  return root;
}
export function classifyDiagnostic(result: CommandResult, inventory: CommandResult | undefined, name: string, image: string, phase: string, expectedId?: string): { state: DiagnosticState; id?: string } {
  if (result.code !== 0) {
    const absence = result.code === 1 && result.stdout.trim() === "" && result.stderr.trim() === `Error: No such object: ${expectedId ?? name}`;
    return { state: absence && inventory?.code === 0 && inventory.stderr === "" && inventory.stdout.trim() === "" ? "absent" : "unknown" };
  }
  if (result.stderr !== "") return { state: "unknown" };
  try {
    const c = JSON.parse(result.stdout);
    if (!/^[a-f0-9]{64}$/.test(c.Id) || (expectedId && c.Id !== expectedId) || c.Name !== `/${name}` || c.Image !== image ||
      c.Config?.Labels?.["io.led-control.bio.pilot"] !== phase || c.HostConfig?.RestartPolicy?.Name !== "no") return { state: "unknown" };
    return { id: c.Id, state: c.State.Running === true && c.State.Status === "running" ? "running" :
      c.State.Running === false && ["exited", "dead"].includes(c.State.Status) ? "terminal" : "unknown" };
  } catch { return { state: "unknown" }; }
}

const usbProbePython = String.raw`import os,sys,json,hashlib,stat
a=json.loads(sys.argv[1]); p=a['physical']; device=a['device']
assert open(p+'/idVendor').read().strip().lower()=='1a86' and open(p+'/idProduct').read().strip().lower()=='5523'
assert hashlib.sha256(open(p+'/descriptors','rb').read()).hexdigest()==a['descriptorSha256']
assert os.path.basename(os.path.realpath(p+':1.0/driver'))==a['driver']
assert os.path.exists(p+':1.0/driver')
owners=[];dev=os.stat(device).st_rdev
for proc in os.scandir('/proc'):
 if not proc.name.isdigit():continue
 try:
  for fd in os.scandir(proc.path+'/fd'):
   try:
    s=os.stat(fd.path)
    if stat.S_ISCHR(s.st_mode) and s.st_rdev==dev:owners.append(fd.path)
   except FileNotFoundError:pass
 except FileNotFoundError:pass
assert not owners
print('USB_RELEASE_DRIVER_PHYSICAL_CONFIRMED')`;
const mappingPython = String.raw`import sys,json,hashlib,os,stat
a=json.loads(sys.argv[1]);p=a['mapping']['path'];s=os.lstat(p)
assert stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_uid==999 and stat.S_IMODE(s.st_mode)==0o600 and os.path.realpath(p)==p
raw=open(p,'rb').read();assert hashlib.sha256(raw).hexdigest()==a['mapping']['sha256']
state=json.loads(raw);assert state['version']==2
rows=state['mappings']
for b in a['bindings']:
 matches=[r for r in rows if r['fixtureId']==b['fixtureId'] or r['nativeUuid']==b['nativeUuid'] or r['logicalAddress']==b['address'] or r['nodeId']==b['nodeId']]
 assert len(matches)==1
 r=matches[0];assert r['status']=='confirmed' and r['fixtureId']==b['fixtureId'] and r['nodeId']==b['nodeId'] and r['nativeUuid']==b['nativeUuid'] and r['deviceUuid']=='bio:'+b['nativeUuid'] and r['logicalAddress']==b['address']
print('MAPPING_HASH_BINDING_CONFIRMED')`;
const leaseShell = String.raw`set -eu
umask 077
trap '' INT TERM HUP
ROOT=/opt/led-control/gateway
for j in .activation.journal .state.journal; do test ! -e "$ROOT/$j" && test ! -L "$ROOT/$j"; done
test ! -L "$ROOT/.appliance-operation.lock"
if test -e "$ROOT/.appliance-operation.lock"; then test -f "$ROOT/.appliance-operation.lock"; fi
exec 9>>"$ROOT/.appliance-operation.lock"
flock -n 9
mkdir "$ROOT/.bio-runtime-deploy.lock"
identity=$(stat -c '%d:%i' "$ROOT/.bio-runtime-deploy.lock")
printf 'LOCKED\n'
IFS= read -r decision
test "$decision" = RELEASE
test "$(stat -c '%d:%i' "$ROOT/.bio-runtime-deploy.lock")" = "$identity"
rmdir "$ROOT/.bio-runtime-deploy.lock"`;

export function createHostPort(a: Approval, root: string, phase: string, token: string, exec: Command = command, signal?: AbortSignal): LauncherPort {
  const name = `bio-event-pilot-${phase}`, evidencePath = join(root, "host-lifecycle.jsonl");
  let diagnosticId: string | undefined, lease: ReturnType<typeof spawn> | undefined, leaseDone: Promise<number> | undefined, exitCode: number | undefined;
  const evidence = async (code: string, result?: CommandResult) => {
    const file = await open(evidencePath, "a", 0o600);
    try { await file.writeFile(JSON.stringify({ code, at: new Date().toISOString(), ...(result ? { result } : {}) }) + "\n"); await file.sync(); } finally { await file.close(); }
  };
  const run = async (cmd: string, args: string[]) => { const r = await exec(cmd, args); await evidence("host-command", r); return r; };
  const required = async (cmd: string, args: string[]) => { const r = await run(cmd, args); if (r.code !== 0) throw Error("PILOT_HOST_COMMAND_FAILED"); return r.stdout; };
  const docker = (args: string[]) => run("sudo", ["-n", "docker", ...args]);
  const requireDocker = async (args: string[]) => { const r = await docker(args); if (r.code !== 0) throw Error("PILOT_DOCKER_COMMAND_FAILED"); return r.stdout; };
  const diagnostic = async (): Promise<DiagnosticState> => {
    const result = await docker(["inspect", diagnosticId ?? name, "--format", "{{json .}}"]);
    const inventory = result.code === 0 ? undefined : await docker(["ps", "--all", "--no-trunc", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
    const classified = classifyDiagnostic(result, inventory, name, a.original.image, phase, diagnosticId);
    // Exact ownership id is immutable once known; created/unknown containers are NOT terminal.
    if (classified.id && !diagnosticId) diagnosticId = classified.id;
    return classified.state;
  };
  const checkUsbHelper = async () => {
    if (digest(await readFile(a.usbPreflight.path)) !== a.usbPreflight.sha256) throw Error("PILOT_USB_HELPER_HASH");
    const stdout = await required("sudo", ["-n", "env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "bash", a.usbPreflight.path]);
    if (stdout !== `GATEWAY_BIO_USB_DEVICE=${a.usb.device}\nGATEWAY_BIO_USB_GID=${a.usb.gid}\n`) throw Error("PILOT_USB_DESCRIPTOR_CHANGED");
  };
  return {
    acquire: async () => {
      // Only a new empty evidence path; no recursive ownership repair or old evidence reuse.
      await required("sudo", ["-n", "python3", "-c", "import os,sys,stat;p=sys.argv[1];s=os.lstat(p);assert stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==0o700 and not os.listdir(p);os.chown(p,999,999)", join(root, "evidence")]);
      lease = spawn("sudo", ["-n", "bash", "-c", leaseShell], { stdio: ["pipe", "pipe", "pipe"] });
      leaseDone = new Promise<number>((resolve, reject) => { lease!.once("error", reject); lease!.once("close", code => resolve(code ?? 1)); });
      await new Promise<void>((resolve, reject) => {
        let output = ""; lease!.stdout!.on("data", data => { output += data; if (output === "LOCKED\n") resolve(); });
        lease!.once("error", reject); lease!.once("close", () => reject(Error("PILOT_SHARED_LOCK_BUSY")));
      });
      try { await evidence("shared-and-bio-locks-held"); }
      catch (error) { lease.stdin!.end("RELEASE\n"); await leaseDone; throw error; }
    },
    release: async () => { lease!.stdin!.end("RELEASE\n"); if (await leaseDone !== 0) throw Error("PILOT_LOCK_RELEASE_FAILED"); },
    preserve: async () => { lease!.stdin!.end("PRESERVE\n"); await leaseDone; },
    verifyFiles: async () => {
      for (const source of [...a.sources, a.usbPreflight]) {
        const info = await lstat(source.path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) || await realpath(source.path) !== source.path || digest(await readFile(source.path)) !== source.sha256) throw Error("PILOT_SOURCE_CHANGED");
      }
      const code = await lstat(join(root, "pilot.mjs"));
      if (!code.isFile() || code.isSymbolicLink() || (code.mode & 0o777) !== 0o444 || digest(await readFile(join(root, "pilot.mjs"))) !== a.artifact.sha256) throw Error("PILOT_ARTIFACT_CHANGED");
      await required("sudo", ["-n", "python3", "-c", mappingPython, JSON.stringify(a)]);
    },
    softwareProbe: async () => {
      await requireDocker(["run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=999:999",
        "--mount", `type=bind,src=${join(root, "pilot.mjs")},dst=/opt/led-control/bio-pilot.mjs,readonly`, "--entrypoint=node", a.original.image,
        "-e", "require('fs').accessSync('/opt/led-control/bio-pilot.mjs',require('fs').constants.R_OK);require('child_process').execFileSync(process.execPath,['--check','/opt/led-control/bio-pilot.mjs']);"]);
    },
    original: async () => {
      const c = JSON.parse(await requireDocker(["inspect", a.original.id, "--format", "{{json .}}"]));
      const mount = c.Mounts?.find((m: { Destination: string }) => m.Destination === "/data/mesh");
      if (!mount || join(mount.Source, "bio-device-mappings.json") !== a.mapping.path) throw Error("PILOT_ORIGINAL_MAPPING_MOUNT_CHANGED");
      return { id: c.Id, image: c.Image, running: c.State.Running, status: c.State.Status, startedAt: c.State.StartedAt };
    },
    diagnostic,
    consumeStart: async () => {
      const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
      if (manifest.runRoot !== root || manifest.phase !== phase || manifest.tokenSha256 !== digest(token) || digest(JSON.stringify(manifest.approval)) !== digest(JSON.stringify(a))) throw Error("PILOT_START_UNBOUND");
      await durableNew(join(root, "START.used"), JSON.stringify({ phase, manifestSha256: digest(await readFile(join(root, "manifest.json"))), consumedAt: new Date().toISOString() })); await syncDirectory(root);
    },
    stopOriginal: async () => { await requireDocker(["stop", "--time", "15", a.original.id]); },
    usbReleased: async () => { await checkUsbHelper(); await required("sudo", ["-n", "python3", "-c", usbProbePython, JSON.stringify(a.usb)]); },
    startDiagnostic: async () => {
      const created = await requireDocker(["create", "--name", name, "--label", `io.led-control.bio.pilot=${phase}`, "--restart=no", "--stop-timeout=45", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--user=999:999", "--group-add", String(a.usb.gid), "--device", `${a.usb.device}:${a.usb.device}:rw`,
        "--mount", `type=bind,src=${join(root, "pilot.mjs")},dst=/opt/led-control/bio-pilot.mjs,readonly`,
        "--mount", `type=bind,src=${join(root, "evidence")},dst=/diag/evidence`, "--mount", `type=bind,src=${a.mapping.path},dst=/diag/mapping.json,readonly`,
        "--entrypoint=node", a.original.image, "/opt/led-control/bio-pilot.mjs", "--run", "--confirm=RUN_BIO_A_B_SENSOR_EVENT_PILOT", "--journal-directory=/diag/evidence"]);
      if (!/^[a-f0-9]{64}\n?$/.test(created)) throw Error("PILOT_CREATE_ID_UNKNOWN"); diagnosticId = created.trim();
      const result = await docker(["inspect", diagnosticId, "--format", "{{json .}}"]);
      const classification = classifyDiagnostic(result, undefined, name, a.original.image, phase, diagnosticId);
      if (!classification.id) throw Error("PILOT_DIAGNOSTIC_OWNERSHIP_UNKNOWN");
      await requireDocker(["start", diagnosticId]);
    },
    waitDiagnostic: async () => {
      // A CLI deadline is not a container lifetime proof. Timeout returns to independent cleanup inspect.
      const wait = docker(["wait", diagnosticId!]);
      const timeout = new Promise<CommandResult>(resolve => { const timer = setTimeout(() => resolve({ code: 124, stdout: "", stderr: "PILOT_WAIT_BUDGET" }), 400000); timer.unref(); });
      const abort = new Promise<CommandResult>(resolve => { if (signal?.aborted) resolve({ code: 130, stdout: "", stderr: "PILOT_CANCELLED" }); else signal?.addEventListener("abort", () => resolve({ code: 130, stdout: "", stderr: "PILOT_CANCELLED" }), { once: true }); });
      const result = await Promise.race([wait, timeout, abort]);
      if (result.code !== 0 || !/^\d+\n?$/.test(result.stdout)) throw Error("PILOT_WAIT_UNCERTAIN"); exitCode = Number(result.stdout); return exitCode;
    },
    terminateDiagnostic: async () => { if (!diagnosticId || await diagnostic() !== "running") throw Error("PILOT_TERM_ID_UNKNOWN"); await requireDocker(["kill", "--signal=SIGTERM", diagnosticId]); },
    waitRecovery: async () => {
      const end = performance.now() + 45000;
      while (performance.now() < end) { const state = await diagnostic(); if (state === "terminal" || state === "absent") return; if (state === "unknown") throw Error("PILOT_RECOVERY_LIFETIME_UNKNOWN"); await sleep(1000); }
    },
    finalJournal: async () => {
      await docker(["logs", diagnosticId!]); // Preserve exact diagnostic stdout/stderr in protected lifecycle evidence.
      const text = await required("sudo", ["-n", "cat", join(root, "evidence", "pilot-journal.jsonl")]);
      if (!text.endsWith("\n")) return false;
      const entries = text.trimEnd().split("\n").map(line => JSON.parse(line)); const last = entries.at(-1);
      const state = await docker(["inspect", diagnosticId!, "--format", "{{.State.ExitCode}}"]);
      return state.code === 0 && state.stdout.trim() === "0" && last?.phase === "closed" && Array.isArray(last.pending) && last.pending.length === 0 && !!last.originals?.A && !!last.originals?.B;
    },
    restartOriginal: async () => { await requireDocker(["start", a.original.id]); },
    postflight: async () => {
      const c = JSON.parse(await requireDocker(["inspect", a.original.id, "--format", "{{json .}}"]));
      if (c.Id !== a.original.id || c.Image !== a.original.image || !c.State.Running) throw Error("PILOT_RESTART_ID_MISMATCH");
      const script = "const fs=require('fs');const h=JSON.parse(fs.readFileSync('/var/lib/led-control/health.json','utf8'));const start=Date.parse(process.argv[1]);if(!Number.isFinite(start)||!Number.isFinite(Date.parse(h.updatedAt))||Date.parse(h.updatedAt)<start||Date.now()-Date.parse(h.updatedAt)>15000||!h.transportConnected||!h.protocolReady||!h.mappingValid||!h.mqtt||h.status!=='healthy'||!h.heartbeatFresh)process.exit(1)";
      const end = performance.now() + 45000; let healthy = false;
      while (performance.now() < end) { const r = await docker(["exec", a.original.id, "node", "-e", script, c.State.StartedAt]); if (r.code === 0) { healthy = true; break; } await sleep(1000); }
      if (!healthy) throw Error("PILOT_POSTFLIGHT_UNHEALTHY");
      await required("sudo", ["-n", "python3", "-c", mappingPython, JSON.stringify(a)]);
    },
    evidence: code => evidence(code)
  };
}
export async function executeRun(root: string, token: string) {
  if (process.platform !== "linux") throw Error("PILOT_LINUX_HOST_REQUIRED");
  await privatePath(root, true); await privatePath(join(root, "manifest.json"), false);
  const m = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
  if (!/^\/tmp\/bio-event-pilot-[A-Za-z0-9]+$/.test(root) || m.runRoot !== root || m.version !== 1 || !/^[a-f0-9]{32}$/.test(m.phase) || m.ownerUid !== process.getuid?.() || m.tokenSha256 !== digest(token) || m.artifactSha256 !== m.approval.artifact.sha256) throw Error("PILOT_FRESH_PHASE_REQUIRED");
  await lstat(join(root, "START.used")).then(() => { throw Error("PILOT_PHASE_ALREADY_USED"); }, error => { if (error.code !== "ENOENT") throw error; });
  validateApproval(m.approval, Date.now());
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel); process.once("SIGHUP", cancel);
  try { await runLauncher(m.approval, createHostPort(m.approval, root, m.phase, token, command, controller.signal), { now: () => Date.now(), signal: controller.signal }); }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); process.removeListener("SIGHUP", cancel); }
}
