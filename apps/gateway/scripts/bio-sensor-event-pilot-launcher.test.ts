import { describe, expect, it } from "vitest";
import { validateApproval, parseLauncherArgs, runLauncher, type Approval, type LauncherPort, type DiagnosticState } from "./bio-sensor-event-pilot-launcher";
import { classifyDiagnostic, createHostPort, prepareRun, boundedCommand, verifyLocalBindings, type CommandResult } from "./bio-sensor-event-pilot-launcher-host";
import { mkdtemp, realpath, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

function fixture() {
  let now = Date.parse("2026-10-07T01:00:00Z"), stopped = false, diagnostic: DiagnosticState = "absent";
  const calls: string[] = [];
  const approval: Approval = {
    version: 1, observedAt: "2026-10-07T00:59:59Z", expiresAt: "2026-10-07T01:01:59Z",
    original: { id: "a".repeat(64), image: "sha256:" + "b".repeat(64), startedAt: "2026-10-07T00:40:00.123456789Z" },
    bindings: [
      { fixtureId: "8bd8f767-8aa9-4ea4-881d-754eefc46543", nativeUuid: "e466e5265fe4", address: 256, networkId: 0, nodeId: "11111111-1111-4111-8111-111111111111", gatewayId: "33333333-3333-4333-8333-333333333333", siteId: "44444444-4444-4444-8444-444444444444", assignmentVersion: 1 },
      { fixtureId: "32f6dcd0-6357-45bb-bd80-a7ec84c71c64", nativeUuid: "e466e55d7e3d", address: 259, networkId: 0, nodeId: "22222222-2222-4222-8222-222222222222", gatewayId: "33333333-3333-4333-8333-333333333333", siteId: "44444444-4444-4444-8444-444444444444", assignmentVersion: 1 }
    ], waiting: Array(8).fill(0), mapping: { path: "/opt/led-control/gateway/data-admin4/mesh/bio-device-mappings.json", sha256: "c".repeat(64) },
    sources: [{ path: "/tmp/pilot-source.ts", sha256: "d".repeat(64) }, { path: "/tmp/pilot-runtime.ts", sha256: "e".repeat(64) }],
    artifact: { path: "/tmp/pilot.mjs", sha256: "f".repeat(64) },
    usb: { device: "/dev/bus/usb/001/003", physical: "/sys/bus/usb/devices/1-1.1", driver: "ch341", descriptorSha256: "9".repeat(64), gid: 0 },
    usbPreflight: { path: "/tmp/gateway-bio-usb-preflight.sh", sha256: "8".repeat(64) }
  };
  const mark = async (name: string) => { calls.push(name); };
  const port: LauncherPort = {
    acquire: () => mark("locks"), release: () => mark("unlock"), preserve: () => mark("lock-preserved"), verifyFiles: () => mark("files"), softwareProbe: () => mark("UID999-no-device-probe"),
    original: async () => { calls.push("inspect-original"); return { ...approval.original, running: !stopped, status: stopped ? "exited" : "running" }; },
    diagnostic: async () => { calls.push("inspect-diagnostic"); return diagnostic; }, consumeStart: () => mark("one-use"),
    stopOriginal: async () => { await mark("STOP-exact"); stopped = true; }, usbReleased: () => mark("USB-free-driver-match"),
    startDiagnostic: async () => { await mark("start-diagnostic"); diagnostic = "running"; },
    waitDiagnostic: async () => { await mark("wait-diagnostic"); diagnostic = "terminal"; return 0; },
    terminateDiagnostic: async () => { await mark("TERM-only"); diagnostic = "terminal"; }, waitRecovery: () => mark("recovery-45s"),
    finalJournal: async () => { await mark("durable-final"); return true; },
    restartOriginal: async () => { await mark("restart-exact"); stopped = false; }, postflight: () => mark("postflight"), evidence: code => mark("evidence:" + code)
  };
  return { approval, port, calls, now: () => now, setNow: (value: number) => { now = value; }, setDiagnostic: (state: DiagnosticState) => { diagnostic = state; } };
}

describe("fixed A/B host pilot launcher", () => {
  it("rejects default/invalid/partial opt-in before any host action", () => {
    expect(parseLauncherArgs([]).mode).toBe("help");
    expect(() => parseLauncherArgs(["--run"])).toThrow();
    expect(() => parseLauncherArgs(["--run", "--root=/tmp/old", "--start=old"])).toThrow();
    expect(() => parseLauncherArgs(["--docker=fake"])).toThrow();
  });
  it("accepts only current receipt with exact bindings and all eight waiting counts zero", () => {
    const f = fixture(); expect(validateApproval(f.approval, f.now()).bindings).toHaveLength(2);
    for (const mutate of [
      (a: Approval) => { a.waiting[7] = 1; }, (a: Approval) => { a.bindings[0].address = 259; },
      (a: Approval) => { a.original.id = "short"; }, (a: Approval) => { a.observedAt = "2026-10-06T01:00:00Z"; }
    ]) { const a = structuredClone(f.approval); mutate(a); expect(() => validateApproval(a, f.now())).toThrow(); }
  });
  it("software UID999 read access and fresh lifetime/hash gates precede STOP", async () => {
    const f = fixture(); await runLauncher(f.approval, f.port, { now: f.now });
    expect(f.calls.indexOf("UID999-no-device-probe")).toBeLessThan(f.calls.indexOf("STOP-exact"));
    expect(f.calls.filter(x => x === "one-use")).toHaveLength(1);
    expect(f.calls.slice(-3)).toEqual(["postflight", "evidence:complete", "unlock"]);
  });
  it.each(["permission", "source hash", "stale TTL", "new lifetime", "used token"])("%s refusal never stops Gateway", async kind => {
    const f = fixture();
    if (kind === "permission") f.port.softwareProbe = async () => { throw Error("EACCES"); };
    if (kind === "source hash") f.port.verifyFiles = async () => { throw Error("hash"); };
    if (kind === "stale TTL") f.port.softwareProbe = async () => { f.setNow(f.now() + 121000); };
    if (kind === "new lifetime") f.port.original = async () => ({ ...f.approval.original, startedAt: "2026-10-07T00:58:00Z", running: true, status: "running" });
    if (kind === "used token") f.port.consumeStart = async () => { throw Error("EEXIST"); };
    await expect(runLauncher(f.approval, f.port, { now: f.now })).rejects.toThrow(); expect(f.calls).not.toContain("STOP-exact");
  });
  it.each(["unknown", "running"] as const)("%s diagnostic never permits competing original restart", async state => {
    const f = fixture(); f.port.waitDiagnostic = async () => { f.setDiagnostic(state); throw Error("CLI disconnected"); };
    f.port.terminateDiagnostic = async () => { f.calls.push("TERM-only"); }; // Recovery does not establish terminal.
    await expect(runLauncher(f.approval, f.port, { now: f.now })).rejects.toThrow();
    expect(f.calls).not.toContain("restart-exact"); expect(f.calls).not.toContain("unlock"); expect(f.calls).not.toContain("KILL");
  });
  it("CLI wait failure still proves terminal independently and safely restarts, with nonzero result", async () => {
    const f = fixture(); f.port.waitDiagnostic = async () => { f.setDiagnostic("terminal"); throw Error("wait CLI timeout"); };
    await expect(runLauncher(f.approval, f.port, { now: f.now })).rejects.toThrow(); expect(f.calls).toContain("restart-exact");
  });
  it("TERM gives independent recovery budget, never forcekill or reset", async () => {
    const f = fixture(), controller = new AbortController();
    f.port.waitDiagnostic = async () => { controller.abort(); f.setDiagnostic("running"); return 143; };
    await expect(runLauncher(f.approval, f.port, { now: f.now, signal: controller.signal })).rejects.toThrow();
    expect(f.calls).toContain("TERM-only"); expect(f.calls.indexOf("recovery-45s")).toBeLessThan(f.calls.indexOf("restart-exact"));
  });
  it.each(["release", "driver"])("unconfirmed %s blocks original restart and retains lock", async () => {
    const f = fixture(); let checks = 0; f.port.usbReleased = async () => { if (++checks > 1) throw Error("unsafe USB"); };
    await expect(runLauncher(f.approval, f.port, { now: f.now })).rejects.toThrow(); expect(f.calls).not.toContain("restart-exact"); expect(f.calls).not.toContain("unlock");
  });
  it("durable pending or diagnostic close failure cannot become successful launcher exit", async () => {
    const f = fixture(); f.port.finalJournal = async () => false;
    await expect(runLauncher(f.approval, f.port, { now: f.now })).rejects.toThrow(); expect(f.calls).toContain("restart-exact");
    expect(f.calls).not.toContain("unlock"); expect(f.calls).toContain("lock-preserved");
  });
  it("missing or fsync-uncertain journal restores safe service but retains lock against baseline recapture", async () => {
    const f = fixture(); f.port.finalJournal = async () => { throw Error("journal unreadable"); };
    await expect(runLauncher(f.approval, f.port, { now: f.now })).rejects.toThrow(); expect(f.calls).toContain("restart-exact");
    expect(f.calls).not.toContain("unlock"); expect(f.calls).toContain("lock-preserved");
  });
  it("postflight mismatch preserves evidence and fails rather than claims restored", async () => {
    const f = fixture(); f.port.postflight = async () => { throw Error("mapping changed"); };
    await expect(runLauncher(f.approval, f.port, { now: f.now })).rejects.toThrow(); expect(f.calls).not.toContain("evidence:complete");
  });
  it("Docker absence requires exact no-such-object plus independently clean inventory", () => {
    const missing = { code: 1, stdout: "\n", stderr: "Error: No such object: diag\n" };
    const empty = { code: 0, stdout: "", stderr: "" };
    expect(classifyDiagnostic(missing, empty, "diag", "image", "phase").state).toBe("absent");
    for (const result of [{ ...missing, code: 124 }, { ...missing, stderr: "daemon error\n" }, { ...missing, stdout: "anything" }]) {
      expect(classifyDiagnostic(result, empty, "diag", "image", "phase").state).toBe("unknown");
    }
    expect(classifyDiagnostic(missing, { ...empty, stdout: "diag\n" }, "diag", "image", "phase").state).toBe("unknown");
  });
  it("same-name replacement or created container is never terminal/owned cleanup evidence", () => {
    const c = { Id: "a".repeat(64), Name: "/diag", Image: "image", Config: { Labels: { "io.led-control.bio.pilot": "phase" } }, HostConfig: { RestartPolicy: { Name: "no" } }, State: { Running: false, Status: "exited" } };
    const result = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
    expect(classifyDiagnostic(result(c), undefined, "diag", "image", "phase", c.Id).state).toBe("terminal");
    expect(classifyDiagnostic(result({ ...c, Id: "b".repeat(64) }), undefined, "diag", "image", "phase", c.Id).state).toBe("unknown");
    expect(classifyDiagnostic(result({ ...c, State: { Running: false, Status: "created" } }), undefined, "diag", "image", "phase", c.Id).state).toBe("unknown");
  });
  it("actual adapter software probe mounts only code, runs UID999 read/syntax, with no USB or service action", async () => {
    const f = fixture(), root = await realpath(await mkdtemp(join(tmpdir(), "pilot-launcher-fixture-")));
    const commands: string[][] = [];
    const port = createHostPort(f.approval, root, "a".repeat(32), "b".repeat(64), async (cmd, args) => { commands.push([cmd, ...args]); return { code: 0, stdout: "", stderr: "" }; });
    await port.softwareProbe(); const cmd = commands[0];
    expect(cmd.slice(0, 5)).toEqual(["sudo", "-n", "docker", "run", "--rm"]);
    expect(cmd).toContain("--user=999:999"); expect(cmd).toContain("--network=none"); expect(cmd).not.toContain("--device"); expect(cmd).not.toContain("stop");
    expect(cmd.at(-1)).toContain("accessSync"); expect(cmd.at(-1)).toContain("--check");
  });
  it("new preparation is private, code-readable, one-use, and bound to its canonical fresh root", async () => {
    const f = fixture(), input = await realpath(await mkdtemp(join(tmpdir(), "pilot-approval-fixture-")));
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    f.approval.observedAt = new Date(Date.now() - 1000).toISOString(); f.approval.expiresAt = new Date(Date.now() + 100000).toISOString();
    for (const [index, file] of [...f.approval.sources, f.approval.artifact, f.approval.usbPreflight].entries()) {
      const content = `/* reviewed fixture ${index} */`;
      file.path = join(input, `input${index}`); file.sha256 = sha(content); await writeFile(file.path, content, { mode: 0o600 });
    }
    const approvalPath = join(input, "approval.json"); await writeFile(approvalPath, JSON.stringify(f.approval), { mode: 0o600 });
    const root = await prepareRun(approvalPath), manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")), bootstrap = JSON.parse(await readFile(join(root, "bootstrap.json"), "utf8"));
    expect(manifest.runRoot).toBe(root); expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "pilot.mjs"))).mode & 0o777).toBe(0o444); expect((await stat(join(root, "bootstrap.json"))).mode & 0o777).toBe(0o600);
    const port = createHostPort(f.approval, root, manifest.phase, bootstrap.start, async () => { throw Error("No Docker in file guard test"); });
    await port.consumeStart(); await expect(port.consumeStart()).rejects.toThrow();
    const second = await prepareRun(approvalPath); expect(second).not.toBe(root);
    await chmod(approvalPath, 0o644); await expect(prepareRun(approvalPath)).rejects.toThrow();
  });
  it("cancel during post-STOP hash verification never creates/starts a diagnostic", async () => {
    const f = fixture(), controller = new AbortController(); let checks = 0;
    f.port.verifyFiles = async () => { if (++checks === 4) controller.abort(); };
    await expect(runLauncher(f.approval, f.port, { now: f.now, signal: controller.signal })).rejects.toThrow();
    expect(f.calls).not.toContain("start-diagnostic");
  });
  it("actual host adapter abort during ownership inspect never starts created container", async () => {
    const f = fixture(), root = await realpath(await mkdtemp(join(tmpdir(), "pilot-abort-fixture-"))), controller = new AbortController();
    const commands: string[][] = [], id = "7".repeat(64), phase = "a".repeat(32);
    const port = createHostPort(f.approval, root, phase, "b".repeat(64), async (cmd, args) => {
      commands.push([cmd, ...args]);
      if (args.includes("create")) return { code: 0, stdout: id + "\n", stderr: "" };
      controller.abort(); return { code: 0, stdout: JSON.stringify({ Id: id, Name: `/bio-event-pilot-${phase}`, Image: f.approval.original.image,
        Config: { Labels: { "io.led-control.bio.pilot": phase } }, HostConfig: { RestartPolicy: { Name: "no" } }, State: { Running: false, Status: "created" } }), stderr: "" };
    }, controller.signal);
    await expect(port.startDiagnostic()).rejects.toThrow(); expect(commands.some(c => c.includes("start"))).toBe(false);
  });
  it("real command deadline reaps a stopped CLI fixture and marks result uncertain", async () => {
    const result = await boundedCommand(process.execPath, ["-e", "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"], { budgetMs: 100 });
    expect(result.code).not.toBe(0); expect(result.uncertain).toBe(true); expect(result.reaped).toBe(true);
    const pid = Number(result.stdout.trim()); if (pid) expect(() => process.kill(pid, 0)).toThrow();
  });
  it("pre-aborted command never spawns; cancel reaps a waiting CLI rather than leaves race loser", async () => {
    const controller = new AbortController(); controller.abort();
    const result = await boundedCommand(process.execPath, ["-e", "throw Error('must not start')"], { budgetMs: 100, signal: controller.signal });
    expect(result.stdout).toBe(""); expect(result.reaped).toBe(true); expect(result.code).not.toBe(0);
    const running = new AbortController(); const timer = setTimeout(() => running.abort(), 50);
    try {
      const cancelled = await boundedCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { budgetMs: 10000, signal: running.signal });
      expect(cancelled.reaped).toBe(true); expect(cancelled.uncertain).toBe(true);
    } finally { clearTimeout(timer); }
  });
  it("canonical server node and registration-local mapping node remain distinct identities", () => {
    const f = fixture(); const state = { version: 2, mappings: f.approval.bindings.map(b => ({
      fixtureId: b.fixtureId, nativeUuid: b.nativeUuid, deviceUuid: `bio:${b.nativeUuid}`, logicalAddress: b.address, status: "confirmed", nodeId: b.fixtureId
    })) };
    expect(() => verifyLocalBindings(state, f.approval.bindings)).not.toThrow();
    const conflict = structuredClone(state); conflict.mappings.push({ ...state.mappings[0], fixtureId: "other", nativeUuid: "other", deviceUuid: "bio:other" });
    expect(() => verifyLocalBindings(conflict, f.approval.bindings)).toThrow();
  });
  it("original handover uses exact-ID TERM and positive terminal inspect, never Docker stop/forcekill", async () => {
    const f = fixture(), root = await realpath(await mkdtemp(join(tmpdir(), "pilot-term-fixture-"))), commands: string[][] = [];
    const port = createHostPort(f.approval, root, "a".repeat(32), "b".repeat(64), async (cmd, args, control) => {
      expect(control.budgetMs).toBeGreaterThan(0); expect(control.budgetMs).toBeLessThanOrEqual(25000); commands.push([cmd, ...args]);
      return { code: 0, stderr: "", stdout: args.includes("inspect") ? JSON.stringify({ Id: f.approval.original.id, Image: f.approval.original.image,
        State: { Running: false, Status: "exited", StartedAt: f.approval.original.startedAt }, Mounts: [{ Destination: "/data/mesh", Source: "/opt/led-control/gateway/data-admin4/mesh" }] }) : "" };
    });
    await port.stopOriginal(); expect(commands[0]).toContain("--signal=SIGTERM"); expect(commands[0]).toContain(f.approval.original.id);
    expect(commands.flat()).not.toContain("stop"); expect(commands.flat()).not.toContain("--signal=SIGKILL");
  });
  it("late or interrupted create stays unknown even if a later inspect/inventory looks absent", async () => {
    const f = fixture(), root = await realpath(await mkdtemp(join(tmpdir(), "pilot-late-create-fixture-"))), phase = "a".repeat(32);
    const port = createHostPort(f.approval, root, phase, "b".repeat(64), async (_cmd, args) => {
      if (args.includes("create")) return { code: 124, stdout: "", stderr: "interrupted", uncertain: true, reaped: true };
      if (args.includes("inspect")) return { code: 1, stdout: "\n", stderr: `Error: No such object: bio-event-pilot-${phase}\n` };
      return { code: 0, stdout: "", stderr: "" };
    });
    await expect(port.startDiagnostic()).rejects.toThrow(); port.beginCleanup!(); expect(await port.diagnostic()).toBe("unknown");
  });
  it("original TERM still-live refuses trial/restart and preserves lock", async () => {
    const f = fixture(); f.port.stopOriginal = async () => { throw Error("TERM has not reached terminal"); };
    await expect(runLauncher(f.approval, f.port, { now: f.now })).rejects.toThrow();
    expect(f.calls).not.toContain("start-diagnostic"); expect(f.calls).not.toContain("restart-exact"); expect(f.calls).toContain("lock-preserved");
  });
});
