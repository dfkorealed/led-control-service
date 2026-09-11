import { BadRequestException } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { VehicleEventRulesService } from "./vehicle-event-rules.service";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const GATEWAY_ID = "00000000-0000-4000-8000-000000000002";
const SOURCE_ID = "00000000-0000-4000-8000-000000000003";
const TARGET_ID = "00000000-0000-4000-8000-000000000004";
const RULE_ID = "00000000-0000-4000-8000-000000000005";

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
  it("rejects an invalid hold duration before opening a write transaction", async () => {
    const prisma = { $transaction: jest.fn() };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: SITE_ID }) };
    const service = new VehicleEventRulesService(
      prisma as never,
      siteAccess as never,
      {} as never,
      {} as never
    );

    await expect(service.create(SITE_ID, admin, ruleInput({ holdSeconds: 4 })))
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
      resolveVehicleSources: jest.fn().mockResolvedValue([SOURCE_ID]),
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
      [SOURCE_ID]
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
