import { BadRequestException } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { EnergyController } from "./energy.controller";

describe("EnergyController comparisons", () => {
  const user = {
    id: "user-1",
    organizationId: "org-1",
    organizationType: "customer",
    loginId: "fixture_user",
    name: "Admin",
    role: "admin",
    status: "active"
  } as AuthenticatedUser;

  it("parses and delegates a published comparison preset", async () => {
    const energyService = { getSiteComparisons: jest.fn().mockResolvedValue({ preset: "current_month" }) };
    const controller = new EnergyController(energyService as never);

    await expect(controller.getSiteComparisons(user, "site-1", "current_month")).resolves.toEqual({ preset: "current_month" });
    expect(energyService.getSiteComparisons).toHaveBeenCalledWith(user, "site-1", "current_month");
  });

  it("rejects an unknown preset before calling the service", () => {
    const energyService = { getSiteComparisons: jest.fn() };
    const controller = new EnergyController(energyService as never);

    expect(() => controller.getSiteComparisons(user, "site-1", "custom")).toThrow(BadRequestException);
    expect(energyService.getSiteComparisons).not.toHaveBeenCalled();
  });

  it("delegates the custom date range without changing the preset route", async () => {
    const energyService = { getSiteCustomComparison: jest.fn().mockResolvedValue({ selection: { kind: "custom" } }) };
    const controller = new EnergyController(energyService as never);
    const query = { from: "2026-09-01", to: "2026-09-23" };

    await expect(Reflect.apply(controller.getSiteCustomComparison, controller, [user, "site-1", query]))
      .resolves.toEqual({ selection: { kind: "custom" } });
    expect(energyService.getSiteCustomComparison).toHaveBeenCalledWith(user, "site-1", query);
  });

  it("preserves extra custom query keys for strict service validation", async () => {
    const energyService = { getSiteCustomComparison: jest.fn().mockResolvedValue({}) };
    const controller = new EnergyController(energyService as never);
    const query = { from: "2026-09-01", to: "2026-09-23", unexpected: "ignored-before" };

    await Reflect.apply(controller.getSiteCustomComparison, controller, [user, "site-1", query]);

    expect(energyService.getSiteCustomComparison).toHaveBeenCalledWith(user, "site-1", query);
  });
});
