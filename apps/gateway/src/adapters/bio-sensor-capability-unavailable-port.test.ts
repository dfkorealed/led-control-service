import { describe, expect, it, vi } from "vitest";
import { BioSensorCapabilityUnavailablePort } from "./bio-sensor-capability-unavailable-port";

describe("BioSensorCapabilityUnavailablePort", () => {
  it("exposes no cloud vehicle sensor sources", async () => {
    const port = new BioSensorCapabilityUnavailablePort();

    await expect(port.listConfirmedSources()).resolves.toEqual([]);
    await expect(port.resolveByFixtureId("fixture-1")).resolves.toBeNull();
    await expect(port.resolveBySourceUnicast(0x0101)).resolves.toBeNull();
  });

  it("fails configure and send with the exact unsupported contract", async () => {
    const port = new BioSensorCapabilityUnavailablePort();

    await expect(port.configureSource({
      fixtureId: "fixture-1",
      meshNodeId: "node-1",
      primaryUnicast: 0x0101,
      elementCount: 1
    })).rejects.toMatchObject({ code: "bio_sensor_cloud_unsupported", message: "bio_sensor_cloud_unsupported" });
    await expect(port.send(0x0101, Uint8Array.of(1))).rejects.toMatchObject({
      code: "bio_sensor_cloud_unsupported",
      message: "bio_sensor_cloud_unsupported"
    });
  });

  it("never synthesizes a cloud sensor message", () => {
    const port = new BioSensorCapabilityUnavailablePort();
    const listener = vi.fn();
    const unsubscribe = port.onMessage(listener);

    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});
