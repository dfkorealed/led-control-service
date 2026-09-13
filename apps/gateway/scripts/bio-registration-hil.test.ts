import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BioAddressConflictError } from "../src/bio/bio-dongle-client";
import {
  decodePassiveHilObservation,
  fingerprintBioUuid,
  runBioRegistrationHil,
  type BioRegistrationHilDependencies,
  type HilDiscoveredDevice,
  type HilWritableSession
} from "./bio-registration-hil";

const device: HilDiscoveredDevice = {
  nativeUuid: "001122334455",
  logicalAddress: 0x1234,
  networkId: 0x0021,
  firmwareVersion: "1.2.3.4",
  rssi: -45
};

function confirmation(newAddress = 0x0100) {
  const fingerprint = fingerprintBioUuid(device.nativeUuid);
  return {
    fingerprint,
    args: [
      "--execute",
      "--fingerprint", fingerprint,
      "--old-address", "0x1234",
      "--new-address", `0x${newAddress.toString(16).padStart(4, "0")}`,
      "--confirm-address-change", `CHANGE:${fingerprint}:0x1234->0x${newAddress.toString(16).padStart(4, "0")}`
    ]
  };
}

function harness(observations: HilDiscoveredDevice[] = [device]) {
  const output: string[] = [];
  const readonlySession = {
    discover: vi.fn(async () => observations),
    close: vi.fn(async () => undefined)
  };
  const writer: HilWritableSession = {
    discoverFresh: vi.fn(async () => [device]),
    reserveTemporaryMapping: vi.fn(async () => undefined),
    confirmTemporaryMapping: vi.fn(async () => undefined),
    assignAddressOnce: vi.fn(async (_device, _newAddress, control) => {
      control?.onWriteStarted?.();
      return { outcome: "confirmed" as const, device: { ...device, logicalAddress: 0x0100 } };
    }),
    readState: vi.fn(async () => ({ brightnessPercent: 60, mode: "sensor" as const })),
    setOutput: vi.fn(async (_device, _percent, control) => { control?.onWriteStarted?.(); }),
    restoreSensorMode: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  };
  const dependencies: BioRegistrationHilDependencies = {
    createReadOnlySession: vi.fn(() => readonlySession),
    createWritableSession: vi.fn(async () => writer),
    createTemporaryMapping: vi.fn(async () => ({ directory: "/tmp/bio-registration-hil-test", path: "/tmp/bio-registration-hil-test/mappings.json" })),
    removeTemporaryMapping: vi.fn(async () => undefined),
    confirmVisualStep: vi.fn(async () => true),
    output: (line) => output.push(line)
  };
  return { output, readonlySession, writer, dependencies };
}

describe("guarded BIO registration HIL CLI", () => {
  it("extracts only the confirmed common header from a checksum-validated passive outer 0x12", () => {
    const payload = Buffer.alloc(16);
    payload.write("001122334455", 1, "hex");
    payload.writeUInt16BE(0x1234, 9);
    payload.writeUInt16BE(0x0021, 13);
    payload[15] = 0x7f;

    expect(decodePassiveHilObservation({ protocol: "crc16", command: 0x12, payload })).toEqual({
      nativeUuid: "001122334455",
      logicalAddress: 0x1234,
      networkId: 0x0021,
      firmwareVersion: "unreported",
      rssi: 0
    });
    expect(decodePassiveHilObservation({ protocol: "crc16", command: 0x03, payload })).toBeNull();
    expect(decodePassiveHilObservation({ protocol: "crc16", command: 0x12, payload: payload.subarray(0, 14) })).toBeNull();
  });

  it("dry-run constructs only the passive read-only session and emits a redacted confirmation tuple", async () => {
    const h = harness();

    expect(await runBioRegistrationHil(["--dry-run", "--new-address", "0x0100"], h.dependencies)).toBe(0);

    expect(h.dependencies.createReadOnlySession).toHaveBeenCalledTimes(1);
    expect(h.dependencies.createWritableSession).not.toHaveBeenCalled();
    expect(h.dependencies.createTemporaryMapping).not.toHaveBeenCalled();
    expect(h.readonlySession.close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.output[0])).toEqual({
      status: "AWAITING_USER_CONFIRMATION",
      fingerprint: fingerprintBioUuid(device.nativeUuid),
      oldAddress: "0x1234",
      requestedNewAddress: "0x0100",
      networkId: "0x0021",
      confirmation: `CHANGE:${fingerprintBioUuid(device.nativeUuid)}:0x1234->0x0100`,
      newAddressSource: "CALLER_MUST_USE_API_RESERVED_ADDRESS"
    });
    expect(h.output[0]).not.toContain(device.nativeUuid);
    expect(h.output[0]).not.toMatch(/payload|descriptor|\/dev\/bus\/usb/i);
  });

  it("dry-run reports address selection blocked when no API-reserved address is supplied", async () => {
    const h = harness();

    expect(await runBioRegistrationHil(["--dry-run"], h.dependencies)).toBe(3);

    expect(JSON.parse(h.output[0])).toEqual({
      status: "NEW_ADDRESS_SELECTION_BLOCKED",
      fingerprint: fingerprintBioUuid(device.nativeUuid),
      oldAddress: "0x1234",
      requestedNewAddress: null,
      networkId: "0x0021",
      reason: "API_RESERVED_ADDRESS_REQUIRED"
    });
    expect(h.dependencies.createWritableSession).not.toHaveBeenCalled();
  });

  it.each([
    [], ["--dry-run", "--old-address", "0x1234"], ["--execute"],
    ["--dry-run", "--new-address", "0x0000"], ["--dry-run", "--new-address", "0x8000"],
    ["--dry-run", "--raw", "deadbeef"], ["--dry-run", "--command", "0x10"],
    ["--dry-run", "--password", "secret"], ["--dry-run", "--reset"],
    ["--dry-run", "--new-address", "0x0100", "--new-address", "0x0101"]
  ])("rejects invalid or write-bypass arguments %j before opening USB", async (...args) => {
    const h = harness();

    expect(await runBioRegistrationHil(args, h.dependencies)).toBe(2);

    expect(h.dependencies.createReadOnlySession).not.toHaveBeenCalled();
    expect(h.dependencies.createWritableSession).not.toHaveBeenCalled();
    expect(JSON.parse(h.output[0])).toEqual({ status: "INVALID_ARGUMENTS" });
  });

  it.each([
    ["zero devices", [], "BIO_DEVICE_NOT_FOUND"],
    ["multiple devices", [device, { ...device, nativeUuid: "aabbccddeeff", logicalAddress: 0x2345 }], "BIO_MULTIPLE_DEVICES"],
    ["duplicate UUID at different addresses", [device, { ...device, logicalAddress: 0x1235 }], "BIO_DUPLICATE_UUID"],
    ["two UUIDs colliding at one address", [device, { ...device, nativeUuid: "aabbccddeeff" }], "BIO_ADDRESS_CONFLICT"]
  ])("fails closed for $0", async (_name, discovered, code) => {
    const h = harness(discovered as HilDiscoveredDevice[]);

    expect(await runBioRegistrationHil(["--dry-run", "--new-address", "0x0100"], h.dependencies)).toBe(1);

    expect(JSON.parse(h.output[0])).toMatchObject({ status: "FAILED", errors: [code] });
    expect(h.dependencies.createWritableSession).not.toHaveBeenCalled();
  });

  it("rejects an address collision with the observed old address", async () => {
    const h = harness();

    expect(await runBioRegistrationHil(["--dry-run", "--new-address", "0x1234"], h.dependencies)).toBe(1);

    expect(JSON.parse(h.output[0])).toMatchObject({ status: "FAILED", errors: ["BIO_ADDRESS_CONFLICT"] });
  });

  it.each([
    ["fingerprint", (args: string[]) => args.map((value) => value === fingerprintBioUuid(device.nativeUuid) ? "sha256:ffffffffffffffff" : value)],
    ["old address", (args: string[]) => args.map((value) => value === "0x1234" ? "0x1235" : value)],
    ["confirmation", (args: string[]) => args.map((value) => value.startsWith("CHANGE:") ? `${value}!` : value)]
  ])("requires exact $0 and fresh discovery before constructing a writer", async (_name, mutate) => {
    const h = harness();
    const request = confirmation();

    expect(await runBioRegistrationHil(mutate(request.args), h.dependencies)).toBe(1);

    expect(h.readonlySession.discover).toHaveBeenCalledTimes(1);
    expect(h.dependencies.createWritableSession).not.toHaveBeenCalled();
    expect(JSON.parse(h.output[0])).toMatchObject({ status: "FAILED", errors: ["CONFIRMATION_MISMATCH"] });
  });

  it("uses only a temporary mapping, assigns once, verifies phase-one getters and outputs, and restores sensor mode", async () => {
    const h = harness();
    const request = confirmation();

    expect(await runBioRegistrationHil(request.args, h.dependencies)).toBe(4);

    expect(h.dependencies.createTemporaryMapping).toHaveBeenCalledTimes(1);
    expect(h.dependencies.createWritableSession).toHaveBeenCalledWith("/tmp/bio-registration-hil-test/mappings.json");
    expect(h.writer.discoverFresh).toHaveBeenCalledTimes(1);
    expect(h.writer.reserveTemporaryMapping).toHaveBeenCalledWith(device, 0x0100);
    expect(h.writer.assignAddressOnce).toHaveBeenCalledTimes(1);
    expect(h.writer.assignAddressOnce).toHaveBeenCalledWith(device, 0x0100, expect.objectContaining({
      onWriteStarted: expect.any(Function)
    }));
    expect(h.writer.confirmTemporaryMapping).toHaveBeenCalledWith(expect.objectContaining({ logicalAddress: 0x0100 }));
    expect(h.writer.readState).toHaveBeenCalledWith(
      expect.objectContaining({ logicalAddress: 0x0100 }),
      expect.any(AbortSignal)
    );
    expect(h.writer.setOutput).toHaveBeenCalledTimes(5);
    expect(h.writer.setOutput).toHaveBeenNthCalledWith(1, expect.objectContaining({ logicalAddress: 0x0100 }), 0, expect.anything());
    expect(h.writer.setOutput).toHaveBeenNthCalledWith(2, expect.anything(), 20, expect.anything());
    expect(h.writer.setOutput).toHaveBeenNthCalledWith(3, expect.anything(), 60, expect.anything());
    expect(h.writer.setOutput).toHaveBeenNthCalledWith(4, expect.anything(), 90, expect.anything());
    expect(h.writer.setOutput).toHaveBeenNthCalledWith(5, expect.anything(), 100, expect.anything());
    expect(h.dependencies.confirmVisualStep).toHaveBeenCalledTimes(5);
    expect(h.writer.restoreSensorMode).toHaveBeenCalledTimes(6);
    expect(h.writer.close).toHaveBeenCalledTimes(1);
    expect(h.dependencies.removeTemporaryMapping).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.output[0])).toEqual({
      status: "PROCESS_RESTART_DRIVER_REQUIRED",
      completedPhase: "ADDRESS_AND_OUTPUT_VALIDATION",
      fingerprint: request.fingerprint,
      oldAddress: "0x1234",
      newAddress: "0x0100",
      networkId: "0x0021",
      temporaryMapping: "REMOVED",
      step7: "INCOMPLETE",
      multiDeviceGroup: "DEFERRED_INSUFFICIENT_HARDWARE"
    });
  });

  it("stops after the first process phase instead of simulating a Gateway restart in one process", async () => {
    const h = harness();

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(4);

    expect(h.writer.setOutput).toHaveBeenCalledTimes(5);
    expect(JSON.parse(h.output[0])).toMatchObject({
      status: "PROCESS_RESTART_DRIVER_REQUIRED",
      completedPhase: "ADDRESS_AND_OUTPUT_VALIDATION",
      temporaryMapping: "REMOVED"
    });
  });

  it("gives every sensor restoration an independent bounded cleanup deadline", async () => {
    const h = harness();
    const controls: Array<{ deadlineAt?: number } | undefined> = [];
    h.writer.restoreSensorMode = vi.fn(async (_device, control?: { deadlineAt?: number }) => {
      controls.push(control);
    });

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(4);

    expect(controls).toHaveLength(6);
    expect(controls.every((control) => typeof control?.deadlineAt === "number" && control.deadlineAt > Date.now())).toBe(true);
    expect(controls.every((control) => !("signal" in control!))).toBe(true);
  });

  it("rejects a production mapping location before creating a write-capable session", async () => {
    const h = harness();
    h.dependencies.createTemporaryMapping = vi.fn(async () => ({
      directory: "/var/lib/led-control",
      path: "/var/lib/led-control/bio-device-mappings.json"
    }));

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(1);

    expect(h.dependencies.createWritableSession).not.toHaveBeenCalled();
    expect(h.dependencies.removeTemporaryMapping).not.toHaveBeenCalled();
    expect(JSON.parse(h.output[0])).toMatchObject({ status: "FAILED", errors: ["TEMP_MAPPING_PATH_FORBIDDEN"] });
  });

  it("does not send a sensor restore when fresh identity validation fails before any state write", async () => {
    const h = harness();
    h.writer.discoverFresh = vi.fn(async () => [{ ...device, logicalAddress: 0x1235 }]);

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(1);

    expect(h.writer.assignAddressOnce).not.toHaveBeenCalled();
    expect(h.writer.restoreSensorMode).not.toHaveBeenCalled();
    expect(h.writer.close).toHaveBeenCalledTimes(1);
    expect(h.dependencies.removeTemporaryMapping).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.output[0])).toMatchObject({ status: "FAILED", errors: ["FRESH_DISCOVERY_MISMATCH"] });
  });

  it.each(["unchanged", "unknown"] as const)("never retries when one assignment reconciles as %s", async (outcome) => {
    const h = harness();
    h.writer.assignAddressOnce = vi.fn(async (_device, _newAddress, control) => {
      control?.onWriteStarted?.();
      return outcome === "unchanged"
        ? { outcome, device }
        : { outcome, code: "BIO_ADDRESS_STATE_UNKNOWN" as const, safeRestoreDevices: [device, { ...device, logicalAddress: 0x0100 }] };
    });

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(1);

    expect(h.writer.assignAddressOnce).toHaveBeenCalledTimes(1);
    expect(h.writer.setOutput).not.toHaveBeenCalled();
    expect(h.writer.restoreSensorMode).toHaveBeenCalledTimes(outcome === "unknown" ? 2 : 1);
    if (outcome === "unknown") {
      expect(h.writer.restoreSensorMode).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ logicalAddress: 0x1234 }),
        expect.objectContaining({ deadlineAt: expect.any(Number) })
      );
      expect(h.writer.restoreSensorMode).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ logicalAddress: 0x0100 }),
        expect.objectContaining({ deadlineAt: expect.any(Number) })
      );
    }
    expect(h.writer.close).toHaveBeenCalledTimes(1);
    expect(h.dependencies.removeTemporaryMapping).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.output[0])).toMatchObject({ status: "FAILED", errors: ["BIO_ADDRESS_STATE_UNKNOWN"] });
  });

  it("does not restore when cancellation wins before the address frame owns a physical write", async () => {
    const h = harness();
    h.writer.assignAddressOnce = vi.fn(async () => { throw new DOMException("cancelled", "AbortError"); });

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(1);

    expect(h.writer.restoreSensorMode).not.toHaveBeenCalled();
    expect(JSON.parse(h.output[0])).toMatchObject({ status: "FAILED", errors: ["CANCELLED"] });
  });

  it("rejects a claimed assignment outcome when no physical address write was observed", async () => {
    const h = harness();
    h.writer.assignAddressOnce = vi.fn(async () => ({
      outcome: "confirmed" as const,
      device: { ...device, logicalAddress: 0x0100 }
    }));

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(1);

    expect(h.writer.setOutput).not.toHaveBeenCalled();
    expect(h.writer.restoreSensorMode).not.toHaveBeenCalled();
    expect(JSON.parse(h.output[0])).toMatchObject({
      status: "FAILED",
      errors: ["ADDRESS_WRITE_OWNERSHIP_MISSING"]
    });
  });

  it("restores only the proven old identity when the requested address collides after assignment", async () => {
    const h = harness();
    h.writer.assignAddressOnce = vi.fn(async (_device, _newAddress, control) => {
      control?.onWriteStarted?.();
      throw new BioAddressConflictError([{
        ...device,
        deviceUuid: `bio:${device.nativeUuid}`
      }]);
    });

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(1);

    expect(h.writer.restoreSensorMode).toHaveBeenCalledTimes(1);
    expect(h.writer.restoreSensorMode).toHaveBeenCalledWith(
      device,
      expect.objectContaining({ deadlineAt: expect.any(Number) })
    );
    expect(h.writer.restoreSensorMode).not.toHaveBeenCalledWith(expect.objectContaining({ logicalAddress: 0x0100 }));
  });

  it("does not trust unbranded collision metadata as authority for a restore write", async () => {
    const h = harness();
    h.writer.assignAddressOnce = vi.fn(async (_device, _newAddress, control) => {
      control?.onWriteStarted?.();
      throw Object.assign(new Error("untrusted collision metadata"), {
        code: "BIO_ADDRESS_CONFLICT",
        safeRestoreDevices: [device]
      });
    });

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(1);

    expect(h.writer.restoreSensorMode).not.toHaveBeenCalled();
  });

  it("preserves primary, sensor-restore, close, and temporary-cleanup failures without leaking messages", async () => {
    const h = harness();
    h.writer.readState = vi.fn(async () => { throw Object.assign(new Error(`uuid=${device.nativeUuid}`), { code: "READBACK_FAILED" }); });
    h.writer.restoreSensorMode = vi.fn(async () => { throw Object.assign(new Error("raw=deadbeef"), { code: "RESTORE_FAILED" }); });
    h.writer.close = vi.fn(async () => { throw Object.assign(new Error("descriptor=/dev/bus/usb/001/004"), { code: "CLOSE_FAILED" }); });
    h.dependencies.removeTemporaryMapping = vi.fn(async () => { throw Object.assign(new Error("payload=secret"), { code: "TEMP_CLEANUP_FAILED" }); });

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(1);

    expect(JSON.parse(h.output[0])).toEqual({
      status: "FAILED",
      errors: ["READBACK_FAILED", "RESTORE_FAILED", "CLOSE_FAILED", "TEMP_CLEANUP_FAILED"],
      temporaryMapping: "RETAINED"
    });
    expect(h.output[0]).not.toMatch(/001122334455|deadbeef|\/dev\/bus|secret|payload|descriptor/i);
  });

  it("preserves an output primary failure before step restore, final restore, close, and cleanup failures", async () => {
    const h = harness();
    h.writer.setOutput = vi.fn(async (_device, _percent, control) => {
      control?.onWriteStarted?.();
      throw Object.assign(new Error("primary"), { code: "OUTPUT_FAILED" });
    });
    h.writer.restoreSensorMode = vi.fn(async () => { throw Object.assign(new Error("restore"), { code: "RESTORE_FAILED" }); });
    h.writer.close = vi.fn(async () => { throw Object.assign(new Error("close"), { code: "CLOSE_FAILED" }); });
    h.dependencies.removeTemporaryMapping = vi.fn(async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(1);

    expect(JSON.parse(h.output[0])).toEqual({
      status: "FAILED",
      errors: ["OUTPUT_FAILED", "RESTORE_FAILED", "RESTORE_FAILED", "CLOSE_FAILED", "TEMP_CLEANUP_FAILED"],
      temporaryMapping: "RETAINED"
    });
  });

  it.each(["SIGINT", "SIGTERM"] as const)("keeps repeated %s inside a real child until restore, close, and cleanup complete", async (terminationSignal) => {
    const directory = await mkdtemp(join(tmpdir(), "bio-hil-signal-test-"));
    const childPath = join(directory, "child.mts");
    const moduleUrl = new URL("./bio-registration-hil.ts", import.meta.url).href;
    await writeFile(childPath, `
      import { runBioRegistrationHil } from ${JSON.stringify(moduleUrl)};
      const device = { nativeUuid: "001122334455", logicalAddress: 0x1234, networkId: 0x21, firmwareVersion: "1", rssi: -1 };
      const writer = {
        discoverFresh: async () => [device], reserveTemporaryMapping: async () => {},
        assignAddressOnce: async (_device, _address, control) => {
          control?.onWriteStarted?.();
          return { outcome: "confirmed", device: { ...device, logicalAddress: 0x0100 } };
        },
        confirmTemporaryMapping: async () => {}, readState: async () => ({ brightnessPercent: 20, mode: "sensor" }),
        setOutput: async (_device, percent, control) => { control?.onWriteStarted?.(); console.log("OUTPUT:" + percent); },
        restoreSensorMode: async () => { console.log("RESTORE"); },
        close: async () => { console.log("CLOSE"); }
      };
      const code = await runBioRegistrationHil([
        "--execute", "--fingerprint", "sha256:48f4634d1002f9f3", "--old-address", "0x1234",
        "--new-address", "0x0100", "--confirm-address-change", "CHANGE:sha256:48f4634d1002f9f3:0x1234->0x0100"
      ], {
        createReadOnlySession: () => ({ discover: async () => [device], close: async () => {} }),
        createWritableSession: async () => writer,
        createTemporaryMapping: async () => ({ directory: "/tmp/bio-registration-hil-child", path: "/tmp/bio-registration-hil-child/mappings.json" }),
        removeTemporaryMapping: async () => { console.log("CLEANUP"); },
        confirmVisualStep: async (_percent, signal) => {
          console.log("PROMPT");
          await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
          return false;
        },
        output: (line) => console.log("RESULT:" + line)
      });
      console.log("EXIT:" + code);
      process.exitCode = code;
    `, { mode: 0o600 });

    const child = spawn(process.execPath, ["--import", "tsx", childPath], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("PROMPT") && !stdout.includes("SIGNALLED")) {
        stdout += "SIGNALLED\n";
        child.kill(terminationSignal);
        child.kill(terminationSignal);
      }
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("signal child timed out")); }, 10_000);
      child.once("close", (code, signal) => { clearTimeout(timeout); resolveResult({ code, signal }); });
    });
    await rm(directory, { recursive: true, force: true });

    expect({ ...result, stderr }).toEqual({ code: 1, signal: null, stderr: "" });
    expect(stdout).toContain("RESTORE");
    expect(stdout).toContain("CLOSE");
    expect(stdout).toContain("CLEANUP");
    expect(stdout).toContain('RESULT:{"status":"FAILED"');
    expect(stdout).toContain("EXIT:1");
    expect(stdout.match(/OUTPUT:/g)).toHaveLength(1);
  }, 15_000);

  it("bounds repeated-signal cancellation through a real client when native close never settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bio-hil-real-client-signal-"));
    const childPath = join(directory, "child.mts");
    const hilModuleUrl = new URL("./bio-registration-hil.ts", import.meta.url).href;
    const clientModuleUrl = new URL("../src/bio/bio-dongle-client.ts", import.meta.url).href;
    await writeFile(childPath, `
      import { EventEmitter } from "node:events";
      import { runBioRegistrationHilStandalone } from ${JSON.stringify(hilModuleUrl)};
      import { BioDongleClient } from ${JSON.stringify(clientModuleUrl)};
      const identity = { nativeUuid: "001122334455", logicalAddress: 0x1234, networkId: 0x21, firmwareVersion: "1", rssi: -1 };
      let factories = 0;
      let writesAtClose = -1;
      class HangingConnection extends EventEmitter {
        writes = [];
        async open() {}
        async write(bytes) {
          const hex = Buffer.from(bytes).toString("hex");
          this.writes.push(hex);
          if (hex === "4753820000") queueMicrotask(() => this.emit("data", Buffer.from("55aa030c02050320682f0000000300001147", "hex")));
          else if (hex.startsWith("55aa0a")) queueMicrotask(() => this.emit("data", Buffer.from("55aa0b0d0001000000000000010c000320c50e", "hex")));
          else if (hex.startsWith("55aa10")) {
            console.log("ACTIVE_WRITE");
            queueMicrotask(() => this.emit("data", Buffer.from("55aa1101002055", "hex")));
          }
        }
        close() {
          writesAtClose = this.writes.length;
          console.log("NATIVE_CLOSE_STARTED");
          return new Promise(() => {});
        }
        onData(listener) { this.on("data", listener); return () => this.off("data", listener); }
        onDisconnect(listener) { this.on("error", listener); return () => this.off("error", listener); }
      }
      const connection = new HangingConnection();
      const client = new BioDongleClient({
        timeoutMs: 100, scanDurationMs: 5_000, observationTimeoutMs: 100,
        reconnectReadyTimeoutMs: 500, retirementTimeoutMs: 100,
        connectionFactory: () => { factories += 1; return connection; }
      });
      const writer = {
        discoverFresh: async () => [identity], reserveTemporaryMapping: async () => {},
        assignAddressOnce: async (_device, _address, control) => {
          control?.onWriteStarted?.();
          return { outcome: "confirmed", device: { ...identity, logicalAddress: 0x0100 } };
        },
        confirmTemporaryMapping: async () => {}, readState: async () => ({ brightnessPercent: 20, mode: "sensor" }),
        setOutput: async (_device, _percent, control) => client.scan(control),
        restoreSensorMode: async (device, control) => client.restoreSensorMode(device, control),
        close: async () => client.close()
      };
      setInterval(() => {}, 1_000);
      await runBioRegistrationHilStandalone([
        "--execute", "--fingerprint", "sha256:48f4634d1002f9f3", "--old-address", "0x1234",
        "--new-address", "0x0100", "--confirm-address-change", "CHANGE:sha256:48f4634d1002f9f3:0x1234->0x0100"
      ], {
        createReadOnlySession: () => ({ discover: async () => [identity], close: async () => {} }),
        createWritableSession: async () => { await client.probe(); return writer; },
        createTemporaryMapping: async () => ({ directory: "/tmp/bio-registration-hil-real-child", path: "/tmp/bio-registration-hil-real-child/mappings.json" }),
        removeTemporaryMapping: async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          console.log("COUNTS:" + factories + ":" + writesAtClose + ":" + connection.writes.length);
          console.log("CLEANUP");
        },
        confirmVisualStep: async () => true,
        cleanupTimeoutMs: 500
      });
      console.log("AFTER_STANDALONE_CLEANUP");
    `, { mode: 0o600 });

    const child = spawn(process.execPath, ["--import", "tsx", childPath], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ACTIVE_WRITE") && !stdout.includes("SIGNALLED")) {
        stdout += "SIGNALLED\n";
        child.kill("SIGTERM");
        child.kill("SIGTERM");
      }
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("real-client signal child timed out")); }, 5_000);
      child.once("close", (code, signal) => { clearTimeout(timeout); resolveResult({ code, signal }); });
    });
    await rm(directory, { recursive: true, force: true });

    expect({ ...result, stderr }).toEqual({ code: 1, signal: null, stderr: "" });
    expect(stdout).toContain("NATIVE_CLOSE_STARTED");
    expect(stdout).toContain("CLEANUP");
    const finalDiagnostic = '{"status":"FAILED","errors":["CANCELLED","CLOSE_FAILED","NOT_READY","NOT_READY","CLOSE_FAILED"],"temporaryMapping":"REMOVED"}';
    expect(stdout.trimEnd().endsWith(finalDiagnostic)).toBe(true);
    expect(stdout).toContain("COUNTS:1:4:4");
    expect(stdout).not.toContain(device.nativeUuid);
    expect(stdout).not.toContain("AFTER_STANDALONE_CLEANUP");
  }, 10_000);

  it("forces the standalone CLI to exit after a complete synchronous diagnostic even when a referenced handle remains", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bio-hil-standalone-exit-"));
    const childPath = join(directory, "child.mts");
    const moduleUrl = new URL("./bio-registration-hil.ts", import.meta.url).href;
    await writeFile(childPath, `
      const moduleUrl = ${JSON.stringify(moduleUrl)};
      process.argv.splice(1, process.argv.length - 1, new URL(moduleUrl).pathname, "--raw");
      setInterval(() => {}, 1_000);
      await import(moduleUrl);
      console.log("AFTER_STANDALONE_MAIN");
    `, { mode: 0o600 });

    const child = spawn(process.execPath, ["--import", "tsx", childPath], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let parentHadToKill = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult) => {
      const timeout = setTimeout(() => {
        parentHadToKill = true;
        child.kill("SIGKILL");
      }, 750);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolveResult({ code, signal });
      });
    });
    await rm(directory, { recursive: true, force: true });

    expect(parentHadToKill).toBe(false);
    expect({ ...result, stderr }).toEqual({ code: 2, signal: null, stderr: "" });
    expect(stdout).toBe('{"status":"INVALID_ARGUMENTS"}\n');
    expect(stdout).not.toContain("AFTER_STANDALONE_MAIN");
  }, 5_000);

  it("bounds hanging restoration, close, and temporary cleanup after cancellation", async () => {
    const h = harness();
    const never = () => new Promise<void>(() => {});
    h.writer.setOutput = vi.fn(async (_device, _percent, control) => {
      control?.onWriteStarted?.();
      throw Object.assign(new Error("cancelled"), { code: "STOPPED" });
    });
    h.writer.restoreSensorMode = vi.fn(never);
    h.writer.close = vi.fn(never);
    h.dependencies.removeTemporaryMapping = vi.fn(never);
    h.dependencies.cleanupTimeoutMs = 5;

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(1);

    expect(JSON.parse(h.output[0])).toEqual({
      status: "FAILED",
      errors: ["STOPPED", "RESTORE_TIMEOUT", "RESTORE_TIMEOUT", "CLOSE_TIMEOUT", "TEMP_CLEANUP_FAILED"],
      temporaryMapping: "RETAINED"
    });
  });

  it("bounds a hanging read-only client close while preserving the discovery cancellation", async () => {
    const h = harness();
    h.readonlySession.discover = vi.fn(async () => { throw Object.assign(new Error("cancelled"), { code: "STOPPED" }); });
    h.readonlySession.close = vi.fn(() => new Promise<void>(() => {}));
    h.dependencies.cleanupTimeoutMs = 5;

    expect(await runBioRegistrationHil(["--dry-run"], h.dependencies)).toBe(1);

    expect(JSON.parse(h.output[0])).toEqual({
      status: "FAILED",
      errors: ["STOPPED", "CLOSE_TIMEOUT"]
    });
  });

  it("does not expose factory-reset, password, arbitrary frame, or raw identity options", () => {
    const source = readFileSync(new URL("./bio-registration-hil.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/--(?:factory|password|reset|raw|command|payload|hex)/i);
    expect(source).not.toMatch(/console\.(?:error|warn)\([^)]*(?:nativeUuid|error\.message)/);
  });
});
