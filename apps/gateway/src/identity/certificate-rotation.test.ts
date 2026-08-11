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
    const schedule = vi.fn();
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
    const mqttStore = {
      currentIdentity: vi.fn().mockResolvedValue({ notAfter: new Date("2026-08-01T00:00:00.000Z"), caPath: "/dev/null" }),
      ensure: vi.fn(async (_gatewayId, _caBundle, _issue, probe) => {
        await probe(candidate);
        return true;
      })
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
    expect(activateMqttIdentity).toHaveBeenCalledWith(candidate);
    expect(mqttProbe.mock.invocationCallOrder[0]).toBeLessThan(activateMqttIdentity.mock.invocationCallOrder[0]);
  });
});
