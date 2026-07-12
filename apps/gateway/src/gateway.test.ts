import { describe, expect, it } from "vitest";
import {
  applyManualDimmingCommand,
  applyProvisionDevice,
  applyProvisioningScan,
  createHeartbeatPayload,
} from "./gateway";
import { StubBleMeshAdapter, StubProvisioningAdapter, StubProvisioningScannerAdapter } from "../test/stub-adapters";

describe("gateway manual dimming", () => {
  it("passes fixture targets to the BLE adapter and returns acknowledged state events", async () => {
    const adapter = new StubBleMeshAdapter();
    const result = await applyManualDimmingCommand(adapter, {
      commandId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      targetType: "group",
      targetId: "33333333-3333-4333-8333-333333333333",
      targetFixtureIds: ["fixture-a", "fixture-b"],
      brightness: 45,
      requestedBy: "operator-1",
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(adapter.commands).toEqual([{ fixtureIds: ["fixture-a", "fixture-b"], brightness: 45 }]);
    expect(result.ack).toMatchObject({ commandId: "11111111-1111-4111-8111-111111111111", status: "acknowledged" });
    expect(result.fixtureStates).toHaveLength(2);
    expect(result.fixtureStates[0]).toMatchObject({ fixtureId: "fixture-a", brightness: 45, powerOn: true, status: "online" });
  });

  it("falls back to a single target id for fixture commands", async () => {
    const adapter = new StubBleMeshAdapter();
    await applyManualDimmingCommand(adapter, {
      commandId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      targetType: "fixture",
      targetId: "fixture-single",
      brightness: 0,
      requestedBy: "operator-1",
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(adapter.commands).toEqual([{ fixtureIds: ["fixture-single"], brightness: 0 }]);
  });

  it("creates heartbeat payloads for the cloud", () => {
    expect(createHeartbeatPayload("site-1", "GW-RPI-001", new Date("2026-07-01T00:00:00.000Z"))).toEqual({
      siteId: "site-1",
      gatewaySerial: "GW-RPI-001",
      sentAt: "2026-07-01T00:00:00.000Z"
    });
  });

  it("marks the command failed when a BLE Mesh node reports a fixture fault", async () => {
    const result = await applyManualDimmingCommand(
      {
        async setBrightness() {
          return [
            {
              fixtureId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              acknowledged: true,
              brightness: 60,
              rssi: -61,
              hopCount: 2
            },
            {
              fixtureId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              acknowledged: false,
              brightness: 0,
              faultCode: "mesh-timeout",
              rssi: null,
              hopCount: null
            }
          ];
        }
      },
      {
        commandId: "11111111-1111-4111-8111-111111111111",
        siteId: "22222222-2222-4222-8222-222222222222",
        targetType: "group",
        targetId: "33333333-3333-4333-8333-333333333333",
        targetFixtureIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        brightness: 60,
        requestedBy: "operator-1",
        requestedAt: "2026-07-01T00:00:00.000Z"
      }
    );

    expect(result.ack).toMatchObject({
      commandId: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      errorMessage: "1 fixture command failed: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb(mesh-timeout)"
    });
    expect(result.fixtureStates).toEqual([
      expect.objectContaining({
        fixtureId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        brightness: 60,
        status: "online",
        rssi: -61,
        hopCount: 2,
        commandSuccessRate: 1
      }),
      expect.objectContaining({
        fixtureId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        brightness: 0,
        powerOn: false,
        status: "fault",
        commandSuccessRate: 0
      })
    ]);
  });

  it("creates discovered node events from provisioning scan commands", async () => {
    const nodes = await applyProvisioningScan(new StubProvisioningScannerAdapter({ count: 2, floorName: "B1" }), {
      sessionId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      gatewayId: "33333333-3333-4333-8333-333333333333",
      floorId: "44444444-4444-4444-8444-444444444444",
      requestedBy: "55555555-5555-4555-8555-555555555555",
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      sessionId: "11111111-1111-4111-8111-111111111111",
      deviceUuid: "esp32h2-b1-001",
      serialNumber: "LC-B1-001",
      oobCapability: "static-oob"
    });
  });

  it("returns provisioning completed and failed result payloads", async () => {
    const command = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      gatewayId: "33333333-3333-4333-8333-333333333333",
      nodeId: "44444444-4444-4444-8444-444444444444",
      deviceUuid: "esp32h2-b1-001",
      meshAddress: "0x0101",
      requestedAt: "2026-07-01T00:00:00.000Z"
    };

    await expect(applyProvisionDevice(new StubProvisioningAdapter(), command)).resolves.toEqual({
      completed: expect.objectContaining({
        sessionId: command.sessionId,
        nodeId: command.nodeId,
        deviceUuid: command.deviceUuid,
        meshAddress: "0x0101"
      })
    });

    await expect(
      applyProvisionDevice(
        {
          async identify() {},
          async provision() {
            throw new Error("provisioning timeout");
          }
        },
        command
      )
    ).resolves.toEqual({
      failed: expect.objectContaining({
        sessionId: command.sessionId,
        nodeId: command.nodeId,
        deviceUuid: command.deviceUuid,
        errorMessage: "provisioning timeout"
      })
    });
  });
});
