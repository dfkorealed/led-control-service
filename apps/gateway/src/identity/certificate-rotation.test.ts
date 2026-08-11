import { describe, expect, it, vi } from "vitest";
import { CertificateRotation, createGatewayCertificateRotation, shouldRotateCertificate } from "./certificate-rotation";

describe("certificate rotation", () => {
  it("uses the leaf certificate notAfter and a fake clock to enter the 30-day renewal window", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    expect(shouldRotateCertificate(new Date("2026-08-13T23:59:59.999Z"), () => now)).toBe(true);
    expect(shouldRotateCertificate(new Date("2026-08-15T00:00:00.000Z"), () => now)).toBe(false);
  });

  it("serializes concurrent runs and bounds retry delays without logging credentials", async () => {
    let release!: () => void;
    const firstRun = new Promise<void>((resolve) => { release = resolve; });
    const rotateDevice = vi.fn(() => firstRun);
    const timer = {};
    const schedule = vi.fn(() => timer);
    const logger = { error: vi.fn() };
    const rotation = new CertificateRotation({
      rotateDevice,
      rotateMqtt: vi.fn(),
      schedule,
      logger,
      initialDelayMs: 50,
      maximumDelayMs: 100
    });

    const running = rotation.run();
    const duplicate = rotation.run();
    await Promise.resolve();
    expect(rotateDevice).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([running, duplicate]);

    rotateDevice.mockRejectedValueOnce(new Error("PRIVATE KEY must not appear"));
    await rotation.run();
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 100);
    expect(logger.error).toHaveBeenCalledWith("gateway certificate rotation failed");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("PRIVATE KEY");
  });

  it("activates the running MQTT client only after the candidate identity probe succeeds", async () => {
    const mqttProbe = vi.fn().mockResolvedValue(undefined);
    const activateMqttIdentity = vi.fn().mockResolvedValue(undefined);
    const candidate = {
      generationPath: "/identity/mqtt/pending-generations/candidate",
      certificatePath: "/identity/mqtt/pending-generations/candidate/gateway.crt",
      keyPath: "/identity/mqtt/pending-generations/candidate/gateway.key",
      caPath: "/identity/mqtt/pending-generations/candidate/mqtt-ca.crt"
    };
    const prepared = {
      candidate,
      commit: vi.fn(),
      rollback: vi.fn(),
      finalize: vi.fn(),
      isCommitted: vi.fn(() => false),
      isCurrentCandidate: vi.fn(async () => false)
    };
    const mqttStore = {
      currentIdentity: vi.fn().mockResolvedValue({ notAfter: new Date("2026-08-01T00:00:00.000Z"), caPath: "/dev/null" }),
      prepare: vi.fn().mockResolvedValue(prepared)
    };
    const rotation = createGatewayCertificateRotation({
      gatewayId: "gateway-27",
      deviceStore: { currentIdentity: vi.fn().mockResolvedValue({ notAfter: new Date("2026-10-01T00:00:00.000Z") }) } as never,
      mqttStore: mqttStore as never,
      deviceClient: {} as never,
      mqttClient: { requestCertificate: vi.fn() } as never,
      mqttProbe,
      activateMqttIdentity,
      clock: () => new Date("2026-07-15T00:00:00.000Z"),
      schedule: vi.fn()
    });

    await rotation.run();

    expect(mqttProbe).toHaveBeenCalledWith(candidate);
    expect(activateMqttIdentity).toHaveBeenCalledWith(prepared);
    expect(mqttProbe.mock.invocationCallOrder[0]).toBeLessThan(activateMqttIdentity.mock.invocationCallOrder[0]);
  });

  it("does not roll back an activated MQTT identity when old-generation cleanup fails", async () => {
    const prepared = {
      candidate: {
        generationPath: "/identity/mqtt/pending-generations/candidate",
        certificatePath: "/identity/mqtt/pending-generations/candidate/gateway.crt",
        keyPath: "/identity/mqtt/pending-generations/candidate/gateway.key",
        caPath: "/identity/mqtt/pending-generations/candidate/mqtt-ca.crt"
      },
      commit: vi.fn(),
      rollback: vi.fn(),
      finalize: vi.fn().mockRejectedValue(new Error("cleanup failed")),
      isCommitted: vi.fn(() => true),
      isCurrentCandidate: vi.fn(async () => true)
    };
    const rotation = createGatewayCertificateRotation({
      gatewayId: "gateway-27",
      deviceStore: { currentIdentity: vi.fn().mockResolvedValue({ notAfter: new Date("2026-10-01T00:00:00.000Z") }) } as never,
      mqttStore: {
        currentIdentity: vi.fn().mockResolvedValue({ notAfter: new Date("2026-08-01T00:00:00.000Z"), caPath: "/dev/null" }),
        prepare: vi.fn().mockResolvedValue(prepared)
      } as never,
      deviceClient: {} as never,
      mqttClient: { requestCertificate: vi.fn() } as never,
      mqttProbe: vi.fn().mockResolvedValue(undefined),
      activateMqttIdentity: vi.fn().mockResolvedValue(undefined),
      clock: () => new Date("2026-07-15T00:00:00.000Z"),
      schedule: vi.fn(),
      logger: { error: vi.fn() }
    });

    await rotation.run();

    expect(prepared.rollback).not.toHaveBeenCalled();
  });

  it("does not roll back a committed identity when runtime activation fails after CONNACK", async () => {
    let committed = false;
    const prepared = {
      candidate: {
        generationPath: "/identity/mqtt/pending-generations/candidate",
        certificatePath: "/identity/mqtt/pending-generations/candidate/gateway.crt",
        keyPath: "/identity/mqtt/pending-generations/candidate/gateway.key",
        caPath: "/identity/mqtt/pending-generations/candidate/mqtt-ca.crt"
      },
      commit: vi.fn(async () => { committed = true; }),
      rollback: vi.fn(async () => { committed = false; }),
      finalize: vi.fn(),
      isCommitted: vi.fn(() => committed),
      isCurrentCandidate: vi.fn(async () => committed)
    };
    const rotation = createGatewayCertificateRotation({
      gatewayId: "gateway-27",
      deviceStore: { currentIdentity: vi.fn().mockResolvedValue({ notAfter: new Date("2026-10-01T00:00:00.000Z") }) } as never,
      mqttStore: {
        currentIdentity: vi.fn().mockResolvedValue({ notAfter: new Date("2026-08-01T00:00:00.000Z"), caPath: "/dev/null" }),
        prepare: vi.fn().mockResolvedValue(prepared)
      } as never,
      deviceClient: {} as never,
      mqttClient: { requestCertificate: vi.fn() } as never,
      mqttProbe: vi.fn().mockResolvedValue(undefined),
      activateMqttIdentity: vi.fn(async (identity) => {
        await identity.commit();
        throw new Error("candidate failed after CONNACK");
      }),
      clock: () => new Date("2026-07-15T00:00:00.000Z"),
      schedule: vi.fn(),
      logger: { error: vi.fn() }
    });

    await rotation.run();

    expect(prepared.rollback).not.toHaveBeenCalled();
    expect(prepared.finalize).toHaveBeenCalledTimes(1);
    expect(committed).toBe(true);
  });

  it("does not finalize the candidate when a failed rollback left the old pointer current", async () => {
    const prepared = {
      candidate: {
        generationPath: "/identity/mqtt/pending-generations/candidate",
        certificatePath: "/identity/mqtt/pending-generations/candidate/gateway.crt",
        keyPath: "/identity/mqtt/pending-generations/candidate/gateway.key",
        caPath: "/identity/mqtt/pending-generations/candidate/mqtt-ca.crt"
      },
      commit: vi.fn(),
      rollback: vi.fn().mockRejectedValue(new Error("rollback fsync failed")),
      finalize: vi.fn(),
      isCommitted: vi.fn(() => true),
      isCurrentCandidate: vi.fn(async () => false)
    };
    const rotation = createGatewayCertificateRotation({
      gatewayId: "gateway-27",
      deviceStore: { currentIdentity: vi.fn().mockResolvedValue({ notAfter: new Date("2026-10-01T00:00:00.000Z") }) } as never,
      mqttStore: {
        currentIdentity: vi.fn().mockResolvedValue({ notAfter: new Date("2026-08-01T00:00:00.000Z"), caPath: "/dev/null" }),
        prepare: vi.fn().mockResolvedValue(prepared)
      } as never,
      deviceClient: {} as never,
      mqttClient: { requestCertificate: vi.fn() } as never,
      mqttProbe: vi.fn().mockResolvedValue(undefined),
      activateMqttIdentity: vi.fn().mockRejectedValue(new Error("candidate failed before CONNACK")),
      clock: () => new Date("2026-07-15T00:00:00.000Z"),
      schedule: vi.fn(),
      logger: { error: vi.fn() }
    });

    await rotation.run();

    expect(prepared.rollback).toHaveBeenCalledTimes(1);
    expect(prepared.finalize).not.toHaveBeenCalled();
  });

  it("cancels its scheduled retry and does not restart after stop", async () => {
    const timer = {};
    let scheduled!: () => void;
    const schedule = vi.fn((callback: () => void) => {
      scheduled = callback;
      return timer;
    });
    const cancel = vi.fn();
    const rotation = new CertificateRotation({
      rotateDevice: vi.fn(),
      rotateMqtt: vi.fn(),
      schedule,
      cancel
    });

    await rotation.run();
    await rotation.stop();
    scheduled();

    expect(cancel).toHaveBeenCalledWith(timer);
  });
});
