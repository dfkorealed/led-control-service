import { ConflictException, NotFoundException } from "@nestjs/common";
import { GatewayRecommissionService } from "./gateway-recommission.service";

const ids = {
  siteId: "site-1", inventoryId: "inventory-1", gatewayId: "gateway-1", serialNumber: "GW-001"
};

describe("GatewayRecommissionService", () => {
  it("rejects plaintext claim credentials before reading or deleting installation data", async () => {
    const db = fixture();
    await expect((service(db) as any).apply("job-1", "a".repeat(64), "plaintext-claim-code"))
      .rejects.toThrow("invalid claim code hash");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("returns a redacted, stable preview for exactly one claimed installation", async () => {
    const first = service(fixture());
    const second = service(fixture({ reverseCollections: true }));

    const [preview, reordered] = await Promise.all([
      first.preview({ siteId: ids.siteId, serialNumber: ids.serialNumber }),
      second.preview({ siteId: ids.siteId, serialNumber: ids.serialNumber })
    ]);

    expect(preview).toEqual({
      siteId: ids.siteId,
      inventoryId: ids.inventoryId,
      gatewayId: ids.gatewayId,
      serialNumber: ids.serialNumber,
      resetDigest: reordered.resetDigest,
      counts: {
        gateway: 1, fixture: 1, meshNode: 1, fixtureGroup: 1,
        provisioningSession: 0, command: 1, automationExecution: 0,
        monitoringIncident: 0, processedGatewayEvent: 0, gatewayEventWatermark: 0,
        energyFixtureIdentity: 0, energyGroupIdentity: 0, energyAggregate: 0,
        energyReport: 1, floorMapRevision: 1, gatewayClaimAudit: 1
      },
      certificates: { deviceActive: 1, mqttActive: 1, mqttPending: 1 }
    });
    expect(JSON.stringify(preview)).not.toContain("certificate-private-material");
    expect(JSON.stringify(preview)).not.toContain("mapping-private-material");
  });

  it("changes the digest when an exact deletion row changes", async () => {
    const baseline = await service(fixture()).preview({ siteId: ids.siteId, serialNumber: ids.serialNumber });
    const changed = await service(fixture({ extraFixture: true })).preview({ siteId: ids.siteId, serialNumber: ids.serialNumber });

    expect(changed.counts.fixture).toBe(2);
    expect(changed.resetDigest).not.toBe(baseline.resetDigest);
  });

  it.each([
    ["a different Site", fixture({ missingSite: true })],
    ["a serial outside the claimed inventory", fixture({ missingInventory: true })],
    ["multiple claimed Gateways", fixture({ multipleGateways: true })],
    ["an unbound Fixture", fixture({ unboundFixture: true })],
    ["disabled inventory", fixture({ disabled: true })],
    ["unclaimed inventory", fixture({ unclaimed: true })]
  ])("rejects %s instead of preparing a partial reset", async (_label, db) => {
    await expect(service(db).preview({ siteId: ids.siteId, serialNumber: ids.serialNumber })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects a stale digest before it can create a durable job", async () => {
    const db = fixture();
    const recommission = service(db);
    await expect(recommission.prepare({ siteId: ids.siteId, serialNumber: ids.serialNumber, resetDigest: "0".repeat(64) }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(db.gatewayRecommissionJob.create).not.toHaveBeenCalled();
  });

  it("persists only redacted reset metadata and rejects a second active job", async () => {
    const db = fixture();
    const recommission = service(db);
    const preview = await recommission.preview({ siteId: ids.siteId, serialNumber: ids.serialNumber });
    const prepared = await recommission.prepare({ ...preview });

    expect(prepared).toMatchObject({ jobId: "job-1", status: "prepared", resetDigest: preview.resetDigest });
    const data = db.gatewayRecommissionJob.create.mock.calls[0][0].data;
    expect(JSON.stringify(data.targetSnapshot)).not.toContain("certificate-private-material");
    expect(JSON.stringify(data.targetSnapshot)).not.toContain("mapping-private-material");
    await expect(recommission.prepare({ ...preview })).rejects.toBeInstanceOf(ConflictException);
  });
});

function service(db: ReturnType<typeof fixture>) {
  return new GatewayRecommissionService(db as never);
}

function fixture(overrides: {
  disabled?: boolean; unclaimed?: boolean; missingSite?: boolean; missingInventory?: boolean;
  multipleGateways?: boolean; unboundFixture?: boolean; extraFixture?: boolean; reverseCollections?: boolean;
} = {}) {
  const rows = [
    overrides.missingSite ? [] : [{ id: ids.siteId }],
    overrides.missingInventory ? [] : [{ id: ids.inventoryId, serialNumber: ids.serialNumber, claimedGatewayId: overrides.unclaimed ? null : ids.gatewayId, disabledAt: overrides.disabled ? new Date() : null }],
    [
      { id: "cert-device", purpose: "device", status: "active", certificateSerial: "certificate-private-material" },
      { id: "cert-mqtt-active", purpose: "mqtt", status: "active", certificateSerial: "certificate-private-material" },
      { id: "cert-mqtt-pending", purpose: "mqtt", status: "pending", certificateSerial: "certificate-private-material" }
    ],
    overrides.multipleGateways ? [{ id: ids.gatewayId, siteId: ids.siteId, serialNumber: ids.serialNumber }, { id: "gateway-2", siteId: ids.siteId, serialNumber: ids.serialNumber }]
      : [{ id: ids.gatewayId, siteId: ids.siteId, serialNumber: ids.serialNumber }],
    [{ id: ids.gatewayId }],
    overrides.unboundFixture ? [{ id: "fixture-1", gatewayId: ids.gatewayId }, { id: "fixture-unbound", gatewayId: null }]
      : overrides.extraFixture ? [{ id: "fixture-1", gatewayId: ids.gatewayId }, { id: "fixture-2", gatewayId: ids.gatewayId }]
        : [{ id: "fixture-1", gatewayId: ids.gatewayId }],
    [{ id: "node-1" }],
    [{ id: "group-1" }],
    [], [{ id: "command-1" }], [], [], [], [], [], [], [],
    [{ id: "report-1", siteId: ids.siteId, format: "pdf", attemptCount: 1 }],
    [{ id: "revision-1", snapshot: "mapping-private-material" }],
    [{ id: "audit-1" }]
  ].map(value => overrides.reverseCollections && Array.isArray(value) ? [...value].reverse() : value);
  let index = 0;
  let jobCreated = false;
  const tx = {
    $queryRaw: jest.fn(async () => rows[index++] ?? []),
    gatewayRecommissionJob: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (jobCreated) throw { code: "P2002" };
        jobCreated = true;
        return { id: "job-1", ...data, preparedAt: new Date("2026-09-14T00:00:00.000Z") };
      })
    }
  };
  return {
    $transaction: jest.fn(async (callback: (transaction: typeof tx) => unknown) => {
      index = 0;
      return callback(tx);
    }),
    gatewayRecommissionJob: tx.gatewayRecommissionJob
  };
}
