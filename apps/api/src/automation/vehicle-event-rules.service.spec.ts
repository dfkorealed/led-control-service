import { BadRequestException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { VehicleEventRulesService } from "./vehicle-event-rules.service";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const GATEWAY_ID = "00000000-0000-4000-8000-000000000002";
const SOURCE_ID = "00000000-0000-4000-8000-000000000003";
const TARGET_ID = "00000000-0000-4000-8000-000000000004";
const RULE_ID = "00000000-0000-4000-8000-000000000005";
// Field references are generated query metadata; this client never connects.
const ruleFields = new PrismaClient().vehicleEventRule.fields;

const admin = {
  id: "00000000-0000-4000-8000-000000000006",
  organizationId: "00000000-0000-4000-8000-000000000007",
  organizationType: "customer",
  loginId: "vehicle_admin",
  name: "Vehicle admin",
  role: "admin",
  mustChangePassword: false,
  status: "active"
} satisfies AuthenticatedUser;

function ruleInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Garage entry",
    status: "enabled",
    sourceFixtureIds: [SOURCE_ID],
    targetFixtureIds: [TARGET_ID],
    action: { dimmingEnabled: true, brightnessPercent: 70 },
    holdSeconds: 60,
    ...overrides
  };
}

describe("VehicleEventRulesService", () => {
  it("rejects an off brightness before persisting a native self-control draft", async () => {
    const service = new VehicleEventRulesService({ $transaction: (f: (tx: unknown) => unknown) => f({ $queryRaw: async () => [] }) } as never,
      { assert: async () => ({}), assertManageInTransaction: async () => ({}) } as never,
      { resolveVehicleSources: async () => ({ fixtureIds: [SOURCE_ID], sensorProtocol: "bio_usb_pulse" }),
        assertSingleGateway: async () => GATEWAY_ID } as never, { lockMutation: async () => {} } as never);
    await expect(service.create(SITE_ID, admin, ruleInput({ status: "disabled", selfControlEnabled: true,
      targetFixtureIds: [], action: { dimmingEnabled: true, brightnessPercent: 0 } })))
      .rejects.toMatchObject({ response: { code: "bio_self_brightness_invalid" } });
  });
  it("saves a self-only BIO draft without inserting its source into force-output targets", async () => {
    let stored: any;
    const sources: any[] = [], targets: any[] = [];
    const tx = { vehicleEventRule: {
      create: async ({ data }: any) => { stored = data; },
      findFirst: async () => ({ ...stored, sources, targets, gateway: { automationConfiguration: null },
        createdAt: new Date("2026-10-16Z"), updatedAt: new Date("2026-10-16Z") }) },
      vehicleEventSource: { createMany: async ({ data }: any) => { sources.push(...data); } },
      vehicleEventTarget: { createMany: async ({ data }: any) => { targets.push(...data); } },
      $queryRaw: async () => [] };
    const service = new VehicleEventRulesService({ $transaction: (f: (tx: unknown) => unknown) => f(tx) } as never,
      { assert: async () => ({}), assertManageInTransaction: async () => ({}) } as never,
      { resolveVehicleSources: async () => ({ fixtureIds: [SOURCE_ID], sensorProtocol: "bio_usb_pulse" }),
        resolve: async () => { throw Error("empty targets must not be expanded"); }, assertSingleGateway: async () => GATEWAY_ID } as never,
      { lockMutation: async () => {}, incrementDesiredRevision: async () => ({}) } as never);
    expect(await service.create(SITE_ID, admin, ruleInput({ status: "disabled", selfControlEnabled: true, targetFixtureIds: [], holdSeconds: 1 })))
      .toMatchObject({ selfControlEnabled: true, sourceFixtureIds: [SOURCE_ID], targetFixtureIds: [], holdSeconds: 1 });
    expect(stored.selfControlEnabled).toBe(true); expect(targets).toEqual([]);
  });
  it("rejects native activation on an old V3 Gateway before saving a rule", async () => {
    const tx = { $queryRaw: async () => [{ assignmentVersion: 1 }], gatewayAutomationProtocolSupport: { findFirst: async () => ({
      maxSnapshotVersion: 3, temporaryControlVersion: 1, bioConfigurationReadback: true, durableFixtureLease: true }) } };
    const service = new VehicleEventRulesService({ $transaction: (f: (tx: unknown) => unknown) => f(tx) } as never,
      { assert: async () => ({}), assertManageInTransaction: async () => ({}) } as never,
      { resolveVehicleSources: async () => ({ fixtureIds: [SOURCE_ID], sensorProtocol: "bio_usb_pulse" }), assertSingleGateway: async () => GATEWAY_ID } as never,
      { lockMutation: async () => {} } as never);
    await expect(service.create(SITE_ID, admin, ruleInput({ selfControlEnabled: true, targetFixtureIds: [] })))
      .rejects.toMatchObject({ response: { code: "bio_self_control_unsupported" } });
  });
  it("returns filtered vehicle-rule counts and site-wide Gateway sync counts in one read transaction", async () => {
    const tx = { vehicleEventRule: { fields: ruleFields, count: jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(1),
      findMany: jest.fn().mockResolvedValue([]) } };
    const prisma = { $transaction: jest.fn((callback, _options) => callback(tx)) };
    const service = new VehicleEventRulesService(prisma as never,
      { assertReadInTransaction: jest.fn().mockResolvedValue({ id: SITE_ID }) } as never,
      {} as never, {} as never);
    await expect(service.list(SITE_ID, admin, { query: "  차고%_  ", status: "disabled", syncStatus: "REJECTED" }))
      .resolves.toEqual({ items: [], total: 4, filteredTotal: 1,
        siteSummary: { ruleCount: 4, syncRuleCounts: { APPLIED: 1, PENDING: 2, REJECTED: 1 } }, nextCursor: null });
    expect(tx.vehicleEventRule.count.mock.calls[1][0].where).toMatchObject({ siteId: SITE_ID,
      name: { contains: "차고\\%\\_", mode: "insensitive" }, status: "disabled" });
    expect(tx.vehicleEventRule.findMany.mock.calls[0][0].where).toMatchObject({ siteId: SITE_ID,
      name: { contains: "차고\\%\\_", mode: "insensitive" }, status: "disabled" });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
  });

  it.each([
    ["APPLIED", 3, 3, "APPLIED"],
    ["APPLIED", 3, 0, "PENDING"],
    ["APPLIED", 3, 2, "PENDING"],
    ["APPLIED", 0, 0, "PENDING"],
    ["PENDING", 3, 2, "PENDING"],
    ["REJECTED", 3, 0, "REJECTED"]
  ] as const)("reports Gateway %s with BIO desired %s / applied %s as %s", async (syncStatus, desiredRevision, appliedRevision, expected) => {
    const now = new Date("2026-10-13T00:00:00Z");
    const row = { id: RULE_ID, siteId: SITE_ID, gatewayId: GATEWAY_ID, name: "BIO draft", status: "disabled",
      sensorProtocol: "bio_usb_pulse", dimmingEnabled: true, brightnessPercent: 100, holdSeconds: 60,
      desiredRevision, appliedRevision, createdById: admin.id, updatedById: admin.id, createdAt: now, updatedAt: now,
      sources: [{ fixtureId: SOURCE_ID }], targets: [{ fixtureId: TARGET_ID }],
      gateway: { automationConfiguration: { desiredRevision, appliedRevision: syncStatus === "APPLIED" ? desiredRevision : 0, syncStatus } } };
    const tx = { vehicleEventRule: { fields: ruleFields, count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([row]) },
      $queryRaw: jest.fn().mockResolvedValue([]) };
    const service = new VehicleEventRulesService({ $transaction: (callback: (tx: unknown) => unknown) => callback(tx) } as never,
      { assertReadInTransaction: jest.fn().mockResolvedValue({ id: SITE_ID }) } as never, {} as never, {} as never);
    const result = await service.list(SITE_ID, admin, {});
    expect(result.items[0]).toMatchObject({ status: "disabled", syncStatus: expected, desiredRevision, appliedRevision });
  });

  it("uses the same revision-qualified BIO predicate for filtered pages and site-wide counts", async () => {
    const tx = { vehicleEventRule: { fields: ruleFields, count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) } };
    const service = new VehicleEventRulesService({ $transaction: (callback: (tx: unknown) => unknown) => callback(tx) } as never,
      { assertReadInTransaction: jest.fn().mockResolvedValue({ id: SITE_ID }) } as never, {} as never, {} as never);
    await service.list(SITE_ID, admin, { syncStatus: "APPLIED" });
    const appliedWhere = { siteId: SITE_ID, OR: [
      { sensorProtocol: "bluez_stateful", gateway: { automationConfiguration: { is: { syncStatus: "APPLIED" } } } },
      { sensorProtocol: "bio_usb_pulse", gateway: { automationConfiguration: { is: { syncStatus: "APPLIED" } } },
        desiredRevision: { gt: 0 }, appliedRevision: { equals: ruleFields.desiredRevision } }
    ] };
    expect(tx.vehicleEventRule.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: appliedWhere }));
    expect(tx.vehicleEventRule.count.mock.calls[1][0].where).toEqual(appliedWhere);
    expect(tx.vehicleEventRule.count.mock.calls[2][0].where).toEqual(appliedWhere);
  });

  it("rejects an invalid hold duration before opening a write transaction", async () => {
    const prisma = { $transaction: jest.fn() };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: SITE_ID }) };
    const service = new VehicleEventRulesService(
      prisma as never,
      siteAccess as never,
      {} as never,
      {} as never
    );

    await expect(service.create(SITE_ID, admin, ruleInput({ holdSeconds: 0 })))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(siteAccess.assert).toHaveBeenCalledWith(admin, SITE_ID, "manage");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("validates sources and targets together as one Gateway after the global lock and Site reauthorization", async () => {
    const calls: string[] = [];
    const tx = {};
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: SITE_ID }),
      assertManageInTransaction: jest.fn().mockImplementation(() => {
        calls.push("site-lock");
        return Promise.resolve({ id: SITE_ID });
      })
    };
    const targetSnapshot = {
      resolveVehicleSources: jest.fn().mockResolvedValue({ fixtureIds: [SOURCE_ID], sensorProtocol: "bluez_stateful" }),
      resolve: jest.fn().mockResolvedValue([TARGET_ID]),
      assertSingleGateway: jest.fn().mockRejectedValue({
        status: 409,
        response: { code: "single_gateway_required" }
      })
    };
    const automationSnapshot = {
      lockMutation: jest.fn().mockImplementation(() => {
        calls.push("automation-lock");
        return Promise.resolve();
      })
    };
    const service = new VehicleEventRulesService(
      prisma as never,
      siteAccess as never,
      targetSnapshot as never,
      automationSnapshot as never
    );

    await expect(service.create(SITE_ID, admin, ruleInput())).rejects.toMatchObject({
      status: 409,
      response: { code: "single_gateway_required" }
    });
    expect(calls).toEqual(["automation-lock", "site-lock"]);
    expect(targetSnapshot.resolveVehicleSources).toHaveBeenCalledWith(
      tx,
      SITE_ID,
      [SOURCE_ID],
      false
    );
    expect(targetSnapshot.resolve).toHaveBeenCalledWith(
      tx,
      SITE_ID,
      { type: "fixtures", fixtureIds: [TARGET_ID] }
    );
    expect(targetSnapshot.assertSingleGateway).toHaveBeenCalledWith(tx, [SOURCE_ID, TARGET_ID]);
  });

  it("authorizes a list before parsing its raw query", async () => {
    const hidden = { status: 404 };
    const tx = { vehicleEventRule: { count: jest.fn(), findMany: jest.fn() } };
    const prisma = { $transaction: jest.fn((callback, _options) => callback(tx)) };
    const siteAccess = { assertReadInTransaction: jest.fn().mockRejectedValue(hidden) };
    const service = new VehicleEventRulesService(
      prisma as never,
      siteAccess as never,
      {} as never,
      {} as never
    );

    await expect(service.list(SITE_ID, admin, { limit: "invalid" })).rejects.toBe(hidden);
    expect(tx.vehicleEventRule.count).not.toHaveBeenCalled();
    expect(tx.vehicleEventRule.findMany).not.toHaveBeenCalled();
  });

  it("locks automation before Site reauthorization on delete", async () => {
    const calls: string[] = [];
    const tx = { vehicleEventRule: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new VehicleEventRulesService(
      { $transaction: jest.fn((callback) => callback(tx)) } as never,
      {
        assert: jest.fn().mockResolvedValue({ id: SITE_ID }),
        assertManageInTransaction: jest.fn().mockImplementation(() => {
          calls.push("site-lock");
          return Promise.resolve({ id: SITE_ID });
        })
      } as never,
      {} as never,
      {
        lockMutation: jest.fn().mockImplementation(() => {
          calls.push("automation-lock");
          return Promise.resolve();
        })
      } as never
    );

    await expect(service.remove(SITE_ID, RULE_ID, admin)).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual(["automation-lock", "site-lock"]);
  });
});
