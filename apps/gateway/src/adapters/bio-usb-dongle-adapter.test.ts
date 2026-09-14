import { describe, expect, it, vi } from "vitest";
import type {
  MeshGroupSubscriptionSyncPayload,
  ProvisioningDeviceCommandV2,
  ProvisioningScanStartPayload
} from "@led-control/shared";
import { BioUsbDongleAdapter } from "./bio-usb-dongle-adapter";

const scanCommand: ProvisioningScanStartPayload = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "33333333-3333-4333-8333-333333333333",
  floorId: "44444444-4444-4444-8444-444444444444",
  scanCorrelationId: "55555555-5555-4555-8555-555555555555",
  scanAttempt: 1,
  requestedAt: "2026-09-13T00:00:00.000Z"
};

const provisioningCommand: ProvisioningDeviceCommandV2 = {
  commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sessionId: scanCommand.sessionId,
  siteId: scanCommand.siteId,
  gatewayId: scanCommand.gatewayId,
  nodeId: "66666666-6666-4666-8666-666666666666",
  deviceUuid: "bio:a1b2c3d4e5f6",
  meshAddress: "0x0101",
  requestedAt: "2026-09-13T00:00:01.000Z"
};

const discovered = {
  nativeUuid: "a1b2c3d4e5f6",
  deviceUuid: "bio:a1b2c3d4e5f6",
  logicalAddress: 0x1234,
  networkId: 0x7788,
  firmwareVersion: "1.2.3.4",
  rssi: -41
};

describe("BioUsbDongleAdapter", () => {
  it("accepts only canonical lowercase BIO UUIDs", () => {
    const adapter = createFixture().adapter;

    expect(adapter.acceptsDeviceUuid("bio:a1b2c3d4e5f6")).toBe(true);
    expect(adapter.acceptsDeviceUuid("bio:A1B2C3D4E5F6")).toBe(false);
    expect(adapter.acceptsDeviceUuid("bio:a1b2c3d4e5f")).toBe(false);
    expect(adapter.acceptsDeviceUuid("44464b4c454401010101aabbccddeeff")).toBe(false);
  });

  it("exposes BIO discovery through the existing provisioning scan payload", async () => {
    const f = createFixture();
    f.client.scan.mockResolvedValue([discovered]);

    await expect(f.adapter.scan(scanCommand)).resolves.toEqual([{
      deviceUuid: discovered.deviceUuid,
      serialNumber: discovered.deviceUuid,
      rssi: -41,
      oobCapability: "none",
      firmwareVersion: "1.2.3.4"
    }]);
  });

  it("recovers an interrupted identify with UUID rediscovery and sensor-only restore", async () => {
    const f = createFixture();
    f.client.scan.mockResolvedValue([discovered]);
    f.client.restoreSensorMode.mockResolvedValue(undefined);

    await expect(f.adapter.recoverIdentifySafety({
      ...provisioningCommand
    })).resolves.toBeUndefined();

    expect(f.client.scan).toHaveBeenCalledOnce();
    expect(f.client.restoreSensorMode).toHaveBeenCalledOnce();
    expect(f.client.restoreSensorMode).toHaveBeenCalledWith(discovered);
    expect(f.client.startIdentify).not.toHaveBeenCalled();
  });

  it("orders identify restore, reservation, UUID assignment, confirmation, and completion", async () => {
    const events: string[] = [];
    const f = createFixture(events);
    f.mappings.findByDeviceUuidIncludingReserved.mockImplementation(async () => { events.push("lookup-mapping"); return null; });
    f.client.startIdentify.mockImplementation(async () => { events.push("identify-restored"); return discovered; });
    f.mappings.reserve.mockImplementation(async () => { events.push("mapping-reserved"); return reservedMapping(); });
    f.client.assignAddressOnce.mockImplementation(async () => {
      events.push("address-confirmed-by-scan");
      return { outcome: "confirmed", device: { ...discovered, logicalAddress: 0x0101 } };
    });
    f.mappings.confirm.mockImplementation(async () => { events.push("mapping-confirmed"); return confirmedMapping(); });

    await expect(f.adapter.provision(provisioningCommand)).resolves.toEqual({
      sessionId: provisioningCommand.sessionId,
      nodeId: provisioningCommand.nodeId,
      deviceUuid: provisioningCommand.deviceUuid,
      meshAddress: "0x0101",
      firmwareVersion: discovered.firmwareVersion,
      rssi: -41,
      hopCount: null,
      completedAt: "2026-09-13T00:00:02.000Z"
    });

    expect(events).toEqual([
      "lookup-mapping",
      "identify-restored",
      "mapping-reserved",
      "address-confirmed-by-scan",
      "mapping-confirmed"
    ]);
    expect(f.mappings.reserve).toHaveBeenCalledWith({
      fixtureId: provisioningCommand.nodeId,
      nodeId: provisioningCommand.nodeId,
      deviceUuid: provisioningCommand.deviceUuid,
      nativeUuid: discovered.nativeUuid,
      logicalAddress: 0x0101,
      observedLogicalAddressBeforeAssignment: discovered.logicalAddress,
      commandId: provisioningCommand.commandId,
      firmware: discovered.firmwareVersion,
      protocol: "crc16"
    });
  });

  it("sends a newly approved address exactly once and leaves an unchanged result unresolved", async () => {
    const f = createFixture();
    f.mappings.findByDeviceUuidIncludingReserved.mockResolvedValue(null);
    f.client.startIdentify.mockResolvedValue(discovered);
    f.mappings.reserve.mockResolvedValue(reservedMapping());
    // 기존 자동 재시도 API가 성공하도록 만들어 두어도 production adapter는 이 경로를
    // 호출하면 안 된다. 실제 1회 write API의 unchanged는 주소 미확정으로 종료돼야 한다.
    f.client.assignAddress.mockResolvedValue({
      outcome: "confirmed",
      device: { ...discovered, logicalAddress: 0x0101 }
    });
    f.client.assignAddressOnce.mockResolvedValue({ outcome: "unchanged", device: discovered });

    await expect(f.adapter.provision(provisioningCommand)).rejects.toMatchObject({
      code: "BIO_ADDRESS_STATE_UNKNOWN"
    });

    expect(f.client.assignAddressOnce).toHaveBeenCalledOnce();
    expect(f.client.assignAddress).not.toHaveBeenCalled();
    expect(f.mappings.confirm).not.toHaveBeenCalled();
  });

  it.each(["0x0000", "0x8000", "0xc000", "0101", "0x001"])(
    "rejects invalid unicast mesh address %s before device work",
    async (meshAddress) => {
      const f = createFixture();
      await expect(f.adapter.provision({ ...provisioningCommand, meshAddress })).rejects.toThrow(/BIO mesh address/i);
      expect(f.client.startIdentify).not.toHaveBeenCalled();
      expect(f.mappings.reserve).not.toHaveBeenCalled();
    }
  );

  it("converges a confirmed restart without repeating identify or address writes", async () => {
    const f = createFixture();
    f.mappings.findByDeviceUuidIncludingReserved.mockResolvedValue(confirmedMapping());

    await expect(f.adapter.recoverProvisioning(provisioningCommand)).resolves.toMatchObject({
      deviceUuid: provisioningCommand.deviceUuid,
      meshAddress: provisioningCommand.meshAddress,
      firmwareVersion: discovered.firmwareVersion,
      rssi: null,
      hopCount: null
    });
    expect(f.client.startIdentify).not.toHaveBeenCalled();
    expect(f.client.assignAddress).not.toHaveBeenCalled();
    expect(f.client.reconcileAddress).not.toHaveBeenCalled();
  });

  it("recovers a reserved restart only from old/new UUID reconciliation", async () => {
    const f = createFixture();
    f.mappings.findByDeviceUuidIncludingReserved.mockResolvedValue(reservedMapping());
    f.client.reconcileAddress.mockResolvedValue({
      outcome: "confirmed",
      device: { ...discovered, logicalAddress: 0x0101 }
    });
    f.mappings.confirm.mockResolvedValue(confirmedMapping());

    await expect(f.adapter.recoverProvisioning(provisioningCommand)).resolves.toMatchObject({
      meshAddress: "0x0101",
      rssi: -41,
      hopCount: null
    });
    expect(f.client.reconcileAddress).toHaveBeenCalledWith(discovered.nativeUuid, discovered.logicalAddress, 0x0101);
    expect(f.client.assignAddress).not.toHaveBeenCalled();
    expect(f.mappings.confirm).toHaveBeenCalledWith(provisioningCommand.deviceUuid, 0x0101);
  });

  it("uses only confirmed mappings and returns one read-back-backed fixture report", async () => {
    const f = createFixture();
    f.client.scan.mockResolvedValue([{ ...discovered, logicalAddress: 0x0101 }]);
    f.mappings.findByFixtureId.mockResolvedValue(confirmedMapping());
    f.client.setOutput.mockResolvedValue({ brightnessPercent: 60, powerOn: true, rawHighBrightness: 198, mode: "force-on" });

    await f.adapter.scan(scanCommand);
    await expect(f.adapter.applyUnicast(provisioningCommand.nodeId, 60)).resolves.toEqual({
      fixtureId: provisioningCommand.nodeId,
      acknowledged: true,
      outcome: "applied",
      brightness: 60,
      mode: "force-on",
      rssi: -41,
      hopCount: null
    });
    expect(f.client.setOutput).toHaveBeenCalledWith({
      kind: "unicast",
      nativeUuid: discovered.nativeUuid,
      networkId: discovered.networkId,
      logicalAddress: 0x0101
    }, 60);

    f.mappings.findByFixtureId.mockResolvedValue(null);
    await expect(f.adapter.applyUnicast("77777777-7777-4777-8777-777777777777", 60)).resolves.toMatchObject({
      acknowledged: false,
      outcome: "failed",
      faultCode: "fixture_not_registered"
    });
  });

  it("propagates command cancellation and deadline to the BIO client operation", async () => {
    const f = createFixture();
    const controller = new AbortController();
    const deadlineAt = Date.now() + 1_000;
    f.client.scan.mockResolvedValue([{ ...discovered, logicalAddress: 0x0101 }]);
    f.mappings.findByFixtureId.mockResolvedValue(confirmedMapping());
    f.client.setOutput.mockRejectedValue(new DOMException("cancelled", "AbortError"));
    await f.adapter.scan(scanCommand);

    const report = await f.adapter.applyUnicast(
      provisioningCommand.nodeId,
      60,
      controller.signal,
      deadlineAt
    );

    expect(f.client.setOutput).toHaveBeenCalledWith(expect.any(Object), 60, {
      signal: controller.signal,
      deadlineAt
    });
    expect(report).toMatchObject({ acknowledged: false, outcome: "failed" });
  });

  it("starts no cold discovery scan when output is aborted during mapping lookup", async () => {
    const f = createFixture();
    const controller = new AbortController();
    let releaseLookup!: (mapping: ReturnType<typeof confirmedMapping>) => void;
    f.mappings.findByFixtureId.mockImplementation(() => new Promise((resolve) => { releaseLookup = resolve; }));
    const applying = f.adapter.applyUnicast(provisioningCommand.nodeId, 60, controller.signal, Date.now() + 1_000);
    void applying.catch(() => {});
    await Promise.resolve();

    controller.abort();
    releaseLookup(confirmedMapping());

    await expect(applying).resolves.toMatchObject({ outcome: "timed_out", faultCode: "command_expired" });
    expect(f.client.scan).not.toHaveBeenCalled();
    expect(f.client.setOutput).not.toHaveBeenCalled();
  });

  it("starts no cold discovery scan when attention is aborted during mapping lookup", async () => {
    const f = createFixture();
    const controller = new AbortController();
    let releaseLookup!: (mapping: ReturnType<typeof confirmedMapping>) => void;
    f.mappings.findByFixtureId.mockImplementation(() => new Promise((resolve) => { releaseLookup = resolve; }));
    const attention = f.adapter.setAttention(
      provisioningCommand.nodeId,
      Date.now() + 1_000,
      "start",
      controller.signal
    );
    void attention.catch(() => {});
    await Promise.resolve();

    controller.abort();
    releaseLookup(confirmedMapping());

    await expect(attention).rejects.toThrow("command_expired");
    expect(f.client.scan).not.toHaveBeenCalled();
    expect(f.client.startIdentify).not.toHaveBeenCalled();
  });

  it("does not share one caller-owned discovery refresh with an independent caller", async () => {
    const f = createFixture();
    const firstController = new AbortController();
    const secondController = new AbortController();
    let rejectFirstScan!: (error: unknown) => void;
    f.mappings.findByFixtureId.mockResolvedValue(confirmedMapping());
    f.client.scan
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirstScan = reject; }))
      .mockResolvedValueOnce([{ ...discovered, logicalAddress: 0x0101 }]);
    f.client.setOutput.mockResolvedValue({ brightnessPercent: 60, powerOn: true, rawHighBrightness: 198, mode: "force-on" });

    const first = f.adapter.applyUnicast(provisioningCommand.nodeId, 60, firstController.signal, Date.now() + 1_000);
    void first.catch(() => {});
    await Promise.resolve();
    const second = f.adapter.applyUnicast(provisioningCommand.nodeId, 60, secondController.signal, Date.now() + 1_000);
    void second.catch(() => {});
    await Promise.resolve();

    firstController.abort();
    rejectFirstScan(new DOMException("cancelled", "AbortError"));

    await expect(first).resolves.toMatchObject({ outcome: "timed_out", faultCode: "command_expired" });
    await expect(second).resolves.toMatchObject({ acknowledged: true, outcome: "applied", mode: "force-on" });
    expect(f.client.scan).toHaveBeenCalledTimes(2);
    expect(f.client.scan).toHaveBeenNthCalledWith(1, {
      signal: firstController.signal,
      deadlineAt: expect.any(Number)
    });
    expect(f.client.scan).toHaveBeenNthCalledWith(2, {
      signal: secondController.signal,
      deadlineAt: expect.any(Number)
    });
  });

  it("propagates observed brightness and mode from a read-back mismatch", async () => {
    const f = createFixture();
    f.client.scan.mockResolvedValue([{ ...discovered, logicalAddress: 0x0101 }]);
    f.mappings.findByFixtureId.mockResolvedValue(confirmedMapping());
    f.client.setOutput.mockRejectedValue(Object.assign(
      new Error("BIO control-mode read-back did not match"),
      { code: "BIO_CONTROL_MODE_STATE_MISMATCH", observedBrightnessPercent: 38, observedMode: "sensor" }
    ));

    await f.adapter.scan(scanCommand);
    await expect(f.adapter.applyUnicast(provisioningCommand.nodeId, 60)).resolves.toEqual({
      fixtureId: provisioningCommand.nodeId,
      acknowledged: false,
      outcome: "failed",
      brightness: 38,
      mode: "sensor",
      faultCode: "BIO_CONTROL_MODE_STATE_MISMATCH",
      rssi: -41,
      hopCount: null
    });
  });

  it("does not substitute requested brightness when a BIO read-back has no table-backed percent", async () => {
    const f = createFixture();
    f.client.scan.mockResolvedValue([{ ...discovered, logicalAddress: 0x0101 }]);
    f.mappings.findByFixtureId.mockResolvedValue(confirmedMapping());
    f.client.setOutput.mockRejectedValue(Object.assign(
      new Error("BIO high-brightness read-back did not match"),
      {
        code: "BIO_BRIGHTNESS_STATE_MISMATCH",
        observedRawHighBrightness: 127,
        observedBrightnessPercent: null
      }
    ));

    await f.adapter.scan(scanCommand);
    const report = await f.adapter.applyUnicast(provisioningCommand.nodeId, 60);

    expect(report).toEqual({
      fixtureId: provisioningCommand.nodeId,
      acknowledged: false,
      outcome: "failed",
      rawBrightness: 127,
      faultCode: "BIO_BRIGHTNESS_STATE_MISMATCH",
      rssi: -41,
      hopCount: null
    });
  });

  it("stores virtual membership and fans group control out as exactly four concurrent unicasts", async () => {
    const f = createFixture();
    const fixtureIds = Array.from({ length: 5 }, (_, index) => `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
    const mappings = fixtureIds.map((fixtureId, index) => confirmedMapping({
      fixtureId,
      nodeId: `${(0xa0000000 + index).toString(16)}-0000-4000-8000-000000000000`,
      deviceUuid: `bio:00000000000${index + 1}`,
      nativeUuid: `00000000000${index + 1}`,
      logicalAddress: 0x0101 + index
    }));
    f.mappings.findByLogicalAddress.mockImplementation(async (address: number) =>
      mappings.find((mapping) => mapping.logicalAddress === address) ?? null
    );
    f.mappings.findByFixtureId.mockImplementation(async (fixtureId: string) =>
      mappings.find((mapping) => mapping.fixtureId === fixtureId) ?? null
    );
    f.client.scan.mockResolvedValue(mappings.map((mapping, index) => ({
      ...discovered,
      nativeUuid: mapping.nativeUuid,
      deviceUuid: mapping.deviceUuid,
      logicalAddress: mapping.logicalAddress,
      rssi: -40 - index
    })));
    await f.adapter.scan(scanCommand);
    const group = groupCommand(mappings);
    await expect(f.adapter.syncGroupSubscriptions(group)).resolves.toMatchObject({
      operations: group.expectedOperations.map((operation) => ({ ...operation, status: "ready" }))
    });

    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.client.setOutput.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return { brightnessPercent: 60, powerOn: true, rawHighBrightness: 198, mode: "force-on" };
    });

    const applying = f.adapter.applyMeshGroup(0xc000, fixtureIds, 60);
    await vi.waitFor(() => expect(active).toBe(4));
    expect(f.client.setOutput).toHaveBeenCalledTimes(4);
    release();
    await expect(applying).resolves.toHaveLength(5);
    expect(maxActive).toBe(4);
    expect(f.client.setOutput).toHaveBeenCalledTimes(5);
  });

  it("caps an explicitly requested parallel-unicast concurrency of eight at four", async () => {
    const f = createFixture();
    const fixtureIds = Array.from({ length: 5 }, (_, index) => `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
    const mappings = fixtureIds.map((fixtureId, index) => confirmedMapping({
      fixtureId,
      nodeId: fixtureId,
      deviceUuid: `bio:00000000000${index + 1}`,
      nativeUuid: `00000000000${index + 1}`,
      logicalAddress: 0x0101 + index
    }));
    f.mappings.findByFixtureId.mockImplementation(async (fixtureId: string) =>
      mappings.find((mapping) => mapping.fixtureId === fixtureId) ?? null
    );
    f.client.scan.mockResolvedValue(mappings.map((mapping) => ({
      ...discovered,
      nativeUuid: mapping.nativeUuid,
      deviceUuid: mapping.deviceUuid,
      logicalAddress: mapping.logicalAddress
    })));
    await f.adapter.scan(scanCommand);
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.client.setOutput.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return { brightnessPercent: 60, powerOn: true, rawHighBrightness: 198, mode: "force-on" };
    });

    const applying = f.adapter.applyParallelUnicast(fixtureIds, 60, 8);
    await vi.waitFor(() => expect(active).toBe(4));
    release();
    await expect(applying).resolves.toHaveLength(5);
    expect(maxActive).toBe(4);
  });

  it("fails virtual membership operations whose address lacks a confirmed mapping", async () => {
    const f = createFixture();
    f.mappings.findByLogicalAddress.mockResolvedValue(null);
    const group = groupCommand([confirmedMapping()]);

    await expect(f.adapter.syncGroupSubscriptions(group)).resolves.toMatchObject({
      operations: [{ ...group.expectedOperations[0], status: "failed", error: "bio_mapping_not_confirmed" }]
    });
    expect(f.client.setOutput).not.toHaveBeenCalled();
  });

  it("restores confirmed virtual membership from the durable applied snapshot", async () => {
    const f = createFixture();
    const mapping = confirmedMapping();
    f.mappings.findByLogicalAddress.mockResolvedValue(mapping);
    f.mappings.findByFixtureId.mockResolvedValue(mapping);
    f.client.scan.mockResolvedValue([{ ...discovered, logicalAddress: mapping.logicalAddress }]);
    f.client.setOutput.mockResolvedValue({ brightnessPercent: 60, powerOn: true, rawHighBrightness: 198, mode: "force-on" });
    await f.adapter.scan(scanCommand);
    const base = groupCommand([mapping]);

    await f.adapter.syncGroupSubscriptions({ ...base, expectedOperations: [] }, base.desiredMembers);

    await expect(f.adapter.applyMeshGroup(0xc000, [mapping.fixtureId], 60)).resolves.toEqual([
      expect.objectContaining({ fixtureId: mapping.fixtureId, acknowledged: true, outcome: "applied" })
    ]);
  });

  it("hydrates only confirmed local virtual members from a ready startup snapshot", async () => {
    const f = createFixture();
    const mapping = confirmedMapping();
    const wrongIdentityMapping = confirmedMapping({
      fixtureId: "88888888-8888-4888-8888-888888888888",
      nodeId: "99999999-9999-4999-8999-999999999999",
      deviceUuid: "bio:001122334466",
      nativeUuid: "001122334466",
      logicalAddress: 0x0102
    });
    f.mappings.findByLogicalAddress.mockImplementation(async (address: number) =>
      address === mapping.logicalAddress ? mapping : address === wrongIdentityMapping.logicalAddress ? wrongIdentityMapping : null
    );
    f.mappings.findByFixtureId.mockImplementation(async (fixtureId: string) =>
      fixtureId === mapping.fixtureId ? mapping : fixtureId === wrongIdentityMapping.fixtureId ? wrongIdentityMapping : null
    );
    f.client.scan.mockResolvedValue([
      { ...discovered, logicalAddress: mapping.logicalAddress },
      {
        ...discovered,
        nativeUuid: wrongIdentityMapping.nativeUuid,
        deviceUuid: wrongIdentityMapping.deviceUuid,
        logicalAddress: wrongIdentityMapping.logicalAddress
      }
    ]);
    f.client.setOutput.mockResolvedValue({ brightnessPercent: 60, powerOn: true, rawHighBrightness: 198, mode: "force-on" });
    await f.adapter.scan(scanCommand);

    await f.adapter.hydrateGroupSubscriptions([{
      groupId: "77777777-7777-4777-8777-777777777777",
      groupAddress: "0xc000",
      version: 1,
      members: [
        { meshNodeId: mapping.nodeId, meshAddress: "0x0101" },
        { meshNodeId: "88888888-8888-4888-8888-888888888888", meshAddress: "0x0102" }
      ]
    }]);

    await expect(f.adapter.applyMeshGroup(0xc000, [mapping.fixtureId], 60)).resolves.toEqual([
      expect.objectContaining({ fixtureId: mapping.fixtureId, acknowledged: true, outcome: "applied" })
    ]);
    await expect(f.adapter.applyMeshGroup(0xc000, [wrongIdentityMapping.fixtureId], 60)).resolves.toEqual([
      expect.objectContaining({ faultCode: "bio_virtual_group_not_ready" })
    ]);
  });
});

function createFixture(events: string[] = []) {
  const client = {
    scan: vi.fn(),
    startIdentify: vi.fn(),
    stopIdentify: vi.fn(),
    assignAddress: vi.fn(),
    assignAddressOnce: vi.fn(),
    reconcileAddress: vi.fn(),
    setOutput: vi.fn(),
    restoreSensorMode: vi.fn()
  };
  const mappings = {
    findByDeviceUuidIncludingReserved: vi.fn(async (): Promise<any> => { events.push("lookup-mapping"); return null; }),
    reserve: vi.fn(),
    confirm: vi.fn(),
    findByFixtureId: vi.fn(),
    findByLogicalAddress: vi.fn(),
    listConfirmed: vi.fn().mockResolvedValue([])
  };
  return {
    client,
    mappings,
    adapter: new BioUsbDongleAdapter(client, mappings, { now: () => new Date("2026-09-13T00:00:02.000Z") })
  };
}

function reservedMapping(overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: provisioningCommand.nodeId,
    nodeId: provisioningCommand.nodeId,
    deviceUuid: provisioningCommand.deviceUuid,
    nativeUuid: discovered.nativeUuid,
    logicalAddress: 0x0101,
    observedLogicalAddressBeforeAssignment: discovered.logicalAddress,
    commandId: provisioningCommand.commandId,
    firmware: discovered.firmwareVersion,
    protocol: "crc16",
    status: "reserved" as const,
    updatedAt: "2026-09-13T00:00:01.000Z",
    ...overrides
  };
}

function confirmedMapping(overrides: Record<string, unknown> = {}) {
  return { ...reservedMapping(), status: "confirmed" as const, ...overrides };
}

function groupCommand(mappings: ReturnType<typeof confirmedMapping>[]): MeshGroupSubscriptionSyncPayload {
  return {
    siteId: scanCommand.siteId,
    gatewayId: scanCommand.gatewayId,
    groupId: "77777777-7777-4777-8777-777777777777",
    version: 1,
    groupAddress: "0xc000",
    reconciliationMode: "full_state",
    desiredMembers: mappings.map((mapping) => ({
      meshNodeId: String(mapping.nodeId),
      meshAddress: `0x${Number(mapping.logicalAddress).toString(16).padStart(4, "0")}`
    })),
    expectedOperations: mappings.map((mapping, index) => ({
      operationId: `${(0xb0000000 + index).toString(16)}-0000-4000-8000-000000000000`,
      action: "add" as const,
      meshNodeId: String(mapping.nodeId),
      meshAddress: `0x${Number(mapping.logicalAddress).toString(16).padStart(4, "0")}`
    })),
    requestedAt: "2026-09-13T00:00:00.000Z"
  };
}
