import { VehicleEventRulesService } from "./vehicle-event-rules.service";
import { TargetSnapshotService } from "./target-snapshot.service";

const siteId = "00000000-0000-4000-8000-000000000001";
const gatewayId = "00000000-0000-4000-8000-000000000002";
const sourceId = "00000000-0000-4000-8000-000000000003";
const targetId = "00000000-0000-4000-8000-000000000004";
const otherId = "00000000-0000-4000-8000-000000000005";
const now = new Date("2026-09-30T00:00:00Z");
const actor = { id: otherId } as never;

function fixture(id: string, bio = true, metadata: Record<string, unknown> = {}) {
  return { id, siteId, gatewayId, meshNodeId: id, meshNode: {
    vehicleSensorProtocol: bio ? "bio_usb_pulse" : "bluez_stateful",
    vehicleSensorCapabilityStatus: bio ? "unknown" : "supported",
    vehicleSensorCapabilityVerifiedAt: bio ? null : now,
    vehicleSensorCapabilityRevision: bio ? 0n : 1n,
    vehicleSensorServerBound: !bio, vehicleVendorEventModelBound: !bio,
    bioPulseReadiness: bio ? "ready" : "off", bioPulseCapabilityRevision: bio ? 1n : 0n,
    bioPulseProfileId: bio ? "test-profile" : null, bioPulseVerifiedAt: bio ? now : null,
    ...metadata
  } };
}

function context(fixtures = [fixture(sourceId), fixture(targetId)], existing?: Record<string, unknown>) {
  let rule: any = existing;
  const tx = {
    fixture: { findMany: jest.fn(async ({ where }) => fixtures.filter(f =>
      where.id.in.includes(f.id) && (!where.siteId || where.siteId === f.siteId))) },
    gateway: { findUnique: jest.fn(async () => ({ siteId })) },
    vehicleEventRule: {
      create: jest.fn(async ({ data }) => { rule = { ...data, createdAt: now, updatedAt: now }; }),
      update: jest.fn(async ({ data }) => { rule = { ...rule, ...data }; }),
      findFirst: jest.fn(async () => rule && ({ ...rule, gateway: { automationConfiguration: {
        desiredRevision: 9, appliedRevision: 9, syncStatus: "APPLIED"
      } } }))
    },
    vehicleEventSource: {
      findFirst: jest.fn().mockResolvedValue(null),
      createMany: jest.fn(async ({ data }) => { rule.sources = data; }),
      deleteMany: jest.fn(async () => { rule.sources = []; })
    },
    vehicleEventTarget: {
      createMany: jest.fn(async ({ data }) => { rule.targets = data; }),
      deleteMany: jest.fn(async () => { rule.targets = []; })
    },
    $queryRaw: jest.fn(async () => [])
  };
  const service = new VehicleEventRulesService({ $transaction: (fn: any) => fn(tx) } as never,
    { assert: async () => {}, assertManageInTransaction: async () => {} } as never,
    new TargetSnapshotService(),
    { lockMutation: async () => {}, incrementDesiredRevision: async () => {} } as never);
  return { service, tx };
}

function input(overrides: Record<string, unknown> = {}) {
  return { name: "BIO draft", status: "disabled", sourceFixtureIds: [sourceId],
    targetFixtureIds: [targetId], action: { dimmingEnabled: true, brightnessPercent: 70 }, ...overrides };
}

describe("server-owned BIO rule qualification", () => {
  it("rechecks saved event targets during an unrelated PATCH", async () => {
    const existing = { ...input(), id: otherId, siteId, gatewayId, sensorProtocol: "bio_usb_pulse", holdSeconds: 60,
      sources: [{ fixtureId: sourceId }], targets: [{ fixtureId: targetId }] };
    const h = context(undefined, existing);
    h.tx.vehicleEventSource.findFirst.mockResolvedValue({ fixtureId: targetId });
    await expect(h.service.update(siteId, otherId, actor, { name: "Renamed" }))
      .rejects.toMatchObject({ response: { code: "bio_source_target_forbidden" } });
    expect(h.tx.vehicleEventRule.update).not.toHaveBeenCalled();
  });
  it("rejects another enabled BIO rule's source as a new event target", async () => {
    const h = context();
    h.tx.vehicleEventSource.findFirst.mockResolvedValue({ fixtureId: targetId });
    await expect(h.service.create(siteId, actor, input())).rejects.toMatchObject({ response: { code: "bio_source_target_forbidden" } });
    expect(h.tx.vehicleEventRule.create).not.toHaveBeenCalled();
  });
  it.each([10, 60, 1800, undefined])("saves a ready BIO disabled draft with hold %s and pending sync", async holdSeconds => {
    const { service, tx } = context();
    const result = await service.create(siteId, actor, input(holdSeconds === undefined ? {} : { holdSeconds }));
    expect(result).toMatchObject({ sensorProtocol: "bio-usb-pulse", status: "disabled", holdSeconds: holdSeconds ?? 60,
      syncStatus: "PENDING" });
    expect(tx.vehicleEventRule.create.mock.calls[0][0].data.sensorProtocol).toBe("bio_usb_pulse");
  });

  it("rejects enabled BIO until separately authenticated V2 support exists", async () => {
    await expect(context().service.create(siteId, actor, input({ status: "enabled" })))
      .rejects.toMatchObject({ response: { code: "v2_support_unverified" } });
  });

  it.each(["off", "shadow", "degraded"])("rejects a %s BIO source even in a new draft", async readiness => {
    await expect(context([fixture(sourceId, true, { bioPulseReadiness: readiness }), fixture(targetId)])
      .service.create(siteId, actor, input())).rejects.toMatchObject({ status: 400 });
  });

  it.each([{ bioPulseCapabilityRevision: 0n }, { bioPulseProfileId: " \t" }, { bioPulseVerifiedAt: null }])(
    "rejects incomplete ready evidence %s", async metadata => {
      await expect(context([fixture(sourceId, true, metadata), fixture(targetId)]).service.create(siteId, actor, input()))
        .rejects.toMatchObject({ status: 400 });
    });

  it.each([9, 1801, 10.5])("rejects BIO hold %s", async holdSeconds => {
    await expect(context().service.create(siteId, actor, input({ holdSeconds }))).rejects.toMatchObject({ status: 400 });
  });

  it("preserves BlueZ five-second enabled rules", async () => {
    await expect(context([fixture(sourceId, false), fixture(targetId, false)]).service.create(siteId, actor,
      input({ status: "enabled", holdSeconds: 5 }))).resolves.toMatchObject({ holdSeconds: 5, sensorProtocol: "bluez-stateful" });
  });

  it.each([true, false])("rejects two sources, including mixed protocols (second BIO=%s)", async secondBio => {
    await expect(context([fixture(sourceId), fixture(otherId, secondBio), fixture(targetId)]).service.create(siteId, actor,
      input({ sourceFixtureIds: [sourceId, otherId] }))).rejects.toMatchObject({ status: 400 });
  });

  it("rejects A among B targets", async () => {
    await expect(context().service.create(siteId, actor, input({ targetFixtureIds: [sourceId, targetId] })))
      .rejects.toMatchObject({ status: 400 });
  });

  it.each(["bio-usb-pulse", "bluez-stateful"])("rejects caller protocol %s", async sensorProtocol => {
    await expect(context().service.create(siteId, actor, input({ sensorProtocol }))).rejects.toMatchObject({ status: 400 });
  });

  it("checks effective BIO hold during partial update", async () => {
    const existing = { ...input(), id: otherId, siteId, gatewayId, sensorProtocol: "bio_usb_pulse", holdSeconds: 60,
      sources: [{ fixtureId: sourceId }], targets: [{ fixtureId: targetId }] };
    await expect(context(undefined, existing).service.update(siteId, otherId, actor, { holdSeconds: 9 }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("rejects a target from another Gateway", async () => {
    await expect(context([fixture(sourceId), { ...fixture(targetId), gatewayId: otherId }])
      .service.create(siteId, actor, input())).rejects.toMatchObject({ response: { code: "single_gateway_required" } });
  });

  it("rejects a target from another site", async () => {
    await expect(context([fixture(sourceId), { ...fixture(targetId), siteId: otherId }])
      .service.create(siteId, actor, input())).rejects.toMatchObject({ status: 400 });
  });

  it("rejects duplicated B targets", async () => {
    await expect(context().service.create(siteId, actor, input({ targetFixtureIds: [targetId, targetId] })))
      .rejects.toMatchObject({ status: 400 });
  });

  it("rejects protocol spoofing on partial update", async () => {
    await expect(context().service.update(siteId, otherId, actor, { sensorProtocol: "bluez-stateful" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("clears prior V1 applied evidence when replacing a BlueZ source with BIO", async () => {
    const existing = { id: otherId, siteId, gatewayId, name: "Old BlueZ", status: "disabled",
      sensorProtocol: "bluez_stateful", holdSeconds: 5, appliedRevision: 9, desiredRevision: 9,
      dimmingEnabled: true, brightnessPercent: 70, createdAt: now, updatedAt: now,
      sources: [{ fixtureId: otherId }], targets: [{ fixtureId: targetId }] };
    await expect(context(undefined, existing).service.update(siteId, otherId, actor,
      { sourceFixtureIds: [sourceId], holdSeconds: 10 })).resolves.toMatchObject({
      sensorProtocol: "bio-usb-pulse", appliedRevision: 0, syncStatus: "PENDING"
    });
  });
});
