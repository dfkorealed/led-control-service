import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
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
    assignAddressOnce: vi.fn(async () => ({ outcome: "confirmed" as const, device: { ...device, logicalAddress: 0x0100 } })),
    readState: vi.fn(async () => ({ brightnessPercent: 60, mode: "sensor" as const })),
    setOutput: vi.fn(async () => undefined),
    restoreSensorMode: vi.fn(async () => undefined),
    restartAndRecover: vi.fn(async () => undefined),
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

  it("uses only a temporary mapping, assigns once, verifies getters and every output, and restores sensor mode", async () => {
    const h = harness();
    const request = confirmation();

    expect(await runBioRegistrationHil(request.args, h.dependencies)).toBe(0);

    expect(h.dependencies.createTemporaryMapping).toHaveBeenCalledTimes(1);
    expect(h.dependencies.createWritableSession).toHaveBeenCalledWith("/tmp/bio-registration-hil-test/mappings.json");
    expect(h.writer.discoverFresh).toHaveBeenCalledTimes(1);
    expect(h.writer.reserveTemporaryMapping).toHaveBeenCalledWith(device, 0x0100);
    expect(h.writer.assignAddressOnce).toHaveBeenCalledTimes(1);
    expect(h.writer.assignAddressOnce).toHaveBeenCalledWith(device, 0x0100);
    expect(h.writer.confirmTemporaryMapping).toHaveBeenCalledWith(expect.objectContaining({ logicalAddress: 0x0100 }));
    expect(h.writer.readState).toHaveBeenCalledWith(expect.objectContaining({ logicalAddress: 0x0100 }));
    expect(h.writer.setOutput).toHaveBeenCalledTimes(6);
    expect(h.writer.setOutput).toHaveBeenNthCalledWith(1, expect.objectContaining({ logicalAddress: 0x0100 }), 0);
    expect(h.writer.setOutput).toHaveBeenNthCalledWith(2, expect.anything(), 20);
    expect(h.writer.setOutput).toHaveBeenNthCalledWith(3, expect.anything(), 60);
    expect(h.writer.setOutput).toHaveBeenNthCalledWith(4, expect.anything(), 90);
    expect(h.writer.setOutput).toHaveBeenNthCalledWith(5, expect.anything(), 100);
    expect(h.writer.setOutput).toHaveBeenNthCalledWith(6, expect.anything(), 20);
    expect(h.dependencies.confirmVisualStep).toHaveBeenCalledTimes(6);
    expect(h.writer.restartAndRecover).toHaveBeenCalledTimes(1);
    expect(h.writer.restoreSensorMode).toHaveBeenCalledTimes(7);
    expect(h.writer.close).toHaveBeenCalledTimes(1);
    expect(h.dependencies.removeTemporaryMapping).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.output[0])).toEqual({
      status: "HIL_WRITE_SEQUENCE_COMPLETED",
      fingerprint: request.fingerprint,
      oldAddress: "0x1234",
      newAddress: "0x0100",
      networkId: "0x0021",
      temporaryMapping: "REMOVED",
      multiDeviceGroup: "DEFERRED_INSUFFICIENT_HARDWARE"
    });
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

  it.each(["unchanged", "unknown"] as const)("never retries when one assignment reconciles as %s", async (outcome) => {
    const h = harness();
    h.writer.assignAddressOnce = vi.fn(async () => outcome === "unchanged"
      ? { outcome, device }
      : { outcome, code: "BIO_ADDRESS_STATE_UNKNOWN" as const });

    expect(await runBioRegistrationHil(confirmation().args, h.dependencies)).toBe(1);

    expect(h.writer.assignAddressOnce).toHaveBeenCalledTimes(1);
    expect(h.writer.setOutput).not.toHaveBeenCalled();
    expect(h.writer.restoreSensorMode).toHaveBeenCalledTimes(outcome === "unknown" ? 2 : 1);
    if (outcome === "unknown") {
      expect(h.writer.restoreSensorMode).toHaveBeenNthCalledWith(1, expect.objectContaining({ logicalAddress: 0x1234 }));
      expect(h.writer.restoreSensorMode).toHaveBeenNthCalledWith(2, expect.objectContaining({ logicalAddress: 0x0100 }));
    }
    expect(h.writer.close).toHaveBeenCalledTimes(1);
    expect(h.dependencies.removeTemporaryMapping).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.output[0])).toMatchObject({ status: "FAILED", errors: ["BIO_ADDRESS_STATE_UNKNOWN"] });
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
      temporaryMapping: "CLEANUP_UNCONFIRMED"
    });
    expect(h.output[0]).not.toMatch(/001122334455|deadbeef|\/dev\/bus|secret|payload|descriptor/i);
  });

  it("does not expose factory-reset, password, arbitrary frame, or raw identity options", () => {
    const source = readFileSync(new URL("./bio-registration-hil.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/--(?:factory|password|reset|raw|command|payload|hex)/i);
    expect(source).not.toMatch(/console\.(?:error|warn)\([^)]*(?:nativeUuid|error\.message)/);
  });
});
