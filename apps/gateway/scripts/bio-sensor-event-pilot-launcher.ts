export interface Approval {
  version: 1; observedAt: string; expiresAt: string;
  original: { id: string; image: string; startedAt: string };
  bindings: Array<{ fixtureId: string; nativeUuid: string; address: number; networkId: number; nodeId: string; gatewayId: string; siteId: string; assignmentVersion: number }>;
  waiting: number[]; mapping: { path: string; sha256: string };
  sources: Array<{ path: string; sha256: string }>; artifact: { path: string; sha256: string };
  usb: { device: string; physical: string; driver: string; descriptorSha256: string; gid: number };
  usbPreflight: { path: string; sha256: string };
}
export interface OriginalState { id: string; image: string; startedAt: string; running: boolean; status: string }
export type DiagnosticState = "absent" | "terminal" | "running" | "unknown";
export interface LauncherPort {
  acquire(): Promise<void>; release(): Promise<void>; preserve(): Promise<void>;
  beginCleanup?(): void;
  verifyFiles(): Promise<void>; softwareProbe(): Promise<void>; original(): Promise<OriginalState>;
  diagnostic(): Promise<DiagnosticState>; consumeStart(): Promise<void>;
  stopOriginal(): Promise<void>; usbReleased(): Promise<void>;
  startDiagnostic(): Promise<void>; waitDiagnostic(): Promise<number>;
  terminateDiagnostic(): Promise<void>; waitRecovery(): Promise<void>;
  finalJournal(): Promise<boolean>; restartOriginal(): Promise<void>; postflight(): Promise<void>;
  evidence(code: string): Promise<void>;
}
const hash = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const absolute = (value: unknown): value is string => typeof value === "string" && value.startsWith("/") && resolve(value) === value && !/[\s,\x00-\x1f]/.test(value);
export function validateApproval(value: unknown, now: number): Approval {
  const a = value as Approval;
  const fail = () => { throw Error("PILOT_FRESH_APPROVAL_REQUIRED"); };
  if (!a || a.version !== 1 || !Number.isFinite(now)) return fail();
  const observed = Date.parse(a.observedAt), expiry = Date.parse(a.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expiry) || now < observed || now - observed > 120000 ||
    expiry <= now || expiry > observed + 120000 || expiry <= observed) return fail();
  if (!a.original || !hash.test(a.original.id) || !/^sha256:[a-f0-9]{64}$/.test(a.original.image) ||
    !Number.isFinite(Date.parse(a.original.startedAt)) || Date.parse(a.original.startedAt) > observed) return fail();
  if (!Array.isArray(a.bindings) || a.bindings.length !== 2 || !Array.isArray(a.waiting) || a.waiting.length !== 8 || a.waiting.some(n => n !== 0)) return fail();
  for (const expected of [
    { fixture: "8bd8f767-8aa9-4ea4-881d-754eefc46543", native: "e466e5265fe4", address: 256 },
    { fixture: "32f6dcd0-6357-45bb-bd80-a7ec84c71c64", native: "e466e55d7e3d", address: 259 }
  ]) {
    const b = a.bindings.find(b => b.fixtureId === expected.fixture);
    if (!b || b.nativeUuid !== expected.native || b.address !== expected.address || b.networkId !== 0 ||
      !uuid.test(b.nodeId) || !uuid.test(b.gatewayId) || !uuid.test(b.siteId) || !Number.isSafeInteger(b.assignmentVersion) || b.assignmentVersion < 1) return fail();
  }
  if (a.bindings[0].nodeId === a.bindings[1].nodeId || a.bindings[0].siteId !== a.bindings[1].siteId ||
    a.bindings[0].gatewayId !== a.bindings[1].gatewayId || a.bindings[0].assignmentVersion !== a.bindings[1].assignmentVersion) return fail();
  if (!a.mapping || !absolute(a.mapping.path) || !a.mapping.path.startsWith("/opt/led-control/gateway/") ||
    !a.mapping.path.endsWith("/mesh/bio-device-mappings.json") || !hash.test(a.mapping.sha256) || !a.artifact || !absolute(a.artifact.path) || !hash.test(a.artifact.sha256) ||
    !Array.isArray(a.sources) || a.sources.length !== 2 || a.sources.some(s => !absolute(s.path) || !hash.test(s.sha256))) return fail();
  if (!a.usbPreflight || !absolute(a.usbPreflight.path) || !hash.test(a.usbPreflight.sha256) || !a.usb || !/^\/dev\/bus\/usb\/\d{3}\/\d{3}$/.test(a.usb.device) || !/^\/sys\/bus\/usb\/devices\/[0-9]+-[0-9.]+$/.test(a.usb.physical) ||
    a.usb.driver !== "ch341" || !hash.test(a.usb.descriptorSha256) || !Number.isSafeInteger(a.usb.gid) || a.usb.gid < 0 || a.usb.gid > 65535) return fail();
  return structuredClone(a);
}
const sameOriginal = (actual: OriginalState, expected: Approval["original"]) => actual.id === expected.id && actual.image === expected.image && actual.startedAt === expected.startedAt;
export async function runLauncher(approval: Approval, port: LauncherPort, options: { now: () => number; signal?: AbortSignal }) {
  validateApproval(approval, options.now());
  const errors: unknown[] = []; let locked = false, stopAttempted = false, safeRelease = true, diagnosticAttempted = false;
  const refuseCancelled = () => { if (options.signal?.aborted) throw Error("PILOT_CANCELLED"); };
  const current = async () => {
    validateApproval(approval, options.now()); refuseCancelled(); await port.verifyFiles(); refuseCancelled();
    const actual = await port.original(); refuseCancelled();
    if (!sameOriginal(actual, approval.original) || !actual.running || actual.status !== "running") throw Error("PILOT_ORIGINAL_CHANGED");
  };
  try {
    await port.acquire(); locked = true; await current();
    if (await port.diagnostic() !== "absent") throw Error("PILOT_DIAGNOSTIC_EXISTS");
    // Software-only UID999 access/syntax probe must complete before STOP or USB handover.
    await port.softwareProbe(); await current(); await port.consumeStart(); await current();
    stopAttempted = true; await port.evidence("stop-pending"); refuseCancelled(); await port.stopOriginal();
    const stopped = await port.original();
    if (!sameOriginal(stopped, approval.original) || stopped.running || !["exited", "dead"].includes(stopped.status)) throw Error("PILOT_STOP_UNCONFIRMED");
    await port.usbReleased(); refuseCancelled(); await port.verifyFiles(); refuseCancelled();
    diagnosticAttempted = true; await port.evidence("diagnostic-pending"); refuseCancelled(); await port.startDiagnostic();
    const exit = await port.waitDiagnostic(); if (exit !== 0) throw Error("PILOT_DIAGNOSTIC_NONZERO");
  } catch (error) { errors.push(error); }
  finally {
    port.beginCleanup?.(); // Independent command controls; normal cancellation cannot cancel recovery.
    if (stopAttempted) {
      try {
        let state = await port.diagnostic();
        if (state === "unknown") throw Error("PILOT_DIAGNOSTIC_LIFETIME_UNKNOWN");
        if (state === "running") {
          // TERM only; allow the independent30s recovery plus retirement. No forced kill/reset/retry.
          await port.terminateDiagnostic(); await port.waitRecovery(); state = await port.diagnostic();
        }
        if (!["terminal", "absent"].includes(state)) throw Error("PILOT_DIAGNOSTIC_STILL_LIVE");
        const actual = await port.original();
        if (!sameOriginal(actual, approval.original)) throw Error("PILOT_ORIGINAL_CHANGED_DURING_TRIAL");
        if (actual.running) {
          // TERM did not establish terminal. Keep evidence/lock; no force kill or trial.
          throw Error("PILOT_ORIGINAL_STILL_LIVE");
        } else {
          await port.usbReleased();
          if (diagnosticAttempted) {
            try { if (!await port.finalJournal()) { errors.push(Error("PILOT_RESTORE_UNCERTAIN")); safeRelease = false; } }
            catch (error) { errors.push(error); safeRelease = false; } // Terminal/free USB permits service restore, never baseline recapture.
          }
          await port.evidence("restart-pending"); await port.restartOriginal();
        }
        await port.postflight(); await port.evidence(errors.length ? "failed-restored" : "complete");
      } catch (error) { errors.push(error); safeRelease = false; }
    }
    if (locked) { try { if (safeRelease) await port.release(); else await port.preserve(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "PILOT_LAUNCHER_FAILED_EVIDENCE_PRESERVED");
  }
}
export function parseLauncherArgs(args: string[]): { mode: "help" | "prepare" | "run"; approval?: string; root?: string; token?: string } {
  if (!args.length) return { mode: "help" };
  const mode = args[0];
  if (mode === "--prepare" && args.length === 2 && args[1].startsWith("--approval=") && absolute(args[1].slice(11))) return { mode: "prepare", approval: args[1].slice(11) };
  if (mode === "--run" && args.length === 3 && args[1].startsWith("--root=") && /^--start=[a-f0-9]{64}$/.test(args[2]) && absolute(args[1].slice(7))) {
    return { mode: "run", root: args[1].slice(7), token: args[2].slice(8) };
  }
  throw Error("PILOT_LAUNCHER_ARGUMENT");
}
export async function launcherMain(args = process.argv.slice(2)) {
  const parsed = parseLauncherArgs(args);
  if (parsed.mode === "help") { console.log("PILOT_LAUNCHER_OPT_IN_REQUIRED_NO_HOST_ACTION"); return; }
  const host = await import("./bio-sensor-event-pilot-launcher-host");
  if (parsed.mode === "prepare") {
    const root = await host.prepareRun(parsed.approval!); console.log(`PILOT_PREPARED_PRIVATE_BOOTSTRAP ${root}/bootstrap.json`); return;
  }
  await host.executeRun(parsed.root!, parsed.token!);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) launcherMain().catch(() => {
  console.error("PILOT_LAUNCHER_FAILED_PRIVATE_EVIDENCE_REQUIRED"); process.exitCode = 1;
});
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
