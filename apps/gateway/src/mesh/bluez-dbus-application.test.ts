import { describe, expect, it, vi } from "vitest";
import {
  BLUEZ_APPLICATION_PATHS,
  BluezDbusApplication,
  type DbusExportBus,
  type DbusInterfaceDefinition
} from "./bluez-dbus-application";

class FakeExportBus implements DbusExportBus {
  readonly exports = new Map<string, { implementation: Record<string, unknown>; definition: DbusInterfaceDefinition }>();

  exportInterface(implementation: Record<string, unknown>, path: string, definition: DbusInterfaceDefinition) {
    this.exports.set(`${path}:${definition.name}`, { implementation, definition });
  }
}

describe("BluezDbusApplication", () => {
  it("BlueZ가 요구하는 application hierarchy와 정확한 callback signature를 export한다", async () => {
    const bus = new FakeExportBus();
    const application = new BluezDbusApplication(bus, async () => [0, 0x0100]);

    await application.start();

    expect([...bus.exports.keys()]).toEqual(
      expect.arrayContaining([
        `${BLUEZ_APPLICATION_PATHS.root}:org.freedesktop.DBus.ObjectManager`,
        `${BLUEZ_APPLICATION_PATHS.application}:org.bluez.mesh.Application1`,
        `${BLUEZ_APPLICATION_PATHS.application}:org.bluez.mesh.Provisioner1`,
        `${BLUEZ_APPLICATION_PATHS.agent}:org.bluez.mesh.ProvisionAgent1`,
        `${BLUEZ_APPLICATION_PATHS.element}:org.bluez.mesh.Element1`
      ])
    );
    const provisioner = bus.exports.get(
      `${BLUEZ_APPLICATION_PATHS.application}:org.bluez.mesh.Provisioner1`
    )!.definition;
    expect(provisioner.methods.RequestProvData).toEqual(["y", "qq"]);
    expect(provisioner.methods.ScanResult).toEqual(["naya{sv}", ""]);
    expect(provisioner.methods.AddNodeComplete).toEqual(["ayqy", ""]);
  });

  it("dbus-native가 직렬화할 수 있는 문자열 property signature를 export한다", async () => {
    const bus = new FakeExportBus();
    const application = new BluezDbusApplication(bus, async () => [0, 0x0100]);

    await application.start();

    for (const { definition } of bus.exports.values()) {
      for (const signature of Object.values(definition.properties ?? {})) {
        expect(typeof signature).toBe("string");
      }
    }
    const agent = bus.exports.get(
      `${BLUEZ_APPLICATION_PATHS.agent}:org.bluez.mesh.ProvisionAgent1`
    )!.definition;
    expect(agent.properties).toEqual({ Capabilities: "as", OutOfBandInfo: "as" });
  });

  it("RequestProvData는 예약 저장소가 선택한 net index와 unicast를 반환한다", async () => {
    const bus = new FakeExportBus();
    const reserve = vi.fn(async (count: number) => [0, 0x120] as [number, number]);
    const application = new BluezDbusApplication(bus, reserve);
    await application.start();
    const provisioner = bus.exports.get(
      `${BLUEZ_APPLICATION_PATHS.application}:org.bluez.mesh.Provisioner1`
    )!.implementation;

    await expect((provisioner.RequestProvData as (count: number) => Promise<[number, number]>)(2)).resolves.toEqual([
      0,
      0x120
    ]);
    expect(reserve).toHaveBeenCalledWith(2);
  });

  it("BlueZ callback을 gateway event로 전달한다", async () => {
    const bus = new FakeExportBus();
    const application = new BluezDbusApplication(bus, async () => [0, 0x0100]);
    const scanListener = vi.fn();
    const messageListener = vi.fn();
    application.on("scanResult", scanListener);
    application.on("messageReceived", messageListener);
    await application.start();

    const provisioner = bus.exports.get(
      `${BLUEZ_APPLICATION_PATHS.application}:org.bluez.mesh.Provisioner1`
    )!.implementation;
    const element = bus.exports.get(`${BLUEZ_APPLICATION_PATHS.element}:org.bluez.mesh.Element1`)!.implementation;
    await (provisioner.ScanResult as Function)(-55, [...new Uint8Array(16).fill(1)], []);
    await (element.MessageReceived as Function)(0x0100, 0, ["q", 0x0001], [0x82, 0x4e, 0xff, 0xff]);

    expect(scanListener).toHaveBeenCalledWith(expect.objectContaining({ rssi: -55 }));
    expect(messageListener).toHaveBeenCalledWith(expect.objectContaining({ source: 0x0100 }));
  });
});
